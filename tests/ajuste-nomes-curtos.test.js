const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planejarAjuste } = require('../ajuste-nomes-curtos');

const p = (id, extra) => ({ id, nome: `Nix ${id}`, nome_curto: '', nome_fornecedor: '', codigo_fornecedor: '', codigo_sku: `SKU-${id}`, grade: '', formato: '', arquivado: false, ...extra });

describe('ajuste único dos nomes curtos (dinossauros)', () => {
  it('acha o modelo pelo código e troca todas as cores; formato só quando vazio', () => {
    const { alterar } = planejarAjuste([
      p(1, { grade: 'GEN', codigo_fornecedor: 'SAR9078', nome_curto: 'Ptero SAR' }),
      p(2, { grade: 'GEN', nome: 'Nix Tricera General • SAR9078 • Metal' }),
      p(3, { nome_fornecedor: 'Óculos de Sol Zaya • NV 560 • Unissex', formato: 'QUADRADO' }),
      p(4, { nome_fornecedor: 'Óculos de Sol • NV 5602' }),
      p(5, { codigo_fornecedor: 'BRSA15164', formato: 'ESPORTIVO' }),
    ]);
    assert.deepEqual(alterar.map(i => [i.id, i.depois, i.formato_depois]),
      [[1, 'Tupan', 'AVIADOR'], [2, 'Tupan', 'AVIADOR'], [3, 'Carnot', 'QUADRADO'], [5, 'Pyroraptor', 'ESPORTIVO']]);
  });

  it('nome de dinossauro já digitado fica; arquivado fica de fora; SAR48 não confunde com SAR4022', () => {
    const { alterar, naoEncontrados } = planejarAjuste([
      p(1, { codigo_fornecedor: 'SAR48', nome_curto: 'Diplodoc' }),
      p(2, { codigo_fornecedor: 'SAR4022' }),
      p(3, { codigo_fornecedor: 'NV1828', arquivado: true }),
    ]);
    assert.deepEqual(alterar.map(i => [i.id, i.depois]), [[2, 'Utah']]);
    assert.ok(naoEncontrados.includes('Megaptor'));
  });

  it('modelo que casa com dois nomes fica de fora (ambíguo)', () => {
    const { alterar, ambiguos } = planejarAjuste([p(1, { nome_fornecedor: 'Óculos Jasper SAR38' })]);
    assert.equal(alterar.length, 0);
    assert.deepEqual(ambiguos[0].nomes.sort(), ['Deinony', 'Edmonto']);
  });
});
