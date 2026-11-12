// Rastreamento: GTM na vitrine, origem do pedido (UTMs), dataLayer com event_id e a
// API de Conversões da Meta no servidor (com uma Graph API falsa, local).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const h = require('./helpers');
const r = require('../rastreamento');
const v = require('../rastreamento-vitrine');
const { renderizarPagina, PADRAO_NIX, montarLoja } = require('../loja');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const ler = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function storageFalso() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, val) => m.set(k, String(val)), removeItem: (k) => m.delete(k), m };
}

describe('rastreamento.js: configuração e hash', () => {
  it('valida GTM, Pixel, token e código de teste', () => {
    assert.equal(r.lerIdGtm(' gtm-abc1234 '), 'GTM-ABC1234');
    assert.equal(r.lerIdGtm(''), '');
    assert.equal(r.lerIdGtm('GTM-1\'></script>'), null);
    assert.equal(r.lerIdGtm('UA-123'), null);
    assert.equal(r.lerPixelId('123456789012345'), '123456789012345');
    assert.equal(r.lerPixelId('12a'), null);
    assert.equal(r.lerTokenCapi('EAAB' + 'x'.repeat(40)), 'EAAB' + 'x'.repeat(40));
    assert.equal(r.lerTokenCapi('curto'), null);
    assert.equal(r.lerCodigoTeste('test123'), 'TEST123');
  });

  it('telefone ganha o 55; e-mail, nome, cidade e CEP vão em SHA-256 normalizados', () => {
    assert.equal(r.normalizarTelefone('(11) 98888-7777'), '5511988887777');
    assert.equal(r.normalizarTelefone('+55 11 98888-7777'), '5511988887777');
    assert.equal(r.normalizarTelefone('123'), '');
    const u = r.montarUserData({
      email: ' Ana@Email.com ', telefone: '(11) 98888-7777', nome: 'Ana Lúcia Souza', cidade: 'São Paulo/SP', cep: '01310-100',
      externalId: 'abc', ip: '200.1.2.3', userAgent: 'UA', fbp: 'fb.1.1700000000000.123', fbc: '',
    });
    assert.deepEqual(u.em, [sha('ana@email.com')]);
    assert.deepEqual(u.ph, [sha('5511988887777')]);
    assert.deepEqual(u.fn, [sha('ana')]);
    assert.deepEqual(u.ln, [sha('souza')]);
    assert.deepEqual(u.ct, [sha('saopaulo')]);
    assert.deepEqual(u.st, [sha('sp')]);
    assert.deepEqual(u.zp, [sha('01310100')]);
    assert.deepEqual(u.country, [sha('br')]);
    assert.deepEqual(u.external_id, [sha('abc')]);
    assert.equal(u.client_ip_address, '200.1.2.3', 'IP vai sem hash (a Meta pede assim)');
    assert.equal(u.client_user_agent, 'UA');
    assert.equal(u.fbp, 'fb.1.1700000000000.123');
    assert.equal(u.fbc, undefined, 'vazio fica de fora');
    assert.doesNotMatch(JSON.stringify(u), /ana@email|98888|Souza/i);
  });

  it('origem só com campos conhecidos e sem query na página de entrada', () => {
    const o = r.lerRastreamento({
      origem: { utm_source: 'instagram', utm_campaign: 'verao', lixo: 'x', landing_page: 'https://loja.com/?email=a@b.c', fbclid: 'IwAR1' },
      event_id: 'abc12345-ok', fbp: 'fb.1.1700000000000.99', fbc: 'invalido',
    });
    assert.deepEqual(o, { utm_source: 'instagram', utm_campaign: 'verao', fbclid: 'IwAR1', landing_page: 'https://loja.com/', event_id: 'abc12345-ok', fbp: 'fb.1.1700000000000.99' });
    assert.deepEqual(r.lerRastreamento('lixo'), {});
  });

  it('enviarEventosMeta: sem configuração não chama nada; token vai no corpo, nunca na URL', async () => {
    let chamada = null;
    const fetchImpl = async (url, opts) => { chamada = { url, opts }; return { ok: true, status: 200 }; };
    assert.equal((await r.enviarEventosMeta(null, [{}], { fetchImpl })).enviado, false);
    assert.equal(chamada, null);
    const out = await r.enviarEventosMeta({ pixel_id: '123456789', token: 'TOKEN-SECRETO', test_code: 'TEST1' }, [{ event_name: 'Lead' }], { fetchImpl });
    assert.equal(out.enviado, true);
    assert.match(chamada.url, /\/v\d+\.0\/123456789\/events$/);
    assert.doesNotMatch(chamada.url, /TOKEN/);
    const corpo = JSON.parse(chamada.opts.body);
    assert.equal(corpo.access_token, 'TOKEN-SECRETO');
    assert.equal(corpo.test_event_code, 'TEST1');
  });
});

