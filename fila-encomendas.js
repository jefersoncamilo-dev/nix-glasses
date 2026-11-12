// Fila de encomendas por fornecedor (aba Encomendas > Aguardando pedido).
//
// O Jefe compra no atacado só quando as encomendas das clientes fecham o pedido mínimo
// do fornecedor. Esta fila junta as encomendas "Aguardando fabricante" que ainda não
// foram pedidas, por fornecedor do produto, e soma o CUSTO delas (preço de custo do
// produto) para mostrar quanto falta para o mínimo e para a personalização grátis.
//
// Regras do fornecedor (configuracoes.fornecedor_regras, JSON por nome em minúsculas):
//   minimo                 pedido mínimo em R$ (0 = sem mínimo)
//   personalizacao_gratis  a partir de quanto a personalização sai grátis (0 = não tem)
//   taxa_personalizacao    taxa cobrada abaixo desse valor (paga à parte)
// Sem regra salva, a Tassia Nunes Atacado começa com a política dela (R$99 / R$350 / R$70).
//
// "Pedir ao fornecedor" marca as encomendas escolhidas com a data (pedido_fornecedor_em)
// e uma referência opcional (nº do pedido no site do fornecedor). Elas saem da fila e
// seguem "Aguardando fabricante" até o Jefe marcar em trânsito.

const CHAVE_REGRAS = 'fornecedor_regras';
const SEM_FORNECEDOR = 'Sem fornecedor';
const REGRA_VAZIA = { minimo: 0, personalizacao_gratis: 0, taxa_personalizacao: 0 };
const REGRAS_PADRAO = [
  { padrao: /tassia/i, regra: { minimo: 99, personalizacao_gratis: 350, taxa_personalizacao: 70 } },
];
const CAMPOS_REGRA = Object.keys(REGRA_VAZIA);

const centavos = (v) => Math.round((Number(v) || 0) * 100);
const chaveFornecedor = (nome) => String(nome || '').trim().toLowerCase();

function regraDoFornecedor(nome, salvas = {}) {
  const chave = chaveFornecedor(nome);
  if (chave && salvas[chave]) return { ...REGRA_VAZIA, ...salvas[chave], padrao: false };
  const p = chave && REGRAS_PADRAO.find((r) => r.padrao.test(chave));
  return { ...(p ? p.regra : REGRA_VAZIA), padrao: true };
}

