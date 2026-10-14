// Contas de clientes: cadastro, login, sessão e isolamento do token de admin.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let srv;

before(async () => { srv = await h.iniciarServidor(); });
beforeEach(h.limparBanco);
after(async () => {
  await srv.parar();
  await h.fecharBanco();
});

async function post(p, body) {
  const res = await fetch(srv.url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function eu(token) {
  const res = await fetch(srv.url('/api/clientes/me'), { headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
}

const cadastrar = (extra = {}) => post('/api/clientes/cadastro', { email: 'Bia@Nix.com', senha: 'senha-forte-1', nome: '  Bia   Lima ', ...extra });

describe('cadastro de cliente', () => {
  it('cria a conta, devolve token e guarda a senha só como hash', async () => {
    const r = await cadastrar();
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.cliente, { id: 1, email: 'bia@nix.com', nome: 'Bia Lima' });
    assert.ok(r.body.token);
    const { rows } = await h.pool.query('SELECT senha_hash FROM clientes');
    assert.match(rows[0].senha_hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
    assert.ok(!rows[0].senha_hash.includes('senha-forte-1'));
    assert.equal((await eu(r.body.token)).body.cliente.email, 'bia@nix.com');
  });

  it('recusa e-mail repetido (sem diferenciar maiúsculas) com 409', async () => {
    await cadastrar();
    const r = await cadastrar({ email: 'BIA@nix.COM' });
    assert.equal(r.status, 409);
  });

  it('recusa e-mail inválido e senha curta com 400', async () => {
    assert.equal((await cadastrar({ email: 'bia' })).status, 400);
    assert.equal((await cadastrar({ email: ['bia@nix.com'] })).status, 400);
    assert.equal((await cadastrar({ senha: '1234567' })).status, 400);
    assert.equal((await cadastrar({ senha: 12345678 })).status, 400);
    assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM clientes')).rows[0].n, 0);
  });
});

describe('login de cliente', () => {
  beforeEach(() => cadastrar());

  it('entra com e-mail e senha certos', async () => {
    const r = await post('/api/clientes/login', { email: ' BIA@nix.com ', senha: 'senha-forte-1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.cliente.nome, 'Bia Lima');
    assert.equal((await eu(r.body.token)).status, 200);
  });

  it('senha errada e e-mail inexistente dão a mesma resposta genérica', async () => {
    const errada = await post('/api/clientes/login', { email: 'bia@nix.com', senha: 'outra-senha' });
    const inexistente = await post('/api/clientes/login', { email: 'ninguem@nix.com', senha: 'senha-forte-1' });
    assert.equal(errada.status, 401);
    assert.deepEqual(errada.body, inexistente.body);
    assert.equal(inexistente.status, 401);
  });

  it('bloqueia depois de 10 senhas erradas', async () => {
    const email = `bloqueio-${Date.now()}@nix.com`;
    await cadastrar({ email });
    for (let i = 0; i < 10; i++) assert.equal((await post('/api/clientes/login', { email, senha: 'errada-errada' })).status, 401);
    assert.equal((await post('/api/clientes/login', { email, senha: 'senha-forte-1' })).status, 429);
  });
});

describe('sessão do cliente', () => {
  it('exige token válido em /api/clientes/me', async () => {
    assert.equal((await eu()).status, 401);
    assert.equal((await eu('lixo')).status, 401);
    // token assinado com o segredo do admin não vale como cliente
    const forjado = h.tokenForjado({ c: 1, t: 'cliente', exp: Math.floor(Date.now() / 1000) + 3600 });
    await cadastrar();
    assert.equal((await eu(forjado)).status, 401);
  });

  it('conta apagada derruba a sessão', async () => {
    const { body } = await cadastrar();
    await h.pool.query('DELETE FROM clientes');
    assert.equal((await eu(body.token)).status, 401);
  });

  it('token de cliente não abre rotas do admin', async () => {
    const { body } = await cadastrar();
    const res = await fetch(srv.url('/api/admin/produtos'), { headers: { Authorization: `Bearer ${body.token}` } });
    assert.equal(res.status, 401);
  });

  it('token de admin não vale como cliente', async () => {
    assert.equal((await eu(await h.login(srv))).status, 401);
  });
});