describe('vitrine: GTM só com ID e só na vitrine', () => {
  const index = ler('index.html');
  it('sem ID nada do GTM; com ID o script no <head> e o noscript depois do <body>', () => {
    assert.doesNotMatch(renderizarPagina(index, PADRAO_NIX), /googletagmanager/);
    const out = renderizarPagina(index, { ...PADRAO_NIX, gtm_id: 'GTM-ABC1234' });
    const head = out.slice(0, out.indexOf('</head>'));
    assert.match(head, /^<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n  <!-- Google Tag Manager -->\n  <script>\(function\(w,d,s,l,i\)/);
    assert.match(head, /'dataLayer','GTM-ABC1234'\);<\/script>/);
    assert.match(out, /<body[^>]*>\n  <!-- Google Tag Manager \(noscript\) -->\n  <noscript><iframe src="https:\/\/www\.googletagmanager\.com\/ns\.html\?id=GTM-ABC1234"/);
    assert.match(out, /<script src="\/rastreamento-vitrine\.js"><\/script>/);
  });
  it('ID inválido não entra e o painel nunca leva GTM', () => {
    assert.doesNotMatch(renderizarPagina(index, { ...PADRAO_NIX, gtm_id: "GTM-X'};alert(1)//" }), /googletagmanager|alert\(1\)/);
    assert.doesNotMatch(renderizarPagina(ler('admin/index.html'), { ...PADRAO_NIX, gtm_id: 'GTM-ABC1234' }), /googletagmanager/);
  });
  it('montarLoja: capi_ativo só com Pixel e token; o token nunca fica no objeto da loja', () => {
    const nix = { slug: 'nix', padrao: true };
    const loja = montarLoja(nix, [{ chave: 'loja_meta_pixel', valor: '123456789' }, { chave: 'meta_capi_token', valor: 'v1:cifrado' }, { chave: 'loja_gtm_id', valor: 'GTM-ABCD12' }]);
    assert.equal(loja.capi_ativo, true);
    assert.equal(loja.gtm_id, 'GTM-ABCD12');
    assert.doesNotMatch(JSON.stringify(loja), /cifrado/);
    assert.equal(montarLoja(nix, [{ chave: 'meta_capi_token', valor: 'v1:x' }]).capi_ativo, false);
    assert.match(renderizarPagina(ler('index.html'), loja), /"capi":true\}/);
  });
});

