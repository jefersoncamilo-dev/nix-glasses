// Vitrine: banner do Provador Virtual no topo, contagem das pílulas
// de filtro e o texto de orientação acima dos cards.
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

const FUNCOES = ['ehSobEncomenda', 'passaFiltroStatus', 'ordemTamanho', 'agruparCards', 'contagemFiltros', 'textoGuiaCatalogo'];
const ctx = vm.createContext({ NICHO: 'oculos' });
vm.runInContext(`${FUNCOES.map(extrairFuncao).join('\n')}\n${FUNCOES.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);

const produtos = [
  { id: 1, status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' },
  { id: 2, status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' },
  { id: 3, status: 'CONDICIONAL', disponibilidade: 'PRONTA_ENTREGA' },
  { id: 4, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' },
];

describe('vitrine: atalhos e pílulas de filtro', () => {
  it('o topo convida para o Provador Virtual (sem repetir os filtros do catálogo)', () => {
    assert.doesNotMatch(html, /data-atalho-filtro|atalho-topo/);
    const banner = html.match(/<div id="bannerProvador"[\s\S]*?<button type="button" id="abrirProvadorTopo" class="btn btn-primario[^"]*">[\s\S]*?<\/button>/);
    assert.ok(banner, 'faltou o banner do provador com o botão principal');
    assert.match(banner[0], /Provador Virtual/);
    // no celular o card é compacto: uma linha (visor, texto e botão lado a lado); só a
    // partir do tablet (md:) ele vira o card vertical do novo design
    assert.match(banner[0], /<div id="bannerProvador" class="[^"]*\bflex items-center\b/);
    assert.doesNotMatch(banner[0], /(^|[\s"])flex-col\b|btn-lg/);
    assert.match(banner[0], /<div id="bannerProvador" class="[^"]*\bmd:flex-col\b/);
    // visor de escaneamento: grade, quatro cantoneiras, linha laser e o selo de Realidade Aumentada
    assert.match(banner[0], /provador-visor/);
    assert.match(banner[0], /provador-grade/);
    assert.equal((banner[0].match(/provador-canto provador-canto-\d/g) || []).length, 4);
    assert.match(banner[0], /provador-laser/);
    assert.match(banner[0], /Realidade Aumentada/);
    assert.match(banner[0], /<span>Experimentar<span class="hidden md:inline"> Agora<\/span><\/span>/);
    // o card inteiro abre o provador, sem disparar duas vezes pelo botão
    assert.match(html, /getElementById\('bannerProvador'\)\.addEventListener\('click', e => \{ if \(!e\.target\.closest\('#abrirProvadorTopo'\)\) abrirProvadorTopo\(\); \}\)/);
    // a linha laser para quando a pessoa pede menos movimento
    assert.match(html, /prefers-reduced-motion: reduce\) \{ \.provador-laser \{ animation: none/);
    // o hero não tem mais blocos de texto/tutorial antes do catálogo
    const hero = html.match(/<section id="hero"[\s\S]*?<\/section>/)[0];
    assert.ok(hero.includes('id="bannerProvador"'));
    assert.doesNotMatch(hero, /data-passo/);
    assert.match(html, /getElementById\('abrirProvadorTopo'\)\.addEventListener\('click', abrirProvadorTopo\)/);
    // loja que não é de óculos: some o banner e fica o atalho para a coleção
    assert.match(html, /if \(!provadorLigado\(\)\) \{\s*document\.getElementById\('bannerProvador'\)\.classList\.add\('hidden'\);\s*document\.getElementById\('heroColecao'\)\.classList\.remove\('hidden'\)/);
    // as pílulas do catálogo continuam com os três filtros
    for (const filtro of ['""', '"DISPONIVEL"', '"SOB_ENCOMENDA"']) assert.match(html, new RegExp(`data-filtro=${filtro}`));
  });

  it('o botão do topo abre o provador com um modelo com foto, de preferência pronta entrega', () => {
    const c = vm.createContext({});
    vm.runInContext(`${['fotosDoProduto', 'fotoProvador', 'ehSobEncomenda', 'passaFiltroStatus', 'produtoParaProvadorTopo'].map(extrairFuncao).join('\n')}; this.f = produtoParaProvadorTopo;`, c);
    // só capa (sem foto 4) não conta: o provador usa só a foto do provador
    const semFoto = { id: 1, imagem_url: 'capa.jpg', status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' };
    const encomenda = { id: 2, imagem_url: 'a.jpg', foto_provador: 'pa.png', status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' };
    const pronta = { id: 3, imagem_url: 'b.jpg', foto_provador: 'pb.png', status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' };
    assert.equal(c.f([semFoto, encomenda, pronta]).id, 3);
    assert.equal(c.f([semFoto, encomenda]).id, 2);
    assert.equal(c.f([semFoto]), null);
    assert.equal(c.f([]), null);
  });

  it('conta todos na Coleção, só pronta entrega livre em Pronta Entrega e só encomendas em Sob Encomenda', () => {
    const c = ctx.contagemFiltros(produtos);
    assert.equal(c[''], 4);
    assert.equal(c.DISPONIVEL, 2);
    assert.equal(c.SOB_ENCOMENDA, 1);
  });

  it('a orientação é uma linha: o primeiro passo na Coleção ou o que o filtro mostra', () => {
    assert.match(ctx.textoGuiaCatalogo('', 0), /\+ Maleta.*provar em casa/);
    assert.match(ctx.textoGuiaCatalogo('DISPONIVEL', 0), /Pronta entrega/);
    assert.match(ctx.textoGuiaCatalogo('SOB_ENCOMENDA', 0), /sinal de 50%/);
    // com modelos escolhidos a barra "Ver maleta" já mostra o próximo passo
    assert.equal(ctx.textoGuiaCatalogo('', 2), '');
    assert.match(ctx.textoGuiaCatalogo('SOB_ENCOMENDA', 2), /sinal de 50%/);
    assert.doesNotMatch(html, /id="guiaCatalogo"[^>]*bg-orange-50/);
  });

  it('os botões de ação usam o padrão .btn (sem laranja/azul/verde soltos)', () => {
    assert.doesNotMatch(html, /bg-orange-500 hover:bg-orange-600|bg-blue-600 hover:bg-blue-700|bg-green-500 hover:bg-green-600/);
    for (const id of ['barraMaleta', 'finalizarPedido', 'enviarCliente', 'sairCliente', 'fotoProvador', 'maletaProvador', 'whatsappLink']) {
      assert.match(html, new RegExp(`id="${id}"[^>]*class="[^"]*\\bbtn\\b`), id);
    }
  });

  it('o botão principal e a pílula escolhida são prateados', () => {
    assert.match(html, /\.btn-primario, \.filtro-pilula\[aria-pressed="true"\][^{]*\{ background: linear-gradient\(180deg, #f5f5f5/);
  });

  it('maleta: endereço editável que aparece depois do CEP e texto que serve para qualquer loja', () => {
    assert.doesNotMatch(html, /id="(ruaCliente|bairroCliente|cidadeCliente)"[^>]*readonly/);
    assert.match(html, /<div id="enderecoCliente" class="hidden /);
    assert.match(extrairFuncao('mostrarEndereco'), /enderecoCliente'\)\.classList\.remove\('hidden'\)/);
    assert.doesNotMatch(html, /Adicione óculos/);
    assert.match(html, /id="verModelosMaleta"/);
  });

  it('os formatos viram chips (sem o <select>): ordem alfabética, "Todos" primeiro e só com dois formatos ou mais', () => {
    assert.doesNotMatch(html, /<select id="filtroFormato"/);
    assert.match(html, /<input type="hidden" id="filtroFormato" value="">/);
    // tela inicial: só os chips de modelo (formato). Gênero e Pronta Entrega /
    // Sob Encomenda não aparecem antes de escolher um modelo.
    const fileira = html.match(/<div id="filtrosRolagem" class="chips-formato[^"]*">[\s\S]*?<\/div>\s*<\/div>/);
    assert.ok(fileira, 'faltou a fileira dos modelos');
    assert.match(fileira[0], /<div id="chipsFormato" class="chips-grupo hidden[^"]*"[^>]*role="group"/);
    assert.doesNotMatch(fileira[0], /data-filtro=|filtroGenero/);
    const pilulas = html.match(/<div id="filtroPilulas" class="hidden"[\s\S]*?<\/div>\s*<\/div>/);
    assert.ok(pilulas, 'as pílulas de disponibilidade deveriam começar escondidas');
    for (const f of ['', 'DISPONIVEL', 'SOB_ENCOMENDA']) assert.match(pilulas[0], new RegExp(`data-filtro="${f}" aria-pressed="(true|false)" class="chip-formato filtro-pilula"`));
    assert.match(html, /<select id="filtroGenero" class="hidden /);
    assert.doesNotMatch(html, /filtroGenero\.classList\.toggle|function preencherFiltroGenero/);
    assert.match(html, /\.chips-formato \{[^}]*overflow-x: auto/);
    // botão "TODOS" e, no celular, os modelos numa linha só (chips compactos que dividem a largura)
    assert.match(html, /oculos: \{[^}]*formatos: 'TODOS'/);
    assert.match(html, /@media \(max-width: 639px\) \{[\s\S]*?#chipsFormato \{ flex-wrap: nowrap;[\s\S]*?font-size: 0\.625rem/);

    const chips = { innerHTML: '', setAttribute() {}, classList: { toggle: (c, v) => { chips.escondido = v; } } };
    const filtroFormato = { value: '' };
    const c = vm.createContext({ chipsFormato: chips, filtroFormato, rotulos: { formato: 'Formato da lente', formatos: 'Todos os formatos' } });
    vm.runInContext(`${extrairFuncao('escapeHtml')}\n${extrairFuncao('preencherFiltroFormato')}; this.f = preencherFiltroFormato;`, c);
    c.produtos = [{ formato: 'Aviador' }, { formato: 'Aviador' }];
    vm.runInContext('produtos = this.produtos; f();', c);
    assert.equal(chips.escondido, true);

    c.produtos = [{ formato: 'Quadrado' }, { formato: 'Aviador' }, { formato: 'Gatinho arredondado' }, { formato: '<img src=x onerror=alert(1)>' }];
    filtroFormato.value = 'Quadrado';
    vm.runInContext('produtos = this.produtos; f();', c);
    assert.equal(chips.escondido, false);
    const rotulos = [...chips.innerHTML.matchAll(/class="chip-formato">([^<]*)</g)].map(m => m[1]);
    assert.deepEqual(rotulos, ['Todos os formatos', '&lt;img src=x onerror=alert(1)&gt;', 'Aviador', 'Gatinho arredondado', 'Quadrado']);
    assert.match(chips.innerHTML, /data-formato="Quadrado" aria-pressed="true"/);
    assert.match(chips.innerHTML, /data-formato="" aria-pressed="false"/);

    // o formato escolhido saiu do catálogo: volta para "Todos"
    c.produtos = [{ formato: 'Aviador' }, { formato: 'Oval' }];
    vm.runInContext('produtos = this.produtos; f();', c);
    assert.equal(filtroFormato.value, '');
    assert.match(chips.innerHTML, /data-formato="" aria-pressed="true"/);
  });

  it('um toque no chip filtra e marca só o chip escolhido; "Todos" volta a disponibilidade para Todos', () => {
    const botoes = ['', 'Aviador', 'Oval'].map(f => ({ dataset: { formato: f }, atributos: {}, setAttribute(k, v) { this.atributos[k] = v; } }));
    const chamadas = [];
    const filtroFormato = { value: '' };
    const c = vm.createContext({
      chipsFormato: { querySelectorAll: () => botoes }, filtroFormato,
      marcarFiltroStatus: (f) => chamadas.push(`status:${f}`),
      atualizarContagemFiltros: () => chamadas.push('contagem'),
      renderizarCatalogo: () => chamadas.push('render'),
      atualizarGuias: () => chamadas.push('guias'),
    });
    vm.runInContext(`${extrairFuncao('aplicarFiltroFormato')}; this.f = aplicarFiltroFormato;`, c);
    c.f('Oval');
    assert.equal(filtroFormato.value, 'Oval');
    assert.deepEqual(botoes.map(b => b.atributos['aria-pressed']), ['false', 'false', 'true']);
    assert.deepEqual(chamadas, ['contagem', 'render', 'guias']);
    chamadas.length = 0;
    c.f('');
    assert.deepEqual(chamadas, ['status:', 'contagem', 'render', 'guias']);
  });

  it('Pronta Entrega / Sob Encomenda só aparecem depois de escolher um modelo', () => {
    const c = vm.createContext({});
    vm.runInContext(`${extrairFuncao('pilulasVisiveis')}; this.f = pilulasVisiveis;`, c);
    assert.equal(c.f('', true, 10), false); // tela inicial
    assert.equal(c.f('Aviador', true, 10), true); // modelo escolhido
    assert.equal(c.f('', false, 10), true); // loja com um formato só: sem chips de modelo
    assert.equal(c.f('', false, 0), false); // catálogo vazio
    // a contagem das pílulas é só do modelo escolhido
    const fn = extrairFuncao('atualizarContagemFiltros');
    assert.match(fn, /formato \? daPromocao\.filter\(p => p\.formato === formato\)/);
    // e, com uma promoção escolhida, só dos modelos dela
    assert.match(fn, /promocaoFiltro \? produtos\.filter\(p => Number\(p\.anuncio_id\) === promocaoFiltro\)/);
  });

  it('barra flutuante da maleta: contador + "Ver Maleta"; aparece com o 1º modelo ou ao rolar no celular', () => {
    assert.match(html, /<button type="button" id="barraMaleta" class="escondida vazia btn barra-maleta fixed[^"]*"/);
    assert.match(html, /id="barraMaleta"[\s\S]{0,1200}id="barraMaletaTexto"[\s\S]{0,400}Ver Maleta/);
    assert.match(html, /window\.addEventListener\('scroll', agendarBarraMaleta, \{ passive: true \}\)/);
    assert.match(html, /\.btn\.barra-maleta \{ bottom: calc\(0\.75rem \+ env\(safe-area-inset-bottom/);

    const estado = (itens, janela) => {
      const classes = new Set(['escondida', 'vazia']);
      const els = { barraMaleta: { classList: { add: (k) => classes.add(k), remove: (k) => classes.delete(k) } }, barraMaletaTexto: { textContent: '' } };
      const c = vm.createContext({ maleta: { itens }, document: { getElementById: (id) => els[id] }, ...(janela ? { window: janela } : {}) });
      vm.runInContext(`${extrairFuncao('atualizarBarraMaleta')}; atualizarBarraMaleta();`, c);
      return { texto: els.barraMaletaTexto.textContent, escondida: classes.has('escondida'), vazia: classes.has('vazia') };
    };
    assert.deepEqual(estado([], { innerWidth: 390, scrollY: 0 }), { texto: 'Sua maleta está vazia', escondida: true, vazia: true });
    assert.deepEqual(estado([], { innerWidth: 390, scrollY: 900 }), { texto: 'Sua maleta está vazia', escondida: false, vazia: true });
    assert.equal(estado([], { innerWidth: 1366, scrollY: 900 }).escondida, true); // computador: só com modelos
    assert.deepEqual(estado([{ id: 1 }], { innerWidth: 390, scrollY: 0 }), { texto: '1 modelo na maleta', escondida: false, vazia: false });
    assert.equal(estado([{ id: 1 }, { id: 2 }]).texto, '2 modelos na maleta');
  });

  it('"Como funciona" sai do fluxo: link discreto no topo abre uma janela com os 3 passos', () => {
    assert.doesNotMatch(html, /<section id="comoFunciona"/);
    const link = html.match(/<button type="button" id="abrirComoFunciona" class="link-ajuda[^"]*"[^>]*aria-controls="modalComoFunciona">[\s\S]*?<\/button>/);
    assert.ok(link, 'faltou o link "Como funciona a maleta"');
    assert.match(link[0], /\?<\/span>\s*Como funciona a maleta/);
    assert.ok(html.indexOf('id="abrirComoFunciona"') < html.indexOf('id="catalogo"'));
    const secao = html.match(/<div id="modalComoFunciona" class="fixed inset-0 [^"]*hidden[^"]*" role="dialog" aria-modal="true"[\s\S]*?id="entendiComoFunciona"/);
    assert.ok(secao, 'faltou a janela Como funciona');
    // o Voltar do celular fecha a janela (histórico), como as outras
    assert.match(html, /comoFunciona: \(\) => fecharComoFunciona\(\)/);
    assert.match(extrairFuncao('abrirComoFunciona'), /entrarModalHistorico\('comoFunciona'\)/);
    assert.match(extrairFuncao('fecharComoFunciona'), /sairModalHistorico\('comoFunciona'\)/);
    const passos = [...secao[0].matchAll(/<li data-passo="(\d)"[\s\S]*?<svg[^>]*fill="none" stroke="currentColor"[\s\S]*?text-white[^"]*">([^<]+)<\/span>\s*<span[^>]*>([^<]+)<\/span>/g)];
    assert.deepEqual(passos.map(m => [m[1], m[2], m[3]]), [
      ['1', 'Monte a Maleta', 'Escolha seus modelos favoritos'],
      ['2', 'Receba em Casa', 'Experimente sem compromisso'],
      ['3', 'Pague o que Ficar', 'Devolva o restante com facilidade'],
    ]);
  });

  it('as animações de orientação param com prefers-reduced-motion', () => {
    const bloco = html.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.guia-cutuca[^}]*\}/);
    assert.ok(bloco, 'faltou desligar as animações de guia');
  });

  it('pop-up do Provador Virtual (quando escolhido no painel): só no celular, loja de óculos, a cada entrada no site e com modelo para provar', () => {
    const ctxPopup = vm.createContext({});
    vm.runInContext(`${extrairFuncao('devePopupProvador')}\nthis.devePopupProvador = devePopupProvador;`, ctxPopup);
    const deve = ctxPopup.devePopupProvador;
    assert.equal(deve(390, undefined, true), true);
    assert.equal(deve(390, true, true), true);
    assert.equal(deve(768, true, true), false, 'no computador/tablet não abre');
    assert.equal(deve(390, false, true), false, 'loja que não é de óculos não tem provador');
    assert.equal(deve(390, true, false), false, 'sem modelo com foto não há o que provar');
    // a janela tem o card grande, o X, o "Agora não" e o botão que abre a câmera
    const popup = html.match(/<div id="popupProvador"[\s\S]*?id="agoraNaoPopupProvador"[^>]*>/);
    assert.ok(popup, 'faltou o pop-up do provador');
    for (const parte of ['role="dialog"', 'aria-modal="true"', 'id="fecharPopupProvador"', 'provador-visor', 'provador-laser', 'Realidade Aumentada', 'Experimentar Agora']) assert.ok(popup[0].includes(parte), parte);
    assert.match(html, /getElementById\('experimentarPopupProvador'\)\.addEventListener\('click', \(\) => \{\s*fecharPopupProvador\(\);\s*abrirProvadorTopo\(\);/);
    // aparece em toda entrada (sem guardar "já visto"), fecha pelo Voltar e é agendado depois de carregar os óculos
    assert.doesNotMatch(html, /CHAVE_POPUP_PROVADOR|popupProvadorJaVisto/);
    assert.match(html, /popupProvador: \(\) => fecharPopupProvador\(\)/);
    // o pop-up da tela inicial agora é escolhido no painel (POP Anúncio): o do provador só
    // abre quando a escolha é "Provador Virtual"
    assert.match(html, /renderizarCatalogo\(\);\s*agendarPopupInicial\(\);/);
    assert.match(extrairFuncao('agendarPopupInicial'), /popupInicial\.tipo === 'provador'\) return agendarPopupProvador\(\)/);
  });
});
