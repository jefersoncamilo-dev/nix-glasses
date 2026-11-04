// Vitrine: atalhos Coleção / Pronta Entrega / Sob Encomenda, contagem das pílulas
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

const FUNCOES = ['ehSobEncomenda', 'passaFiltroStatus', 'contagemFiltros', 'textoGuiaCatalogo'];
const ctx = vm.createContext({ NICHO: 'oculos' });
vm.runInContext(`${FUNCOES.map(extrairFuncao).join('\n')}\n${FUNCOES.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);

const produtos = [
  { id: 1, status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' },
  { id: 2, status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' },
  { id: 3, status: 'CONDICIONAL', disponibilidade: 'PRONTA_ENTREGA' },
  { id: 4, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' },
];

describe('vitrine: atalhos e pílulas de filtro', () => {
  it('o topo tem Coleção, Pronta Entrega e Sob Encomenda no lugar de "Ver Coleção"', () => {
    assert.ok(!html.includes('>Ver Coleção<'));
    assert.match(html, /data-atalho-filtro="DISPONIVEL"[^>]*>Pronta Entrega </);
    assert.match(html, /data-atalho-filtro="SOB_ENCOMENDA"[^>]*>Sob Encomenda </);
    for (const filtro of ['""', '"DISPONIVEL"', '"SOB_ENCOMENDA"']) {
      assert.match(html, new RegExp(`data-atalho-filtro=${filtro}`));
      assert.match(html, new RegExp(`data-filtro=${filtro}`));
    }
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

  it('o botão principal é prateado como o "Coleção" e o atalho escolhido fica prateado', () => {
    assert.match(html, /\.btn-primario, \.btn\.atalho-topo\[aria-pressed="true"\][^{]*\{ background: linear-gradient\(180deg, #f5f5f5/);
    assert.match(html, /data-atalho-filtro="" aria-pressed="true"/);
    assert.match(html, /querySelectorAll\('\[data-atalho-filtro\]'\)\.forEach\(a => a\.setAttribute\('aria-pressed'/);
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
    assert.match(html, /<div id="chipsFormato" class="chips-formato hidden[^"]*" role="group"/);
    // os chips ficam logo abaixo das pílulas Coleção / Pronta Entrega / Sob Encomenda
    assert.ok(html.indexOf('id="chipsFormato"') > html.indexOf('id="filtroPilulas"'));
    assert.match(html, /\.chips-formato \{[^}]*overflow-x: auto/);

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

  it('um toque no chip filtra e marca só o chip escolhido', () => {
    const botoes = ['', 'Aviador', 'Oval'].map(f => ({ dataset: { formato: f }, atributos: {}, setAttribute(k, v) { this.atributos[k] = v; } }));
    let renderizou = 0;
    const filtroFormato = { value: '' };
    const c = vm.createContext({ chipsFormato: { querySelectorAll: () => botoes }, filtroFormato, renderizarCatalogo: () => renderizou++ });
    vm.runInContext(`${extrairFuncao('aplicarFiltroFormato')}; this.f = aplicarFiltroFormato;`, c);
    c.f('Oval');
    assert.equal(filtroFormato.value, 'Oval');
    assert.deepEqual(botoes.map(b => b.atributos['aria-pressed']), ['false', 'false', 'true']);
    assert.equal(renderizou, 1);
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

  it('"Como funciona" em 3 passos com ícones de linha, logo abaixo do banner', () => {
    const secao = html.match(/<section id="comoFunciona"[\s\S]*?<\/section>/);
    assert.ok(secao, 'faltou a seção Como funciona');
    assert.ok(html.indexOf('id="comoFunciona"') < html.indexOf('id="catalogo"'));
    assert.ok(html.indexOf('id="comoFunciona"') > html.indexOf('data-loja="chamada"'));
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
});
