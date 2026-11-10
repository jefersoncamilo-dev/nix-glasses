// Vendas nas Métricas: junta tudo o que virou dinheiro num período.
//   PEDIDO     pedido entregue (fechamento): compra direta + peças da maleta vendidas
//              no acerto + acessórios, já com desconto (total_final), na data da entrega
//   MALETA     acerto de maleta com peça vendida cujo pedido ainda não foi entregue (ou
//              sem pedido): conta na data do acerto; quando o pedido é entregue, a venda
//              passa a contar pelo fechamento (nunca as duas)
//   ENCOMENDA  encomenda entregue (valor cheio), na data da entrega
//   BALCAO     "Marcar como vendido" da Conferência de estoque (vendas fora do sistema)
// Lucro = valor vendido - custo das peças (custo atual do cadastro; na Conferência,
// o custo gravado na venda) - custo dos acessórios. Tudo em centavos por dentro.
// O período é no horário de Brasília (UTC-3, sem horário de verão) e nunca começa
// antes de "Limpar testes" (metricas_desde).

const PERIODOS = ['mes', 'mes_passado', '30', '90', 'ano', 'tudo'];
const CANAIS = {
  PEDIDO: 'Pedidos entregues',
  MALETA: 'Maletas acertadas',
  ENCOMENDA: 'Encomendas entregues',
  BALCAO: 'Conferência de estoque',
};
const FUSO_MS = 3 * 60 * 60 * 1000; // Brasília = UTC-3

// Limites [inicio, fim) em UTC (Date). agora é injetável para os testes.
function limitesPeriodo(periodo, agora = new Date()) {
  const local = new Date(agora.getTime() - FUSO_MS); // relógio de Brasília lido em UTC
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const utc = (ano, mes, dia = 1) => new Date(Date.UTC(ano, mes, dia) + FUSO_MS);
  switch (periodo) {
    case 'mes': return { inicio: utc(y, m), fim: null };
    case 'mes_passado': return { inicio: utc(y, m - 1), fim: utc(y, m) };
    case '30': return { inicio: new Date(agora.getTime() - 30 * 864e5), fim: null };
    case '90': return { inicio: new Date(agora.getTime() - 90 * 864e5), fim: null };
    case 'ano': return { inicio: utc(y, 0), fim: null };
    default: return { inicio: null, fim: null };
  }
}

const centavos = (v) => Math.round((Number(v) || 0) * 100);

function intencao(item) {
  if (item && item.encomenda === true) return 'ENCOMENDA';
  return item && (item.intencao === 'COMPRA' || item.intencao === 'CONDICIONAL') ? item.intencao : 'CONDICIONAL';
}

