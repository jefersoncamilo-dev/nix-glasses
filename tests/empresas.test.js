// Várias empresas num único serviço: cada endereço (Host) tem o seu banco, o seu
// login do admin e os seus dados da loja, sem nada vazar de uma para a outra.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Pool } = require('pg');
const h = require('./helpers');
const { lerEmpresas, empresaDoHost, identidadeBanco } = require('../empresas');
const { PADRAO_NIX, lojaPadrao, limparTextoLoja, montarLoja, renderizarPagina } = require('../loja');

after(h.fecharBanco);

describe('lerEmpresas', () => {
  it('sem EMPRESAS, é a Nix de sempre com DATABASE_URL e ADMIN_*', () => {
    const [nix, ...resto] = lerEmpresas({ DATABASE_URL: 'pg://a', ADMIN_USER: 'u', ADMIN_PASS_HASH: 'h' });
    assert.equal(resto.length, 0);
    assert.deepEqual(
      { slug: nix.slug, padrao: nix.padrao, db: nix.databaseUrl, user: nix.adminUser, hash: nix.adminPassHash },
      { slug: 'nix', padrao: true, db: 'pg://a', user: 'u', hash: 'h' }
    );
  });

  it('lê EMPRESA_<SLUG>_* e só a primeira herda as variáveis antigas', () => {
    const empresas = lerEmpresas({
      EMPRESAS: ' nix , pasuc-portas ',
      DATABASE_URL: 'pg://nix',
      ADMIN_USER: 'nix',
      ADMIN_PASS_HASH: 'hn',
      EMPRESA_PASUC_PORTAS_DATABASE_URL: 'pg://pasuc',
      EMPRESA_PASUC_PORTAS_DOMINIOS: 'Pasuc.TemCatalogo.com.br, www.pasuc.com.br',
      EMPRESA_PASUC_PORTAS_NOME: 'Pasuc Portas',
    });
    assert.deepEqual(empresas.map((e) => e.slug), ['nix', 'pasuc-portas']);
    const pasuc = empresas[1];
    assert.equal(pasuc.padrao, false);
    assert.equal(pasuc.databaseUrl, 'pg://pasuc');
    assert.equal(pasuc.nome, 'Pasuc Portas');
    assert.equal(pasuc.adminUser, '', 'não herda o login da Nix');
    assert.deepEqual(pasuc.dominios, ['pasuc.temcatalogo.com.br', 'www.pasuc.com.br']);
  });

  it('para o boot com nome inválido, repetido, sem banco ou banco de outra empresa', () => {
    assert.throws(() => lerEmpresas({ EMPRESAS: 'Nix Glasses', DATABASE_URL: 'pg://a' }), /inválido/);
    assert.throws(() => lerEmpresas({ EMPRESAS: 'nix,nix', DATABASE_URL: 'pg://a' }), /duas vezes/);
    assert.throws(() => lerEmpresas({ EMPRESAS: 'nix,outra', DATABASE_URL: 'pg://a' }), /EMPRESA_OUTRA_DATABASE_URL/);
    assert.throws(() => lerEmpresas({ EMPRESAS: 'nix,outra', DATABASE_URL: 'pg://a', EMPRESA_OUTRA_DATABASE_URL: 'pg://a' }), /mesmo banco/);
  });

  it('acha o mesmo banco escrito de jeitos diferentes', () => {
    const neon = 'postgresql://u:s@ep-abc-123.us-east-2.aws.neon.tech/neondb?sslmode=require';
    const mesmos = [
      'postgresql://outro:x@EP-ABC-123.us-east-2.aws.neon.tech:5432/neondb',
      'postgresql://u:s@ep-abc-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    ];
    for (const outra of mesmos) {
      assert.equal(identidadeBanco(outra), identidadeBanco(neon), outra);
      assert.throws(() => lerEmpresas({ EMPRESAS: 'nix,outra', DATABASE_URL: neon, EMPRESA_OUTRA_DATABASE_URL: outra }), /mesmo banco da empresa "nix"/);
    }
    assert.equal(identidadeBanco('postgres://a@127.0.0.1/x'), identidadeBanco('postgres://b@localhost:5432/x'));
    assert.notEqual(identidadeBanco(neon), identidadeBanco(neon.replace('/neondb', '/pasuc')));
    assert.notEqual(identidadeBanco(neon), identidadeBanco(neon.replace('ep-abc-123', 'ep-xyz-999')));
  });
});

describe('empresaDoHost', () => {
  const empresas = lerEmpresas({
    EMPRESAS: 'nix,pasucportas,loja',
    DATABASE_URL: 'pg://1',
    EMPRESA_PASUCPORTAS_DATABASE_URL: 'pg://2',
    EMPRESA_LOJA_DATABASE_URL: 'pg://3',
    EMPRESA_LOJA_DOMINIOS: 'minhaloja.com.br',
    RENDER_EXTERNAL_HOSTNAME: 'nix-glasses.onrender.com',
  });
  const slug = (host) => empresaDoHost(empresas, host).slug;

  it('acha pelo subdomínio igual ao nome, sem porta nem maiúsculas', () => {
    assert.equal(slug('pasucportas.temcatalogo.com.br'), 'pasucportas');
    assert.equal(slug('PASUCPORTAS.temcatalogo.com.br:443'), 'pasucportas');
  });

  it('com DOMINIOS, só os domínios listados valem', () => {
    assert.equal(slug('minhaloja.com.br'), 'loja');
    assert.equal(empresaDoHost(empresas, 'loja.temcatalogo.com.br'), null);
  });

  it('o endereço do serviço no Render e os internos ficam com a empresa padrão', () => {
    assert.equal(slug('nix-glasses.onrender.com'), 'nix');
    assert.equal(slug('NIX-GLASSES.onrender.com.'), 'nix');
    assert.equal(slug('localhost'), 'nix');
    assert.equal(slug('10.0.0.5:10000'), 'nix');
    assert.equal(slug(''), 'nix');
  });

  it('com várias empresas, endereço de ninguém não cai na loja padrão', () => {
    assert.equal(empresaDoHost(empresas, 'pasucportasfalso.com'), null);
    assert.equal(empresaDoHost(empresas, 'digitado-errado.temcatalogo.com.br'), null);
    assert.equal(empresaDoHost(empresas, 'outra-loja.onrender.com'), null, 'só o .onrender.com deste serviço');
  });

  it('com uma empresa só, qualquer endereço é dela (como antes)', () => {
    const [nix] = lerEmpresas({ DATABASE_URL: 'pg://1' });
    assert.equal(empresaDoHost([nix], 'www.qualquer.com.br'), nix);
  });
});

describe('dados da loja', () => {
  it('a Nix padrão sai com os textos de hoje; as outras, com textos neutros', () => {
    assert.deepEqual(lojaPadrao({ slug: 'nix', padrao: true, nome: '' }), PADRAO_NIX);
    const pasuc = lojaPadrao({ slug: 'pasuc', padrao: false, nome: 'Pasuc Portas' });
    assert.equal(pasuc.marca, 'PASUC');
    assert.equal(pasuc.complemento, 'Portas');
    assert.equal(pasuc.oculos, false);
    assert.doesNotMatch(JSON.stringify(pasuc), /Nix|óculos|UV400/i);
  });

  it('o salvo no banco vale mais que o padrão', () => {
    const loja = montarLoja({ slug: 'p', padrao: false, nome: 'P' }, [
      { chave: 'loja_nome', valor: 'Outro Nome' },
      { chave: 'loja_oculos', valor: '1' },
      { chave: 'loja_logo', valor: '/imagens/abc' },
    ]);
    assert.equal(loja.nome, 'Outro Nome');
    assert.equal(loja.oculos, true);
    assert.equal(loja.logo, '/imagens/abc');
  });

  it('limpa os textos e mantém os parágrafos do "sobre"', () => {
    assert.equal(limparTextoLoja('nome', '  Pasuc   Portas \n'), 'Pasuc Portas');
    assert.equal(limparTextoLoja('sobre', 'Um\r\ndois\n\n\n  Três  '), 'Um dois\n\nTrês');
    assert.equal(limparTextoLoja('nome', 'x'.repeat(500)).length, 100);
    assert.equal(limparTextoLoja('nome', 5), null);
  });
});

describe('renderizarPagina', () => {
  const paginas = ['index.html', 'admin/index.html', 'admin/login.html', 'admin/acerto.html'];
  const ler = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const semScriptLoja = (html) => html.replace(/  <script>window\.LOJA = .*;<\/script>\n/, '');

  it('com os dados da Nix, as páginas ficam iguais (só ganham window.LOJA)', () => {
    for (const p of paginas) {
      const html = ler(p);
      const out = renderizarPagina(html, PADRAO_NIX);
      assert.match(out, /<script>window\.LOJA = \{"nome":"Nix Glasses","marca":"NIX","oculos":true\};<\/script>/, p);
      assert.equal(semScriptLoja(out), html, p);
    }
  });

  it('troca nome, marca, textos e parágrafos de outra loja', () => {
    const loja = { ...lojaPadrao({ slug: 'p', padrao: false, nome: 'Pasuc Portas' }), sobre: 'Primeiro.\n\nSegundo.' };
    const out = renderizarPagina(ler('index.html'), loja);
    const visivel = semScriptLoja(out).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
    assert.doesNotMatch(visivel, /Nix Glasses|>NIX<|UV400|Fundada/);
    assert.match(out, /<title data-loja="titulo">Pasuc Portas<\/title>/);
    assert.match(out, /alt="PASUC"/);
    assert.match(out, /<div data-loja-paragrafos="sobre"><p class="mb-4" [^>]*>Primeiro\.<\/p><p [^>]*>Segundo\.<\/p><\/div>/);
    const admin = renderizarPagina(ler('admin/login.html'), loja);
    assert.match(admin, /<title data-loja="nome" data-loja-sufixo=" - Login Admin">Pasuc Portas - Login Admin<\/title>/);
  });

  it('escapa o que o admin digita, no HTML e no window.LOJA', () => {
    const loja = { ...PADRAO_NIX, nome: '<img src=x onerror=alert(1)>', marca: '"><b>', sobre: '<script>x</script>' };
    const out = renderizarPagina(ler('index.html'), loja);
    assert.doesNotMatch(out, /<img src=x|"><b>|<script>x/);
    assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(out, /window\.LOJA = \{"nome":"\\u003cimg src=x onerror=alert\(1\)>"/);
  });
});

// Requisição com Host próprio (o fetch do Node não deixa trocar o Host).
function pedir(srv, host, metodo, caminho, { json, token, corpo, headers = {} } = {}) {
  const { port } = new URL(srv.base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: metodo,
      path: caminho,
      headers: {
        Host: host,
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(partes);
        let body = buf.toString('utf8');
        if (/json/.test(res.headers['content-type'] || '')) body = JSON.parse(body);
        resolve({ status: res.statusCode, headers: res.headers, body, buf });
      });
    });
    req.on('error', reject);
    if (json !== undefined) req.end(JSON.stringify(json));
    else req.end(corpo);
  });
}

