// Vendas nas Métricas: pedidos entregues, maletas acertadas, encomendas entregues e
// vendas da Conferência de estoque, sem contar a mesma peça duas vezes.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { limitesPeriodo } = require('../vendas');

let srv;
let token;

before(async () => {
  srv = await h.iniciarServidor();
  token = await h.login(srv);
});
beforeEach(async () => {
  await h.limparBanco();
  await h.pool.query(`DELETE FROM configuracoes WHERE chave = 'metricas_desde'`);
});
after(async () => {
  await h.pool.query(`DELETE FROM configuracoes WHERE chave = 'metricas_desde'`);
  await srv.parar();
  await h.fecharBanco();
});

async function api(method, p, body) {
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(srv.url(p), opts);
  return { status: res.status, body: await res.json() };
}

async function produto(sku, { custo = 40, venda = 100, estoque = 5 } = {}) {
  return (await h.pool.query(
    `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, estoque, status)
     VALUES ($1, $2, $3, $4, $5, 'DISPONIVEL') RETURNING *`, [`Óculos ${sku}`, sku, custo, venda, estoque])).rows[0];
}

const item = (p, intencao, preco = Number(p.preco_venda)) => ({ produto_id: p.id, nome: p.nome, codigo_sku: p.codigo_sku, preco, intencao });

