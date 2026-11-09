// Configurações > Usuários: o dono cadastra quem entra no painel e em quais telas.
// O servidor confere a área em cada rota (não só o menu), o dono continua com tudo
// e cada usuário só existe na loja em que foi cadastrado.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const h = require('./helpers');

async function chamar(srv, method, p, { token, json } = {}) {
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  }
  const res = await fetch(srv.url(p), opts);
  const texto = await res.text();
  let body = texto;
  try { body = JSON.parse(texto); } catch {}
  return { status: res.status, body };
}

const entrar = (srv, user, password) => chamar(srv, 'POST', '/api/admin/login', { json: { user, password } });

describe('usuários do painel admin', () => {
  let srv;
  let dono;

  before(async () => {
    srv = await h.iniciarServidor();
    dono = await h.login(srv);
  });
  beforeEach(async () => {
    await h.limparBanco();
    await h.pool.query('TRUNCATE admin_usuarios RESTART IDENTITY');
  });
  after(async () => {
    await h.pool.query('TRUNCATE admin_usuarios RESTART IDENTITY');
    await srv.parar();
    await h.fecharBanco();
  });

  const criar = (dados, token = dono) => chamar(srv, 'POST', '/api/admin/usuarios', { token, json: dados });

  it('o dono continua com acesso total e se vê como dono', async () => {
    const me = await chamar(srv, 'GET', '/api/admin/me', { token: dono });
    assert.equal(me.status, 200);
    assert.equal(me.body.dono, true);
    assert.equal(me.body.user, h.ADMIN_USER);
    assert.ok(me.body.areas.some((a) => a.chave === 'pedidos'));
    assert.equal((await chamar(srv, 'GET', '/api/admin/usuarios', { token: dono })).status, 200);
    assert.equal((await chamar(srv, 'GET', '/api/admin/zerar', { token: dono })).status, 200);
  });

  it('cadastra um usuário com senha em hash e entra só nas telas marcadas', async () => {
    const r = await criar({ nome: 'Maria Vendas', login: 'Maria', senha: 'senha-da-maria', permissoes: ['pedidos', 'clientes', 'inventada'] });
    assert.equal(r.status, 201);
    assert.equal(r.body.login, 'maria');
    assert.deepEqual(r.body.permissoes, ['pedidos', 'clientes']);
    assert.equal(r.body.senha_hash, undefined);
    const { rows } = await h.pool.query('SELECT senha_hash FROM admin_usuarios WHERE login = $1', ['maria']);
    assert.ok(!rows[0].senha_hash.includes('senha-da-maria'));
    assert.match(rows[0].senha_hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);

    const login = await entrar(srv, 'MARIA', 'senha-da-maria');
    assert.equal(login.status, 200);
    assert.equal(login.body.dono, false);
    const t = login.body.token;

    const me = await chamar(srv, 'GET', '/api/admin/me', { token: t });
    assert.deepEqual({ dono: me.body.dono, nome: me.body.nome, permissoes: me.body.permissoes },
      { dono: false, nome: 'Maria Vendas', permissoes: ['pedidos', 'clientes'] });

    // Telas liberadas
    assert.equal((await chamar(srv, 'GET', '/api/admin/pedidos', { token: t })).status, 200);
    assert.equal((await chamar(srv, 'GET', '/api/admin/clientes', { token: t })).status, 200);
    // Pedidos precisa ler produtos e acessórios para o fechamento da maleta
    assert.equal((await chamar(srv, 'GET', '/api/admin/produtos', { token: t })).status, 200);
    assert.equal((await chamar(srv, 'GET', '/api/admin/acessorios', { token: t })).status, 200);

    // Telas não liberadas: 403 no servidor
    const bloqueadas = [
      ['POST', '/api/produtos', { nome: 'X', codigo_sku: 'X-1', preco_custo: 1, preco_venda: 2 }],
      ['PUT', '/api/admin/produtos/lote', { produtos: [] }],
      ['POST', '/api/admin/produtos/excluir', { ids: [1], confirmacao: 'EXCLUIR' }],
      ['GET', '/api/admin/metrics'],
      ['GET', '/api/admin/loja'],
      ['POST', '/api/config/whatsapp', { whatsapp: '5511999999999' }],
      ['POST', '/api/admin/acerto', {}],
      ['GET', '/api/admin/products/conditional'],
      ['POST', '/api/admin/encomendas', {}],
      ['POST', '/api/admin/acessorios', {}],
      ['POST', '/api/admin/acessorios/excluir', { ids: [1], confirmacao: 'EXCLUIR' }],
      ['POST', '/api/admin/encomendas/excluir/conferir', { ids: [1] }],
      ['GET', '/api/admin/usuarios'],
      ['POST', '/api/admin/usuarios', { nome: 'Eu', login: 'eu-mesmo', senha: 'senha-qualquer', permissoes: ['config'] }],
      ['GET', '/api/admin/zerar'],
      ['POST', '/api/admin/zerar', { confirmacao: 'ZERAR', escopo: 'tudo' }],
    ];
    for (const [m, p, json] of bloqueadas) {
      const res = await chamar(srv, m, p, { token: t, json });
      assert.equal(res.status, 403, `${m} ${p} deveria ser 403, veio ${res.status}`);
    }
    assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM admin_usuarios')).rows[0].n, 1);
  });

  it('o dono muda as telas e vale na hora, sem novo login', async () => {
    const u = (await criar({ nome: 'Caixa', login: 'caixa', senha: 'senha-do-caixa', permissoes: ['acerto'] })).body;
    const t = (await entrar(srv, 'caixa', 'senha-do-caixa')).body.token;
    assert.equal((await chamar(srv, 'GET', '/api/admin/metrics', { token: t })).status, 403);
    assert.equal((await chamar(srv, 'GET', '/api/admin/products/conditional', { token: t })).status, 200);

    const r = await chamar(srv, 'PUT', `/api/admin/usuarios/${u.id}`, { token: dono, json: { permissoes: ['metricas'] } });
    assert.equal(r.status, 200);
    assert.equal((await chamar(srv, 'GET', '/api/admin/metrics', { token: t })).status, 200);
    assert.equal((await chamar(srv, 'GET', '/api/admin/products/conditional', { token: t })).status, 403);
  });

  it('desativar, trocar a senha ou excluir derruba a sessão do usuário', async () => {
    const u = (await criar({ nome: 'Ana', login: 'ana', senha: 'senha-da-ana-1', permissoes: ['produtos'] })).body;
    let t = (await entrar(srv, 'ana', 'senha-da-ana-1')).body.token;
    assert.equal((await chamar(srv, 'GET', '/api/admin/produtos', { token: t })).status, 200);

    await chamar(srv, 'PUT', `/api/admin/usuarios/${u.id}`, { token: dono, json: { ativo: false } });
    assert.equal((await chamar(srv, 'GET', '/api/admin/produtos', { token: t })).status, 401);
    const bloqueado = await entrar(srv, 'ana', 'senha-da-ana-1');
    assert.equal(bloqueado.status, 401);
    assert.match(bloqueado.body.error, /desativado/);

    await chamar(srv, 'PUT', `/api/admin/usuarios/${u.id}`, { token: dono, json: { ativo: true } });
    t = (await entrar(srv, 'ana', 'senha-da-ana-1')).body.token;
    assert.equal((await chamar(srv, 'GET', '/api/admin/produtos', { token: t })).status, 200);

    // Editar sem senha mantém a senha antiga
    await chamar(srv, 'PUT', `/api/admin/usuarios/${u.id}`, { token: dono, json: { nome: 'Ana Paula', senha: '' } });
    assert.equal((await chamar(srv, 'GET', '/api/admin/produtos', { token: t })).status, 200);

    await chamar(srv, 'PUT', `/api/admin/usuarios/${u.id}`, { token: dono, json: { senha: 'senha-nova-da-ana' } });
    assert.equal((await chamar(srv, 'GET', '/api/admin/produtos', { token: t })).status, 401);
    assert.equal((await entrar(srv, 'ana', 'senha-da-ana-1')).status, 401);
    t = (await entrar(srv, 'ana', 'senha-nova-da-ana')).body.token;

    assert.equal((await chamar(srv, 'DELETE', `/api/admin/usuarios/${u.id}`, { token: dono })).status, 200);
    assert.equal((await chamar(srv, 'GET', '/api/admin/produtos', { token: t })).status, 401);
    assert.equal((await chamar(srv, 'GET', '/api/admin/usuarios', { token: dono })).body.usuarios.length, 0);
  });

  it('confere os dados do cadastro', async () => {
    assert.equal((await criar({ nome: '', login: 'ok-login', senha: 'senha-valida' })).status, 400);
    assert.equal((await criar({ nome: 'A', login: 'com espaço', senha: 'senha-valida' })).status, 400);
    assert.equal((await criar({ nome: 'A', login: 'curta', senha: '123' })).status, 400);
    assert.equal((await criar({ nome: 'A', login: h.ADMIN_USER.toUpperCase(), senha: 'senha-valida' })).status, 409);
    assert.equal((await criar({ nome: 'A', login: 'repetido', senha: 'senha-valida' })).status, 201);
    assert.equal((await criar({ nome: 'B', login: 'REPETIDO', senha: 'senha-valida' })).status, 409);
    assert.equal((await chamar(srv, 'PUT', '/api/admin/usuarios/999', { token: dono, json: { nome: 'X' } })).status, 404);
    // Sem login nenhum
    assert.equal((await chamar(srv, 'GET', '/api/admin/usuarios')).status, 401);
  });

  it('usuário sem nenhuma tela entra mas não abre nada', async () => {
    await criar({ nome: 'Novo', login: 'novo', senha: 'senha-do-novo', permissoes: [] });
    const t = (await entrar(srv, 'novo', 'senha-do-novo')).body.token;
    assert.deepEqual((await chamar(srv, 'GET', '/api/admin/me', { token: t })).body.permissoes, []);
    assert.equal((await chamar(srv, 'GET', '/api/admin/produtos', { token: t })).status, 403);
  });

  it('senha errada repetida bloqueia o login do usuário por um tempo', async () => {
    await criar({ nome: 'Alvo', login: 'alvo', senha: 'senha-do-alvo' });
    for (let i = 0; i < 10; i++) assert.equal((await entrar(srv, 'alvo', 'errada-' + i)).status, 401);
    assert.equal((await entrar(srv, 'alvo', 'senha-do-alvo')).status, 429);
    // O dono não é afetado
    assert.equal((await entrar(srv, h.ADMIN_USER, h.ADMIN_PASS)).status, 200);
  });
});

