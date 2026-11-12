// Métricas > Origem dos pedidos: de onde vieram os pedidos da vitrine (UTMs guardadas em
// pedidos.rastreamento, ver rastreamento.js), com quantos pedidos, valor pedido e quanto
// já foi vendido (pedidos entregues, valor do fechamento).
// Visitas sem pedido não são guardadas no banco (ficam no GA4/Meta), então aqui só pedidos.
// Pedidos de antes do rastreamento, ou de quem entrou direto, ficam em "Direto / sem origem".
// O período segue o quadro de Vendas (vendas.limitesPeriodo, horário de Brasília) e nunca
// começa antes de "Limpar testes".

const { limitesPeriodo, PERIODOS } = require('./vendas');

const centavos = (v) => Math.round((Number(v) || 0) * 100);

// Nome da origem: "instagram / bio"; só o clique do anúncio sem UTM; ou direto.
function origemDe(r) {
  const o = r && typeof r === 'object' ? r : {};
  const fonte = String(o.utm_source || '').trim().toLowerCase();
  const meio = String(o.utm_medium || '').trim().toLowerCase();
  if (fonte) return meio ? `${fonte} / ${meio}` : fonte;
  if (o.fbclid) return 'Anúncio Meta (sem UTM)';
  if (o.gclid) return 'Anúncio Google (sem UTM)';
  return 'Direto / sem origem';
}

// Linhas { rastreamento, status, total, total_final } -> origens ordenadas por pedidos,
// cada uma com as campanhas dela. Cancelados contam à parte e não entram no valor.
function agruparOrigens(linhas) {
  const mapa = new Map();
  const novo = (nome) => ({ nome, pedidos: 0, cancelados: 0, valor: 0, entregues: 0, vendido: 0 });
  const somar = (alvo, l) => {
    if (l.status === 'CANCELADO') { alvo.cancelados += 1; return; }
    alvo.pedidos += 1;
    alvo.valor += centavos(l.total);
    if (l.status === 'ENTREGUE') {
      alvo.entregues += 1;
      alvo.vendido += centavos(l.total_final !== null && l.total_final !== undefined ? l.total_final : l.total);
    }
  };
  for (const l of linhas) {
    const nome = origemDe(l.rastreamento);
    if (!mapa.has(nome)) mapa.set(nome, { ...novo(nome), campanhas: new Map() });
    const o = mapa.get(nome);
    somar(o, l);
    const campanha = String((l.rastreamento && l.rastreamento.utm_campaign) || '').trim();
    if (campanha) {
      if (!o.campanhas.has(campanha)) o.campanhas.set(campanha, novo(campanha));
      somar(o.campanhas.get(campanha), l);
    }
  }
  const emReais = (x) => ({ ...x, valor: x.valor / 100, vendido: x.vendido / 100 });
  const ordem = (a, b) => b.pedidos - a.pedidos || b.valor - a.valor || a.nome.localeCompare(b.nome);
  const origens = [...mapa.values()].sort(ordem)
    .map((o) => ({ ...emReais(o), campanhas: [...o.campanhas.values()].sort(ordem).map(emReais) }));
  const totais = origens.reduce((t, o) => ({
    pedidos: t.pedidos + o.pedidos, cancelados: t.cancelados + o.cancelados,
    valor: (centavos(t.valor) + centavos(o.valor)) / 100, entregues: t.entregues + o.entregues,
    vendido: (centavos(t.vendido) + centavos(o.vendido)) / 100,
  }), { pedidos: 0, cancelados: 0, valor: 0, entregues: 0, vendido: 0 });
  const rastreados = origens.filter((o) => o.nome !== 'Direto / sem origem').reduce((n, o) => n + o.pedidos, 0);
  return { origens, totais, rastreados };
}

function criarHandler({ lerMetricasDesde }) {
  return async function handleOrigens(req, res) {
    const periodo = PERIODOS.includes(req.query.periodo) ? req.query.periodo : 'mes';
    try {
      const { inicio: ini, fim } = limitesPeriodo(periodo);
      const desdeTxt = await lerMetricasDesde(req.db);
      const desde = desdeTxt && !Number.isNaN(Date.parse(desdeTxt)) ? new Date(desdeTxt) : null;
      const inicio = desde && (!ini || desde > ini) ? desde : ini;
      const ts = (d) => (d ? d.toISOString().replace('T', ' ').replace('Z', '') : null);
      // O pedido conta na data em que chegou (created_at): é ali que a origem foi medida
      const { rows } = await req.db.query(
        `SELECT rastreamento, status, total, total_final FROM pedidos
         WHERE ($1::timestamp IS NULL OR created_at >= $1::timestamp) AND ($2::timestamp IS NULL OR created_at < $2::timestamp)`,
        [ts(inicio), ts(fim)]);
      res.json({ periodo, inicio: inicio ? inicio.toISOString() : null, fim: fim ? fim.toISOString() : null, ...agruparOrigens(rows) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar a origem dos pedidos' });
    }
  };
}

module.exports = { origemDe, agruparOrigens, criarHandler };