describe('Vendas nas Métricas', () => {
  it('limites do período no horário de Brasília', () => {
    const agora = new Date('2026-11-01T02:00:00Z'); // ainda 31/10 23h em Brasília
    assert.equal(limitesPeriodo('mes', agora).inicio.toISOString(), '2026-10-01T03:00:00.000Z');
    const passado = limitesPeriodo('mes_passado', agora);
    assert.equal(passado.inicio.toISOString(), '2026-09-01T03:00:00.000Z');
    assert.equal(passado.fim.toISOString(), '2026-10-01T03:00:00.000Z');
    assert.equal(limitesPeriodo('ano', new Date('2026-01-01T02:00:00Z')).inicio.toISOString(), '2025-01-01T03:00:00.000Z');
    assert.deepEqual(limitesPeriodo('tudo', agora), { inicio: null, fim: null });
  });

  it('exige login, a tela Métricas e um período válido', async () => {
    assert.equal((await fetch(srv.url('/api/admin/vendas'))).status, 401);
    assert.equal((await api('GET', '/api/admin/vendas?periodo=semana')).status, 400);
    const r = await api('GET', '/api/admin/vendas');
    assert.equal(r.status, 200);
    assert.equal(r.body.periodo, 'mes');
    assert.equal(r.body.totais.vendas, 0);
  });

  it('junta os quatro canais sem contar a maleta duas vezes', async () => {
    const a = await produto('A1', { custo: 40, venda: 100 });
    const b = await produto('B2', { custo: 30, venda: 80 });
    const c = await produto('C3', { custo: 50, venda: 150 });
    const d = await produto('D4', { custo: 20, venda: 60 });
    const acc = (await h.pool.query(`INSERT INTO acessorios (nome, preco_venda, preco_custo, estoque) VALUES ('Estojo', 15, 5, 10) RETURNING id`)).rows[0].id;

    // Pedido entregue: A1 compra direta + B2 da maleta vendida no acerto + 2 estojos, com R$ 10 de desconto
    const p1 = (await h.pool.query(
      `INSERT INTO pedidos (nome, itens, status, extras, total_final, entregue_em)
       VALUES ('Ana', $1, 'ENTREGUE', $2, 200, CURRENT_TIMESTAMP) RETURNING id`,
      [JSON.stringify([item(a, 'COMPRA'), item(b, 'CONDICIONAL'), item(d, 'CONDICIONAL')]),
        JSON.stringify([{ acessorio_id: acc, nome: 'Estojo', preco: 15, quantidade: 2 }])])).rows[0].id;
    await h.pool.query(`INSERT INTO acertos (comprados, devolvidos, pedido_id) VALUES ($1, $2, $3)`, [[b.id], [d.id], p1]);

    // Maleta acertada, pedido ainda em andamento: C3 vendida
    const p2 = (await h.pool.query(`INSERT INTO pedidos (nome, itens, status) VALUES ('Bia', $1, 'EM_ANDAMENTO') RETURNING id`,
      [JSON.stringify([item(c, 'CONDICIONAL', 140)])])).rows[0].id;
    await h.pool.query(`INSERT INTO acertos (comprados, pedido_id) VALUES ($1, $2)`, [[c.id], p2]);

    // Encomenda entregue
    await h.pool.query(`INSERT INTO encomendas (produto_id, modelo, codigo_sku, valor, status, entregue_em)
                        VALUES ($1, 'Óculos D4', 'D4', 90, 'ENTREGUE', CURRENT_TIMESTAMP)`, [d.id]);
    // Encomenda ainda não entregue não conta
    await h.pool.query(`INSERT INTO encomendas (produto_id, modelo, valor, status) VALUES ($1, 'X', 500, 'EM_TRANSITO')`, [d.id]);
    // Pedido cancelado e pedido novo não contam
    await h.pool.query(`INSERT INTO pedidos (nome, itens, status) VALUES ('Cris', $1, 'CANCELADO'), ('Dani', $1, 'NOVO')`,
      [JSON.stringify([item(a, 'COMPRA')])]);

    // Conferência: 2 peças de A1 vendidas no balcão
    const v = await api('POST', '/api/admin/estoque/conferencia', { acao: 'VENDIDO', itens: [{ id: a.id, quantidade: 2 }] });
    assert.equal(v.status, 200);

    const r = await api('GET', '/api/admin/vendas?periodo=tudo');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const canal = Object.fromEntries(r.body.canais.map((x) => [x.chave, x]));
    // Pedido: 200 (já com desconto); custo 40 + 30 + 2x5 = 80
    assert.deepEqual([canal.PEDIDO.vendas, canal.PEDIDO.pecas, canal.PEDIDO.acessorios, canal.PEDIDO.faturamento, canal.PEDIDO.custo, canal.PEDIDO.lucro],
      [1, 2, 2, 200, 80, 120]);
    // Maleta: preço do pedido (140), custo 50
    assert.deepEqual([canal.MALETA.vendas, canal.MALETA.pecas, canal.MALETA.faturamento, canal.MALETA.lucro], [1, 1, 140, 90]);
    assert.deepEqual([canal.ENCOMENDA.vendas, canal.ENCOMENDA.faturamento, canal.ENCOMENDA.lucro], [1, 90, 70]);
    assert.deepEqual([canal.BALCAO.vendas, canal.BALCAO.pecas, canal.BALCAO.faturamento, canal.BALCAO.lucro], [1, 2, 200, 120]);
    assert.deepEqual(r.body.totais, { vendas: 4, pecas: 6, acessorios: 2, faturamento: 630, custo: 230, lucro: 400, ticket_medio: 157.5 });

    // Mais vendidos: A1 (1 no pedido + 2 no balcão) na frente
    assert.equal(r.body.mais_vendidos[0].codigo_sku, 'A1');
    assert.equal(r.body.mais_vendidos[0].pecas, 3);
    assert.equal(r.body.mais_vendidos[0].valor, 300);
    assert.deepEqual(r.body.mais_vendidos.map((x) => x.codigo_sku).sort(), ['A1', 'B2', 'C3', 'D4']);
    assert.equal(r.body.ultimas.length, 4);

    // Entregou o pedido da maleta: a venda passa para Pedidos (não conta duas vezes)
    await h.pool.query(`UPDATE pedidos SET status = 'ENTREGUE', total_final = 140, entregue_em = CURRENT_TIMESTAMP WHERE id = $1`, [p2]);
    const depois = await api('GET', '/api/admin/vendas?periodo=tudo');
    const cd = Object.fromEntries(depois.body.canais.map((x) => [x.chave, x]));
    assert.equal(cd.MALETA.vendas, 0);
    assert.equal(cd.PEDIDO.vendas, 2);
    assert.equal(depois.body.totais.faturamento, 630);
  });

  it('respeita o período e o "Limpar testes"', async () => {
    const a = await produto('A1');
    await h.pool.query(`INSERT INTO pedidos (nome, itens, status, total_final, entregue_em)
                        VALUES ('Velha', $1, 'ENTREGUE', 100, CURRENT_TIMESTAMP - interval '200 days')`,
    [JSON.stringify([item(a, 'COMPRA')])]);
    await api('POST', '/api/admin/estoque/conferencia', { acao: 'VENDIDO', itens: [{ id: a.id }] });
    assert.equal((await api('GET', '/api/admin/vendas?periodo=tudo')).body.totais.vendas, 2);
    assert.equal((await api('GET', '/api/admin/vendas?periodo=90')).body.totais.vendas, 1);
    assert.equal((await api('GET', '/api/admin/vendas?periodo=mes')).body.totais.vendas, 1);
    assert.equal((await api('GET', '/api/admin/vendas?periodo=mes_passado')).body.totais.vendas, 0);

    await h.pool.query(`INSERT INTO configuracoes (chave, valor) VALUES ('metricas_desde', $1)`, [new Date(Date.now() + 60000).toISOString()]);
    const r = await api('GET', '/api/admin/vendas?periodo=tudo');
    assert.equal(r.body.totais.vendas, 0, 'antes de limpar os testes não conta');
    assert.ok(r.body.metricas_desde);
  });
});
