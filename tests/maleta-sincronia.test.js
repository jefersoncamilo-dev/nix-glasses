// A maleta salva no navegador acompanha o catálogo: peças que saíram de venda
// (ou cujo id passou a ser outro produto depois de zerar os dados) são retiradas.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extrairFuncao(nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}
const ctx = vm.createContext({});
vm.runInContext(`${extrairFuncao('sincronizarMaleta')}\nthis.sincronizarMaleta = sincronizarMaleta;`, ctx);
const copia = (v) => JSON.parse(JSON.stringify(v));

describe('vitrine: maleta sincronizada com o catálogo', () => {
  const catalogo = [
    { id: 1, codigo_sku: 'NIX001', nome: 'NIX Brachio', preco_venda: '129.90', imagem_url: '/imagens/a' },
    { id: 2, codigo_sku: 'NIX002', nome: 'NIX Rex', preco_venda: '129.90', imagem_url: '/imagens/b' },
  ];

  it('tira peças que não estão mais no catálogo', () => {
    const maleta = { itens: [{ id: 2, sku: 'NIX002', nome: 'NIX Rex', preco: 129.9 }, { id: 9, sku: 'X9', nome: 'Velho', preco: 50 }] };
    assert.equal(ctx.sincronizarMaleta(maleta, catalogo), 1);
    assert.deepEqual(copia(maleta.itens.map((i) => i.id)), [2]);
  });

  it('tira a peça cujo id agora é outro produto (dados zerados)', () => {
    const maleta = { itens: [
      { id: 1, nome: 'Óculos de teste', preco: 99 },          // maleta antiga, sem SKU
      { id: 2, sku: 'TESTE-2', nome: 'NIX Rex', preco: 99 },  // SKU diferente
    ] };
    assert.equal(ctx.sincronizarMaleta(maleta, catalogo), 2);
    assert.equal(maleta.itens.length, 0);
  });

  it('mantém e atualiza preço, foto e SKU das peças que continuam à venda', () => {
    const maleta = { itens: [{ id: 1, nome: 'NIX Brachio', preco: 100, imagem: null, intencao: 'COMPRA' }] };
    assert.equal(ctx.sincronizarMaleta(maleta, catalogo), 0);
    assert.deepEqual(copia(maleta.itens[0]), { id: 1, sku: 'NIX001', nome: 'NIX Brachio', preco: 129.9, imagem: '/imagens/a', intencao: 'COMPRA' });
  });
});