// Multipart mínimo com um arquivo no campo foto1
function multipartFoto(buf) {
  const fronteira = '----teste' + Date.now();
  const corpo = Buffer.concat([
    Buffer.from(`--${fronteira}\r\nContent-Disposition: form-data; name="foto1"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${fronteira}--\r\n`),
  ]);
  return { corpo, headers: { 'Content-Type': `multipart/form-data; boundary=${fronteira}`, 'Content-Length': corpo.length } };
}

describe('duas empresas no mesmo servidor', () => {
  const NIX = 'nix-glasses.onrender.com';
  const PASUC = 'pasucportas.temcatalogo.com.br';
  const PASUC_USER = 'pasuc-admin';
  const PASUC_PASS = 'senha-da-pasuc-123';
  // Segundo banco no mesmo Postgres dos testes (apagado a cada execução, como o primeiro)
  const url2 = new URL(h.DATABASE_URL);
  const nomeBanco2 = `${url2.pathname.slice(1)}_pasuc`;
  url2.pathname = '/' + nomeBanco2;
  let srv;
  let pool2;

  before(async () => {
    const existe = await h.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [nomeBanco2]);
    if (!existe.rows.length) await h.pool.query(`CREATE DATABASE "${nomeBanco2}"`);
    srv = await h.iniciarServidor({
      env: {
        EMPRESAS: 'nix,pasucportas',
        RENDER_EXTERNAL_HOSTNAME: NIX,
        EMPRESA_PASUCPORTAS_DATABASE_URL: url2.href,
        EMPRESA_PASUCPORTAS_NOME: 'Pasuc Portas',
        EMPRESA_PASUCPORTAS_ADMIN_USER: PASUC_USER,
        EMPRESA_PASUCPORTAS_ADMIN_PASS_HASH: h.hashSenha(PASUC_PASS),
      },
    });
    pool2 = new Pool({ connectionString: url2.href });
    await h.limparBanco();
    await pool2.query('TRUNCATE produtos, compras_fornecedor, imagens, acertos, pedidos, clientes, acessorios, encomendas RESTART IDENTITY');
    await pool2.query(`DELETE FROM configuracoes WHERE chave LIKE 'loja%'`);
    await h.pool.query(`DELETE FROM configuracoes WHERE chave LIKE 'loja%'`);
  });
  after(async () => {
    await srv.parar();
    await pool2.end();
  });

  const loginEm = async (host, user, password) =>
    pedir(srv, host, 'POST', '/api/admin/login', { json: { user, password } });

  let tokenNix;
  let tokenPasuc;

  it('cada empresa entra no painel só com o próprio login', async () => {
    assert.equal((await loginEm(PASUC, h.ADMIN_USER, h.ADMIN_PASS)).status, 401);
    assert.equal((await loginEm(NIX, PASUC_USER, PASUC_PASS)).status, 401);
    tokenNix = (await loginEm(NIX, h.ADMIN_USER, h.ADMIN_PASS)).body.token;
    tokenPasuc = (await loginEm(PASUC, PASUC_USER, PASUC_PASS)).body.token;
    assert.ok(tokenNix && tokenPasuc);
  });

  it('o token de uma empresa não abre o painel da outra', async () => {
    assert.equal((await pedir(srv, PASUC, 'GET', '/api/admin/produtos', { token: tokenNix })).status, 401);
    assert.equal((await pedir(srv, NIX, 'GET', '/api/admin/produtos', { token: tokenPasuc })).status, 401);
    assert.equal((await pedir(srv, PASUC, 'GET', '/api/admin/produtos', { token: tokenPasuc })).status, 200);
  });

  it('produtos, WhatsApp e clientes ficam no banco de cada uma', async () => {
    const criar = await pedir(srv, PASUC, 'POST', '/api/produtos', {
      token: tokenPasuc,
      json: { nome: 'Porta Pivotante', codigo_sku: 'PORTA-1', preco_custo: 900, preco_venda: 1500 },
    });
    assert.equal(criar.status, 201);
    await pedir(srv, PASUC, 'POST', '/api/config/whatsapp', { token: tokenPasuc, json: { whatsapp: '5511988887777' } });

    assert.deepEqual((await pedir(srv, PASUC, 'GET', '/api/produtos')).body.map((p) => p.codigo_sku), ['PORTA-1']);
    assert.deepEqual((await pedir(srv, NIX, 'GET', '/api/produtos')).body, []);
    assert.equal((await pedir(srv, PASUC, 'GET', '/api/config/whatsapp')).body.whatsapp, '5511988887777');
    assert.equal((await pedir(srv, NIX, 'GET', '/api/config/whatsapp')).body.whatsapp, '');
    assert.equal((await pool2.query('SELECT count(*)::int AS n FROM produtos')).rows[0].n, 1);
    assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM produtos')).rows[0].n, 0);

    const cadastro = await pedir(srv, PASUC, 'POST', '/api/clientes/cadastro', { json: { email: 'bia@ex.com', senha: 'senha-boa-123', nome: 'Bia' } });
    assert.equal(cadastro.status, 201);
    assert.equal((await pedir(srv, NIX, 'POST', '/api/clientes/login', { json: { email: 'bia@ex.com', senha: 'senha-boa-123' } })).status, 401);
    assert.equal((await pedir(srv, NIX, 'GET', '/api/clientes/me', { token: cadastro.body.token })).status, 401);
    assert.equal((await pedir(srv, PASUC, 'GET', '/api/clientes/me', { token: cadastro.body.token })).status, 200);
  });

  it('o health check responde em qualquer endereço', async () => {
    const res = await pedir(srv, 'errado.temcatalogo.com.br', 'GET', '/saude');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
  });

  it('o banco guarda de qual empresa ele é', async () => {
    assert.equal((await pool2.query(`SELECT valor FROM configuracoes WHERE chave = 'empresa_dona'`)).rows[0].valor, 'pasucportas');
    assert.equal((await h.pool.query(`SELECT valor FROM configuracoes WHERE chave = 'empresa_dona'`)).rows[0].valor, 'nix');
  });

  it('endereço que não é de nenhuma empresa responde 404, sem dados de ninguém', async () => {
    for (const caminho of ['/', '/api/produtos', '/api/config/whatsapp']) {
      const res = await pedir(srv, 'errado.temcatalogo.com.br', 'GET', caminho);
      assert.equal(res.status, 404, caminho);
      assert.equal(res.body, 'Loja não encontrada neste endereço.');
    }
  });

  it('a vitrine de cada endereço sai com a sua loja', async () => {
    const pasuc = await pedir(srv, PASUC, 'GET', '/');
    assert.equal(pasuc.status, 200);
    assert.match(pasuc.body, /<title data-loja="titulo">Pasuc Portas<\/title>/);
    assert.match(pasuc.body, /"oculos":false/);
    const nix = await pedir(srv, NIX, 'GET', '/');
    assert.match(nix.body, /<title data-loja="titulo">Nix Glasses - Óculos de Sol Premium<\/title>/);
    assert.equal((await pedir(srv, PASUC, 'GET', '/admin/')).status, 200);
    assert.match((await pedir(srv, PASUC, 'GET', '/admin/login.html')).body, /Pasuc Portas - Login Admin/);
  });

  it('logo e ícones: a Nix usa os do repositório, a outra só a logo que enviar', async () => {
    assert.equal((await pedir(srv, NIX, 'GET', '/logo.png')).status, 200);
    assert.equal((await pedir(srv, NIX, 'GET', '/favicon.ico')).status, 200);
    assert.equal((await pedir(srv, PASUC, 'GET', '/logo.png')).status, 404);
    assert.equal((await pedir(srv, PASUC, 'GET', '/favicon.ico')).status, 404);

    const { corpo, headers } = multipartFoto(h.PNG_1x1);
    const envio = await pedir(srv, PASUC, 'POST', '/api/admin/loja/logo', { token: tokenPasuc, corpo, headers });
    assert.equal(envio.status, 200);
    assert.match(envio.body.logo, /^\/imagens\/[0-9a-f]{32}$/);
    const logo = await pedir(srv, PASUC, 'GET', '/logo.png');
    assert.equal(logo.status, 302);
    assert.equal(logo.headers.location, envio.body.logo);
    assert.equal((await pedir(srv, PASUC, 'GET', envio.body.logo)).status, 200);
    assert.equal((await pedir(srv, NIX, 'GET', envio.body.logo)).status, 404, 'a foto fica no banco da Pasuc');
    assert.equal((await pedir(srv, NIX, 'GET', '/logo.png')).status, 200);

    const remover = await pedir(srv, PASUC, 'DELETE', '/api/admin/loja/logo', { token: tokenPasuc });
    assert.equal(remover.body.logo, '');
    assert.equal((await pedir(srv, PASUC, 'GET', envio.body.logo)).status, 404, 'a imagem antiga é apagada');
    assert.equal((await pedir(srv, PASUC, 'GET', '/logo.png')).status, 404);
  });

  it('o admin troca os dados da loja e a vitrine muda na hora', async () => {
    assert.equal((await pedir(srv, PASUC, 'PUT', '/api/admin/loja', { json: { nome: 'X' } })).status, 401);
    assert.equal((await pedir(srv, PASUC, 'PUT', '/api/admin/loja', { token: tokenPasuc, json: { oculos: 'sim' } })).status, 400);
    assert.equal((await pedir(srv, PASUC, 'PUT', '/api/admin/loja', { token: tokenPasuc, json: { nome: 7 } })).status, 400);

    const salvo = await pedir(srv, PASUC, 'PUT', '/api/admin/loja', {
      token: tokenPasuc,
      json: { nome: 'Pasuc Portas & Janelas', chamada: 'Portas sob medida', oculos: true },
    });
    assert.equal(salvo.status, 200);
    assert.equal(salvo.body.nome, 'Pasuc Portas & Janelas');
    assert.equal(salvo.body.oculos, true);
    const pagina = (await pedir(srv, PASUC, 'GET', '/')).body;
    assert.match(pagina, /<h1 data-loja="chamada"[^>]*>Portas sob medida<\/h1>/);
    assert.match(pagina, /Pasuc Portas &amp; Janelas/);
    assert.equal((await pedir(srv, PASUC, 'GET', '/api/admin/loja', { token: tokenPasuc })).body.chamada, 'Portas sob medida');

    // Vazio volta ao padrão; a Nix não muda
    const limpo = await pedir(srv, PASUC, 'PUT', '/api/admin/loja', { token: tokenPasuc, json: { chamada: '' } });
    assert.equal(limpo.body.chamada, 'Escolha seus favoritos');
    assert.equal((await pedir(srv, NIX, 'GET', '/api/admin/loja', { token: tokenNix })).body.nome, 'Nix Glasses');
  });
});

describe('mesmo banco com connection strings diferentes', () => {
  it('o servidor não sobe quando o banco já é de outra empresa', async () => {
    // Mesmo banco dos testes, escrito com outro host (127.0.0.1 em vez de localhost, ou o
    // contrário) e com um parâmetro a mais: a URL não denuncia, a marca no banco sim.
    const outra = new URL(h.DATABASE_URL);
    outra.hostname = outra.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    outra.searchParams.set('application_name', 'outra');
    await h.pool.query(`INSERT INTO configuracoes (chave, valor) VALUES ('empresa_dona', 'nix') ON CONFLICT DO NOTHING`);
    await assert.rejects(
      h.iniciarServidor({
        env: { EMPRESAS: 'outra', DATABASE_URL: '', EMPRESA_OUTRA_DATABASE_URL: outra.href },
      }),
      /já é da empresa "nix"/
    );
  });
});
