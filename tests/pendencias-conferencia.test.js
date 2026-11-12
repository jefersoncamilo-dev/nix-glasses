// Em conferência: o painel mostra os campos a ajustar antes de liberar na vitrine
// (nome curto fora do padrão dos dinossauros, preço fora do padrão 169,90/149,90,
// gênero, formato, tipo, material, código do fornecedor, custo, foto e quantidade por cor).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

function extrair(nome, re = new RegExp(`(async )?function ${nome}\\(`)) {
  const inicio = html.search(re);
  assert.notEqual(inicio, -1, `${nome} não encontrado`);
  let i = html.indexOf(re.source.startsWith('const') ? '[' : '{', inicio);
  const abre = html[i];
  const fecha = abre === '[' ? ']' : '}';
  for (let nivel = 0; ; i++) {
    if (html[i] === abre) nivel++;
    else if (html[i] === fecha && --nivel === 0) return html.slice(inicio, i + 1) + (abre === '[' ? ';' : '');
  }
}

const ctx = {
  nicho: 'oculos',
  formatarMoeda: v => `R$ ${Number(v).toFixed(2).replace('.', ',')}`,
  rotulosPainel: () => ({ formato: 'Formato da lente', tipo: 'Tipo', material: 'Material' }),
  ehSobEncomendaAdmin: p => p.disponibilidade === 'SOB_ENCOMENDA',
};
vm.createContext(ctx);
vm.runInContext(`
  ${extrair('NOMES_CURTOS_PADRAO', /const NOMES_CURTOS_PADRAO = /)}
  const PRECO_PADRAO_OCULOS = { polarizado: 169.90, comum: 149.90 };
  function nichoPainel() { return nicho; }
  ${extrair('pendenciasProduto')}
  ${extrair('pendenciasDasCores')}
  ${extrair('pendenciasConferencia')}
  this._pp = pendenciasProduto;
  this._pc = pendenciasConferencia;
`, ctx);
// Arrays do outro contexto -> arrays daqui (deepStrictEqual compara o protótipo)
const local = v => JSON.parse(JSON.stringify(v));
ctx.pendenciasProduto = (...a) => local(ctx._pp(...a));
ctx.pendenciasConferencia = (...a) => local(ctx._pc(...a));

const completo = {
  nome: 'Nix Raptor Jasper - Preto', nome_curto: 'Deinony', preco_venda: '149.90', preco_custo: '39.90',
  genero: 'UNISSEX', formato: 'Esportivo', tipo: 'UV400', material: 'Acetato', codigo_fornecedor: '2003',
  imagem_url: '/x.jpg', estoque: 2, disponibilidade: 'PRONTA_ENTREGA',
};
const campos = (lista) => lista.map(x => x.campo).sort();

describe('Em conferência: campos a ajustar', () => {
  it('produto completo no padrão não tem pendência', () => {
    assert.deepEqual(ctx.pendenciasConferencia([completo]), []);
    assert.deepEqual(ctx.pendenciasProduto({ ...completo, tipo: 'Polarizado UV400', preco_venda: '169.90', nome_curto: 'Deinony 2' }), []);
  });

  it('nome curto vazio ou fora da tabela dos dinossauros', () => {
    assert.deepEqual(campos(ctx.pendenciasProduto({ ...completo, nome_curto: '' })), ['nome_curto']);
    const fora = ctx.pendenciasProduto({ ...completo, nome_curto: 'Hexagonal Dubai' });
    assert.equal(fora[0].campo, 'nome_curto');
    assert.match(fora[0].motivo, /fora do padrão/);
    assert.deepEqual(ctx.pendenciasProduto({ ...completo, nome_curto: 'triassico' }), [], 'sem acento e minúsculo também vale');
  });

  it('preço fora do padrão: polarizado 169,90, os outros 149,90', () => {
    const p = ctx.pendenciasProduto({ ...completo, tipo: 'Polarizado', preco_venda: '149.90' });
    assert.deepEqual(campos(p), ['preco_venda']);
    assert.match(p[0].motivo, /169,90/);
    assert.deepEqual(campos(ctx.pendenciasProduto({ ...completo, preco_venda: '139.90' })), ['preco_venda']);
    assert.equal(ctx.pendenciasProduto({ ...completo, preco_venda: '0' })[0].grave, true);
    assert.deepEqual(ctx.pendenciasProduto({ ...completo, nome_fornecedor: 'Óculos de Sol Polarizado X', preco_venda: '169.90' }), []);
  });

  it('campos vazios: gênero, formato, tipo, material, código, custo', () => {
    const p = ctx.pendenciasProduto({ ...completo, genero: '', formato: '', tipo: '', material: '', codigo_fornecedor: '', preco_custo: '' });
    assert.deepEqual(campos(p), ['codigo_fornecedor', 'formato', 'genero', 'material', 'preco_custo', 'tipo']);
    assert.deepEqual(p.filter(x => x.grave).map(x => x.campo).sort(), ['formato', 'genero']);
  });

  it('foto e quantidade de cada cor', () => {
    const cores = [
      { ...completo, cor_armacao: 'Preto' },
      { ...completo, cor_armacao: 'Azul', imagem_url: '', estoque: 0 },
      { ...completo, cor_armacao: 'Rosa', estoque: 0, disponibilidade: 'SOB_ENCOMENDA' },
    ];
    const p = ctx.pendenciasConferencia(cores);
    assert.deepEqual(campos(p), ['estoque', 'foto']);
    assert.match(p.find(x => x.campo === 'foto').motivo, /Azul/);
    assert.match(p.find(x => x.campo === 'estoque').motivo, /Azul$/, 'Sob Encomenda não precisa de quantidade');
  });

  it('outras lojas: sem regra de dinossauro nem de preço fixo', () => {
    ctx.nicho = 'roupas';
    try {
      assert.deepEqual(ctx.pendenciasProduto({ ...completo, nome_curto: 'Vestido Floral', preco_venda: '89.90' }), []);
    } finally { ctx.nicho = 'oculos'; }
  });

  it('a tela usa as pendências: selo, filtro, aviso ao liberar e campos marcados no Editar', () => {
    assert.match(html, /<option value="PENDENCIAS">/);
    assert.match(html, /id="modalLiberarPendencias"/);
    assert.match(html, /Liberar mesmo assim/);
    assert.match(html, /id="pendenciasForm"/);
    assert.match(html, /\$\{htmlPendencias\(produtos\)\}/);
    assert.match(html, /atualizarPendenciasForm\(\);\n\s+document.getElementById\('importarStatus'\)/);
  });
});