function criarHandler({ lerMetricasDesde }) {
  async function montarVendas(db, periodo, agora = new Date()) {
    const { inicio: ini, fim } = limitesPeriodo(periodo, agora);
    const desdeTxt = await lerMetricasDesde(db);
    const desde = desdeTxt && !Number.isNaN(Date.parse(desdeTxt)) ? new Date(desdeTxt) : null;
    const inicio = desde && (!ini || desde > ini) ? desde : ini;
    // Colunas TIMESTAMP sem fuso guardam UTC (CURRENT_TIMESTAMP no Neon/Render)
    const ts = (d) => (d ? d.toISOString().replace('T', ' ').replace('Z', '') : null);
    const params = [ts(inicio), ts(fim)];
    const noPeriodo = (col) => `(${col} IS NOT NULL AND ($1::timestamp IS NULL OR ${col} >= $1::timestamp) AND ($2::timestamp IS NULL OR ${col} < $2::timestamp))`;

    const vendas = []; // { canal, data, descricao, itens: [{produto_id, nome, codigo_sku, pecas, valor}], valor, custo }

    // 1. Pedidos entregues
    const pedidos = (await db.query(
      `SELECT id, nome, itens, itens_removidos, extras, total_final, entregue_em
       FROM pedidos WHERE status = 'ENTREGUE' AND ${noPeriodo('entregue_em')}`, params)).rows;
    const vendidosAcerto = new Map((await db.query(
      `SELECT a.pedido_id, array_agg(DISTINCT x) AS ids FROM acertos a, unnest(a.comprados) x
       WHERE a.pedido_id = ANY($1) GROUP BY a.pedido_id`, [pedidos.map((p) => p.id)])).rows
      .map((r) => [Number(r.pedido_id), (r.ids || []).map(Number)]));

    // 2. Acertos com peça vendida fora de pedido entregue
    const acertos = (await db.query(
      `SELECT a.id, a.comprados, a.created_at, a.pedido_id, p.nome, p.itens
       FROM acertos a LEFT JOIN pedidos p ON p.id = a.pedido_id
       WHERE cardinality(a.comprados) > 0 AND (p.id IS NULL OR p.status <> 'ENTREGUE') AND ${noPeriodo('a.created_at')}`, params)).rows;

    // 3. Encomendas entregues
    const encomendas = (await db.query(
      `SELECT id, produto_id, nome_cliente, modelo, codigo_sku, valor, entregue_em
       FROM encomendas WHERE status = 'ENTREGUE' AND ${noPeriodo('entregue_em')}`, params)).rows;

    // 4. Conferência de estoque
    const balcao = (await db.query(
      `SELECT id, produto_id, nome, codigo_sku, quantidade, preco_venda, preco_custo, created_at
       FROM movimentos_estoque WHERE tipo = 'VENDIDO' AND ${noPeriodo('created_at')}`, params)).rows;

    // Custos e fotos atuais dos produtos e acessórios envolvidos
    const idsProdutos = new Set();
    for (const p of pedidos) for (const i of p.itens || []) idsProdutos.add(Number(i.produto_id));
    for (const a of acertos) for (const id of a.comprados || []) idsProdutos.add(Number(id));
    for (const e of encomendas) if (e.produto_id) idsProdutos.add(Number(e.produto_id));
    for (const b of balcao) if (b.produto_id) idsProdutos.add(Number(b.produto_id));
    const produtos = new Map((await db.query(
      `SELECT id, nome, codigo_sku, preco_custo, preco_venda, COALESCE(fotos[1], imagem_url) AS foto
       FROM produtos WHERE id = ANY($1)`, [[...idsProdutos].filter(Number.isInteger)])).rows.map((p) => [Number(p.id), p]));
    const idsAcessorios = new Set();
    for (const p of pedidos) for (const e of p.extras || []) idsAcessorios.add(Number(e.acessorio_id));
    const acessorios = new Map((await db.query(
      'SELECT id, preco_custo FROM acessorios WHERE id = ANY($1)', [[...idsAcessorios].filter(Number.isInteger)])).rows
      .map((a) => [Number(a.id), a]));
    const custoProduto = (id) => centavos(produtos.get(Number(id))?.preco_custo);

    for (const p of pedidos) {
      const removidos = (p.itens_removidos || []).map(Number);
      const doAcerto = vendidosAcerto.get(Number(p.id)) || [];
      const cobrados = (p.itens || []).filter((i) => {
        const id = Number(i.produto_id);
        const t = intencao(i);
        return t === 'COMPRA' ? !removidos.includes(id) : t === 'CONDICIONAL' && doAcerto.includes(id);
      });
      const extras = Array.isArray(p.extras) ? p.extras : [];
      let valor = p.total_final === null || p.total_final === undefined
        ? cobrados.reduce((t, i) => t + centavos(i.preco), 0) + extras.reduce((t, e) => t + centavos(e.preco) * Number(e.quantidade), 0)
        : centavos(p.total_final);
      if (!cobrados.length && !extras.length && !valor) continue; // pedido só de encomenda
      const custo = cobrados.reduce((t, i) => t + custoProduto(i.produto_id), 0)
        + extras.reduce((t, e) => t + centavos(acessorios.get(Number(e.acessorio_id))?.preco_custo) * Number(e.quantidade), 0);
      vendas.push({
        canal: 'PEDIDO', data: p.entregue_em, descricao: `Pedido #${p.id}${p.nome ? ' · ' + p.nome : ''}`,
        itens: cobrados.map((i) => ({ produto_id: Number(i.produto_id), nome: i.nome, codigo_sku: i.codigo_sku, pecas: 1, valor: centavos(i.preco) })),
        pecas: cobrados.length, acessorios: extras.reduce((t, e) => t + Number(e.quantidade), 0), valor, custo,
      });
    }

    for (const a of acertos) {
      const precosPedido = new Map((Array.isArray(a.itens) ? a.itens : []).map((i) => [Number(i.produto_id), i]));
      const itens = (a.comprados || []).map(Number).map((id) => {
        const doPedido = precosPedido.get(id);
        const prod = produtos.get(id);
        return {
          produto_id: id,
          nome: doPedido?.nome || prod?.nome || '(excluído)',
          codigo_sku: doPedido?.codigo_sku || prod?.codigo_sku || '',
          pecas: 1,
          valor: centavos(doPedido ? doPedido.preco : prod?.preco_venda),
        };
      });
      vendas.push({
        canal: 'MALETA', data: a.created_at,
        descricao: a.pedido_id ? `Acerto da maleta do pedido #${a.pedido_id}${a.nome ? ' · ' + a.nome : ''}` : `Acerto de maleta #${a.id}`,
        itens, pecas: itens.length, acessorios: 0,
        valor: itens.reduce((t, i) => t + i.valor, 0),
        custo: itens.reduce((t, i) => t + custoProduto(i.produto_id), 0),
      });
    }

    for (const e of encomendas) {
      const valor = centavos(e.valor);
      vendas.push({
        canal: 'ENCOMENDA', data: e.entregue_em, descricao: `Encomenda #${e.id}${e.nome_cliente ? ' · ' + e.nome_cliente : ''}`,
        itens: [{ produto_id: e.produto_id ? Number(e.produto_id) : null, nome: e.modelo || '(sem modelo)', codigo_sku: e.codigo_sku, pecas: 1, valor }],
        pecas: 1, acessorios: 0, valor, custo: e.produto_id ? custoProduto(e.produto_id) : 0,
      });
    }

    for (const b of balcao) {
      const q = Number(b.quantidade) || 0;
      const valor = centavos(b.preco_venda) * q;
      vendas.push({
        canal: 'BALCAO', data: b.created_at, descricao: 'Conferência de estoque',
        itens: [{ produto_id: b.produto_id ? Number(b.produto_id) : null, nome: b.nome, codigo_sku: b.codigo_sku, pecas: q, valor }],
        pecas: q, acessorios: 0, valor, custo: centavos(b.preco_custo) * q,
      });
    }

    // Totais, por canal e os mais vendidos
    const soma = (lista) => {
      const t = { vendas: lista.length, pecas: 0, acessorios: 0, valor: 0, custo: 0 };
      for (const v of lista) { t.pecas += v.pecas; t.acessorios += v.acessorios; t.valor += v.valor; t.custo += v.custo; }
      return {
        vendas: t.vendas, pecas: t.pecas, acessorios: t.acessorios,
        faturamento: t.valor / 100, custo: t.custo / 100, lucro: (t.valor - t.custo) / 100,
        ticket_medio: t.vendas ? Math.round(t.valor / t.vendas) / 100 : 0,
      };
    };
    const ranking = new Map();
    for (const v of vendas) {
      for (const i of v.itens) {
        const chave = i.produto_id ? `p${i.produto_id}` : `s${i.codigo_sku || i.nome}`;
        const atual = ranking.get(chave) || {
          produto_id: i.produto_id, nome: produtos.get(i.produto_id)?.nome || i.nome, codigo_sku: produtos.get(i.produto_id)?.codigo_sku || i.codigo_sku,
          foto: produtos.get(i.produto_id)?.foto || null, pecas: 0, valor: 0,
        };
        atual.pecas += i.pecas;
        atual.valor += i.valor;
        ranking.set(chave, atual);
      }
    }
    const dataIso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(String(d).replace(' ', 'T') + 'Z').toISOString() : null);
    return {
      periodo, inicio: inicio ? inicio.toISOString() : null, fim: fim ? fim.toISOString() : null, metricas_desde: desdeTxt,
      totais: soma(vendas),
      canais: Object.entries(CANAIS).map(([chave, rotulo]) => ({ chave, rotulo, ...soma(vendas.filter((v) => v.canal === chave)) })),
      mais_vendidos: [...ranking.values()]
        .sort((a, b) => b.pecas - a.pecas || b.valor - a.valor)
        .slice(0, 10)
        .map((r) => ({ ...r, valor: r.valor / 100 })),
      ultimas: vendas
        .map((v) => ({ canal: v.canal, data: dataIso(v.data), descricao: v.descricao, pecas: v.pecas, acessorios: v.acessorios, valor: v.valor / 100,
          itens: v.itens.map((i) => i.nome).slice(0, 5) }))
        .sort((a, b) => String(b.data).localeCompare(String(a.data)))
        .slice(0, 20),
    };
  }

  async function handleVendas(req, res) {
    const periodo = req.query.periodo === undefined ? 'mes' : String(req.query.periodo);
    if (!PERIODOS.includes(periodo)) return res.status(400).json({ error: 'Período inválido' });
    try {
      res.json(await montarVendas(req.db, periodo));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao calcular as vendas' });
    }
  }

  return { handleVendas, montarVendas };
}

module.exports = { criarHandler, limitesPeriodo, PERIODOS, CANAIS };
