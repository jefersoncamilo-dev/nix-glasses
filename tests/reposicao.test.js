// Histórico de reposição: compra do cadastro, registro de reposições, última
// compra e variação de custo na lista do admin e o resumo por fornecedor.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let srv;
let token;

before(async () => {
  srv = await h.iniciarServidor();
  token = await h.login(srv);
});
beforeEach(h.limparBanco);
after(async () => {
  await srv.parar();
  await h.fecharBanco();
});

async function api(method, p, { body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

async function criarProduto(campos) {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, String(v));
  const res = await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return (await res.json());
}

const produto = (sku, extra = {}) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: '100', preco_venda: '250', fornecedor: 'Clush', ...extra });
const doAdmin = async (id) => (await api('GET', '/api/admin/produtos')).body.find(p => p.id === id);

describe('histórico de reposição', () => {
  it('o cadastro (individual e em lote) vira a primeira compra', async () => {
    const p = await criarProduto(produto('R-1'));
    await api('POST', '/api/admin/produtos/lote', { body: { produtos: [{ nome: 'L', codigo_sku: 'R-2', preco_custo: 40, preco_venda: 90, fornecedor: 'Forn B' }] } });

    const compras = await api('GET', `/api/admin/produtos/${p.id}/compras`);
    assert.equal(compras.status, 200);
    assert.equal(compras.body.length, 1);
    assert.equal(compras.body[0].origem, 'CADASTRO');
    assert.equal(Number(compras.body[0].preco_custo), 100);
    assert.equal(compras.body[0].fornecedor, 'Clush');

    const lista = (await api('GET', '/api/admin/produtos')).body;
    for (const item of lista) {
      assert.match(item.ultima_compra, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(item.custo_compra_anterior, null);
      assert.equal(item.total_compras, 1);
    }
  });

  it('registrar reposição atualiza o custo e mostra a variação em relação à compra anterior', async () => {
    const p = await criarProduto(produto('R-3'));
    const r = await api('POST', `/api/admin/produtos/${p.id}/compras`, { body: { preco_custo: '110.00', quantidade: 3, data_compra: '2030-01-15' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.compra.origem, 'REPOSICAO');
    assert.equal(r.body.compra.quantidade, 3);
    assert.equal(r.body.compra.data_compra, '2030-01-15');
    assert.equal(Number(r.body.produto.preco_custo), 110);

    const item = await doAdmin(p.id);
    assert.equal(item.ultima_compra, '2030-01-15');
    assert.equal(Number(item.custo_ultima_compra), 110);
    assert.equal(Number(item.custo_compra_anterior), 100);
    assert.equal(item.total_compras, 2);

    // Compra mais antiga registrada depois não muda o custo atual
    await api('POST', `/api/admin/produtos/${p.id}/compras`, { body: { preco_custo: 80, data_compra: '2020-05-01' } });
    const depois = await doAdmin(p.id);
    assert.equal(Number(depois.preco_custo), 110);
    assert.equal(depois.ultima_compra, '2030-01-15');

    const historico = (await api('GET', `/api/admin/produtos/${p.id}/compras`)).body;
    assert.deepEqual(historico.map(c => Number(c.preco_custo)), [110, 100, 80]);
  });

  it('soma as peças no estoque e devolve o esgotado para disponível', async () => {
    const p = await criarProduto(produto('R-4'));
    await api('PUT', `/api/produtos/${p.id}`, { body: { status: 'ESGOTADO' } });
    const r = await api('POST', `/api/admin/produtos/${p.id}/compras`, { body: { preco_custo: 100, quantidade: 3, pedido_fornecedor: '14563', data_compra: '09/11/2025' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.produto.status, 'DISPONIVEL');
    assert.equal(r.body.produto.estoque, 3);
    assert.equal(r.body.compra.pedido_fornecedor, '14563');
    assert.equal(r.body.compra.data_compra, '2025-11-09');
    const mais = await api('POST', `/api/admin/produtos/${p.id}/compras`, { body: { preco_custo: 90, quantidade: 2 } });
    assert.equal(mais.body.produto.estoque, 5);
    const historico = (await api('GET', `/api/admin/produtos/${p.id}/compras`)).body;
    assert.deepEqual(historico.map(c => [c.origem, c.quantidade, c.pedido_fornecedor]), [['REPOSICAO', 2, ''], ['CADASTRO', 1, ''], ['REPOSICAO', 3, '14563']]);
  });

  it('valida custo, quantidade, data, produto e login', async () => {
    const p = await criarProduto(produto('R-5'));
    const url = `/api/admin/produtos/${p.id}/compras`;
    for (const body of [{}, { preco_custo: -1 }, { preco_custo: 'abc' }, { preco_custo: 10, quantidade: 0 }, { preco_custo: 10, quantidade: 1.5 },
      { preco_custo: 10, data_compra: '2026-02-30' }, { preco_custo: 10, data_compra: 'ontem' }]) {
      assert.equal((await api('POST', url, { body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await api('POST', '/api/admin/produtos/99999/compras', { body: { preco_custo: 10 } })).status, 404);
    assert.equal((await api('GET', '/api/admin/produtos/abc/compras')).status, 404);
    assert.equal((await api('POST', url, { body: { preco_custo: 10 }, auth: false })).status, 401);
    assert.equal((await api('GET', url, { auth: false })).status, 401);
    assert.equal((await api('GET', '/api/admin/fornecedores/reposicao', { auth: false })).status, 401);
    assert.equal((await api('GET', url)).body.length, 1);
  });

  it('resumo por fornecedor: produtos, última compra e variação média', async () => {
    const a = await criarProduto(produto('F-A'));
    const b = await criarProduto(produto('F-B', { preco_custo: '50' }));
    await criarProduto(produto('F-C', { fornecedor: '' }));
    await api('POST', `/api/admin/produtos/${a.id}/compras`, { body: { preco_custo: 120, data_compra: '2030-03-01' } }); // +20%
    await api('POST', `/api/admin/produtos/${b.id}/compras`, { body: { preco_custo: 45, data_compra: '2030-02-01' } }); // -10%

    const { status, body } = await api('GET', '/api/admin/fornecedores/reposicao');
    assert.equal(status, 200);
    const clush = body.find(f => f.fornecedor === 'Clush');
    assert.equal(clush.produtos, 2);
    assert.equal(clush.ultima_compra, '2030-03-01');
    assert.equal(clush.subiram, 1);
    assert.equal(clush.baixaram, 1);
    assert.equal(clush.variacao_media, 5);
    const sem = body.find(f => f.fornecedor === '');
    assert.equal(sem.produtos, 1);
    assert.equal(sem.variacao_media, null);
    assert.equal(body[0].fornecedor, 'Clush'); // ordenado pela compra mais recente
  });

  it('apagar o produto apaga o histórico dele', async () => {
    const p = await criarProduto(produto('DEL'));
    await h.pool.query('DELETE FROM produtos WHERE id = $1', [p.id]);
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM compras_fornecedor');
    assert.equal(rows[0].n, 0);
  });
});
