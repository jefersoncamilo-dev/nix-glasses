const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planejarAjuste } = require('../ajuste-precos-oculos');

const p = (id, extra) => ({ id, nome: `Nix ${id}`, nome_fornecedor: '', codigo_sku: `SKU-${id}`, grade: '', tipo: '', preco_venda: '139.90', preco_promocional: null, arquivado: false, ...extra });

describe('ajuste único dos preços dos óculos', () => {
  it('polarizado 169,90, comum 149,90, todas as cores do modelo juntas', () => {
    const { alterar, iguais, pendentes } = planejarAjuste([
      p(1, { grade: 'VOGUE', tipo: 'Polarizado UV400' }),
      p(2, { grade: 'VOGUE', tipo: '' }),
      p(3, { tipo: 'UV400' }),
      p(4, { nome_fornecedor: 'Óculos de Sol Aviador Polarizado' }),
      p(5, { nome_fornecedor: 'Óculos Gatinho', preco_venda: '149.90' }),
    ]);
    assert.deepEqual(alterar.map(i => [i.id, i.depois]), [[1, 169.9], [2, 169.9], [3, 149.9], [4, 169.9]]);
    assert.deepEqual(iguais.map(i => i.id), [5]);
    assert.equal(pendentes.length, 0);
  });

  it('arquivado fica de fora; sem tipo e sem nome fornec. fica pendente', () => {
    const { alterar, pendentes } = planejarAjuste([p(1, { arquivado: true, tipo: 'Polarizado' }), p(2), p(3, { nome: 'Nix Polarizado' })]);
    assert.deepEqual(pendentes.map(i => i.id), [2]);
    assert.deepEqual(alterar.map(i => [i.id, i.depois]), [[3, 169.9]]);
  });

  it('avisa quando o promocional fica maior ou igual ao novo preço', () => {
    const { alterar } = planejarAjuste([p(1, { tipo: 'UV400', preco_venda: '199.90', preco_promocional: '159.90' }), p(2, { tipo: 'UV400', preco_promocional: '99.90' })]);
    assert.equal(alterar[0].aviso_promocional, 159.9);
    assert.equal(alterar[1].aviso_promocional, undefined);
  });
});
