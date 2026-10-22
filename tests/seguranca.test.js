// Regressões das correções de segurança da auditoria (PRs #1 e #2).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('./helpers');

after(h.fecharBanco);

describe('arquivos estáticos', () => {
  let srv;
  before(async () => { srv = await h.iniciarServidor(); });
  after(async () => { await srv.parar(); });

  it('serve a vitrine e as páginas do admin', async () => {
    for (const p of ['/', '/index.html', '/admin/login.html', '/admin/index.html', '/admin/acerto.html']) {
      const res = await fetch(srv.url(p));
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type'), /text\/html/, p);
    }
  });

  it('nunca expõe código-fonte, configuração nem dependências', async () => {
    const proibidos = [
      '/server.js',
      '/db.js',
      '/empresas.js',
      '/loja.js',
      '/master.js',
      '/master/index.html',
      '/package.json',
      '/package-lock.json',
      '/.env',
      '/.env.example',
      '/render.yaml',
      '/.gitignore',
      '/node_modules/express/package.json',
      '/scripts/generate-admin-hash.js',
      '/.git/config',
      '/uploads/../server.js',
      '/%2e%2e/server.js',
      '/admin/../server.js',
    ];
    for (const p of proibidos) {
      const res = await fetch(srv.url(p));
      const corpo = await res.text();
      assert.notEqual(res.status, 200, `${p} respondeu 200`);
      assert.doesNotMatch(corpo, /require\(|DATABASE_URL|"dependencies"/, `${p} vazou conteúdo`);
    }
  });
});

describe('admin sem credenciais configuradas', () => {
  let srv;
  before(async () => { srv = await h.iniciarServidor({ comAdmin: false }); });
  after(async () => { await srv.parar(); });

  it('informa que o login está desligado', async () => {
    const res = await fetch(srv.url('/api/admin/status'));
    assert.deepEqual(await res.json(), { authEnabled: false });
  });

  it('fecha as rotas admin (503), mesmo com token assinado', async () => {
    const token = h.tokenForjado({ u: 'qualquer', exp: Math.floor(Date.now() / 1000) + 3600 });
    const rotas = [
      ['GET', '/api/admin/produtos'],
      ['GET', '/api/admin/metrics'],
      ['POST', '/api/produtos'],
      ['PUT', '/api/produtos/1'],
      ['POST', '/api/admin/acerto'],
      ['GET', '/api/admin/acertos'],
      ['POST', '/api/config/whatsapp'],
    ];
    for (const [method, p] of rotas) {
      for (const headers of [{}, { Authorization: `Bearer ${token}` }]) {
        const res = await fetch(srv.url(p), { method, headers });
        assert.equal(res.status, 503, `${method} ${p}`);
      }
    }
  });

  it('recusa login', async () => {
    const res = await fetch(srv.url('/api/admin/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: '', password: '' }),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).token, undefined);
  });
});

describe('login e token do admin', () => {
  let srv;
  before(async () => { srv = await h.iniciarServidor(); });
  after(async () => { await srv.parar(); });

  const tentar = (body) =>
    fetch(srv.url('/api/admin/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('aceita usuário e senha corretos e o token abre as rotas admin', async () => {
    const res = await tentar({ user: h.ADMIN_USER, password: h.ADMIN_PASS });
    assert.equal(res.status, 200);
    const { token, user } = await res.json();
    assert.equal(user, h.ADMIN_USER);
    const lista = await fetch(srv.url('/api/admin/produtos'), { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(lista.status, 200);
  });

  it('aceita os nomes de campo alternativos (username/pass)', async () => {
    const res = await tentar({ username: h.ADMIN_USER, pass: h.ADMIN_PASS });
    assert.equal(res.status, 200);
  });

  it('recusa senha errada, usuário errado e corpo vazio com a mesma mensagem', async () => {
    for (const body of [
      { user: h.ADMIN_USER, password: 'errada' },
      { user: 'outro', password: h.ADMIN_PASS },
      {},
    ]) {
      const res = await tentar(body);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'Usuário ou senha inválidos' });
    }
  });

  it('exige token nas rotas admin', async () => {
    const res = await fetch(srv.url('/api/admin/produtos'));
    assert.equal(res.status, 401);
  });

  it('recusa token malformado, adulterado, com segredo errado ou expirado', async () => {
    const valido = await h.login(srv);
    const [body, sig] = valido.split('.');
    const agora = Math.floor(Date.now() / 1000);
    const ruins = [
      'abc',
      `${body}.`,
      `${body}.${'0'.repeat(sig.length)}`,
      `${Buffer.from(JSON.stringify({ u: 'x', exp: agora + 3600 })).toString('base64url')}.${sig}`,
      h.tokenForjado({ u: h.ADMIN_USER, exp: agora + 3600 }, 'outro-segredo'),
      h.tokenForjado({ u: h.ADMIN_USER, exp: agora - 1 }),
      h.tokenForjado({ u: h.ADMIN_USER }),
    ];
    for (const t of ruins) {
      const res = await fetch(srv.url('/api/admin/produtos'), { headers: { Authorization: `Bearer ${t}` } });
      assert.equal(res.status, 401, t);
    }
    const semBearer = await fetch(srv.url('/api/admin/produtos'), { headers: { Authorization: valido } });
    assert.equal(semBearer.status, 401);
  });
});

describe('upload de imagens', () => {
  let srv;
  let token;
  before(async () => {
    srv = await h.iniciarServidor();
    token = await h.login(srv);
  });
  beforeEach(h.limparBanco);
  after(async () => {
    await h.limparBanco();
    await srv.parar();
  });

  let seq = 0;
  function enviar(arquivo, nome, tipo) {
    const form = new FormData();
    form.append('nome', 'Óculos teste');
    form.append('codigo_sku', `UP-${++seq}`);
    form.append('preco_custo', '10');
    form.append('preco_venda', '20');
    if (arquivo) form.append('imagem', new Blob([arquivo], { type: tipo }), nome);
    return fetch(srv.url('/api/produtos'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  }

  it('aceita PNG e a imagem fica acessível pela URL salva', async () => {
    const res = await enviar(h.PNG_1x1, 'foto.png', 'image/png');
    assert.equal(res.status, 201);
    const { imagem_url } = await res.json();
    assert.equal(typeof imagem_url, 'string');
    const img = await fetch(new URL(imagem_url, srv.base));
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type'), /image\/png/);
  });

  it('a extensão vem do tipo validado, não do nome enviado', async () => {
    const res = await enviar(h.PNG_1x1, 'ataque.html', 'image/png');
    assert.equal(res.status, 201);
    const { imagem_url } = await res.json();
    assert.doesNotMatch(imagem_url, /\.html$/);
    const img = await fetch(new URL(imagem_url, srv.base));
    assert.doesNotMatch(img.headers.get('content-type'), /html/);
  });

  it('recusa SVG, HTML e outros formatos sem gravar o produto', async () => {
    for (const [nome, tipo] of [
      ['x.svg', 'image/svg+xml'],
      ['x.html', 'text/html'],
      ['x.gif', 'image/gif'],
      ['x.pdf', 'application/pdf'],
    ]) {
      const res = await enviar(Buffer.from('<svg onload="alert(1)"/>'), nome, tipo);
      assert.equal(res.status, 400, tipo);
      assert.match((await res.json()).error, /Formato de imagem/);
    }
    const { rows } = await h.pool.query('SELECT COUNT(*)::int AS n FROM produtos');
    assert.equal(rows[0].n, 0);
  });

  it('recusa arquivo que diz ser PNG mas não é imagem', async () => {
    const res = await enviar(Buffer.from('<html><script>alert(1)</script></html>'), 'foto.png', 'image/png');
    assert.equal(res.status, 400);
    const { rows } = await h.pool.query('SELECT (SELECT COUNT(*) FROM produtos)::int AS p, (SELECT COUNT(*) FROM imagens)::int AS i');
    assert.deepEqual(rows[0], { p: 0, i: 0 });
  });

  it('a foto fica no banco e sobrevive a um restart do servidor', async () => {
    const res = await enviar(h.PNG_1x1, 'foto.png', 'image/png');
    const { imagem_url } = await res.json();
    assert.match(imagem_url, /^\/imagens\/[0-9a-f]{32}$/);
    await srv.parar();
    srv = await h.iniciarServidor();
    token = await h.login(srv);
    const img = await fetch(new URL(imagem_url, srv.base));
    assert.equal(img.status, 200);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), h.PNG_1x1);
  });

  it('trocar a foto apaga a antiga; editar sem foto mantém a atual', async () => {
    const criado = await (await enviar(h.PNG_1x1, 'a.png', 'image/png')).json();
    const editar = (form) => fetch(srv.url(`/api/produtos/${criado.id}`), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    const comFoto = new FormData();
    comFoto.append('imagem', new Blob([h.PNG_1x1], { type: 'image/png' }), 'b.png');
    const { imagem_url: nova } = await (await editar(comFoto)).json();
    assert.notEqual(nova, criado.imagem_url);
    assert.equal((await fetch(new URL(criado.imagem_url, srv.base))).status, 404);

    const semFoto = new FormData();
    semFoto.append('nome', 'Outro nome');
    const atualizado = await (await editar(semFoto)).json();
    assert.equal(atualizado.imagem_url, nova);
    const { rows } = await h.pool.query('SELECT COUNT(*)::int AS n FROM imagens');
    assert.equal(rows[0].n, 1);
  });

  it('recusa imagem acima de 8 MB', async () => {
    const res = await enviar(Buffer.alloc(8 * 1024 * 1024 + 1), 'grande.jpg', 'image/jpeg');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /muito grande/);
  });

  it('recusa mais de um arquivo', async () => {
    const form = new FormData();
    form.append('nome', 'x');
    form.append('codigo_sku', 'MULTI');
    form.append('imagem', new Blob([h.PNG_1x1], { type: 'image/png' }), 'a.png');
    form.append('imagem', new Blob([h.PNG_1x1], { type: 'image/png' }), 'b.png');
    const res = await fetch(srv.url('/api/produtos'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.equal(res.status, 400);
  });

  it('exige login para subir imagem', async () => {
    const form = new FormData();
    form.append('imagem', new Blob([h.PNG_1x1], { type: 'image/png' }), 'a.png');
    const res = await fetch(srv.url('/api/produtos'), { method: 'POST', body: form });
    assert.equal(res.status, 401);
  });
});

// O redirecionamento pós-login roda no navegador; testamos a função safeNext
// do próprio login.html para não regredir no XSS via ?next=javascript:...
describe('login.html: parâmetro next', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'login.html'), 'utf8');
  const fonte = html.match(/function safeNext\(next\) \{[\s\S]*?\n    \}/);
  const ctx = { window: { location: { origin: 'https://nix.example' } }, URL };
  vm.runInNewContext(`${fonte[0]}; this.safeNext = safeNext;`, ctx);

  it('mantém destinos relativos do próprio site', () => {
    assert.equal(ctx.safeNext('/admin/acerto.html'), '/admin/acerto.html');
    assert.equal(ctx.safeNext('/admin/index.html?aba=2#x'), '/admin/index.html?aba=2#x');
  });

  it('troca qualquer outro destino pelo painel', () => {
    for (const next of [
      null,
      '',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://evil.com',
      '//evil.com',
      '/\\evil.com',
      'admin/index.html',
    ]) {
      assert.equal(ctx.safeNext(next), './index.html', String(next));
    }
  });
});
