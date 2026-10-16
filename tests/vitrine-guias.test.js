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

  it('o texto de orientação explica o filtro e o próximo passo', () => {
    assert.match(ctx.textoGuiaCatalogo('', 0), /Coleção completa.*\+ Maleta.*provar em casa/);
    assert.match(ctx.textoGuiaCatalogo('DISPONIVEL', 0), /Pronta entrega/);
    assert.match(ctx.textoGuiaCatalogo('SOB_ENCOMENDA', 0), /sinal de 50%/);
    assert.match(ctx.textoGuiaCatalogo('', 1), /1 modelo\. .*WhatsApp/);
    assert.match(ctx.textoGuiaCatalogo('', 3), /3 modelos/);
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

  it('as animações de orientação param com prefers-reduced-motion', () => {
    const bloco = html.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.guia-seta[^}]*\}/);
    assert.ok(bloco, 'faltou desligar as animações de guia');
  });
});
