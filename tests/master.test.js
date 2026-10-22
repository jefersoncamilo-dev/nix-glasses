// Painel master: o dono do serviço cria e configura as lojas sem mexer nas variáveis
// do Render. O cadastro fica no banco da empresa padrão; cada loja continua com o seu.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const h = require('./helpers');
const master = require('../master');
const { lerEmpresas } = require('../empresas');

after(h.fecharBanco);

describe('lerLojaMaster', () => {
  const nova = { slug: 'donatti', nome: 'Donatti', banco: 'postgresql://u:s@ep-x.neon.tech/neondb', admin_user: 'donatti', senha: 'senha-boa-123' };

  it('aceita uma loja nova completa e normaliza os endereços', () => {
    const { erro, campos } = master.lerLojaMaster({ ...nova, dominios: 'Donatti.TemCatalogo.com.br\nwww.donatti.com.br, ' }, { nova: true });
    assert.equal(erro, undefined);
    assert.deepEqual(campos.dominios, ['donatti.temcatalogo.com.br', 'www.donatti.com.br']);
    assert.equal(campos.slug, 'donatti');
  });

  it('recusa o que falta ou está errado', () => {
    const casos = [
      [{ ...nova, slug: 'Donatti Loja' }, /Identificador/],
      [{ ...nova, slug: 'admin' }, /reservado/],
      [{ ...nova, nome: '  ' }, /nome/],
      [{ ...nova, banco: '' }, /connection string/],
      [{ ...nova, banco: 'mysql://x/y' }, /postgresql/],
      [{ ...nova, admin_user: '' }, /usuário/],
      [{ ...nova, senha: 'curta' }, /8 caracteres/],
      [{ ...nova, dominios: 'https://loja.com.br' }, /inválido/],
      [{ ...nova, ativo: 'sim' }, /ativo/],
    ];
    for (const [corpo, msg] of casos) assert.match(master.lerLojaMaster(corpo, { nova: true }).erro || '', msg, JSON.stringify(corpo));
  });

  it('na edição, só o que veio (em branco mantém senha e banco)', () => {
    assert.deepEqual(master.lerLojaMaster({ senha: '', banco: '', admin_user: '' }).campos, {});
    assert.deepEqual(master.lerLojaMaster({ ativo: false }).campos, { ativo: false });
  });
});

describe('cifra do banco', () => {
  it('volta igual com a mesma chave e falha com outra', () => {
    const url = 'postgresql://u:segredo@ep-x.neon.tech/neondb';
    const c = master.cifrar(url, 'chave-1');
    assert.doesNotMatch(c, /segredo|neon/);
    assert.equal(master.decifrar(c, 'chave-1'), url);
    assert.throws(() => master.decifrar(c, 'chave-2'));
  });
});

describe('mesclarEmpresas', () => {
  const env = lerEmpresas({ EMPRESAS: 'nix,pasuc', DATABASE_URL: 'pg://nix', EMPRESA_PASUC_DATABASE_URL: 'pg://pasuc', EMPRESA_PASUC_ADMIN_USER: 'p', EMPRESA_PASUC_DOMINIOS: 'pasuc.com.br' });
  const linha = (l) => ({ dominios: null, banco_cifrado: null, admin_user: null, admin_pass_hash: null, ativo: true, sessao: 0, nome: '', ...l });

  it('o painel completa as variáveis do Render e acrescenta lojas novas', () => {
    const empresas = master.mesclarEmpresas(env, [
      linha({ slug: 'pasuc', admin_user: 'novo', sessao: 2 }),
      linha({ slug: 'donatti', nome: 'Donatti', banco_cifrado: 'x', admin_user: 'd', admin_pass_hash: 'h', dominios: '' }),
    ], () => 'pg://donatti');
    assert.deepEqual(empresas.map((e) => [e.slug, e.origem]), [['nix', 'render'], ['pasuc', 'render+painel'], ['donatti', 'painel']]);
    assert.equal(empresas[1].adminUser, 'novo');
    assert.deepEqual(empresas[1].dominios, ['pasuc.com.br'], 'domínios nulos seguem as variáveis');
    assert.equal(empresas[1].sessao, 2);
    assert.equal(empresas[2].databaseUrl, 'pg://donatti');
    assert.equal(env[1].adminUser, 'p', 'não altera a lista das variáveis');
  });

  it('banco que não dá para ler deixa só aquela loja com erro', () => {
    const [, , donatti] = master.mesclarEmpresas(env, [linha({ slug: 'donatti', banco_cifrado: 'x' })], () => { throw new Error('x'); });
    assert.match(donatti.erro, /JWT_SECRET/);
  });

  it('a loja principal não troca de banco nem é suspensa pelo painel', () => {
    const [nix] = master.mesclarEmpresas(env, [linha({ slug: 'nix', banco_cifrado: 'x', ativo: false })], () => 'pg://outro');
    assert.equal(nix.databaseUrl, 'pg://nix');
    assert.equal(nix.ativo, true);
  });
});

