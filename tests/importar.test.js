// Importação de produto pelo link do fornecedor: leitura do HTML (JSON-LD,
// meta tags, <title>), download seguro (redirect, gzip, charset, rede interna
// bloqueada) e a rota do painel.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const h = require('./helpers');
const { extrairDadosProduto, extrairEspecificacoes, baixarPagina, importarProduto, lerPrecoTexto, enderecoBloqueado } = require('../importar-produto');

// Página no formato das lojas Nuvemshop/Shopify: JSON-LD Product + Open Graph
const PAGINA_JSONLD = `<!doctype html><html><head>
<title>Óculos Aviador Gold | Clush</title>
<meta property="og:site_name" content="Clush">
<meta property="og:title" content="Óculos Aviador Gold &amp; Lente Verde">
<meta property="og:image" content="/img/aviador.jpg">
<script type="application/ld+json">{ "quebrado": </script>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":"Product","name":"Óculos Aviador Gold","sku":"CL-AV-001","mpn":"AV001","gtin13":"7890000000001","brand":{"@type":"Brand","name":"Clush"},
"image":["https://cdn.clush.com.br/av-1.jpg","https://cdn.clush.com.br/av-2.jpg"],
"offers":[{"@type":"Offer","price":"89.90","priceCurrency":"BRL"},{"@type":"Offer","price":"79.90","priceCurrency":"BRL"}]}]}
</script></head><body></body></html>`;

// Loja sem JSON-LD: só meta tags
const PAGINA_META = `<html><head>
<title>Clubmaster Tartaruga - Ótica Atacado</title>
<meta property='og:site_name' content='Ótica Atacado'>
<meta name="twitter:title" content="Clubmaster Tartaruga">
<meta property="product:price:amount" content="1.234,56">
<meta property="product:retailer_item_id" content="OT-55">
</head><body><span itemprop="price" content="999"></span></body></html>`;

