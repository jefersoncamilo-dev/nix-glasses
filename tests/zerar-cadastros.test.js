// Configurações > Zerar um cadastro: um botão para cada (produtos, clientes, pedidos,
// acertos, encomendas, acessórios). Só o dono, com ZERAR digitado; o que está em uso
// (peça em maleta, pedido aberto) barra tudo e nada é apagado.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let srv;
let tokenAdmin;

before(async () => {
  srv = await h.iniciarServidor();
  tokenAdmin = await h.login(srv);
});
beforeEach(async () => {
  await h.limparBanco();
  await h.pool.query(`DELETE FROM configuracoes WHERE chave = 'loja_logo'`);
});
after(async () => {
  await h.pool.query(`DELETE FROM configuracoes WHERE chave = 'loja_logo'`);
  await srv.parar();
  await h.fecharBanco();
});

async function api(method, p, { body, token = tokenAdmin } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let corpo;
  if (body instanceof FormData) corpo = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; corpo = JSON.stringify(body); }
  const res = await fetch(srv.url(p), { method, headers, body: corpo });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

const png = (n) => Buffer.concat([h.PNG_1x1, Buffer.from([n])]);

async function criarProduto(sku, { estoque = 2 } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: 10, preco_venda: 100, estoque })) form.append(k, String(v));
  form.append('foto1', new Blob([png(sku.length)], { type: 'image/png' }), 'f.png');
  const r = await api('POST', '/api/produtos', { body: form });
  assert.equal(r.status, 201);
  return r.body.id;
}

const cadastrar = async (email) =>
  (await api('POST', '/api/clientes/cadastro', { token: null, body: { email, senha: 'senha-forte-1', nome: 'Ana Lima' } })).body;
const pedir = async (itens, token = null) =>
  (await api('POST', '/api/maleta/checkout', { token, body: { itens, contato: { nome: 'Ana Lima', telefone: '11999990000' } } })).body.pedido.id;
const contar = async (tabela) => Number((await h.pool.query(`SELECT COUNT(*) FROM ${tabela}`)).rows[0].count);
const previa = (c) => api('GET', `/api/admin/zerar/${c}`);
const zerar = (c, confirmacao = 'ZERAR') => api('POST', `/api/admin/zerar/${c}`, { body: { confirmacao } });