describe('usuários do painel em duas empresas', () => {
  const NIX = 'nix-glasses.onrender.com';
  const PASUC = 'pasucportas.temcatalogo.com.br';
  const url2 = new URL(h.DATABASE_URL);
  const nomeBanco2 = `${url2.pathname.slice(1)}_usuarios`;
  url2.pathname = '/' + nomeBanco2;
  let srv;
  let pool2;
  let poolNix;

  function pedir(host, metodo, caminho, { json, token } = {}) {
    const { port } = new URL(srv.base);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: metodo, path: caminho,
        headers: {
          Host: host,
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }, (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          let body = texto;
          try { body = JSON.parse(texto); } catch {}
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', reject);
      req.end(json !== undefined ? JSON.stringify(json) : undefined);
    });
  }

  before(async () => {
    poolNix = new Pool({ connectionString: h.DATABASE_URL });
    const existe = await poolNix.query('SELECT 1 FROM pg_database WHERE datname = $1', [nomeBanco2]);
    if (!existe.rows.length) await poolNix.query(`CREATE DATABASE "${nomeBanco2}"`);
    srv = await h.iniciarServidor({
      env: {
        EMPRESAS: 'nix,pasucportas',
        RENDER_EXTERNAL_HOSTNAME: NIX,
        EMPRESA_PASUCPORTAS_DATABASE_URL: url2.href,
        EMPRESA_PASUCPORTAS_ADMIN_USER: 'pasuc-admin',
        EMPRESA_PASUCPORTAS_ADMIN_PASS_HASH: h.hashSenha('senha-da-pasuc-123'),
      },
    });
    pool2 = new Pool({ connectionString: url2.href });
    await poolNix.query('TRUNCATE admin_usuarios RESTART IDENTITY');
    await pool2.query('TRUNCATE admin_usuarios RESTART IDENTITY');
  });
  after(async () => {
    await poolNix.query('TRUNCATE admin_usuarios RESTART IDENTITY');
    await srv.parar();
    await pool2.end();
    await poolNix.end();
  });

  it('o usuário só existe e só entra na loja em que foi cadastrado', async () => {
    const donoPasuc = (await pedir(PASUC, 'POST', '/api/admin/login', { json: { user: 'pasuc-admin', password: 'senha-da-pasuc-123' } })).body.token;
    const r = await pedir(PASUC, 'POST', '/api/admin/usuarios', {
      token: donoPasuc, json: { nome: 'Vendedor', login: 'vendedor', senha: 'senha-vendedor', permissoes: ['produtos'] },
    });
    assert.equal(r.status, 201);
    assert.equal((await pool2.query('SELECT count(*)::int AS n FROM admin_usuarios')).rows[0].n, 1);
    assert.equal((await poolNix.query('SELECT count(*)::int AS n FROM admin_usuarios')).rows[0].n, 0);

    assert.equal((await pedir(NIX, 'POST', '/api/admin/login', { json: { user: 'vendedor', password: 'senha-vendedor' } })).status, 401);
    const t = (await pedir(PASUC, 'POST', '/api/admin/login', { json: { user: 'vendedor', password: 'senha-vendedor' } })).body.token;
    assert.ok(t);
    assert.equal((await pedir(PASUC, 'GET', '/api/admin/produtos', { token: t })).status, 200);
    assert.equal((await pedir(NIX, 'GET', '/api/admin/produtos', { token: t })).status, 401);
  });
});
