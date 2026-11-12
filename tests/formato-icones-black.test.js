'use strict';
// Vitrine no celular: formatos de óculos só com o desenho (sem o nome escrito) e o botão
// da promoção do momento (ex.: BLACK NIX) na barra de filtros, ao lado do gênero.
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

describe('chips de formato só com o desenho do óculos', () => {
  const chips = { innerHTML: '', setAttribute() {}, classList: { toggle: (c, v) => { chips.escondido = v; } } };
  const filtroFormato = { value: '' };
  const c = vm.createContext({ chipsFormato: chips, filtroFormato, filtroGenero: { value: '' }, promocaoFiltro: 0 });
  vm.runInContext(`${['escapeHtml', 'passaFiltroGenero', 'produtosDoGenero', 'iconeFormato', 'preencherFiltroFormato'].map(extrairFuncao).join('\n')}; this.f = preencherFiltroFormato; this.icone = iconeFormato;`, c);

  it('tem desenho para os formatos da loja (com e sem acento, maiúsculas, feminino)', () => {
    for (const f of ['AVIADOR', 'Redondo', 'redonda', 'QUADRADO', 'Quadrada', 'ESPORTIVO', 'Hexagonal', 'Gatinho', 'Oval', 'Retangular', 'Máscara', 'Shield', 'Geométrico']) {
      assert.match(c.icone(f), /^<svg class="icone-formato"[^>]*aria-hidden="true">/, f);
    }
    assert.equal(c.icone('Clubmaster'), '');
    assert.equal(c.icone(''), '');
  });

  it('óculos: só os desenhos, sem "TODOS" (tocar de novo no escolhido volta a todos)', () => {
    c.rotulos = { formato: 'Formato da lente', formatos: 'TODOS', icones: true };
    c.produtos = [{ formato: 'AVIADOR' }, { formato: 'ESPORTIVO' }, { formato: 'REDONDO' }];
    vm.runInContext('produtos = this.produtos; rotulos = this.rotulos; f();', c);
    assert.doesNotMatch(chips.innerHTML, /data-formato=""/);
    assert.equal((chips.innerHTML.match(/chip-icone/g) || []).length, 3);
    assert.match(html, /aplicarFiltroFormato\(rotulos\.icones && chip\.dataset\.formato && chip\.dataset\.formato === filtroFormato\.value \? '' : chip\.dataset\.formato\)/);
  });

  it('óculos com um formato sem desenho: "TODOS" volta e o formato fica escrito', () => {
    c.rotulos = { formato: 'Formato da lente', formatos: 'TODOS', icones: true };
    c.produtos = [{ formato: 'AVIADOR' }, { formato: 'ESPORTIVO' }, { formato: 'Clubmaster' }];
    vm.runInContext('produtos = this.produtos; rotulos = this.rotulos; f();', c);
    assert.match(chips.innerHTML, /data-formato="" aria-pressed="true" class="chip-formato">TODOS</);
    assert.match(chips.innerHTML, /data-formato="AVIADOR" aria-pressed="false" class="chip-formato chip-icone" aria-label="AVIADOR" title="AVIADOR"><svg/);
    assert.match(chips.innerHTML, /data-formato="ESPORTIVO"[^>]*class="chip-formato chip-icone"/);
    assert.doesNotMatch(chips.innerHTML, />AVIADOR</);
    // formato sem desenho continua com o nome
    assert.match(chips.innerHTML, /class="chip-formato">Clubmaster</);
  });

  it('roupas/geral: categorias continuam escritas', () => {
    c.rotulos = { formato: 'Categoria', formatos: 'TODAS' };
    c.produtos = [{ formato: 'Oval' }, { formato: 'Camiseta' }];
    vm.runInContext('produtos = this.produtos; rotulos = this.rotulos; f();', c);
    assert.doesNotMatch(chips.innerHTML, /chip-icone|<svg/);
    assert.match(chips.innerHTML, /class="chip-formato">Oval</);
  });

  it('no celular o botão de formato tem altura boa para o dedo', () => {
    assert.match(html, /#chipsFormato \.chip-icone \{ min-height: 36px;/);
    assert.match(html, /oculos: \{[^}]*icones: true/);
  });
});

describe('botão da promoção do momento na barra de filtros', () => {
  it('fica nas pílulas do topo, depois do WhatsApp e do Instagram', () => {
    assert.match(html, /<a id="topoInstagram"[\s\S]*?<\/a>\s*<!--[\s\S]*?-->\s*<div id="promocoesFiltro" class="hidden promocoes-filtro" role="group" aria-label="Promoção do momento"><\/div>/);
    assert.match(extrairFuncao('renderizarPromocoes'), /if \(visiveis\.length\) document\.getElementById\('redesTopo'\)\?\.classList\?\.remove\('hidden'\)/);
  });

  function montar(anuncios, produtos, promocaoFiltro = 0) {
    const el = () => ({ innerHTML: '', attrs: {}, escondido: null, setAttribute(k, v) { this.attrs[k] = v; }, classList: { toggle(c, v) { this.dono.escondido = v; } } });
    const els = { botoesPromocao: el(), promocoesVitrine: el(), promocoesFiltro: el(), chipPromocao: el() };
    for (const e of Object.values(els)) e.classList.dono = e;
    const c = vm.createContext({ anuncios, produtos, promocaoFiltro, document: { getElementById: (id) => els[id] } });
    vm.runInContext(`${['escapeHtml', 'promocoesComModelos', 'anuncioPorId', 'renderizarPromocoes'].map(extrairFuncao).join('\n')}; renderizarPromocoes();`, c);
    return els;
  }

  const anuncios = [{ id: 1, nome: 'Black Friday', botao_texto: 'BLACK NIX', selo_url: '/imagens/selo' }, { id: 2, nome: 'Natal', botao_texto: 'Encomenda de Natal', selo_url: '' }];
  const produtos = [{ anuncio_id: 1 }, { anuncio_id: null }];

  it('mostra o botão prateado com o texto configurado (BLACK NIX), só das promoções com modelo', () => {
    const els = montar(anuncios, produtos);
    assert.equal(els.promocoesFiltro.escondido, false);
    assert.match(els.promocoesFiltro.innerHTML, /data-promocao="1" aria-pressed="false" class="btn btn-primario botao-promocao-filtro" aria-label="Promoção Black Friday"><span>BLACK NIX<\/span><\/button>/);
    assert.doesNotMatch(els.promocoesFiltro.innerHTML, /Natal/);
  });

  it('escolhida: fica marcada com o X e o chip repetido some', () => {
    const els = montar(anuncios, produtos, 1);
    assert.match(els.promocoesFiltro.innerHTML, /aria-pressed="true"[^>]*: toque para ver todos os modelos">[\s\S]*&times;/);
    assert.equal(els.chipPromocao.escondido, true);
  });

  it('sem promoção com modelo: botão escondido', () => {
    const els = montar(anuncios, [{ anuncio_id: null }]);
    assert.equal(els.promocoesFiltro.escondido, true);
    assert.equal(els.promocoesFiltro.innerHTML, '');
  });

  it('um toque filtra sem rolar a página (outro toque volta a todos)', () => {
    assert.match(html, /getElementById\('promocoesFiltro'\)\.addEventListener\('click'[\s\S]{0,160}aplicarFiltroPromocao\(b\.dataset\.promocao, \{ rolar: false \}\)/);
  });
});

describe('celular: layout do exemplo', () => {
  it('topo com menu, logo no centro e maleta; cliente vai para o menu', () => {
    assert.match(html, /<div class="topo-celular flex items-center justify-between h-14 sm:h-16">\s*<!--[^>]*-->\s*<button type="button" id="abrirMenu" class="sm:hidden/);
    assert.match(html, /<button id="btnCliente" class="hidden sm:flex/);
    assert.match(html, /<div id="menuCelular" class="fixed inset-0 z-\[60\] hidden" role="dialog"/);
    assert.match(html, /data-menu="comoFunciona"[\s\S]*data-menu="cliente"/);
    assert.match(html, /menu: \(\) => fecharMenu\(\)/, 'o Voltar do celular fecha o menu');
  });

  it('busca filtra por nome, cor, formato, material e tipo, sem acento e em qualquer ordem', () => {
    const c = vm.createContext({});
    vm.runInContext(`${['normalizarBusca', 'passaBusca'].map(extrairFuncao).join('\n')}; this.b = passaBusca;`, c);
    const p = { nome: 'Nix Rex Aviador - Preto', nome_curto: 'Nix Rex', cor_armacao: 'Preto', formato: 'AVIADOR', material: 'Metal', tipo: 'Polarizado', codigo_sku: 'SAR-9073' };
    assert.equal(c.b(p, 'rex'), true);
    assert.equal(c.b(p, 'aviador preto'), true);
    assert.equal(c.b(p, 'METAL polarizado'), true);
    assert.equal(c.b(p, 'sar-9073'), true);
    assert.equal(c.b({ ...p, cor_armacao: 'Marrom Tartaruga' }, 'tartaruga'), true);
    assert.equal(c.b({ ...p, material: 'Acetato' }, 'acetáto'), true);
    assert.equal(c.b(p, 'redondo'), false);
    assert.match(html, /<input type="search" id="buscaVitrine" placeholder="Buscar modelo, cor ou formato"/);
    assert.match(extrairFuncao('renderizarCatalogo'), /termoBusca && !passaBusca\(p, termoBusca\)/);
  });

  it('título da lista: formato, promoção ou busca, com quantos modelos', () => {
    const el = () => ({ textContent: '' });
    const els = { tituloListaNome: el(), tituloListaInfo: el() };
    const c = vm.createContext({ document: { getElementById: id => els[id] }, filtroFormato: { value: 'AVIADOR' }, promocaoFiltro: 0, termoBusca: '', anuncios: [{ id: 1, nome: 'Black Friday', botao_texto: 'BLACK NIX' }] });
    vm.runInContext(`${['anuncioPorId', 'atualizarTituloLista'].map(extrairFuncao).join('\n')}; this.t = atualizarTituloLista;`, c);
    c.t(8);
    assert.equal(els.tituloListaNome.textContent, 'Aviador');
    assert.equal(els.tituloListaInfo.textContent, '8 modelos · Disponíveis primeiro');
    vm.runInContext('promocaoFiltro = 1; filtroFormato.value = ""; t(1);', c);
    assert.equal(els.tituloListaNome.textContent, 'BLACK NIX');
    assert.equal(els.tituloListaInfo.textContent, '1 modelo');
    vm.runInContext('promocaoFiltro = 0; termoBusca = "preto"; t(0);', c);
    assert.equal(els.tituloListaNome.textContent, '“preto”');
  });

  it('botão + na foto: põe na maleta, abre as cores quando há várias e vira o check verde', () => {
    const c = vm.createContext({ ehSobEncomenda: p => p.status === 'SOB_ENCOMENDA', nomeCard: p => p.nome_curto, escapeHtml: s => String(s) });
    vm.runInContext(`${extrairFuncao('botaoFotoCard')}; this.f = botaoFotoCard;`, c);
    assert.match(c.f([{ id: 7, nome_curto: 'Nix Rex', status: 'DISPONIVEL' }], false), /onclick="toggleMaleta\(7\)" aria-pressed="false" class="btn-foto-maleta" aria-label="Colocar Nix Rex na maleta"/);
    assert.match(c.f([{ id: 7, nome_curto: 'Nix Rex', status: 'DISPONIVEL' }], true), /class="btn-foto-maleta na-maleta" aria-label="Tirar Nix Rex da maleta"/);
    assert.match(c.f([{ id: 7, nome_curto: 'Nix Rex' }, { id: 8, nome_curto: 'Nix Rex' }], false), /onclick="abrirDetalhes\(7\)"[^>]*aria-label="Escolher a cor de Nix Rex"/);
    assert.match(c.f([{ id: 9, nome_curto: 'Nix Dilo', status: 'SOB_ENCOMENDA' }], false), /class="btn-foto-maleta encomenda" aria-label="Encomendar Nix Dilo"/);
    // o clique troca também o botão da foto, sem redesenhar o catálogo
    assert.match(extrairFuncao('atualizarCardMaleta'), /\[data-acao-foto\][\s\S]*botaoFotoCard\(/);
  });
});