describe('zerar um cadastro de cada vez', () => {
  it('exige login, cadastro conhecido e a palavra ZERAR', async () => {
    await criarProduto('A1');
    assert.equal((await api('GET', '/api/admin/zerar/produtos', { token: null })).status, 401);
    assert.equal((await api('POST', '/api/admin/zerar/produtos', { token: null, body: { confirmacao: 'ZERAR' } })).status, 401);
    assert.equal((await previa('usuarios')).status, 404);
    assert.equal((await zerar('configuracoes')).status, 404);
    assert.equal((await zerar('__proto__')).status, 404);
    for (const c of ['produtos', 'clientes', 'pedidos', 'acertos', 'encomendas', 'acessorios']) {
      assert.equal((await zerar(c, 'zerar')).status, 400, c);
      assert.equal((await api('POST', `/api/admin/zerar/${c}`, { body: {} })).status, 400, c);
    }
    assert.equal(await contar('produtos'), 1);
  });

  it('cada botão apaga só o seu cadastro', async () => {
    const p1 = await criarProduto('A1');
    await criarProduto('A2');
    const { token } = await cadastrar('ana@nix.com');
    const pedido = await pedir([{ id: p1, intencao: 'CONDICIONAL' }], token);
    await api('PATCH', `/api/admin/pedidos/${pedido}/status`, { body: { status: 'CANCELADO' } });
    await h.pool.query(`INSERT INTO acertos (comprados, pedido_id) VALUES ($1, $2)`, [[p1], pedido]);
    await h.pool.query(`INSERT INTO encomendas (produto_id, pedido_id, modelo, sinal_pago) VALUES ($1, $2, 'Aviador', 50)`, [p1, pedido]);
    await api('POST', '/api/admin/acessorios', { body: { nome: 'Flanela', preco_venda: 15, estoque: 3 } });

    let r = await previa('acertos');
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1);
    assert.equal(r.body.pode_zerar, true);
    assert.match(r.body.avisos.join(' '), /não volta para o estoque/);
    r = await zerar('acertos');
    assert.equal(r.status, 200);
    assert.equal(r.body.apagados, 1);
    assert.equal(r.body.agora.acertos, 0);
    assert.equal(r.body.agora.produtos, 2);
    assert.equal(r.body.agora.pedidos, 1);

    r = await previa('pedidos');
    assert.equal(r.body.pode_zerar, true);
    assert.match(r.body.avisos.join(' '), /encomenda veio de pedido/);
    r = await zerar('pedidos');
    assert.equal(r.status, 200);
    assert.equal(await contar('pedidos'), 0);
    // A encomenda fica, só sem o número do pedido; a numeração dos pedidos volta a 1
    assert.equal((await h.pool.query('SELECT pedido_id FROM encomendas')).rows[0].pedido_id, null);
    assert.equal(await pedir([{ id: p1, intencao: 'CONDICIONAL' }]), 1);
    await api('PATCH', '/api/admin/pedidos/1/status', { body: { status: 'CANCELADO' } });

    r = await previa('encomendas');
    assert.match(r.body.avisos.join(' '), /R\$ 50,00 de sinal/);
    assert.equal((await zerar('encomendas')).status, 200);
    assert.equal(await contar('encomendas'), 0);

    assert.equal((await zerar('clientes')).status, 200);
    assert.equal(await contar('clientes'), 0);
    assert.equal(await contar('pedidos'), 1);

    r = await previa('acessorios');
    assert.match(r.body.avisos.join(' '), /3 un\. em estoque/);
    assert.equal((await zerar('acessorios')).status, 200);
    assert.equal(await contar('acessorios'), 0);

    assert.equal(await contar('imagens'), 2);
    r = await zerar('produtos');
    assert.equal(r.status, 200);
    assert.equal(r.body.apagados, 2);
    assert.equal(await contar('produtos'), 0);
    assert.equal(await contar('imagens'), 0);
    // O pedido antigo continua (guarda nome e preço)
    assert.equal(await contar('pedidos'), 1);
  });

  it('sem nada cadastrado a prévia não deixa zerar', async () => {
    const r = await previa('clientes');
    assert.equal(r.body.total, 0);
    assert.equal(r.body.pode_zerar, false);
    assert.equal((await zerar('clientes')).status, 200);
  });

  it('peça em maleta ou pedido aberto barra e nada é apagado', async () => {
    const p1 = await criarProduto('M1');
    await criarProduto('M2');
    const { token } = await cadastrar('ana@nix.com');
    const pedido = await pedir([{ id: p1, intencao: 'CONDICIONAL' }], token);

    // Pedido aberto (NOVO) barra produtos e clientes
    let r = await previa('produtos');
    assert.equal(r.body.pode_zerar, false);
    assert.equal(r.body.total_bloqueados, 1);
    assert.match(r.body.bloqueados[0].bloqueios.join(' '), /pedido aberto #1/);
    r = await zerar('produtos');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Nada foi apagado/);
    assert.equal(await contar('produtos'), 2);
    assert.equal((await zerar('clientes')).status, 409);
    assert.equal(await contar('clientes'), 1);

    // Com a maleta enviada, nem os pedidos saem (as peças estão com a cliente)
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/enviar-maleta`)).status, 200);
    r = await zerar('pedidos');
    assert.equal(r.status, 409);
    assert.match(r.body.bloqueados[0].bloqueios.join(' '), /Faça o acerto da maleta antes/);
    assert.equal(await contar('pedidos'), 1);
    assert.equal(await contar('maleta_pecas'), 1);

    // Acessório no fechamento de pedido aberto também barra
    const fl = (await api('POST', '/api/admin/acessorios', { body: { nome: 'Flanela', preco_venda: 15, estoque: 5 } })).body;
    assert.equal((await api('PUT', `/api/admin/pedidos/${pedido}/fechamento`, { body: { extras: [{ acessorio_id: fl.id, quantidade: 1 }] } })).status, 200);
    assert.equal((await zerar('acessorios')).status, 409);
    assert.equal(await contar('acessorios'), 1);

    // Acertos não dependem de nada
    await h.pool.query(`INSERT INTO acertos (comprados) VALUES ('{}')`);
    assert.equal((await zerar('acertos')).status, 200);
  });

  it('zerar produtos mantém a logo e apaga os pedidos do fornecedor que ficaram vazios', async () => {
    const logo = new FormData();
    logo.append('foto1', new Blob([png(99)], { type: 'image/png' }), 'logo.png');
    assert.equal((await api('POST', '/api/admin/loja/logo', { body: logo })).status, 200);
    const p = await criarProduto('F1');
    await h.pool.query(`INSERT INTO compras_fornecedor (produto_id, fornecedor, preco_custo, pedido_fornecedor) VALUES ($1, 'Tassia', 10, '14314')`, [p]);
    await h.pool.query(`INSERT INTO pedidos_fornecedor (fornecedor, numero) VALUES ('Tassia', '14314'), ('Clush', '63647')`);
    await h.pool.query(`INSERT INTO acessorios (nome) VALUES ('Estojo')`);
    await h.pool.query(`INSERT INTO compras_acessorio (acessorio_id, pedido_fornecedor) VALUES (1, '63647')`);

    assert.equal((await zerar('produtos')).status, 200);
    assert.equal(await contar('compras_fornecedor'), 0);
    assert.deepEqual((await h.pool.query('SELECT numero FROM pedidos_fornecedor')).rows.map((r) => r.numero), ['63647']);
    assert.equal(await contar('imagens'), 1);
    const loja = (await api('GET', '/api/admin/loja')).body;
    assert.ok(loja.logo);

    assert.equal((await zerar('acessorios')).status, 200);
    assert.equal(await contar('pedidos_fornecedor'), 0);
  });
});
