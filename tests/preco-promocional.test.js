// Preço promocional: com PROMOÇÃO marcada no cadastro, o produto pode ter um preço
// promocional (menor que o preço de venda). A vitrine recebe o preço promocional só
// enquanto a promoção está ativa, mostra o preço de antes riscado, e o pedido e a venda
// da conferência de estoque cobram o promocional.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('./helpers');

let srv;
let token;

before(async () => {
  srv = await h.iniciarServidor();
  token = await h.login(srv);
});
beforeEach(h.limparBanco);
after(async () => {
  await srv.parar();
  await h.fecharBanco();
});

async function api(method, p, body, auth = true) {
  const headers = auth ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

async function enviar(method, p, campos) {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  const res = await fetch(srv.url(p), { method, headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json() };
}

const produto = (sku, extra = {}) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: '30', preco_venda: '199.90', formato: 'Aviador', estoque: '3', ...extra });

async function novoAnuncio(nome = 'Black Friday') {
  const r = await enviar('POST', '/api/admin/anuncios', { nome });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const vitrine = async () => (await api('GET', '/api/produtos', undefined, false)).body;
const admin = async () => (await api('GET', '/api/admin/produtos')).body;

describe('API: preço promocional', () => {
  it('cadastro com promoção e preço promocional: a vitrine recebe os dois preços', async () => {
    const a = await novoAnuncio();
    const r = await enviar('POST', '/api/produtos', produto('NIX-001', { anuncio_id: String(a.id), preco_promocional: '149,90' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(Number(r.body.preco_promocional), 149.9);
    await enviar('POST', '/api/produtos', produto('NIX-002'));
    const v = Object.fromEntries((await vitrine()).map((p) => [p.codigo_sku, p]));
    assert.equal(Number(v['NIX-001'].preco_venda), 199.9);
    assert.equal(Number(v['NIX-001'].preco_promocional), 149.9);
    assert.equal(v['NIX-002'].preco_promocional, null);
  });

  it('sem promoção marcada o preço promocional não é gravado; maior ou igual ao preço é recusado', async () => {
    const a = await novoAnuncio();
    const sem = await enviar('POST', '/api/produtos', produto('NIX-003', { preco_promocional: '99' }));
    assert.equal(sem.status, 201);
    assert.equal(sem.body.preco_promocional, null);
    for (const valor of ['199.90', '250', 'abc', '-5']) {
      const r = await enviar('POST', '/api/produtos', produto(`NIX-X${valor.length}`, { anuncio_id: String(a.id), preco_promocional: valor }));
      assert.equal(r.status, 400, valor);
    }
    const vazio = await enviar('POST', '/api/produtos', produto('NIX-004', { anuncio_id: String(a.id), preco_promocional: '' }));
    assert.equal(vazio.status, 201, 'promoção sem preço promocional: só o selo');
    assert.equal(vazio.body.preco_promocional, null);
  });

  it('editar: troca o preço promocional, recusa acima do preço e desmarcar a promoção tira o preço', async () => {
    const a = await novoAnuncio();
    const { body: p } = await enviar('POST', '/api/produtos', produto('NIX-010', { anuncio_id: String(a.id), preco_promocional: '150' }));
    let r = await enviar('PUT', `/api/produtos/${p.id}`, { anuncio_id: String(a.id), preco_promocional: '129.90' });
    assert.equal(r.status, 200);
    assert.equal(Number(r.body.preco_promocional), 129.9);
    r = await enviar('PUT', `/api/produtos/${p.id}`, { preco_venda: '120' });
    assert.equal(r.status, 400, 'baixar o preço de venda abaixo do promocional é recusado');
    assert.match(r.body.error, /menor que o preço de venda/);
    assert.equal(Number((await admin())[0].preco_venda), 199.9, 'nada foi gravado');
    r = await enviar('PUT', `/api/produtos/${p.id}`, { anuncio_id: '', preco_promocional: '100' });
    assert.equal(r.status, 200);
    assert.equal(r.body.anuncio_id, null);
    assert.equal(r.body.preco_promocional, null);
  });

  it('vale para todas as cores do modelo', async () => {
    const a = await novoAnuncio();
    const r = await enviar('POST', '/api/produtos', { ...produto('NIX-020'), cores: [{ cor: 'Preto', estoque: 1 }, { cor: 'Azul', estoque: 1 }], anuncio_id: String(a.id), preco_promocional: '159.90' });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.produtos.map((x) => Number(x.preco_promocional)), [159.9, 159.9]);
    const [preto, azul] = r.body.produtos;
    await enviar('PUT', `/api/produtos/${preto.id}`, { anuncio_id: String(a.id), preco_promocional: '139.90' });
    assert.equal(Number((await admin()).find((x) => x.id === azul.id).preco_promocional), 139.9, 'a outra cor acompanha');
    // cor nova incluída no Editar produto herda a promoção e o preço promocional
    const nova = await enviar('POST', `/api/produtos/${preto.id}/cores`, { cores: [{ cor: 'Verde', estoque: 1 }] });
    assert.equal(nova.status, 201, JSON.stringify(nova.body));
    assert.equal(Number(nova.body.produtos[0].preco_promocional), 139.9);
  });

  it('promoção inativa: a vitrine volta ao preço normal (o preço promocional fica guardado)', async () => {
    const a = await novoAnuncio();
    await enviar('POST', '/api/produtos', produto('NIX-030', { anuncio_id: String(a.id), preco_promocional: '149.90' }));
    await enviar('PUT', `/api/admin/anuncios/${a.id}`, { ativo: 'false' });
    assert.equal((await vitrine())[0].preco_promocional, null);
    assert.equal(Number((await admin())[0].preco_promocional), 149.9);
    await enviar('PUT', `/api/admin/anuncios/${a.id}`, { ativo: 'true' });
    assert.equal(Number((await vitrine())[0].preco_promocional), 149.9);
  });

  it('o pedido da maleta cobra o preço promocional e guarda o preço de antes', async () => {
    const a = await novoAnuncio();
    const { body: promo } = await enviar('POST', '/api/produtos', produto('NIX-040', { anuncio_id: String(a.id), preco_promocional: '149.90' }));
    const { body: normal } = await enviar('POST', '/api/produtos', produto('NIX-041'));
    const { body: enc } = await enviar('POST', '/api/produtos', produto('NIX-042', { disponibilidade: 'SOB_ENCOMENDA', anuncio_id: String(a.id), preco_promocional: '100' }));
    const r = await api('POST', '/api/maleta/checkout', {
      itens: [{ id: promo.id, intencao: 'COMPRA' }, { id: normal.id, intencao: 'CONDICIONAL' }, { id: enc.id }],
      contato: { nome: 'Ana', telefone: '11999999999' },
    }, false);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pedido = (await api('GET', '/api/admin/pedidos')).body.find((p) => p.id === r.body.pedido.id);
    const itens = Object.fromEntries(pedido.itens.map((i) => [i.codigo_sku, i]));
    assert.equal(itens['NIX-040'].preco, 149.9);
    assert.equal(itens['NIX-040'].preco_normal, 199.9);
    assert.equal(itens['NIX-041'].preco, 199.9);
    assert.equal(itens['NIX-041'].preco_normal, undefined);
    assert.equal(itens['NIX-042'].preco, 100);
    assert.equal(itens['NIX-042'].sinal, 50, 'sinal de 50% sobre o preço promocional');
    assert.equal(Number(pedido.total_compra), 149.9);
    assert.equal(Number(pedido.total), 449.8);
  });

  it('a venda da conferência de estoque vale pelo preço promocional', async () => {
    const a = await novoAnuncio();
    const { body: p } = await enviar('POST', '/api/produtos', produto('NIX-050', { anuncio_id: String(a.id), preco_promocional: '149.90' }));
    const r = await api('POST', '/api/admin/estoque/conferencia/conferir', { acao: 'VENDIDO', itens: [{ id: p.id, quantidade: 2 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.totais.valor_venda, 299.8);
    const g = await api('POST', '/api/admin/estoque/conferencia', { acao: 'VENDIDO', itens: [{ id: p.id, quantidade: 1 }] });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    const m = (await api('GET', '/api/admin/estoque/movimentos')).body;
    assert.equal(m.movimentos[0].preco_venda, 149.9);
  });
});

// ---------- Vitrine (funções do index.html) ----------
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extrairFuncao(nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

describe('vitrine: preço promocional', () => {
  const ctx = vm.createContext({
    formatarMoeda: (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v),
  });
  vm.runInContext(['precoDe', 'precoAntes', 'calcularSinal', 'prazoEncomenda', 'itemEhEncomenda', 'resumoMaleta', 'montarTextoWhatsapp'].map(extrairFuncao).join('\n')
    + '\nthis.precoDe = precoDe; this.precoAntes = precoAntes; this.resumoMaleta = resumoMaleta; this.montarTextoWhatsapp = montarTextoWhatsapp;', ctx);

  it('precoDe é o promocional quando vale; precoAntes é o preço de venda para riscar', () => {
    assert.equal(ctx.precoDe({ preco_venda: '199.90', preco_promocional: '149.90' }), 149.9);
    assert.equal(ctx.precoAntes({ preco_venda: '199.90', preco_promocional: '149.90' }), 199.9);
    assert.equal(ctx.precoDe({ preco_venda: '199.90', preco_promocional: null }), 199.9);
    assert.equal(ctx.precoAntes({ preco_venda: '199.90', preco_promocional: null }), null);
    assert.equal(ctx.precoDe({ preco_venda: '100', preco_promocional: '120' }), 100, 'promocional maior não vale');
  });

  it('a maleta soma a economia e o WhatsApp mostra o preço de antes riscado', () => {
    const itens = [
      { id: 1, nome: 'Nix Rex', sku: 'NIX-1', preco: 149.9, precoNormal: 199.9, intencao: 'COMPRA' },
      { id: 2, nome: 'Nix Brachio', sku: 'NIX-2', preco: 99.9, intencao: 'CONDICIONAL' },
    ];
    assert.equal(ctx.resumoMaleta(itens).economia, 50);
    const texto = ctx.montarTextoWhatsapp({ itens }, { nome: 'Ana', telefone: '1199' });
    assert.match(texto, /Nix Rex \(Ref\. NIX-1\) - ~R\$\s199,90~ R\$\s149,90 \(promoção\)/);
    assert.match(texto, /Nix Brachio \(Ref\. NIX-2\) - R\$\s99,90\n/);
    assert.match(texto, /_Economia com promoção: R\$\s50,00_/);
  });
});
