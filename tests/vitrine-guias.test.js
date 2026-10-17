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
const ctx = vm.createContext({});
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

  it('o filtro de formato só aparece com dois formatos ou mais', () => {
    const el = { innerHTML: '', appendChild() {}, classList: { toggle: (c, v) => { el.escondido = v; } } };
    const c = vm.createContext({ document: { createElement: () => ({}) }, filtroFormato: el });
    vm.runInContext(`${extrairFuncao('preencherFiltroFormato')}; this.f = preencherFiltroFormato;`, c);
    c.produtos = [{ formato: 'Aviador' }, { formato: 'Aviador' }];
    vm.runInContext('produtos = this.produtos; f();', c);
    assert.equal(el.escondido, true);
    c.produtos = [{ formato: 'Aviador' }, { formato: 'Redondo' }];
    vm.runInContext('produtos = this.produtos; f();', c);
    assert.equal(el.escondido, false);
  });

  it('as animações de orientação param com prefers-reduced-motion', () => {
    const bloco = html.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.guia-cutuca[^}]*\}/);
    assert.ok(bloco, 'faltou desligar as animações de guia');
  });
});
