const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { nomeNix, nomeCurtoDoNome, nomeNovo, planejarAjuste } = require('../nome-nix');

const p = (id, extra) => ({ id, nome: `Nix ${id}`, nome_curto: '', tipo: '', formato: '', cor_armacao: '', tamanho: '', grade: '', codigo_sku: `SKU-${id}`, arquivado: false, ...extra });

describe('nome NIX + nome curto + tipo + formato da lente', () => {
  it('monta o nome sem bullets, hífens soltos nem palavra repetida', () => {
    assert.equal(nomeNix({ nome_curto: 'Pyroraptor', tipo: 'Polarizado UV400', formato: 'ESPORTIVO' }), 'NIX Pyroraptor Polarizado Esportivo');
    assert.equal(nomeNix({ nome_curto: 'Utah', tipo: 'Proteção UV400', formato: 'QUADRADO' }), 'NIX Utah UV400 Quadrado');
    assert.equal(nomeNix({ nome_curto: 'Fossil' }), 'NIX Fossil');
    assert.equal(nomeNix({ nome_curto: 'Kentro', tipo: 'Polarizado Degradê', formato: 'Gatinho' }), 'NIX Kentro Polarizado Degradê Gatinho');
    assert.equal(nomeNix({ nome_curto: 'Bary', tipo: 'Polarizado Quadrado', formato: 'QUADRADO' }), 'NIX Bary Polarizado Quadrado');
    assert.equal(nomeNix({ nome_curto: '' }), '');
  });

  it('é a mesma regra do painel (importação pelo link)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
    const inicio = src.indexOf('function nomeNix(');
    const fim = src.indexOf('\n    }\n', inicio) + 6;
    const ctx = vm.createContext({});
    vm.runInContext(src.slice(inicio, fim), ctx);
    const casos = [
      { nome_curto: 'Pyroraptor', tipo: 'Polarizado UV400', formato: 'ESPORTIVO' },
      { nome_curto: 'Nix Utah •', tipo: 'Proteção uv400', formato: 'quadrado' },
      { nome_curto: 'Ptero Gold', tipo: '', formato: 'AVIADOR' },
      { nome_curto: '', tipo: 'Polarizado', formato: 'Oval' },
    ];
    for (const c of casos) assert.equal(ctx.nomeNix(c), nomeNix(c));
  });

  it('sem nome curto, usa o modelo do nome atual', () => {
    assert.equal(nomeCurtoDoNome('Nix Dilo Soul - Onyx Black Gradient'), 'Dilo Soul');
    assert.equal(nomeCurtoDoNome('Nix Bronto - Moch'), 'Bronto');
    assert.equal(nomeCurtoDoNome('Nix Jungle'), 'Jungle');
  });

  it('modelo com cores guarda " - <cor>" no fim; produto único não', () => {
    assert.equal(nomeNovo(p(1, { nome: 'Nix Raptor • BRSA15164 • • Esporte• Uv400 • Polarizado• - Onyx Black - Azul', nome_curto: 'Pyroraptor', tipo: 'Polarizado UV400', formato: 'ESPORTIVO', cor_armacao: 'Azul', grade: 'NIX-BEU-RAP' })),
      'NIX Pyroraptor Polarizado Esportivo - Azul');
    assert.equal(nomeNovo(p(2, { nome: 'Nix Ptero Solt - Onyx Black', nome_curto: 'Haopterus', formato: 'AVIADOR', cor_armacao: 'Preto' })), 'NIX Haopterus Aviador');
  });
});

describe('ajuste único dos nomes já cadastrados', () => {
  it('troca só o nome, pula arquivado e o que já está certo, e avisa nome repetido', () => {
    const { alterar, iguais } = planejarAjuste([
      p(1, { nome: 'Nix Raptor • X - Preto', nome_curto: 'Megaptor', formato: 'ESPORTIVO', grade: 'G1', cor_armacao: 'Preto' }),
      p(2, { nome: 'NIX Fossil Redondo', nome_curto: 'Fossil', formato: 'REDONDO' }),
      p(3, { nome: 'Nix Velho', nome_curto: 'Utah', arquivado: true }),
      p(4, { nome: 'Nix Ptero Gold - Ocean Blue', formato: 'AVIADOR' }),
      p(5, { nome: 'Nix Ptero Gold Gradient', nome_curto: 'Ptero Gold', formato: 'AVIADOR' }),
    ]);
    assert.deepEqual(alterar.map(a => [a.id, a.depois]), [[1, 'NIX Megaptor Esportivo - Preto'], [4, 'NIX Ptero Gold Aviador'], [5, 'NIX Ptero Gold Aviador']]);
    assert.equal(alterar[0].antes, 'Nix Raptor • X - Preto');
    assert.deepEqual(iguais, [['NIX Ptero Gold Aviador', [4, 5]]]);
  });
});