describe('enderecoDaLoja', () => {
  it('usa o primeiro domínio ou o subdomínio do painel', () => {
    assert.equal(master.enderecoDaLoja({ slug: 'a', dominios: ['x.com.br'] }, 'admin.temcatalogo.com.br'), 'x.com.br');
    assert.equal(master.enderecoDaLoja({ slug: 'donatti', dominios: [] }, 'admin.temcatalogo.com.br'), 'donatti.temcatalogo.com.br');
    assert.equal(master.enderecoDaLoja({ slug: 'donatti', dominios: [] }, 'localhost'), '');
  });
});

// Requisição com Host próprio (o fetch do Node não deixa trocar o Host).
function pedir(srv, host, metodo, caminho, { json, token } = {}) {
  const { port } = new URL(srv.base);
  const corpo = json !== undefined ? JSON.stringify(json) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: metodo,
      path: caminho,
      headers: {
        Host: host,
        // Com tamanho: sem ele o Node manda o corpo do DELETE sem framing
        ...(corpo !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (/json/.test(res.headers['content-type'] || '')) body = JSON.parse(body);
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end(corpo);
  });
}

describe('painel master', () => {
  const NIX = 'nix-glasses.onrender.com';
  const MASTER = 'admin.temcatalogo.com.br';
  const DONATTI = 'donatti.temcatalogo.com.br';
  const MASTER_USER = 'jefe';
  const MASTER_PASS = 'senha-do-master-123';
  const env = {
    RENDER_EXTERNAL_HOSTNAME: NIX,
    MASTER_USER,
    MASTER_PASS_HASH: h.hashSenha(MASTER_PASS),
    MASTER_DOMINIOS: MASTER,
  };
  const urlLoja = (sufixo) => {
    const u = new URL(h.DATABASE_URL);
    u.pathname = `/${u.pathname.slice(1)}_${sufixo}`;
    return u;
  };
  const banco1 = urlLoja('master1');
  const banco2 = urlLoja('master2');
  let srv;
  let tokenMaster;

  async function bancoNovo(u) {
    const nome = u.pathname.slice(1);
    await h.pool.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`);
    await h.pool.query(`CREATE DATABASE "${nome}"`);
  }
  const limparCadastro = () => h.pool.query('DROP TABLE IF EXISTS master_lojas');

  before(async () => {
    await limparCadastro();
    await bancoNovo(banco1);
    await bancoNovo(banco2);
    await h.pool.query(`DELETE FROM configuracoes WHERE chave LIKE 'loja%'`).catch(() => {});
    srv = await h.iniciarServidor({ env });
  });
  after(async () => {
    if (srv) await srv.parar();
    // O cadastro fica no banco dos outros testes: sem isto, eles subiriam com estas lojas.
    await limparCadastro();
  });

  const novaLoja = (extra = {}) => ({
    slug: 'donatti',
    nome: 'Donatti - LOJA',
    nicho: 'roupas',
    dominios: '',
    admin_user: 'donatti',
    senha: 'senha-da-donatti-1',
    banco: banco1.href,
    ...extra,
  });

  it('abre no endereço do master e no do Render, e "/" do master leva ao painel', async () => {
    const raiz = await pedir(srv, MASTER, 'GET', '/');
    assert.equal(raiz.status, 302);
    assert.equal(raiz.headers.location, '/master/');
    for (const host of [MASTER, NIX, 'localhost']) {
      const pagina = await pedir(srv, host, 'GET', '/master/');
      assert.equal(pagina.status, 200, host);
      assert.match(pagina.body, /Painel master/);
    }
    assert.equal((await pedir(srv, MASTER, 'GET', '/api/produtos')).status, 404, 'o endereço do master não é loja');
  });

  it('só entra com o login do master', async () => {
    assert.equal((await pedir(srv, MASTER, 'GET', '/api/master/lojas')).status, 401);
    assert.equal((await pedir(srv, MASTER, 'POST', '/api/master/login', { json: { user: MASTER_USER, password: 'errada' } })).status, 401);
    assert.equal((await pedir(srv, MASTER, 'POST', '/api/master/login', { json: { user: h.ADMIN_USER, password: h.ADMIN_PASS } })).status, 401, 'o login da loja não abre o master');
    const login = await pedir(srv, MASTER, 'POST', '/api/master/login', { json: { user: MASTER_USER, password: MASTER_PASS } });
    assert.equal(login.status, 200);
    tokenMaster = login.body.token;
    const tokenNix = await h.login(srv);
    assert.equal((await pedir(srv, MASTER, 'GET', '/api/master/lojas', { token: tokenNix })).status, 401, 'o token do admin da loja não abre o master');
    assert.equal((await pedir(srv, NIX, 'GET', '/api/admin/produtos', { token: tokenMaster })).status, 401, 'o token do master não é de admin de loja');
  });

  it('lista a loja das variáveis do Render', async () => {
    const { body } = await pedir(srv, MASTER, 'GET', '/api/master/lojas', { token: tokenMaster });
    assert.equal(body.length, 1);
    assert.equal(body[0].slug, 'nix');
    assert.equal(body[0].origem, 'render');
    assert.equal(body[0].endereco, NIX);
    assert.doesNotMatch(JSON.stringify(body), /postgres:\/\/|postgresql:\/\//, 'connection string não sai');
  });

  it('recusa loja com banco de outra, identificador repetido ou endereço do master', async () => {
    const criar = (corpo) => pedir(srv, MASTER, 'POST', '/api/master/lojas', { token: tokenMaster, json: corpo });
    assert.match((await criar(novaLoja({ banco: h.DATABASE_URL }))).body.error, /já é da loja "nix"/);
    assert.equal((await criar(novaLoja({ slug: 'nix', banco: banco2.href }))).status, 409);
    assert.match((await criar(novaLoja({ dominios: MASTER }))).body.error, /painel master/);
    assert.match((await criar(novaLoja({ dominios: NIX }))).body.error, /Render/);
    assert.match((await criar(novaLoja({ banco: 'postgresql://u:s@127.0.0.1:1/nada' }))).body.error, /Não consegui usar esse banco/);
    assert.equal((await criar(novaLoja({ nicho: 'carros' }))).status, 400);
  });

  let tokenDonatti;

  it('cria a loja e ela já abre no subdomínio, com o tipo e o login escolhidos', async () => {
    const criada = await pedir(srv, MASTER, 'POST', '/api/master/lojas', { token: tokenMaster, json: novaLoja() });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    assert.equal(criada.body.endereco, DONATTI);
    assert.equal(criada.body.nicho, 'roupas');
    assert.equal(criada.body.origem, 'painel');

    const vitrine = await pedir(srv, DONATTI, 'GET', '/');
    assert.equal(vitrine.status, 200);
    assert.match(vitrine.body, /"nome":"Donatti - LOJA"/);
    assert.match(vitrine.body, /"nicho":"roupas"/);
    assert.match((await pedir(srv, NIX, 'GET', '/')).body, /"nicho":"oculos"/, 'a Nix não muda');

    const login = await pedir(srv, DONATTI, 'POST', '/api/admin/login', { json: { user: 'donatti', password: 'senha-da-donatti-1' } });
    assert.equal(login.status, 200);
    tokenDonatti = login.body.token;
    assert.equal((await pedir(srv, NIX, 'POST', '/api/admin/login', { json: { user: 'donatti', password: 'senha-da-donatti-1' } })).status, 401);

    const pool1 = new Pool({ connectionString: banco1.href });
    try {
      assert.equal((await pool1.query(`SELECT valor FROM configuracoes WHERE chave = 'empresa_dona'`)).rows[0].valor, 'donatti');
    } finally {
      await pool1.end();
    }
    const { rows: [linha] } = await h.pool.query('SELECT * FROM master_lojas WHERE slug = $1', ['donatti']);
    assert.doesNotMatch(linha.banco_cifrado, /postgres|localhost|127\.0\.0\.1/, 'banco cifrado no cadastro');
    assert.doesNotMatch(linha.admin_pass_hash, /senha-da-donatti/);
  });

  it('com duas lojas, endereço desconhecido deixa de abrir a Nix', async () => {
    assert.equal((await pedir(srv, 'errado.temcatalogo.com.br', 'GET', '/')).status, 404);
    assert.equal((await pedir(srv, NIX, 'GET', '/')).status, 200);
  });

  it('não deixa outra loja tomar o endereço da Donatti', async () => {
    const res = await pedir(srv, MASTER, 'PUT', '/api/master/lojas/nix', { token: tokenMaster, json: { dominios: `nixglasses.temcatalogo.com.br, ${DONATTI}` } });
    assert.match(res.body.error, /já abre a loja "donatti"/);
    assert.match((await pedir(srv, MASTER, 'PUT', '/api/master/lojas/nix', { token: tokenMaster, json: { banco: banco2.href } })).body.error, /Render/);
    assert.match((await pedir(srv, MASTER, 'PUT', '/api/master/lojas/nix', { token: tokenMaster, json: { ativo: false } })).body.error, /principal/);
  });

  it('dá endereço próprio à Nix sem tirar o do Render', async () => {
    const res = await pedir(srv, MASTER, 'PUT', '/api/master/lojas/nix', { token: tokenMaster, json: { dominios: 'nixglasses.temcatalogo.com.br' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.origem, 'render+painel');
    assert.equal((await pedir(srv, 'nixglasses.temcatalogo.com.br', 'GET', '/api/produtos')).status, 200);
    assert.equal((await pedir(srv, NIX, 'GET', '/api/produtos')).status, 200);
  });

  it('trocar a senha derruba a sessão antiga do admin da loja', async () => {
    assert.equal((await pedir(srv, DONATTI, 'GET', '/api/admin/produtos', { token: tokenDonatti })).status, 200);
    const res = await pedir(srv, MASTER, 'PUT', '/api/master/lojas/donatti', { token: tokenMaster, json: { senha: 'senha-nova-da-donatti' } });
    assert.equal(res.status, 200);
    assert.equal((await pedir(srv, DONATTI, 'GET', '/api/admin/produtos', { token: tokenDonatti })).status, 401);
    assert.equal((await pedir(srv, DONATTI, 'POST', '/api/admin/login', { json: { user: 'donatti', password: 'senha-da-donatti-1' } })).status, 401);
    assert.equal((await pedir(srv, DONATTI, 'POST', '/api/admin/login', { json: { user: 'donatti', password: 'senha-nova-da-donatti' } })).status, 200);
  });

  it('renomeia e troca o tipo da loja no banco dela', async () => {
    const res = await pedir(srv, MASTER, 'PUT', '/api/master/lojas/donatti', { token: tokenMaster, json: { nome: 'Donatti Moda', nicho: 'geral' } });
    assert.equal(res.body.nome, 'Donatti Moda');
    assert.equal(res.body.nicho, 'geral');
    assert.match((await pedir(srv, DONATTI, 'GET', '/')).body, /"nome":"Donatti Moda","marca":"[^"]*","oculos":false,"nicho":"geral"/);
  });

  it('suspende e volta a loja', async () => {
    await pedir(srv, MASTER, 'PUT', '/api/master/lojas/donatti', { token: tokenMaster, json: { ativo: false } });
    const fora = await pedir(srv, DONATTI, 'GET', '/');
    assert.equal(fora.status, 503);
    assert.equal(fora.body, 'Loja temporariamente indisponível.');
    assert.equal((await pedir(srv, DONATTI, 'POST', '/api/admin/login', { json: { user: 'donatti', password: 'senha-nova-da-donatti' } })).status, 503);
    await pedir(srv, MASTER, 'PUT', '/api/master/lojas/donatti', { token: tokenMaster, json: { ativo: true } });
    assert.equal((await pedir(srv, DONATTI, 'GET', '/')).status, 200);
  });

  it('o master entra no painel da loja com um token de 1 hora dela', async () => {
    const res = await pedir(srv, MASTER, 'POST', '/api/master/lojas/donatti/acesso', { token: tokenMaster, json: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.endereco, DONATTI);
    assert.equal((await pedir(srv, DONATTI, 'GET', '/api/admin/produtos', { token: res.body.token })).status, 200);
    assert.equal((await pedir(srv, NIX, 'GET', '/api/admin/produtos', { token: res.body.token })).status, 401);
    const [corpo] = res.body.token.split('.');
    const payload = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    assert.ok(payload.exp - payload.iat <= 3600);
  });

  it('troca o banco da loja por outro vazio', async () => {
    const res = await pedir(srv, MASTER, 'PUT', '/api/master/lojas/donatti', { token: tokenMaster, json: { banco: banco2.href } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.banco, /_master2$/);
  });

  it('as lojas do painel continuam depois de reiniciar o serviço', async () => {
    await srv.parar();
    srv = await h.iniciarServidor({ env });
    assert.match((await pedir(srv, DONATTI, 'GET', '/')).body, /"nome":"Donatti Moda"/);
    assert.equal((await pedir(srv, DONATTI, 'POST', '/api/admin/login', { json: { user: 'donatti', password: 'senha-nova-da-donatti' } })).status, 200);
    assert.equal((await pedir(srv, 'nixglasses.temcatalogo.com.br', 'GET', '/api/produtos')).status, 200);
  });

  it('remove a loja do painel só com a confirmação, sem apagar o banco', async () => {
    const remover = (confirmacao) => pedir(srv, MASTER, 'DELETE', '/api/master/lojas/donatti', { token: tokenMaster, json: { confirmacao } });
    assert.equal((await remover('sim')).status, 400);
    const nix = await pedir(srv, MASTER, 'DELETE', '/api/master/lojas/nix', { token: tokenMaster, json: { confirmacao: 'nix' } });
    assert.match(nix.body.error, /Render/, JSON.stringify(nix));
    assert.equal((await remover('donatti')).status, 200);
    assert.equal((await pedir(srv, DONATTI, 'GET', '/')).status, 404);
    const pool2 = new Pool({ connectionString: banco2.href });
    try {
      assert.equal((await pool2.query(`SELECT valor FROM configuracoes WHERE chave = 'empresa_dona'`)).rows[0].valor, 'donatti');
    } finally {
      await pool2.end();
    }
  });
});

describe('painel master sem login configurado', () => {
  let srv;
  before(async () => { srv = await h.iniciarServidor(); });
  after(async () => { await srv.parar(); });

  it('fica fechado (503)', async () => {
    assert.deepEqual((await (await fetch(srv.url('/api/master/status'))).json()), { habilitado: false });
    assert.equal((await fetch(srv.url('/api/master/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
    assert.equal((await fetch(srv.url('/api/master/lojas'))).status, 503);
  });
});
