// Vitrine: atalhos Coleção / Disponíveis / Sob Encomenda, contagem das pílulas
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
  it('o topo tem Coleção, Disponíveis e Sob Encomenda no lugar de "Ver Coleção"', () => {
    assert.ok(!html.includes('>Ver Coleção<'));
    for (const filtro of ['""', '"DISPONIVEL"', '"SOB_ENCOMENDA"']) {
      assert.match(html, new RegExp(`data-atalho-filtro=${filtro}`));
      assert.match(html, new RegExp(`data-filtro=${filtro}`));
    }
  });

  it('conta todos na Coleção, só pronta entrega livre em Disponíveis e só encomendas em Sob Encomenda', () => {
    const c = ctx.contagemFiltros(produtos);
    assert.equal(c[''], 4);
    assert.equal(c.DISPONIVEL, 2);
    assert.equal(c.SOB_ENCOMENDA, 1);
  });

  it('o texto de orientação explica o filtro e o próximo passo', () => {
    assert.match(ctx.textoGuiaCatalogo('', 0), /Coleção completa.*\+ Maleta.*provar em casa/);
    assert.match(ctx.textoGuiaCatalogo('DISPONIVEL', 0), /Pronta entrega/);
    assert.match(ctx.textoGuiaCatalogo('SOB_ENCOMENDA', 0), /sinal de 50%/);
    assert.match(ctx.textoGuiaCatalogo('', 1), /1 modelo\. .*WhatsApp/);
    assert.match(ctx.textoGuiaCatalogo('', 3), /3 modelos/);
  });

  it('as animações de orientação param com prefers-reduced-motion', () => {
    const bloco = html.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.guia-seta[^}]*\}/);
    assert.ok(bloco, 'faltou desligar as animações de guia');
  });
});
