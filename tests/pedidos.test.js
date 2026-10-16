// Pedidos da maleta: o checkout grava o pedido (ligado à conta do cliente
// quando ele está logado) e o painel lista clientes e pedidos só para o admin.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let srv;
let tokenAdmin;

before(async () => {
  srv = await h.iniciarServidor();
  tokenAdmin = await h.login(srv);
});
beforeEach(h.limparBanco);
after(async () => {
  await srv.parar();
  await h.fecharBanco();
});

async function api(method, p, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

async function criarProduto(sku, preco, disponibilidade = 'PRONTA_ENTREGA') {
  const form = new FormData();
  for (const [k, v] of Object.entries({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: 10, preco_venda: preco, disponibilidade })) form.append(k, String(v));
  const res = await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${tokenAdmin}` }, body: form });
  return (await res.json()).id;
}

async function cadastrar(email = 'bia@nix.com', nome = 'Bia Lima') {
  const r = await api('POST', '/api/clientes/cadastro', { body: { email, senha: 'senha-forte-1', nome } });
  return r.body;
}

const contato = { nome: 'Bia Lima', telefone: '(11) 99999-0000', cep: '01001-000', rua: 'Rua A', numero: '10', bairro: 'Centro', cidade: 'São Paulo', complemento: 'apto 2' };

describe('checkout grava o pedido', () => {
  it('liga o pedido ao cliente logado, com preços e encomendas vindos do banco', async () => {
    const a = await criarProduto('P-1', 199.99);
    const e = await criarProduto('P-2', 300.01, 'SOB_ENCOMENDA');
    const { token, cliente } = await cadastrar();
    const r = await api('POST', '/api/maleta/checkout', { token, body: { produtoIds: [e, a], contato } });
    assert.equal(r.status, 200);
    assert.ok(r.body.pedido.id);

    const { rows } = await h.pool.query('SELECT * FROM pedidos');
    assert.equal(rows.length, 1);
    const p = rows[0];
    assert.equal(p.cliente_id, cliente.id);
    assert.equal(p.email, 'bia@nix.com');
    assert.equal(p.nome, 'Bia Lima');
    assert.equal(p.telefone, '(11) 99999-0000');
    assert.equal(p.endereco, 'Rua A, 10 - Centro - São Paulo (apto 2) CEP 01001-000');
    assert.deepEqual(p.itens, [
      { produto_id: e, nome: 'Óculos P-2', codigo_sku: 'P-2', preco: 300.01, encomenda: true, sinal: 150.01, intencao: 'ENCOMENDA' },
      { produto_id: a, nome: 'Óculos P-1', codigo_sku: 'P-1', preco: 199.99, encomenda: false, sinal: 0, intencao: 'CONDICIONAL' },
    ]);
    assert.equal(p.total_prova, '199.99');
    assert.equal(p.total_encomendas, '300.01');
    assert.equal(p.sinal, '150.01');
    assert.equal(p.total, '500.00');
    assert.equal(p.status, 'NOVO');
  });

  it('sem login (ou com token inválido) grava o pedido sem conta', async () => {
    const a = await criarProduto('P-3', 100);
    for (const token of [undefined, 'lixo', tokenAdmin]) {
      assert.equal((await api('POST', '/api/maleta/checkout', { token, body: { produtoIds: [a], contato } })).status, 200);
    }
    const { rows } = await h.pool.query('SELECT cliente_id, email FROM pedidos');
    assert.deepEqual(rows, [{ cliente_id: null, email: '' }, { cliente_id: null, email: '' }, { cliente_id: null, email: '' }]);
  });

  it('ignora preço mandado pelo navegador e IDs repetidos', async () => {
    const a = await criarProduto('P-4', 100);
    await api('POST', '/api/maleta/checkout', { body: { produtoIds: [a, a, String(a)], itens: [{ id: a, preco: 1 }], contato: { ...contato, nome: 'x'.repeat(500) } } });
    const { rows } = await h.pool.query('SELECT nome, itens, total FROM pedidos');
    assert.equal(rows[0].total, '100.00');
    assert.equal(rows[0].itens.length, 1);
    assert.equal(rows[0].nome.length, 100);
  });

  it('não grava pedido quando nenhum produto existe', async () => {
    const r = await api('POST', '/api/maleta/checkout', { body: { produtoIds: [999] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.pedido, null);
    assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM pedidos')).rows[0].n, 0);
  });

  it('recusa IDs que não são inteiros positivos', async () => {
    for (const ids of [[true], [1.5], [-1], [''], ['1e3'], [3000000000], [{}]]) {
      assert.equal((await api('POST', '/api/maleta/checkout', { body: { produtoIds: ids } })).status, 400, JSON.stringify(ids));
    }
  });

  it('conta apagada mantém o pedido, sem cliente', async () => {
    const a = await criarProduto('P-5', 100);
    const { token } = await cadastrar();
    await api('POST', '/api/maleta/checkout', { token, body: { produtoIds: [a] } });
    await h.pool.query('DELETE FROM clientes');
    const { rows } = await h.pool.query('SELECT cliente_id FROM pedidos');
    assert.deepEqual(rows, [{ cliente_id: null }]);
  });
});

describe('painel: clientes e pedidos', () => {
  it('lista clientes com resumo dos pedidos, sem senha', async () => {
    const a = await criarProduto('P-6', 100);
    const bia = await cadastrar();
    await cadastrar('caio@nix.com', 'Caio');
    await api('POST', '/api/maleta/checkout', { token: bia.token, body: { produtoIds: [a] } });
    await api('POST', '/api/maleta/checkout', { token: bia.token, body: { produtoIds: [a] } });

    const r = await api('GET', '/api/admin/clientes', { token: tokenAdmin });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(c => [c.email, c.nome, c.pedidos, Number(c.total_pedidos)]), [
      ['bia@nix.com', 'Bia Lima', 2, 200],
      ['caio@nix.com', 'Caio', 0, 0],
    ]);
    assert.ok(r.body.every(c => !('senha_hash' in c)));
    assert.equal(r.body[1].ultimo_pedido, null);
  });

  it('filtra pedidos por cliente e sem conta', async () => {
    const a = await criarProduto('P-7', 100);
    const bia = await cadastrar();
    await api('POST', '/api/maleta/checkout', { token: bia.token, body: { produtoIds: [a] } });
    await api('POST', '/api/maleta/checkout', { body: { produtoIds: [a], contato } });

    const todos = await api('GET', '/api/admin/pedidos', { token: tokenAdmin });
    assert.equal(todos.body.length, 2);
    const daBia = await api('GET', `/api/admin/pedidos?cliente=${bia.cliente.id}`, { token: tokenAdmin });
    assert.deepEqual(daBia.body.map(p => p.cliente_id), [bia.cliente.id]);
    const semConta = await api('GET', '/api/admin/pedidos?cliente=sem-conta', { token: tokenAdmin });
    assert.deepEqual(semConta.body.map(p => [p.cliente_id, p.nome]), [[null, 'Bia Lima']]);
    assert.equal((await api('GET', '/api/admin/pedidos?cliente=abc', { token: tokenAdmin })).status, 400);
    assert.equal((await api('GET', '/api/admin/pedidos?cliente=1&cliente=2', { token: tokenAdmin })).status, 400);
  });

  it('exige login de admin (token de cliente não serve)', async () => {
    const { token } = await cadastrar();
    for (const rota of ['/api/admin/clientes', '/api/admin/pedidos']) {
      assert.equal((await api('GET', rota)).status, 401);
      assert.equal((await api('GET', rota, { token })).status, 401);
    }
  });
});
