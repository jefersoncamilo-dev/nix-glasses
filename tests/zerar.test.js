// Zerar dados de teste (Configurações do painel): exige login e a palavra ZERAR,
// apaga só o escopo escolhido e mantém a logo e as configurações da loja.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let srv;
let token;

before(async () => {
  srv = await h.iniciarServidor();
  token = await h.login(srv);
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

const png = (n) => Buffer.concat([h.PNG_1x1, Buffer.from([n])]);

async function api(method, p, body) {
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body instanceof FormData) opts.body = body;
  else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(srv.url(p), opts);
  return { status: res.status, body: await res.json() };
}

async function cadastrarProduto(sku) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: '50', preco_venda: '199.90' })) form.append(k, v);
  form.append('foto1', new Blob([png(sku.length)], { type: 'image/png' }), 'f.png');
  const r = await api('POST', '/api/produtos', form);
  assert.equal(r.status, 201);
  return r.body;
}

async function popular() {
  const p = await cadastrarProduto('Z1');
  await cadastrarProduto('Z22');
  await h.pool.query(`INSERT INTO clientes (email, senha_hash) VALUES ('a@b.com', 'x')`);
  await h.pool.query(`INSERT INTO pedidos (cliente_id, nome, itens) VALUES (1, 'Maria', $1)`,
    [JSON.stringify([{ produto_id: p.id }])]);
  await h.pool.query(`INSERT INTO acertos (comprados) VALUES ($1)`, [[p.id]]);
  await h.pool.query(`INSERT INTO encomendas (produto_id, modelo) VALUES ($1, 'X')`, [p.id]);
  await h.pool.query(`INSERT INTO acessorios (nome) VALUES ('Estojo')`);
  const logo = new FormData();
  logo.append('foto1', new Blob([png(99)], { type: 'image/png' }), 'logo.png');
  const r = await api('POST', '/api/admin/loja/logo', logo);
  assert.equal(r.status, 200);
  return { logo: r.body.logo };
}

const contar = async (tabela) => Number((await h.pool.query(`SELECT COUNT(*) FROM ${tabela}`)).rows[0].count);

describe('API: zerar dados de teste', () => {
  it('exige login', async () => {
    const res = await fetch(srv.url('/api/admin/zerar'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmacao: 'ZERAR', escopo: 'tudo' }),
    });
    assert.equal(res.status, 401);
    assert.equal((await fetch(srv.url('/api/admin/zerar'))).status, 401);
  });

  it('sem a palavra ZERAR ou sem escopo válido não apaga nada', async () => {
    await popular();
    for (const corpo of [{ escopo: 'tudo' }, { confirmacao: 'zerar', escopo: 'tudo' }, { confirmacao: 'ZERAR', escopo: 'clientes' }]) {
      const r = await api('POST', '/api/admin/zerar', corpo);
      assert.equal(r.status, 400);
    }
    assert.equal(await contar('produtos'), 2);
    assert.equal(await contar('pedidos'), 1);
  });

  it('mostra quanto existe hoje', async () => {
    await popular();
    const r = await api('GET', '/api/admin/zerar');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { produtos: 2, clientes: 1, pedidos: 1, acertos: 1, encomendas: 1, acessorios: 1 });
  });

  it('"tudo" apaga produtos, fotos, clientes, pedidos, acertos e encomendas e mantém logo e acessórios', async () => {
    const { logo } = await popular();
    await h.pool.query(`UPDATE configuracoes SET valor = '5511999999999' WHERE chave = 'whatsapp_number'`);
    const r = await api('POST', '/api/admin/zerar', { confirmacao: 'ZERAR', escopo: 'tudo' });
    assert.equal(r.status, 200);
    assert.equal(r.body.apagados.produtos, 2);
    assert.deepEqual(r.body.agora, { produtos: 0, clientes: 0, pedidos: 0, acertos: 0, encomendas: 0, acessorios: 1 });
    for (const t of ['produtos', 'compras_fornecedor', 'clientes', 'pedidos', 'acertos', 'encomendas']) assert.equal(await contar(t), 0, t);
    assert.equal(await contar('imagens'), 1);
    assert.equal((await fetch(srv.url(logo))).status, 200);
    const loja = await api('GET', '/api/admin/loja');
    assert.equal(loja.body.logo, logo);
    const whats = await h.pool.query(`SELECT valor FROM configuracoes WHERE chave = 'whatsapp_number'`);
    assert.equal(whats.rows[0].valor, '5511999999999');

    // A numeração recomeça: o primeiro produto real é o 1
    const novo = await cadastrarProduto('REAL1');
    assert.equal(novo.id, 1);
  });

  it('"tudo" com acessórios marcado apaga os acessórios também', async () => {
    await popular();
    const r = await api('POST', '/api/admin/zerar', { confirmacao: 'ZERAR', escopo: 'tudo', acessorios: true });
    assert.equal(r.status, 200);
    assert.equal(await contar('acessorios'), 0);
  });

  it('"produtos" apaga só produtos e as fotos deles; pedidos e clientes ficam', async () => {
    const { logo } = await popular();
    const r = await api('POST', '/api/admin/zerar', { confirmacao: 'ZERAR', escopo: 'produtos' });
    assert.equal(r.status, 200);
    assert.equal(await contar('produtos'), 0);
    assert.equal(await contar('imagens'), 1);
    assert.equal((await fetch(srv.url(logo))).status, 200);
    assert.equal(await contar('clientes'), 1);
    assert.equal(await contar('pedidos'), 1);
    assert.equal(await contar('encomendas'), 1);
    assert.equal(await contar('acessorios'), 1);
    // Sem reiniciar a numeração: pedidos antigos não passam a apontar para produtos novos
    const novo = await cadastrarProduto('REAL1');
    assert.ok(novo.id > 2);
  });
});
