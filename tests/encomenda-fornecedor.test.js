// Sob Encomenda vende pelo estoque do FORNECEDOR (pedido do Jefe, 2026-11-12): trocar
// para Sob Encomenda não precisa zerar o estoque. O estoque do cadastro são as peças que
// a loja tem guardadas; o produto fica na vitrine (DISPONIVEL) mesmo com 0 na loja.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { initTables } = require('../db');

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

async function api(method, p, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

async function criar(sku, campos = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: '29', preco_venda: '169.90', ...campos })) form.append(k, String(v));
  const res = await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  assert.equal(res.status, 201);
  return res.json();
}

const linha = async (id) => (await h.pool.query('SELECT estoque, status, disponibilidade FROM produtos WHERE id = $1', [id])).rows[0];
const vitrine = async () => (await (await fetch(srv.url('/api/produtos'))).json()).map((p) => p.codigo_sku).sort();

describe('Sob Encomenda pelo estoque do fornecedor', () => {
  it('troca para Sob Encomenda sem zerar: as peças da loja ficam guardadas', async () => {
    const p = await criar('NIX-HEX-PRETO', { estoque: '2' });
    const r = await api('PUT', `/api/produtos/${p.id}`, { disponibilidade: 'SOB_ENCOMENDA' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await linha(p.id), { estoque: 2, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' });

    // Volta para Pronta Entrega: as 2 peças continuam lá
    await api('PUT', `/api/produtos/${p.id}`, { disponibilidade: 'PRONTA_ENTREGA' });
    assert.deepEqual(await linha(p.id), { estoque: 2, status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' });
  });

  it('Sob Encomenda com 0 na loja fica na vitrine; Pronta Entrega com 0 sai', async () => {
    const enc = await criar('NIX-ENC', { estoque: '0', disponibilidade: 'SOB_ENCOMENDA' });
    const pronta = await criar('NIX-PRONTA', { estoque: '0' });
    assert.equal((await linha(enc.id)).status, 'DISPONIVEL');
    assert.equal((await linha(pronta.id)).status, 'ESGOTADO');
    assert.deepEqual(await vitrine(), ['NIX-ENC']);

    // Zerar a loja de um Sob Encomenda não tira da vitrine
    const p = await criar('NIX-ENC-2', { estoque: '1', disponibilidade: 'SOB_ENCOMENDA' });
    await api('PUT', `/api/produtos/${p.id}`, { estoque: '0' });
    assert.deepEqual(await linha(p.id), { estoque: 0, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' });
  });

  it('Editar em estoque: muda para Sob Encomenda mantendo o estoque', async () => {
    const p = await criar('NIX-LOTE', { estoque: '3' });
    const atual = (await api('GET', '/api/admin/produtos')).body.find((x) => x.id === p.id);
    const r = await api('PUT', '/api/admin/produtos/lote', { produtos: [{ ...atual, preco_custo: '29', preco_venda: '169.90', disponibilidade: 'SOB_ENCOMENDA', estoque: '3' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await linha(p.id), { estoque: 3, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' });
  });

  it('marcar Esgotado à mão tira o Sob Encomenda (nem loja nem fornecedor)', async () => {
    const p = await criar('NIX-ESG', { estoque: '1', disponibilidade: 'SOB_ENCOMENDA' });
    await api('PUT', `/api/produtos/${p.id}`, { status: 'ESGOTADO' });
    assert.deepEqual(await linha(p.id), { estoque: 0, status: 'ESGOTADO', disponibilidade: 'PRONTA_ENTREGA' });
  });

  it('ajuste único: o 1 de mentira do Sob Encomenda vira 0 e o escondido volta a DISPONIVEL', async () => {
    const ins = async (sku, estoque, disp, status) => (await h.pool.query(
      `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, estoque, disponibilidade, status)
       VALUES ($1, $1, 10, 100, $2, $3, $4) RETURNING id`, [sku, estoque, disp, status])).rows[0].id;
    const um = await ins('E1', 1, 'SOB_ENCOMENDA', 'DISPONIVEL');
    const zero = await ins('E0', 0, 'SOB_ENCOMENDA', 'ESGOTADO');
    const tres = await ins('E3', 3, 'SOB_ENCOMENDA', 'DISPONIVEL');
    const pronta = await ins('P1', 1, 'PRONTA_ENTREGA', 'DISPONIVEL');
    const CHAVE = 'encomenda_estoque_fornecedor_2026_11_12';
    await h.pool.query('DELETE FROM configuracoes WHERE chave = $1', [CHAVE]);
    await initTables(h.pool);
    assert.deepEqual(await linha(um), { estoque: 0, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' });
    assert.deepEqual(await linha(zero), { estoque: 0, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' });
    assert.equal((await linha(tres)).estoque, 3);
    assert.equal((await linha(pronta)).estoque, 1);
    const salvo = JSON.parse((await h.pool.query('SELECT valor FROM configuracoes WHERE chave = $1', [CHAVE])).rows[0].valor);
    assert.deepEqual(salvo.estoque_1_para_0.map((x) => x.codigo_sku), ['E1']);
    assert.deepEqual(salvo.status_para_disponivel.map((x) => [x.codigo_sku, x.antes]), [['E0', 'ESGOTADO']]);

    // Roda uma vez só: um 1 de verdade gravado depois não é mexido
    await h.pool.query('UPDATE produtos SET estoque = 1 WHERE id = $1', [um]);
    await initTables(h.pool);
    assert.equal((await linha(um)).estoque, 1);
  });
});