// Valor em R$ de uma regra: número de 0 a 100000, com até 2 casas. null = inválido.
function lerValorRegra(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? Number(v.trim().replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}

// Linhas do banco (encomenda + produto) -> grupos por fornecedor, com as contas.
function montarFila(linhas, salvas = {}) {
  const grupos = new Map();
  for (const l of linhas) {
    const nome = String(l.fornecedor || '').trim();
    const chave = chaveFornecedor(nome) || '';
    if (!grupos.has(chave)) grupos.set(chave, { fornecedor: nome || SEM_FORNECEDOR, sem_fornecedor: !nome, encomendas: [] });
    const custo = l.produto_id && Number(l.preco_custo) > 0 ? Number(l.preco_custo) : null;
    grupos.get(chave).encomendas.push({
      id: l.id, modelo: l.modelo, codigo_sku: l.codigo_sku, especificacoes: l.especificacoes || '',
      nome_cliente: l.nome_cliente, valor: Number(l.valor) || 0, sinal_pago: Number(l.sinal_pago) || 0,
      created_at: l.created_at, produto_id: l.produto_id, custo,
      codigo_fornecedor: l.codigo_fornecedor || '', nome_fornecedor: l.nome_fornecedor || '',
      cor: l.cor || '', link_fornecedor: l.link_fornecedor || '',
    });
  }
  const lista = [...grupos.values()].map((g) => {
    const regra = g.sem_fornecedor ? { ...REGRA_VAZIA, padrao: true } : regraDoFornecedor(g.fornecedor, salvas);
    const total = g.encomendas.reduce((t, e) => t + centavos(e.custo), 0);
    const minimo = centavos(regra.minimo);
    const gratis = centavos(regra.personalizacao_gratis);
    return {
      ...g,
      regra,
      pecas: g.encomendas.length,
      sem_custo: g.encomendas.filter((e) => e.custo === null).length,
      custo_total: total / 100,
      valor_clientes: g.encomendas.reduce((t, e) => t + centavos(e.valor), 0) / 100,
      atingiu_minimo: total >= minimo,
      faltam_minimo: Math.max(minimo - total, 0) / 100,
      faltam_personalizacao: gratis ? Math.max(gratis - total, 0) / 100 : 0,
      taxa_personalizacao: gratis && total < gratis ? Number(regra.taxa_personalizacao) || 0 : 0,
    };
  });
  // Quem está mais perto de fechar primeiro; "Sem fornecedor" por último
  return lista.sort((a, b) => (a.sem_fornecedor - b.sem_fornecedor) || (b.custo_total - a.custo_total) || a.fornecedor.localeCompare(b.fornecedor));
}

function criarHandlers() {
  async function lerRegras(db) {
    const { rows } = await db.query('SELECT valor FROM configuracoes WHERE chave = $1', [CHAVE_REGRAS]);
    try {
      const v = rows.length ? JSON.parse(rows[0].valor) : {};
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  async function handleFila(req, res) {
    try {
      const { rows } = await req.db.query(
        `SELECT e.id, e.modelo, e.codigo_sku, e.especificacoes, e.nome_cliente, e.valor, e.sinal_pago, e.created_at, e.produto_id,
                p.fornecedor, p.preco_custo, p.codigo_fornecedor, p.nome_fornecedor, p.cor_armacao AS cor, p.link_fornecedor
           FROM encomendas e LEFT JOIN produtos p ON p.id = e.produto_id
          WHERE e.status = 'AGUARDANDO_FABRICANTE' AND e.pedido_fornecedor_em IS NULL
          ORDER BY e.created_at, e.id`
      );
      res.json({ grupos: montarFila(rows, await lerRegras(req.db)) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao montar a fila de encomendas' });
    }
  }

  async function handleSalvarRegra(req, res) {
    const b = req.body || {};
    const nome = typeof b.fornecedor === 'string' ? b.fornecedor.trim().slice(0, 120) : '';
    if (!nome) return res.status(400).json({ error: 'Informe o fornecedor' });
    const regra = {};
    for (const campo of CAMPOS_REGRA) {
      const v = lerValorRegra(b[campo]);
      if (v === null) return res.status(400).json({ error: 'Valor inválido: use um valor em R$ (ex.: 99 ou 350,00)' });
      regra[campo] = v;
    }
    try {
      const salvas = await lerRegras(req.db);
      salvas[chaveFornecedor(nome)] = regra;
      await req.db.query(
        `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = $2`,
        [CHAVE_REGRAS, JSON.stringify(salvas)]
      );
      res.json({ fornecedor: nome, regra: regraDoFornecedor(nome, salvas) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao salvar a regra do fornecedor' });
    }
  }

  // Marca (ou desmarca, com desfazer: true) encomendas como pedidas ao fornecedor.
  async function handlePedirFornecedor(req, res) {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number))] : [];
    if (!ids.length || ids.length > 500 || ids.some((id) => !Number.isInteger(id) || id <= 0 || id >= 2 ** 31)) {
      return res.status(400).json({ error: 'Escolha as encomendas' });
    }
    const referencia = typeof b.referencia === 'string' ? b.referencia.trim().slice(0, 60) : '';
    try {
      const { rows } = b.desfazer === true
        ? await req.db.query(
          `UPDATE encomendas SET pedido_fornecedor_em = NULL, pedido_fornecedor_ref = '', updated_at = CURRENT_TIMESTAMP
            WHERE id = ANY($1) AND status = 'AGUARDANDO_FABRICANTE' AND pedido_fornecedor_em IS NOT NULL RETURNING id`, [ids])
        : await req.db.query(
          `UPDATE encomendas SET pedido_fornecedor_em = CURRENT_TIMESTAMP, pedido_fornecedor_ref = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = ANY($1) AND status = 'AGUARDANDO_FABRICANTE' AND pedido_fornecedor_em IS NULL RETURNING id`, [ids, referencia]);
      if (!rows.length) {
        return res.status(409).json({ error: b.desfazer === true ? 'Nenhuma dessas encomendas está marcada como pedida' : 'Essas encomendas já foram pedidas ou não estão aguardando o fabricante' });
      }
      res.json({ ids: rows.map((r) => r.id).sort((x, y) => x - y) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao marcar o pedido ao fornecedor' });
    }
  }

  return { handleFila, handleSalvarRegra, handlePedirFornecedor };
}

module.exports = { criarHandlers, montarFila, regraDoFornecedor, lerValorRegra, SEM_FORNECEDOR };