describe('rastreamento-vitrine.js', () => {
  it('guarda as UTMs da URL, mantém sem UTM e esquece depois de 30 dias', () => {
    const s = storageFalso();
    const agora = new Date('2026-11-01T12:00:00Z');
    const o = v.capturarOrigem(s, 'https://loja.com/?utm_source=instagram&utm_medium=cpc&utm_campaign=verao&fbclid=IwAR9&x=1', 'https://l.instagram.com/x?y', agora);
    assert.deepEqual(o, { utm_source: 'instagram', utm_medium: 'cpc', utm_campaign: 'verao', fbclid: 'IwAR9', landing_page: 'https://loja.com/', referrer: 'https://l.instagram.com/x', capturado_em: agora.toISOString() });
    assert.equal(v.capturarOrigem(s, 'https://loja.com/', '', new Date('2026-11-05T12:00:00Z')).utm_source, 'instagram');
    assert.equal(v.capturarOrigem(s, 'https://loja.com/?utm_source=google', '', new Date('2026-11-06T12:00:00Z')).utm_source, 'google', 'último clique');
    assert.deepEqual(v.capturarOrigem(s, 'https://loja.com/', '', new Date('2026-12-30T12:00:00Z')), {});
  });

  it('_fbc vem do cookie ou é montado com o fbclid', () => {
    assert.deepEqual(v.idsMeta('_fbp=fb.1.1.2; _fbc=fb.1.3.abc', {}), { fbp: 'fb.1.1.2', fbc: 'fb.1.3.abc' });
    assert.equal(v.idsMeta('', { fbclid: 'IwAR9', capturado_em: '2026-11-01T12:00:00.000Z' }).fbc, 'fb.1.1793534400000.IwAR9');
  });

  it('evento no formato do GA4 com event_id e valor somado em centavos', () => {
    const itens = [v.itemGa4({ id: 1, codigo_sku: 'NIX-1', nome: 'Rex', preco: 199.9, tipo: 'Sol' }), v.itemGa4({ id: 2, sku: 'NIX-2', nome: 'Duo', preco: 0.1 })];
    const ev = v.montarEventoDataLayer('add_to_cart', itens, { eventId: 'ev-12345678', origem: { utm_source: 'ig', landing_page: 'x' } });
    assert.equal(ev.event, 'add_to_cart');
    assert.equal(ev.event_id, 'ev-12345678');
    assert.equal(ev.ecommerce.currency, 'BRL');
    assert.equal(ev.ecommerce.value, 200);
    assert.deepEqual(ev.ecommerce.items[0], { item_id: 'NIX-1', item_name: 'Rex', price: 199.9, quantity: 1, item_category: 'Sol' });
    assert.deepEqual(ev.traffic, { utm_source: 'ig' });
  });

  it('lembrar meus dados: guarda token e contato; desmarcado guarda só o token', () => {
    const s = storageFalso();
    v.salvarDados(s, 'a'.repeat(24), { nome: 'Ana', telefone: '11999990000', email: 'ana@x.com', senha: 'nao' });
    assert.deepEqual(v.dadosSalvos(s), { visitante: 'a'.repeat(24), contato: { nome: 'Ana', telefone: '11999990000', email: 'ana@x.com' } });
    v.salvarDados(s, 'a'.repeat(24), { nome: 'Ana' }, false);
    assert.deepEqual(v.dadosSalvos(s), { visitante: 'a'.repeat(24), contato: {} });
    s.setItem('nix_meus_dados', '{quebrado');
    assert.deepEqual(v.dadosSalvos(s), { visitante: '', contato: {} });
  });

  it('user_data do dataLayer só em SHA-256', async () => {
    const u = await v.userDataComHash({ email: ' Ana@X.com', telefone: '(11) 99999-0000' }, globalThis.crypto);
    assert.deepEqual(u, { sha256_email_address: sha('ana@x.com'), sha256_phone_number: sha('5511999990000') });
  });

  it('index.html dispara os eventos nos gatilhos certos', () => {
    const index = ler('index.html');
    assert.match(index, /detalhes = \{ id: produtoId[^\n]*\n\s*rastrear\('view_item', \[produto\]\);/);
    assert.match(index, /rastrear\(index < 0 \? 'add_to_cart' : 'remove_from_cart', \[produto\]\);/);
    assert.match(index, /NixRastreamento\.iniciarCheckout\(maleta\.itens\.map\(produtoParaRastreio\)\)/);
    // O pedido é gravado (fetch) antes dos eventos de conversão e do WhatsApp
    const fim = index.slice(index.indexOf("finalizarPedido.addEventListener('click'"));
    const iFetch = fim.indexOf("fetch('/api/maleta/checkout'");
    const iEvento = fim.indexOf('R.pedidoEnviado(');
    const iWhats = fim.indexOf('window.open(url');
    assert.ok(iFetch > 0 && iFetch < iEvento && iEvento < iWhats);
    assert.match(fim, /rastreamento: rastro, visitante/);
  });
});

describe('API: rastreamento e Conversions API', () => {
  let srv;
  let meta;
  let recebidos = [];
  let tokenAdmin;
  const TOKEN = 'EAAG' + 'segredoDaMeta'.repeat(4);

  before(async () => {
    meta = http.createServer((req, res) => {
      let corpo = '';
      req.on('data', (c) => { corpo += c; });
      req.on('end', () => {
        recebidos.push({ url: req.url, corpo: JSON.parse(corpo) });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"events_received":1}');
      });
    });
    await new Promise((ok) => meta.listen(0, '127.0.0.1', ok));
    srv = await h.iniciarServidor({ env: { META_GRAPH_URL: `http://127.0.0.1:${meta.address().port}` } });
    tokenAdmin = await h.login(srv);
  });
  beforeEach(async () => {
    await h.limparBanco();
    await h.pool.query(`DELETE FROM configuracoes WHERE chave IN ('loja_gtm_id', 'loja_meta_pixel', 'meta_capi_token', 'meta_capi_teste')`);
    recebidos = [];
  });
  after(async () => {
    await h.pool.query(`DELETE FROM configuracoes WHERE chave IN ('loja_gtm_id', 'loja_meta_pixel', 'meta_capi_token', 'meta_capi_teste')`);
    await srv.parar();
    await new Promise((ok) => meta.close(ok));
  });

  async function api(method, p, { body, token = tokenAdmin, headers: extra = {} } = {}) {
    const headers = { ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const texto = await res.text();
    return { status: res.status, body: texto ? JSON.parse(texto) : null };
  }
  async function criarProduto(sku, preco, disponibilidade = 'PRONTA_ENTREGA') {
    const form = new FormData();
    for (const [k, val] of Object.entries({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: 10, preco_venda: preco, disponibilidade })) form.append(k, String(val));
    const res = await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${tokenAdmin}` }, body: form });
    return (await res.json()).id;
  }
  const esperar = async (cond) => {
    for (let i = 0; i < 50 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 40));
  };

  it('painel salva GTM/Pixel/token; o token sai cifrado no banco e nunca volta', async () => {
    assert.equal((await api('GET', '/api/admin/rastreamento', { token: null })).status, 401);
    assert.equal((await api('PUT', '/api/admin/rastreamento', { body: { gtm_id: 'xx' } })).status, 400);
    assert.equal((await api('PUT', '/api/admin/rastreamento', { body: { meta_pixel_id: 'abc' } })).status, 400);
    assert.equal((await api('PUT', '/api/admin/rastreamento', { body: { capi_token: 'curto' } })).status, 400);
    const r1 = await api('PUT', '/api/admin/rastreamento', { body: { gtm_id: 'gtm-abc1234', meta_pixel_id: '123456789012345', capi_token: TOKEN } });
    assert.equal(r1.status, 200);
    assert.deepEqual({ ...r1.body, graph_version: 'x' }, { gtm_id: 'GTM-ABC1234', meta_pixel_id: '123456789012345', capi_token_configurado: true, capi_ativo: true, meta_test_code: '', graph_version: 'x' });
    assert.doesNotMatch(JSON.stringify(r1.body), /segredoDaMeta/);
    const salvo = (await h.pool.query(`SELECT valor FROM configuracoes WHERE chave = 'meta_capi_token'`)).rows[0].valor;
    assert.match(salvo, /^v1:/);
    assert.doesNotMatch(salvo, /segredoDaMeta/);
    // Nem a vitrine nem os dados da loja levam o token
    const pagina = await (await fetch(srv.url('/'))).text();
    assert.doesNotMatch(pagina, /segredoDaMeta|v1:/);
    assert.match(pagina, /'dataLayer','GTM-ABC1234'/);
    assert.match(pagina, /"capi":true\}/);
    assert.doesNotMatch(JSON.stringify((await api('GET', '/api/admin/loja')).body), /segredoDaMeta|v1:/);
    // Salvar sem token mantém; remover desliga
    assert.equal((await api('PUT', '/api/admin/rastreamento', { body: { gtm_id: '' } })).body.capi_ativo, true);
    const sem = await api('PUT', '/api/admin/rastreamento', { body: { remover_capi_token: true } });
    assert.equal(sem.body.capi_ativo, false);
    assert.equal(sem.body.capi_token_configurado, false);
    assert.doesNotMatch(await (await fetch(srv.url('/'))).text(), /googletagmanager/);
  });

  it('sem CAPI configurada, o pedido grava a origem e nada vai para a Meta', async () => {
    const a = await criarProduto('NIX-A', 100);
    const r1 = await api('POST', '/api/maleta/checkout', {
      token: null,
      body: { itens: [{ id: a }], contato: { nome: 'Ana', telefone: '11999990000', email: 'Ana@Email.com' },
        rastreamento: { origem: { utm_source: 'instagram', utm_campaign: 'verao' }, event_id: 'evento-0001' } },
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.event_id, 'evento-0001');
    assert.match(r1.body.visitante, /^[A-Za-z0-9_-]{22,64}$/);
    const ped = (await h.pool.query('SELECT email, rastreamento, visitante_token FROM pedidos')).rows[0];
    assert.equal(ped.email, 'ana@email.com', 'e-mail digitado na maleta (sem conta)');
    assert.deepEqual(ped.rastreamento, { utm_source: 'instagram', utm_campaign: 'verao', event_id: 'evento-0001' });
    assert.equal(ped.visitante_token, r1.body.visitante);
    // O mesmo navegador volta com o mesmo token
    const r2 = await api('POST', '/api/maleta/checkout', { token: null, body: { itens: [{ id: a }], contato: { nome: 'Ana' }, visitante: r1.body.visitante } });
    assert.equal(r2.body.visitante, r1.body.visitante);
    assert.match(r2.body.event_id, /^[0-9a-f-]{36}$/, 'sem event_id da vitrine o servidor cria');
    assert.equal((await api('POST', '/api/rastreamento/evento', { token: null, body: { evento: 'view_item', event_id: 'evento-0002', produto_ids: [a] } })).status, 204);
    await new Promise((ok) => setTimeout(ok, 200));
    assert.equal(recebidos.length, 0);
    // O painel mostra a origem no pedido
    assert.equal((await api('GET', '/api/admin/pedidos')).body.at(-1).rastreamento.utm_source, 'instagram');
  });

  it('com CAPI: pedido vira Lead + Purchase com o mesmo event_id e dados em hash', async () => {
    await api('PUT', '/api/admin/rastreamento', { body: { meta_pixel_id: '123456789012345', capi_token: TOKEN, meta_test_code: 'TEST999' } });
    const a = await criarProduto('NIX-A', 100);
    const b = await criarProduto('NIX-B', 50.5, 'SOB_ENCOMENDA');
    const r1 = await api('POST', '/api/maleta/checkout', {
      token: null,
      headers: { 'User-Agent': 'Navegador/1.0', 'X-Forwarded-For': '200.10.20.30, 10.0.0.1' },
      body: {
        itens: [{ id: a }, { id: b }],
        contato: { nome: 'Ana Souza', telefone: '(11) 99999-0000', email: 'ana@email.com', cep: '01310-100', cidade: 'São Paulo/SP' },
        rastreamento: { origem: { utm_source: 'facebook' }, event_id: 'pedido-evento-1', fbp: 'fb.1.1700000000000.42', url: 'https://loja.com/?x=1' },
      },
    });
    assert.equal(r1.status, 200);
    await esperar(() => recebidos.length >= 1);
    assert.equal(recebidos.length, 1);
    const { url, corpo } = recebidos[0];
    assert.match(url, /^\/v\d+\.0\/123456789012345\/events$/);
    assert.equal(corpo.access_token, TOKEN);
    assert.equal(corpo.test_event_code, 'TEST999');
    assert.deepEqual(corpo.data.map((e) => e.event_name), ['Lead', 'Purchase']);
    for (const e of corpo.data) {
      assert.equal(e.event_id, 'pedido-evento-1');
      assert.equal(e.action_source, 'website');
      assert.equal(e.event_source_url, 'https://loja.com/');
      assert.deepEqual(e.user_data.em, [sha('ana@email.com')]);
      assert.deepEqual(e.user_data.ph, [sha('5511999990000')]);
      assert.deepEqual(e.user_data.external_id, [sha(r1.body.visitante)]);
      assert.equal(e.user_data.client_ip_address, '200.10.20.30');
      assert.equal(e.user_data.client_user_agent, 'Navegador/1.0');
      assert.equal(e.user_data.fbp, 'fb.1.1700000000000.42');
      assert.equal(e.custom_data.value, 150.5, 'valor do banco');
      assert.equal(e.custom_data.currency, 'BRL');
      assert.deepEqual(e.custom_data.content_ids, ['NIX-A', 'NIX-B']);
      assert.equal(e.custom_data.order_id, String(r1.body.pedido.id));
    }
    assert.doesNotMatch(JSON.stringify(corpo.data), /ana@email|99999-0000|Souza/);
    await esperar(() => false);
    const ped = (await h.pool.query('SELECT rastreamento FROM pedidos')).rows[0];
    assert.match(ped.rastreamento.capi_enviado_em, /^\d{4}-\d\d-\d\dT/);
  });

  it('com CAPI: eventos da vitrine com o event_id e o preço do banco', async () => {
    await api('PUT', '/api/admin/rastreamento', { body: { meta_pixel_id: '123456789012345', capi_token: TOKEN } });
    const a = await criarProduto('NIX-A', 120);
    assert.equal((await api('POST', '/api/rastreamento/evento', { token: null, body: { evento: 'purchase', event_id: 'x-12345678' } })).status, 400);
    assert.equal((await api('POST', '/api/rastreamento/evento', { token: null, body: { evento: 'view_item' } })).status, 400);
    const ok = await api('POST', '/api/rastreamento/evento', { token: null, body: { evento: 'add_to_cart', event_id: 'carrinho-0001', produto_ids: [a], preco: 1 } });
    assert.equal(ok.status, 202);
    await esperar(() => recebidos.length >= 1);
    const e = recebidos[0].corpo.data[0];
    assert.equal(e.event_name, 'AddToCart');
    assert.equal(e.event_id, 'carrinho-0001');
    assert.equal(e.custom_data.value, 120);
    assert.equal(recebidos[0].corpo.test_event_code, undefined);
  });
});

describe('painel: tela de Rastreamento explica cada campo', () => {
  const admin = ler('admin/index.html');
  it('cada campo tem passo a passo, exemplo e selo de estado; aviso e guia de conferência', () => {
    for (const id of ['estadoGtm', 'estadoPixel', 'estadoToken', 'estadoTeste']) assert.match(admin, new RegExp(`id="${id}"`));
    assert.match(admin, /placeholder="Exemplo: GTM-AB12CD3"/);
    assert.match(admin, /placeholder="Exemplo: 123456789012345"/);
    assert.match(admin, /Gerar token de acesso/);
    assert.match(admin, /Sem estes dados, nada é enviado\./);
    assert.match(admin, /Como conferir se está funcionando/);
  });
  it('situação diz o que falta', () => {
    const vm = require('node:vm');
    const ini = admin.indexOf('function textoSituacaoRastreamento(');
    const fim = admin.indexOf('\n    }\n', ini) + 6;
    const ctx = vm.createContext({});
    vm.runInContext(admin.slice(ini, fim) + '\nthis.f = textoSituacaoRastreamento;', ctx);
    assert.equal(ctx.f({}), 'GTM desligado: falta o ID · API de Conversões desligada: faltam o Pixel ID e o token');
    assert.equal(ctx.f({ gtm_id: 'GTM-AB12CD3', meta_pixel_id: '1' }), 'GTM ligado (GTM-AB12CD3) · API de Conversões desligada: falta o token');
    assert.match(ctx.f({ capi_ativo: true, meta_test_code: 'TEST1' }), /modo de teste/);
  });
});

describe('Métricas: origem dos pedidos', () => {
  const { origemDe, agruparOrigens } = require('../origens');
  it('nomeia a origem pelas UTMs, pelo clique do anúncio ou direto', () => {
    assert.equal(origemDe({ utm_source: 'Instagram', utm_medium: 'bio' }), 'instagram / bio');
    assert.equal(origemDe({ utm_source: 'google' }), 'google');
    assert.equal(origemDe({ fbclid: 'x' }), 'Anúncio Meta (sem UTM)');
    assert.equal(origemDe({ gclid: 'x' }), 'Anúncio Google (sem UTM)');
    assert.equal(origemDe({}), 'Direto / sem origem');
    assert.equal(origemDe(null), 'Direto / sem origem');
  });
  it('agrupa por origem e campanha; cancelado fica fora do valor; vendido = fechamento dos entregues', () => {
    const bio = { utm_source: 'instagram', utm_medium: 'bio' };
    const r = agruparOrigens([
      { rastreamento: { ...bio, utm_campaign: 'verao' }, status: 'NOVO', total: '100.10' },
      { rastreamento: { ...bio, utm_campaign: 'verao' }, status: 'ENTREGUE', total: '200.00', total_final: '180.20' },
      { rastreamento: bio, status: 'CANCELADO', total: '999' },
      { rastreamento: {}, status: 'ENTREGUE', total: '50', total_final: null },
    ]);
    assert.deepEqual(r.origens.map((o) => [o.nome, o.pedidos, o.cancelados, o.valor, o.entregues, o.vendido]), [
      ['instagram / bio', 2, 1, 300.1, 1, 180.2],
      ['Direto / sem origem', 1, 0, 50, 1, 50],
    ]);
    assert.deepEqual(r.origens[0].campanhas.map((c) => [c.nome, c.pedidos, c.valor]), [['verao', 2, 300.1]]);
    assert.deepEqual(r.totais, { pedidos: 3, cancelados: 1, valor: 350.1, entregues: 2, vendido: 230.2 });
    assert.equal(r.rastreados, 2);
  });
  it('painel: link com UTMs limpo e tabela escapada', () => {
    const vm = require('node:vm');
    const admin = ler('admin/index.html');
    const pegar = (nome) => { const i = admin.indexOf(`function ${nome}(`); let n = 0, j = admin.indexOf('{', i); for (; ; j++) { if (admin[j] === '{') n++; else if (admin[j] === '}' && --n === 0) return admin.slice(i, j + 1); } };
    const ctx = vm.createContext({ URL, formatarMoeda: (v) => 'R$ ' + v, escapeHtml: (t) => String(t).replace(/[&<>"']/g, '_') });
    vm.runInContext(['limparUtm', 'montarLinkOrigem', 'linhasOrigens'].map(pegar).join('\n') + '\nthis.link = montarLinkOrigem; this.linhas = linhasOrigens;', ctx);
    assert.equal(ctx.link('https://loja.com/', 'instagram|bio', ''), 'https://loja.com/?utm_source=instagram&utm_medium=bio');
    assert.equal(ctx.link('https://loja.com/', 'outro', 'Black Friday!', 'Parceira Ána', 'indicação'), 'https://loja.com/?utm_source=parceira-ana&utm_medium=indicacao&utm_campaign=black-friday');
    const html = ctx.linhas({ origens: [{ nome: '<img src=x>', pedidos: 1, cancelados: 0, valor: 1, entregues: 0, vendido: 0, campanhas: [{ nome: '"><b>', pedidos: 1, cancelados: 0, valor: 1, entregues: 0, vendido: 0 }] }], totais: { pedidos: 1, valor: 1, vendido: 0 } });
    assert.doesNotMatch(html, /<img src=x|"><b>/);
    assert.match(ctx.linhas({ origens: [], totais: {} }), /Nenhum pedido no período/);
  });
});

describe('API: origem dos pedidos', () => {
  let srv;
  let tokenAdmin;
  before(async () => {
    srv = await h.iniciarServidor();
    tokenAdmin = await h.login(srv);
  });
  beforeEach(h.limparBanco);
  after(async () => { await srv.parar(); });

  it('soma os pedidos do período por origem, só para quem vê Métricas', async () => {
    const form = new FormData();
    for (const [k, val] of Object.entries({ nome: 'Óculos A', codigo_sku: 'A1', preco_custo: 10, preco_venda: 100 })) form.append(k, String(val));
    const id = (await (await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${tokenAdmin}` }, body: form })).json()).id;
    const pedir = (origem) => fetch(srv.url('/api/maleta/checkout'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itens: [{ id }], contato: { nome: 'Ana' }, rastreamento: { origem } }) });
    await pedir({ utm_source: 'instagram', utm_medium: 'bio' });
    await pedir({ utm_source: 'instagram', utm_medium: 'bio', utm_campaign: 'verao' });
    await pedir({});
    assert.equal((await fetch(srv.url('/api/admin/origens'))).status, 401);
    const r = await (await fetch(srv.url('/api/admin/origens?periodo=tudo'), { headers: { Authorization: `Bearer ${tokenAdmin}` } })).json();
    assert.deepEqual(r.origens.map((o) => [o.nome, o.pedidos, o.valor]), [['instagram / bio', 2, 200], ['Direto / sem origem', 1, 100]]);
    assert.deepEqual(r.origens[0].campanhas.map((c) => c.nome), ['verao']);
    assert.equal(r.totais.pedidos, 3);
  });
});

after(() => h.fecharBanco());
