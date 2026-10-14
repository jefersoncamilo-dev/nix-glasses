// Produtos "Sob Encomenda": campo disponibilidade na API, migração dos produtos
// antigos e a vitrine (etiqueta, filtro, mensagem do WhatsApp com sinal de 50%).
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

async function api(method, p, { body, auth = true, servidor = srv } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(servidor.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

async function criarProduto(campos) {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, String(v));
  const res = await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json() };
}

const base = (sku, extra = {}) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: 50, preco_venda: 199.99, ...extra });

describe('API: disponibilidade do produto', () => {
  it('cadastra como Pronta Entrega quando o campo não vem', async () => {
    const { status, body } = await criarProduto(base('PE-1'));
    assert.equal(status, 201);
    assert.equal(body.disponibilidade, 'PRONTA_ENTREGA');
  });

  it('cadastra Sob Encomenda e a vitrine pública devolve o campo', async () => {
    const { status, body } = await criarProduto(base('SE-1', { disponibilidade: 'SOB_ENCOMENDA' }));
    assert.equal(status, 201);
    assert.equal(body.disponibilidade, 'SOB_ENCOMENDA');

    const pub = await api('GET', '/api/produtos', { auth: false });
    assert.equal(pub.body[0].disponibilidade, 'SOB_ENCOMENDA');
    const adm = await api('GET', '/api/admin/produtos');
    assert.equal(adm.body[0].disponibilidade, 'SOB_ENCOMENDA');
  });

  it('troca a disponibilidade na edição', async () => {
    const { body: p } = await criarProduto(base('ED-1'));
    const r = await api('PUT', `/api/produtos/${p.id}`, { body: { disponibilidade: 'SOB_ENCOMENDA' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.disponibilidade, 'SOB_ENCOMENDA');
    assert.equal(r.body.status, 'DISPONIVEL');
  });

  it('recusa valor inválido com 400', async () => {
    assert.equal((await criarProduto(base('X-1', { disponibilidade: 'QUALQUER' }))).status, 400);
    const { body: p } = await criarProduto(base('X-2'));
    const r = await api('PUT', `/api/produtos/${p.id}`, { body: { disponibilidade: 'QUALQUER' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Disponibilidade inválida');
  });

  it('migra produtos antigos (sem a coluna) para Pronta Entrega', async () => {
    await h.pool.query('ALTER TABLE produtos DROP COLUMN disponibilidade');
    await h.pool.query(`INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda) VALUES ('Antigo', 'OLD-1', 10, 20)`);
    const outro = await h.iniciarServidor();
    try {
      const r = await api('GET', '/api/produtos', { auth: false, servidor: outro });
      assert.equal(r.status, 200);
      assert.equal(r.body[0].codigo_sku, 'OLD-1');
      assert.equal(r.body[0].disponibilidade, 'PRONTA_ENTREGA');
    } finally {
      await outro.parar();
    }
  });
});

// ---------- Vitrine (index.html) num DOM mínimo ----------

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

const FUNCOES = ['escapeHtml', 'fotosDoProduto', 'indiceCircular', 'ehSobEncomenda', 'calcularSinal', 'passaFiltroStatus', 'etiquetaProduto',
  'montarTextoEncomenda', 'encomendarProduto', 'renderizarCatalogo'];

function elemento() {
  return {
    innerHTML: '', value: '', filhos: [], dataset: {},
    classList: { add() {}, remove() {} },
    appendChild(f) { this.filhos.push(f); },
  };
}

function vitrine(produtos, filtro = '') {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const abertos = [];
  const toasts = [];
  const catalogoGrid = elemento();
  const ctx = vm.createContext({
    produtos,
    maleta: { itens: [] },
    fotoCard: {},
    whatsappNumero: '5511999990000',
    filtroStatus: { value: filtro },
    filtroFormato: { value: '' },
    catalogoGrid,
    emptyState: elemento(),
    document: { createElement: elemento },
    window: { open: (url) => abertos.push(url) },
    formatarMoeda: (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v),
    sanitizeWhatsapp: (n) => String(n).replace(/\D/g, ''),
    mostrarToast: (m) => toasts.push(m),
    encodeURIComponent, Intl, Number, String, Math,
  });
  vm.runInContext(`${FUNCOES.map((f) => extrairFuncao(html, f)).join('\n')}\n${FUNCOES.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);
  ctx.renderizarCatalogo();
  const cards = catalogoGrid.filhos.map((c) => c.innerHTML.replace(/ /g, ' '));
  return { ctx, cards, abertos, toasts };
}

const pronta = { id: 1, nome: 'Aviador', codigo_sku: 'AV-01', preco_venda: '199.99', status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' };
const condicional = { ...pronta, id: 2, codigo_sku: 'AV-02', status: 'CONDICIONAL' };
const encomenda = { id: 3, nome: 'Cat Eye', codigo_sku: 'CE-09', preco_venda: '350.25', status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' };

describe('vitrine: produtos Sob Encomenda', () => {
  it('calcula o sinal como 50% arredondado para centavos', () => {
    const { ctx } = vitrine([]);
    assert.equal(ctx.calcularSinal('199.99'), 100);
    assert.equal(ctx.calcularSinal('350.25'), 175.13);
    assert.equal(ctx.calcularSinal(120), 60);
  });

  it('mostra etiqueta verde DISPONÍVEL e azul SOB ENCOMENDA com o texto do sinal', () => {
    const { cards } = vitrine([pronta, encomenda]);
    assert.match(cards[0], /bg-green-100 text-green-700">DISPONÍVEL</);
    assert.doesNotMatch(cards[0], /50% sinal/);
    assert.match(cards[0], /toggleMaleta\(1\)/);

    assert.match(cards[1], /bg-blue-100 text-blue-700">SOB ENCOMENDA</);
    assert.match(cards[1], /50% sinal \+ 50% na entrega/);
    assert.match(cards[1], /encomendarProduto\(3\)/);
    assert.doesNotMatch(cards[1], /toggleMaleta/);
  });

  it('filtra Sob Encomenda e tira as encomendas de "Disponíveis"', () => {
    const so = vitrine([pronta, condicional, encomenda], 'SOB_ENCOMENDA').cards;
    assert.equal(so.length, 1);
    assert.match(so[0], /CE-09/);
    const disp = vitrine([pronta, condicional, encomenda], 'DISPONIVEL').cards;
    assert.equal(disp.length, 1);
    assert.match(disp[0], /AV-01/);
    assert.equal(vitrine([pronta, condicional, encomenda], '').cards.length, 3);
  });

  it('abre o WhatsApp com a mensagem de encomenda, preço e sinal', () => {
    const v = vitrine([encomenda]);
    v.ctx.encomendarProduto(3);
    assert.equal(v.abertos.length, 1);
    const url = new URL(v.abertos[0]);
    assert.equal(url.origin + url.pathname, 'https://wa.me/5511999990000');
    assert.equal(
      url.searchParams.get('text').replace(/ /g, ' '),
      'Olá! Gostaria de encomendar o modelo Cat Eye (Ref: CE-09). O valor é R$ 350,25 (com sinal de 50% de R$ 175,13). Como procedemos?'
    );
  });

  it('avisa quando o WhatsApp não está configurado', () => {
    const v = vitrine([encomenda]);
    v.ctx.whatsappNumero = '';
    v.ctx.encomendarProduto(3);
    assert.equal(v.abertos.length, 0);
    assert.equal(v.toasts.length, 1);
  });
});
