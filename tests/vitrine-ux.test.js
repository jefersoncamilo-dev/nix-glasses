// Vitrine no celular: botão Voltar fecha o modal aberto (History API), card com
// nome curto, etiquetas e selo do sinal, e botão da maleta que muda na hora.
// Também a API e o painel do campo "Nome curto".
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('./helpers');

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

function carregar(arquivo, funcoes, globais = {}, prefixo = '') {
  const html = fs.readFileSync(path.join(__dirname, '..', ...arquivo.split('/')), 'utf8');
  const ctx = vm.createContext({ Number, String, Math, Map, Set, Object, URL, Intl, ...globais });
  vm.runInContext(`${typeof prefixo === 'function' ? prefixo(html) : prefixo}\n${funcoes.map((f) => extrairFuncao(html, f)).join('\n')}\n${funcoes.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

const formatarMoeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v).replace(/ /g, ' ');

// ---------- Botão Voltar (History API) ----------

describe('vitrine: botão Voltar fecha o modal', () => {
  const HISTORICO = ['entrarModalHistorico', 'sairModalHistorico', 'aoVoltarHistorico'];

  function montar() {
    const entradas = [];
    const fechados = [];
    const historico = {
      voltas: 0,
      pushState(estado) { entradas.push(estado); },
      back() { this.voltas++; entradas.pop(); },
    };
    const ctx = carregar('index.html', HISTORICO, { history: historico },
      'const historicoModais = { pilha: [], ignorar: 0, adiados: [] };');
    // Os fechamentos de verdade chamam sairModalHistorico, como na página
    ctx.FECHAR_MODAL = {};
    for (const nome of ['detalhes', 'provador', 'maleta', 'cliente']) {
      ctx.FECHAR_MODAL[nome] = () => { fechados.push(nome); ctx.sairModalHistorico(nome); };
    }
    vm.runInContext('this.historicoModais = historicoModais; var FECHAR_MODAL = this.FECHAR_MODAL;', ctx);
    return { ctx, entradas, fechados, historico };
  }

  it('abrir empilha uma entrada e o Voltar fecha o modal sem sair da página', () => {
    const { ctx, entradas, fechados, historico } = montar();
    ctx.entrarModalHistorico('detalhes');
    assert.deepEqual(entradas.map((e) => e.nixModal), ['detalhes']);
    ctx.entrarModalHistorico('detalhes'); // abrir de novo não duplica
    assert.equal(entradas.length, 1);

    entradas.pop(); // o navegador volta uma entrada e dispara popstate
    ctx.aoVoltarHistorico();
    assert.deepEqual(fechados, ['detalhes']);
    assert.equal(historico.voltas, 0, 'fechar pelo Voltar não volta de novo');
    assert.equal(ctx.historicoModais.pilha.length, 0);
  });

  it('fechar pelo X consome a entrada e ignora o popstate que vem dele', () => {
    const { ctx, entradas, fechados, historico } = montar();
    ctx.entrarModalHistorico('maleta');
    ctx.sairModalHistorico('maleta');
    assert.equal(historico.voltas, 1);
    assert.equal(entradas.length, 0);
    ctx.aoVoltarHistorico(); // popstate do history.back()
    assert.deepEqual(fechados, []);
    ctx.sairModalHistorico('maleta'); // fechar de novo não volta outra vez
    assert.equal(historico.voltas, 1);
  });

  it('provador aberto sobre os detalhes: cada Voltar fecha um', () => {
    const { ctx, fechados } = montar();
    ctx.entrarModalHistorico('detalhes');
    ctx.entrarModalHistorico('provador');
    ctx.aoVoltarHistorico();
    assert.deepEqual(fechados, ['provador']);
    ctx.aoVoltarHistorico();
    assert.deepEqual(fechados, ['provador', 'detalhes']);
    ctx.aoVoltarHistorico(); // nada mais aberto: deixa o navegador seguir
    assert.deepEqual(fechados, ['provador', 'detalhes']);
  });

  it('abrir outro modal antes do history.back() terminar espera o popstate', () => {
    const { ctx, entradas } = montar();
    ctx.entrarModalHistorico('detalhes');
    ctx.sairModalHistorico('detalhes');
    ctx.entrarModalHistorico('cliente');
    assert.equal(entradas.length, 0, 'não empilha durante a volta');
    ctx.aoVoltarHistorico();
    assert.deepEqual(entradas.map((e) => e.nixModal), ['cliente']);
    assert.deepEqual([...ctx.historicoModais.pilha], ['cliente']);
  });

  it('a página liga os modais da vitrine ao histórico', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.match(html, /addEventListener\('popstate', aoVoltarHistorico\)/);
    for (const [abrir, fechar, nome] of [['abrirDetalhes', 'fecharDetalhes', 'detalhes'], ['abrirProvador', 'fecharProvador', 'provador'],
      ['abrirModalMaleta', 'fecharModalMaleta', 'maleta'], ['abrirCliente', 'fecharCliente', 'cliente']]) {
      assert.match(extrairFuncao(html, abrir), new RegExp(`entrarModalHistorico\\('${nome}'\\)`), abrir);
      assert.match(extrairFuncao(html, fechar), new RegExp(`sairModalHistorico\\('${nome}'\\)`), fechar);
    }
  });
});

// ---------- Card do produto ----------

const VITRINE = ['ordemTamanho', 'agruparCards', 'nomeModelo', 'tamanhosCard', 'botaoGrupoCard', 'escapeHtml', 'fotosDoProduto', 'indiceCircular', 'ehSobEncomenda', 'calcularSinal', 'passaFiltroStatus', 'etiquetaProduto',
  'nomeCard', 'tagsCard', 'botaoMaletaCard', 'atualizarCardMaleta', 'passaFiltroGenero', 'renderizarCatalogo', 'toggleMaleta'];

function elemento() {
  return { innerHTML: '', value: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {} } };
}

function vitrine(produtos, extra = {}) {
  const cards = [];
  const ctx = carregar('index.html', VITRINE, {
    produtos,
    maleta: { itens: [] },
    fotoCard: {},
    filtroStatus: { value: '' },
    filtroFormato: { value: '' },
    filtroGenero: { value: '' },
    NICHO: 'oculos', rotulos: { formato: 'Formato da lente', formatos: 'Todos os formatos', material: 'Material', tipo: 'Tipo' }, ORDEM_TAMANHOS: [], filtroTamanho: { value: '' },
    catalogoGrid: { innerHTML: '', classList: { add() {}, remove() {} }, appendChild: (c) => cards.push(c) },
    emptyState: elemento(),
    document: { createElement: elemento },
    formatarMoeda,
    salvarMaleta() {},
    atualizarMaletaUI() {},
    mostrarToast() {},
    ...extra,
  });
  ctx.renderizarCatalogo();
  return { ctx, cards };
}

const hexagonal = {
  id: 5, nome: 'Óculos de Sol Blogueira Hexagonal Dubai Premium Proteção UV400', nome_curto: 'Hexagonal Dubai', codigo_sku: 'HX-01',
  preco_venda: '135.00', status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA', material: 'Metal', formato: 'Hexagonal', cor_armacao: 'Dourado',
};

describe('vitrine: card limpo', () => {
  it('mostra o nome curto (nome completo no title), limitado a 2 linhas', () => {
    const card = vitrine([hexagonal]).cards[0].innerHTML;
    assert.match(card, /line-clamp-2[^"]*" title="Óculos de Sol Blogueira Hexagonal Dubai Premium Proteção UV400">Hexagonal Dubai<\/h3>/);
  });

  it('sem nome curto usa o nome completo', () => {
    const { ctx, cards } = vitrine([{ ...hexagonal, nome_curto: '  ' }]);
    assert.match(cards[0].innerHTML, />Óculos de Sol Blogueira Hexagonal Dubai Premium Proteção UV400<\/h3>/);
    assert.equal(ctx.nomeCard({ nome: 'Aviador' }), 'Aviador');
  });

  it('material, formato e cor viram uma linha discreta, só os preenchidos, sem o SKU', () => {
    const { ctx, cards } = vitrine([hexagonal]);
    assert.match(cards[0].innerHTML, /data-tags-card[^>]*>Metal · Hexagonal · Dourado<\/p>/);
    assert.doesNotMatch(cards[0].innerHTML, /HX-01/);
    assert.deepEqual([...ctx.tagsCard({ material: '', formato: 'Redondo', cor_armacao: null })], ['Redondo']);
  });

  it('encomenda mostra o preço total e um selo só com o sinal', () => {
    const card = vitrine([hexagonal]).cards[0].innerHTML;
    assert.match(card, /font-bold text-gray-900">R\$ 135,00</);
    assert.match(card, /data-selo-sinal[^>]*>Sinal: R\$ 67,50</);
    assert.doesNotMatch(card, /50% sinal \+ 50% na entrega|sinal de R\$/);
  });

  it('pronta entrega não tem selo de sinal', () => {
    const card = vitrine([{ ...hexagonal, disponibilidade: 'PRONTA_ENTREGA' }]).cards[0].innerHTML;
    assert.doesNotMatch(card, /data-selo-sinal|Sinal:/);
  });
});

describe('vitrine: botão da maleta muda na hora', () => {
  it('estados do botão: adicionar, encomendar e já na maleta', () => {
    const { ctx } = vitrine([]);
    const pronta = { ...hexagonal, disponibilidade: 'PRONTA_ENTREGA' };
    assert.match(ctx.botaoMaletaCard(pronta, false), /aria-pressed="false"[^>]*btn-primario[\s\S]*Adicionar à Maleta/);
    assert.match(ctx.botaoMaletaCard(hexagonal, false), /btn-encomenda[\s\S]*Encomendar \(na Maleta\)/);
    const naMaleta = ctx.botaoMaletaCard(hexagonal, true);
    assert.match(naMaleta, /aria-pressed="true"[^>]*btn-na-maleta/);
    assert.match(naMaleta, /✓ Na Maleta</);
    assert.match(naMaleta, /onclick="toggleMaleta\(5\)"/);
    assert.match(naMaleta, /class="btn btn-sm btn-maleta /);
  });

  it('clicar troca só o botão e o selo do card, sem redesenhar o catálogo', () => {
    const classes = [];
    const botao = { classList: { add: (c) => classes.push(c) }, focus() {} };
    const acao = { innerHTML: '', querySelector: () => botao, contains: () => false };
    let seloEscondido = true;
    const selo = { classList: { toggle: (c, v) => { seloEscondido = v; } } };
    const card = { dataset: { produtos: '5' }, querySelector: (s) => ({ '[data-acao-maleta]': acao, '[data-selo-maleta]': selo })[s] };
    let redesenhos = 0;
    const grid = { innerHTML: '', classList: { add() {}, remove() {} }, appendChild() { redesenhos++; }, querySelector: (s) => (s === '[data-produtos~="5"]' ? card : null) };
    const { ctx } = vitrine([hexagonal], { catalogoGrid: grid, document: { createElement: elemento, activeElement: null } });
    redesenhos = 0;

    ctx.toggleMaleta(5);
    assert.equal(redesenhos, 0);
    assert.match(acao.innerHTML, /✓ Na Maleta/);
    assert.equal(seloEscondido, false);
    assert.deepEqual(classes, ['pulso']);

    ctx.toggleMaleta(5);
    assert.match(acao.innerHTML, /Encomendar \(na Maleta\)/);
    assert.equal(seloEscondido, true);
    assert.equal(ctx.maleta.itens.length, 0);
  });
});

// ---------- Nome curto: API e painel ----------

describe('nome curto: painel', () => {
  const painel = carregar('admin/index.html',
    ['linhaLoteVazia', 'linhaLoteEstaVazia', 'lerPreco', 'lerMedida', 'lerDisponibilidade', 'lerStatus', 'lerGenero', 'campoDoCabecalho', 'linhasDaPlanilha'],
    {}, (html) => `${html.match(/const COLUNAS_LOTE = \[[\s\S]*?\n {4}\];/)[0]}\n${html.match(/const CAMPOS_MEDIDA = \[.*\];/)[0]}`);

  it('coluna "Nome curto" da planilha vai para nome_curto, sem confundir com Nome', () => {
    assert.equal(painel.campoDoCabecalho('Nome curto'), 'nome_curto');
    assert.equal(painel.campoDoCabecalho('Nome'), 'nome');
    const [l] = painel.linhasDaPlanilha('Nome\tNome curto\tSKU\tVenda\nÓculos Hexagonal Dubai Premium\tHexagonal Dubai\tHX-1\t135');
    assert.equal(l.nome, 'Óculos Hexagonal Dubai Premium');
    assert.equal(l.nome_curto, 'Hexagonal Dubai');
    assert.equal(painel.linhaLoteEstaVazia({ ...painel.linhaLoteVazia(), nome_curto: 'X' }), false);
  });

  it('vem depois das colunas antigas (e antes do gênero e da compra), para planilhas sem cabeçalho manterem a ordem', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
    const colunas = vm.runInNewContext(`${html.match(/const COLUNAS_LOTE = \[[\s\S]*?\n {4}\];/)[0]}; COLUNAS_LOTE`);
    assert.deepEqual(JSON.parse(JSON.stringify(colunas.slice(-8).map((c) => c.campo))), ['tipo', 'nome_curto', 'genero', 'quantidade', 'pedido_fornecedor', 'data_compra', 'tamanho', 'grade']);
    assert.match(html, /\['nome_curto', 'fornecedor', 'codigo_fornecedor'/);
  });
});

describe('nome curto: API', () => {
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

  async function api(method, p, body) {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  async function criar(campos) {
    const form = new FormData();
    for (const [k, v] of Object.entries(campos)) form.append(k, String(v));
    const res = await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: await res.json() };
  }

  const base = (sku) => ({ nome: 'Óculos de Sol Blogueira Hexagonal Dubai Premium', codigo_sku: sku, preco_custo: 50, preco_venda: 135 });

  it('grava no cadastro, aparece na vitrine e no painel, e a edição troca ou apaga', async () => {
    const { status, body } = await criar({ ...base('NC-1'), nome_curto: '  Hexagonal   Dubai ' });
    assert.equal(status, 201);
    assert.equal(body.nome_curto, 'Hexagonal Dubai');

    const publico = await fetch(srv.url('/api/produtos')).then((r) => r.json());
    assert.equal(publico[0].nome_curto, 'Hexagonal Dubai');
    assert.equal((await api('GET', '/api/admin/produtos')).body[0].nome_curto, 'Hexagonal Dubai');

    assert.equal((await api('PUT', `/api/produtos/${body.id}`, { status: 'CONDICIONAL' })).body.nome_curto, 'Hexagonal Dubai');
    assert.equal((await api('PUT', `/api/produtos/${body.id}`, { nome_curto: 'Dubai' })).body.nome_curto, 'Dubai');
    assert.equal((await api('PUT', `/api/produtos/${body.id}`, { nome_curto: '' })).body.nome_curto, '');
  });

  it('é opcional e limitado a 80 caracteres', async () => {
    assert.equal((await criar(base('NC-2'))).body.nome_curto, '');
    assert.equal((await criar({ ...base('NC-3'), nome_curto: 'x'.repeat(120) })).body.nome_curto.length, 80);
  });

  it('cadastro em lote grava o nome curto', async () => {
    const r = await api('POST', '/api/admin/produtos/lote', { produtos: [{ ...base('NC-L1'), nome_curto: 'Hexagonal Dubai' }, base('NC-L2')] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.produtos.map((p) => p.nome_curto), ['Hexagonal Dubai', '']);
  });
});