describe('extrairDadosProduto', () => {
  it('lê nome, menor preço, referências e imagens do JSON-LD', () => {
    const d = extrairDadosProduto(PAGINA_JSONLD, 'https://www.clush.com.br/produtos/aviador');
    assert.equal(d.nome, 'Óculos Aviador Gold');
    assert.equal(d.preco_custo, 79.9);
    assert.equal(d.codigo_fornecedor, 'CL-AV-001');
    assert.deepEqual(d.referencias, { sku: 'CL-AV-001', mpn: 'AV001', gtin: '7890000000001', marca: 'Clush' });
    assert.equal(d.fornecedor, 'Clush');
    assert.deepEqual(d.imagens, ['https://cdn.clush.com.br/av-1.jpg', 'https://cdn.clush.com.br/av-2.jpg', 'https://www.clush.com.br/img/aviador.jpg']);
  });

  it('sem JSON-LD, usa as meta tags', () => {
    const d = extrairDadosProduto(PAGINA_META, 'https://atacado.exemplo.com/p/1');
    assert.equal(d.nome, 'Clubmaster Tartaruga');
    assert.equal(d.preco_custo, 1234.56);
    assert.equal(d.codigo_fornecedor, 'OT-55');
    assert.equal(d.fornecedor, 'Ótica Atacado');
  });

  it('sem nada, cai no <title> sem o nome da loja e no domínio', () => {
    const d = extrairDadosProduto('<title>Redondo Preto | Loja X</title><meta property="og:site_name" content="Loja X">', 'https://www.lojax.com/p');
    assert.equal(d.nome, 'Redondo Preto');
    assert.equal(d.preco_custo, null);
    const s = extrairDadosProduto('<title>Só título</title>', 'https://www.lojay.com.br/p');
    assert.equal(s.fornecedor, 'lojay.com.br');
    assert.equal(s.codigo_fornecedor, '');
  });

  it('página da Clush (Nuvemshop): nome fornec., código do link e especificações técnicas da descrição', () => {
    const nome = 'Óculos de Sol Esportivo Máscara Nitro - Multicolors Espelhado - Injetado';
    const pagina = `<title>${nome} - Comprar em Clush</title>
<meta property="og:site_name" content="Clush">
<script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product","name":"${nome}","offers":{"@type":"Offer","price":"39.90","priceCurrency":"BRL"}}</script>
<div class="product-description user-content" data-store="product-description-123">
<p><strong>Especificações Técnicas:</strong></p><ul>
<li>Diâmetro da lente: 6,2 cm</li><li>Ponte: 1 cm</li><li>Largura total: 16 cm</li><li>Material: Injetado</li><li>Formato: Máscara</li>
<li>Proteção: UV400 (100% proteção contra raios UVA e UVB)</li><li>Lente: Resistente a riscos, multicolors espelhada</li>
<li>Haste: Preta fosca</li><li>Tecnologia: Anti-reflexo, lente envolvente espelhada multicolorida</li>
<li>Formatos de rosto recomendados: Oval, redondo, coração e quadrado</li></ul></div>`;
    const d = extrairDadosProduto(pagina, 'https://www.clush.com.br/produtos/oculos-de-sol-esportivo-mascara-nitro-multicolors-espelhado-injetado-djy8z/');
    assert.equal(d.nome_fornecedor, nome);
    assert.equal(d.preco_custo, 39.9);
    assert.equal(d.fornecedor, 'Clush');
    assert.equal(d.codigo_fornecedor, 'DJY8Z');
    assert.equal(d.diametro_cm, 6.2);
    assert.equal(d.ponte_cm, 1);
    assert.equal(d.largura_total_cm, 16);
    assert.equal(d.material, 'Injetado');
    assert.equal(d.formato, 'Máscara');
    assert.equal(d.estilo, 'Esportivo');
    assert.equal(d.tipo, 'UV400');
    assert.equal(d.cor_armacao, 'Multicolors Espelhado, haste preta fosca');
    assert.equal(d.genero, '');
  });

  it('página da Clush com a seção Especificações Técnicas fora da descrição (<strong>Rótulo:</strong> valor)', () => {
    const li = (k, v) => `<li class="ml-4" style="background-color: transparent;"><strong style="background-color: transparent;">${k}:</strong> ${v}</li>`;
    const nome = 'Óculos de Sol Esportivo Turbo 2.0 C1';
    const pagina = `<title>${nome} - Comprar em Clush</title><meta property="og:site_name" content="Clush">
<script type="application/ld+json">{"@type":"Product","name":"${nome}","offers":{"price":"34.90"}}</script>
<div><p class="first:mt-1.5!">Atende diferentes perfis.</p><p class="first:mt-1.5!"><strong>Especificações Técnicas</strong></p><ul class="list-disc">
${li('Modelo', 'Turbo 2.0 C1')}${li('Cor da armação', 'Preto fosco')}${li('Cor da lente', 'Fumê escura')}${li('Estilo', 'Esportivo shield')}
${li('Tamanho', 'Médio-grande')}${li('Diâmetro da lente', '5.6 cm')}${li('Ponte', '1 cm')}${li('Largura total', '14,5 cm')}
${li('Proteção', 'UV400 (100% UVA/UVB)')}${li('Material da lente', 'Policarbonato resistente a riscos')}
${li('Formatos de rosto compatíveis', 'Oval, quadrado, triangular')}${li('Gênero', 'Unissex')}</ul></div>`;
    const d = extrairDadosProduto(pagina, 'https://www.clush.com.br/produtos/oculos-turbo-2-0-c1-ab12c/');
    assert.equal(d.preco_custo, 34.9);
    assert.deepEqual([d.diametro_cm, d.ponte_cm, d.largura_total_cm], [5.6, 1, 14.5]);
    assert.equal(d.cor_armacao, 'Preto fosco, lente fumê escura');
    assert.equal(d.estilo, 'Esportivo shield');
    assert.equal(d.formato, 'Shield'); // não "Oval" dos formatos de rosto
    assert.equal(d.material, ''); // policarbonato é da lente, não da armação
    assert.equal(d.tipo, 'UV400');
    assert.equal(d.genero, 'UNISSEX');
  });

  it('descrição numa linha só (JSON-LD sem quebras): cada rótulo vira uma linha', () => {
    const e = extrairEspecificacoes('Óculos', 'Especificações Técnicas Modelo: Turbo Cor da armação: Preto fosco Cor da lente: Fumê Diâmetro da lente: 5.6 cm Ponte: 1 cm Material: Acetato Gênero: Feminino');
    assert.deepEqual([e.diametro_cm, e.ponte_cm, e.material, e.cor_armacao, e.genero], [5.6, 1, 'Acetato', 'Preto fosco, lente fumê', 'FEMININO']);
  });

  it('especificações em lista numa linha, em mm, polarizado e gênero', () => {
    const e = extrairEspecificacoes('Óculos Aviador Polarizado Masculino', 'Medidas: * Lente: 58mm * Ponte: 18 mm * Largura frontal: 145mm * Material: Metal * Cor: Dourado * Proteção: UV400');
    assert.equal(e.diametro_cm, 5.8);
    assert.equal(e.ponte_cm, 1.8);
    assert.equal(e.largura_total_cm, 14.5);
    assert.equal(e.material, 'Metal');
    assert.equal(e.cor_armacao, 'Dourado');
    assert.equal(e.formato, 'Aviador');
    assert.equal(e.tipo, 'Polarizado UV400');
    assert.equal(e.genero, 'MASCULINO');
    // UV400 não vira medida; sem dados, tudo vazio
    const v = extrairEspecificacoes('Óculos', 'Lente UV400 com proteção total');
    assert.equal(v.diametro_cm, null);
    assert.deepEqual([v.material, v.cor_armacao, v.formato, v.estilo, v.genero], ['', '', '', '', '']);
  });

  it('lê preços em formatos brasileiro e internacional', () => {
    assert.equal(lerPrecoTexto('R$ 1.234,56'), 1234.56);
    assert.equal(lerPrecoTexto('199,90'), 199.9);
    assert.equal(lerPrecoTexto('199.90'), 199.9);
    assert.equal(lerPrecoTexto('1,234.56'), 1234.56);
    assert.equal(lerPrecoTexto('1.234'), 1234);
    assert.equal(lerPrecoTexto(59.9), 59.9);
    assert.equal(lerPrecoTexto('grátis'), null);
    assert.equal(lerPrecoTexto(''), null);
    assert.equal(lerPrecoTexto(-3), null);
  });
});

