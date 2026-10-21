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

const FUNCOES = ['ordemTamanho', 'agruparCards', 'nomeModelo', 'tamanhosCard', 'botaoGrupoCard', 'escapeHtml', 'fotosDoProduto', 'indiceCircular', 'ehSobEncomenda', 'calcularSinal', 'passaFiltroStatus', 'etiquetaProduto',
  'nomeCard', 'tagsCard', 'botaoMaletaCard', 'atualizarCardMaleta', 'itemEhEncomenda', 'resumoMaleta', 'passaFiltroGenero', 'renderizarCatalogo', 'toggleMaleta', 'salvarMaleta', 'textoGuiaCatalogo', 'atualizarGuias', 'atualizarMaletaUI', 'montarTextoWhatsapp'];

function elemento() {
  return {
    innerHTML: '', value: '', textContent: '', filhos: [], dataset: {}, escondido: false,
    classList: {
      add(c) { if (c === 'hidden') this.dono.escondido = true; },
      remove(c) { if (c === 'hidden') this.dono.escondido = false; },
    },
    appendChild(f) { this.filhos.push(f); },
  };
}
function novoElemento() {
  const e = elemento();
  e.classList.dono = e;
  return e;
}

const formatarMoeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v).replace(/ /g, ' ');

function vitrine(produtos, filtro = '', itens = []) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const toasts = [];
  const guardado = {};
  const catalogoGrid = novoElemento();
  const els = {
    maletaVazia: novoElemento(), maletaItens: novoElemento(), maletaFormulario: novoElemento(),
    maletaFooter: novoElemento(), maletaTotal: novoElemento(), maletaSinal: novoElemento(),
  };
  const ctx = vm.createContext({
    produtos,
    maleta: { itens },
    filtroStatus: { value: filtro },
    filtroFormato: { value: '' },
    filtroGenero: { value: '' },
    NICHO: 'oculos', rotulos: { formato: 'Formato da lente', formatos: 'Todos os formatos', material: 'Material', tipo: 'Tipo' }, ORDEM_TAMANHOS: [], filtroTamanho: { value: '' },
    catalogoGrid,
    emptyState: novoElemento(),
    ...els,
    document: { createElement: novoElemento, getElementById: novoElemento },
    localStorage: { setItem: (k, v) => { guardado[k] = v; } },
    formatarMoeda,
    mostrarToast: (m) => toasts.push(m),
    Intl, Number, String, Math,
  });
  vm.runInContext(`${FUNCOES.map((f) => extrairFuncao(html, f)).join('\n')}\n${FUNCOES.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);
  ctx.renderizarCatalogo();
  const cards = catalogoGrid.filhos.map((c) => c.innerHTML);
  return { ctx, cards, toasts, guardado, els };
}

const pronta = { id: 1, nome: 'Aviador', codigo_sku: 'AV-01', preco_venda: '199.99', status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' };
const condicional = { ...pronta, id: 2, codigo_sku: 'AV-02', status: 'CONDICIONAL' };
const encomenda = { id: 3, nome: 'Cat Eye', codigo_sku: 'CE-09', preco_venda: '350.25', status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' };
const encomenda2 = { ...encomenda, id: 4, nome: 'Redondo', codigo_sku: 'RD-01', preco_venda: '99.99' };

describe('vitrine: produtos Sob Encomenda', () => {
  it('calcula o sinal como 50% arredondado para centavos', () => {
    const { ctx } = vitrine([]);
    assert.equal(ctx.calcularSinal('199.99'), 100);
    assert.equal(ctx.calcularSinal('350.25'), 175.13);
    assert.equal(ctx.calcularSinal(120), 60);
  });

  it('só a encomenda ganha etiqueta (azul SOB ENCOMENDA), e os dois vão para a maleta', () => {
    const { ctx, cards } = vitrine([pronta, encomenda]);
    assert.doesNotMatch(cards[0], /DISPONÍVEL|SOB ENCOMENDA/);
    assert.equal(ctx.etiquetaProduto(pronta).texto, 'DISPONÍVEL');
    assert.doesNotMatch(cards[0], /50% sinal/);
    assert.match(cards[0], /toggleMaleta\(1\)/);

    assert.match(cards[1], /bg-blue-100 text-blue-700">SOB ENCOMENDA</);
    assert.match(cards[1], /data-selo-sinal[^>]*>Sinal: R\$ 175,13</);
    assert.doesNotMatch(cards[1], /50% sinal \+ 50% na entrega/);
    assert.match(cards[1], /toggleMaleta\(3\)/);
    assert.match(cards[1], /btn-encomenda/);
    assert.doesNotMatch(cards[1], /encomendarProduto/);
  });

  it('filtra Sob Encomenda e tira as encomendas de "Disponíveis"', () => {
    const so = vitrine([pronta, condicional, encomenda], 'SOB_ENCOMENDA').cards;
    assert.equal(so.length, 1);
    assert.match(so[0], /toggleMaleta\(3\)/);
    const disp = vitrine([pronta, condicional, encomenda], 'DISPONIVEL').cards;
    assert.equal(disp.length, 1);
    assert.match(disp[0], /toggleMaleta\(1\)/);
    assert.equal(vitrine([pronta, condicional, encomenda], '').cards.length, 3);
  });
});

describe('maleta com itens Sob Encomenda', () => {
  it('adiciona a encomenda na maleta marcada como encomenda e com preço numérico', () => {
    const v = vitrine([pronta, encomenda]);
    v.ctx.toggleMaleta(1);
    v.ctx.toggleMaleta(3);
    assert.deepEqual(v.ctx.maleta.itens.map((i) => [i.id, i.preco, i.encomenda]), [[1, 199.99, false], [3, 350.25, true]]);
    assert.match(v.toasts[1], /Cat Eye adicionado à maleta \(sob encomenda\)/);
    assert.equal(JSON.parse(v.guardado.nix_maleta).itens.length, 2);
    v.ctx.toggleMaleta(3);
    assert.deepEqual(v.ctx.maleta.itens.map((i) => i.id), [1]);
  });

  it('destaca a encomenda na lista com a etiqueta e o sinal de 50%', () => {
    const v = vitrine([pronta, encomenda]);
    v.ctx.toggleMaleta(1);
    v.ctx.toggleMaleta(3);
    const lista = v.els.maletaItens.innerHTML;
    assert.equal((lista.match(/SOB ENCOMENDA/g) || []).length, 1);
    assert.match(lista, /50% de sinal: R\$ 175,13/);
    assert.equal(v.els.maletaTotal.textContent, 'R$ 550,24');
    assert.equal(v.els.maletaSinal.textContent, 'Sinal das encomendas (50%): R$ 175,13');
    assert.equal(v.els.maletaSinal.escondido, false);
  });

  it('esconde o sinal quando só há itens para prova e soma preços que vêm como texto', () => {
    // maleta antiga do navegador: preço guardado como texto, sem o campo encomenda
    const v = vitrine([pronta], '', [{ id: 1, nome: 'Aviador', preco: '199.99' }, { id: 2, nome: 'Outro', preco: '10.01' }]);
    v.ctx.atualizarMaletaUI();
    assert.doesNotMatch(v.els.maletaItens.innerHTML, /SOB ENCOMENDA/);
    assert.equal(v.els.maletaTotal.textContent, 'R$ 210,00');
    assert.equal(v.els.maletaSinal.escondido, true);
  });

  const cliente = { nome: 'Ana', telefone: '11 99999-0000', rua: 'Rua A', numero: '10', bairro: 'Centro', cidade: 'São Paulo/SP' };

  it('separa a mensagem do WhatsApp em itens para prova e encomendas com sinal', () => {
    const v = vitrine([pronta, condicional, encomenda, encomenda2]);
    for (const id of [1, 3, 2, 4]) v.ctx.toggleMaleta(id);
    assert.equal(v.ctx.montarTextoWhatsapp(v.ctx.maleta, cliente), [
      '*Nix Glasses - Novo Pedido*',
      '',
      '*Cliente:* Ana',
      '*Telefone:* 11 99999-0000',
      '*Endereço:* Rua A, 10 - Centro, São Paulo/SP',
      '',
      '*Para provar (pronta entrega):*',
      '1. Aviador - R$ 199,99',
      '2. Aviador - R$ 199,99',
      '*Subtotal para prova:* R$ 399,98',
      '',
      '*Sob encomenda (sinal de 50%):*',
      '1. Cat Eye - R$ 350,25 | Sinal 50%: R$ 175,13',
      '2. Redondo - R$ 99,99 | Sinal 50%: R$ 50,00',
      '*Total das encomendas:* R$ 450,24',
      '*Sinal a pagar (50%):* R$ 225,13',
      '',
      '*Total geral:* R$ 850,22',
      '',
      'Aguardamos sua confirmação!',
    ].join('\n'));
  });

  it('omite a seção vazia quando a maleta só tem um tipo de item', () => {
    const v = vitrine([pronta, encomenda]);
    v.ctx.toggleMaleta(3);
    const soEncomenda = v.ctx.montarTextoWhatsapp(v.ctx.maleta, cliente);
    assert.doesNotMatch(soEncomenda, /Para provar/);
    assert.match(soEncomenda, /\*Sinal a pagar \(50%\):\* R\$ 175,13/);

    v.ctx.toggleMaleta(3);
    v.ctx.toggleMaleta(1);
    const soProva = v.ctx.montarTextoWhatsapp(v.ctx.maleta, cliente);
    assert.match(soProva, /\*Para provar \(pronta entrega\):\*\n1\. Aviador - R\$ 199,99/);
    assert.doesNotMatch(soProva, /encomenda|Sinal/i);
  });
});

describe('checkout da maleta com encomendas', () => {
  it('conta a encomenda como adicionada à maleta sem mudar status nem disponibilidade', async () => {
    const { body: a } = await criarProduto(base('CK-1'));
    const { body: e } = await criarProduto(base('CK-2', { disponibilidade: 'SOB_ENCOMENDA' }));
    const r = await api('POST', '/api/maleta/checkout', { auth: false, body: { produtoIds: [a.id, e.id] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.atualizados.length, 2);
    const { rows } = await h.pool.query('SELECT codigo_sku, status, disponibilidade, vezes_em_maleta FROM produtos ORDER BY id');
    assert.deepEqual(rows, [
      { codigo_sku: 'CK-1', status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA', vezes_em_maleta: 1 },
      { codigo_sku: 'CK-2', status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA', vezes_em_maleta: 1 },
    ]);
  });
});
