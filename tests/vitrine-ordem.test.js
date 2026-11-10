// Vitrine: ordem dos cards (disponíveis, depois Sob Encomenda, depois em condicional)
// e, com uma promoção escolhida, só os modelos (chips) que têm produto na promoção.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extrairFuncao(nome) {
  const inicio = html.search(new RegExp(`function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

function contexto(nomes, extra = {}) {
  const c = vm.createContext(extra);
  vm.runInContext(`${nomes.map(extrairFuncao).join('\n')}\n${nomes.map((f) => `this.${f} = ${f};`).join('\n')}`, c);
  return c;
}

describe('ordem dos cards na vitrine', () => {
  const c = contexto(['ehSobEncomenda', 'ordemTamanho', 'agruparCards', 'ordemDisponibilidade', 'ordenarCardsVitrine'], { ORDEM_TAMANHOS: [] });
  const ids = (grupos) => grupos.map(g => g.map(p => p.id).join('+'));

  it('disponíveis primeiro, depois Sob Encomenda, depois em condicional (mantendo a ordem de cada grupo)', () => {
    const lista = [
      { id: 1, status: 'CONDICIONAL', disponibilidade: 'PRONTA_ENTREGA' },
      { id: 2, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' },
      { id: 3, status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' },
      { id: 4, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' },
      { id: 5, status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' },
    ];
    assert.deepEqual([...ids(c.ordenarCardsVitrine(c.agruparCards(lista)))], ['3', '5', '2', '4', '1']);
  });

  it('um modelo com uma cor disponível vai para o começo, sem trocar a capa do card', () => {
    const lista = [
      { id: 1, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' },
      { id: 2, grade: 'NIX-01', status: 'CONDICIONAL', disponibilidade: 'PRONTA_ENTREGA' },
      { id: 3, grade: 'NIX-01', status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' },
    ];
    assert.deepEqual([...ids(c.ordenarCardsVitrine(c.agruparCards(lista)))], ['2+3', '1']);
  });

  it('o catálogo usa a ordem ao montar os cards', () => {
    assert.match(extrairFuncao('renderizarCatalogo'), /ordenarCardsVitrine\(agruparCards\(filtrados\)\)\.forEach/);
  });
});

describe('promoção escolhida: só os modelos da promoção nos chips', () => {
  const chips = { innerHTML: '', setAttribute() {}, classList: { toggle: (cl, v) => { chips.escondido = v; } } };
  const filtroFormato = { value: '' };
  const c = contexto(['escapeHtml', 'preencherFiltroFormato'], { chipsFormato: chips, filtroFormato, rotulos: { formato: 'Formato', formatos: 'TODOS' } });
  const rotulos = () => [...chips.innerHTML.matchAll(/class="chip-formato">([^<]*)</g)].map(m => m[1]);
  const produtos = [
    { formato: 'Aviador', anuncio_id: 7 },
    { formato: 'Gatinho', anuncio_id: 7 },
    { formato: 'Oval', anuncio_id: null },
    { formato: 'Quadrado', anuncio_id: 9 },
  ];

  it('sem promoção mostra todos os formatos', () => {
    c.produtos = produtos;
    vm.runInContext('produtos = this.produtos; promocaoFiltro = 0; preencherFiltroFormato();', c);
    assert.deepEqual(rotulos(), ['TODOS', 'Aviador', 'Gatinho', 'Oval', 'Quadrado']);
  });

  it('com a promoção mostra só os formatos que têm produto nela', () => {
    filtroFormato.value = 'Oval';
    vm.runInContext('promocaoFiltro = 7; preencherFiltroFormato();', c);
    assert.deepEqual(rotulos(), ['TODOS', 'Aviador', 'Gatinho']);
    assert.equal(filtroFormato.value, '', 'o formato fora da promoção volta para TODOS');
    assert.equal(chips.escondido, false);
    // promoção de um formato só: a fileira de chips some
    vm.runInContext('promocaoFiltro = 9; preencherFiltroFormato();', c);
    assert.equal(chips.escondido, true);
  });

  it('escolher ou tirar a promoção refaz os chips', () => {
    const inicio = html.indexOf('function aplicarFiltroPromocao(');
    const f = html.slice(inicio, html.indexOf('\n    }\n', inicio));
    assert.match(f, /renderizarPromocoes\(\);\s*preencherFiltroFormato\(\);\s*atualizarContagemFiltros\(\);/);
    // ao carregar, a promoção é conferida antes de montar os chips
    assert.match(html, /renderizarPromocoes\(\);\s*preencherFiltroFormato\(\);\s*preencherFiltroTamanho\(\);/);
  });
});