describe('baixarPagina', () => {
  let loja;
  let base;
  before(async () => {
    loja = http.createServer((req, res) => {
      if (req.url === '/redir') { res.writeHead(302, { Location: '/gzip' }); return res.end(); }
      if (req.url === '/gzip') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip' });
        return res.end(zlib.gzipSync(PAGINA_JSONLD));
      }
      if (req.url === '/latin1') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
        return res.end(Buffer.from('<title>Óculos Ômega</title>', 'latin1'));
      }
      if (req.url === '/grande') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('x'.repeat(5000));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(r => loja.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${loja.address().port}`;
  });
  after(() => new Promise(r => loja.close(r)));

  const local = { permitirRedeLocal: true };

  it('segue redirecionamento e descompacta gzip', async () => {
    const r = await baixarPagina(`${base}/redir`, local);
    assert.equal(r.url, `${base}/gzip`);
    const d = await importarProduto(`${base}/redir#topo`, local);
    assert.equal(d.nome, 'Óculos Aviador Gold');
    assert.equal(d.link_fornecedor, `${base}/redir`);
  });

  it('respeita o charset da página', async () => {
    const r = await baixarPagina(`${base}/latin1`, local);
    assert.match(r.html, /Óculos Ômega/);
  });

  it('recusa página grande demais, erro HTTP e link inválido', async () => {
    await assert.rejects(baixarPagina(`${base}/grande`, { ...local, maxBytes: 1000 }), /grande demais/);
    await assert.rejects(baixarPagina(`${base}/nao-existe`, local), /erro 404/);
    await assert.rejects(baixarPagina('ftp://x.com/a'), (e) => e.status === 400);
    await assert.rejects(baixarPagina('javascript:alert(1)'), (e) => e.status === 400);
  });

  it('nunca acessa a rede interna (nem por IP, nem por nome, nem por redirecionamento)', async () => {
    await assert.rejects(baixarPagina(`${base}/gzip`), (e) => e.status === 400);
    await assert.rejects(baixarPagina(`http://localhost:${loja.address().port}/gzip`), (e) => e.status === 400);
    await assert.rejects(baixarPagina('http://[::1]/'), (e) => e.status === 400);
    await assert.rejects(baixarPagina('http://169.254.169.254/latest/meta-data'), (e) => e.status === 400);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '100.64.0.1']) {
      assert.ok(enderecoBloqueado(ip), ip);
    }
    for (const ip of ['8.8.8.8', '200.147.67.142', '2606:4700::1111']) assert.ok(!enderecoBloqueado(ip), ip);
  });
});

describe('rota POST /api/admin/importar-url', () => {
  let srv;
  let token;
  before(async () => {
    srv = await h.iniciarServidor();
    token = await h.login(srv);
  });
  after(async () => {
    await srv.parar();
    await h.fecharBanco();
  });

  const importar = (body, auth = true) => fetch(srv.url('/api/admin/importar-url'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  it('exige login de admin', async () => {
    assert.equal((await importar({ url: 'https://example.com' }, false)).status, 401);
  });

  it('recusa link inválido e endereço interno com mensagem', async () => {
    for (const url of [undefined, '', 'nada', 'file:///etc/passwd', `${srv.base}/api/admin/status`, 'http://169.254.169.254/']) {
      const res = await importar({ url });
      assert.equal(res.status, 400, String(url));
      assert.ok((await res.json()).error);
    }
  });
});
