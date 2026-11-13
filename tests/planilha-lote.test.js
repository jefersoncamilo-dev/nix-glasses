// Planilhas do Cadastro em Lote e do Editar em estoque: o que as duas têm em comum
// (colunas escondidas, colar várias células da planilha, o que mudou antes de salvar)
// e a tela de conferência do lote abrindo a janela certa.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

function extrairFuncao(nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

const fonte = [
  html.match(/const COLUNAS_LOTE = \[[\s\S]*?\n {4}\];/)[0],
  html.match(/const CAMPOS_MEDIDA = \[.*\];/)[0],
  html.match(/const CAMPOS_SO_CADASTRO = .*;/)[0],
  html.match(/const COLUNAS_EDICAO = [\s\S]*?;\n/)[0],
  html.match(/const COLUNAS_FIXAS_PLANILHA = .*;/)[0],
  ...['escapeHtml', 'lerDisponibilidade', 'lerStatus', 'lerGenero', 'colunasNaTela', 'camposComErro', 'htmlCampoPlanilha',
    'celulasDaColagem', 'valorColadoNaColuna', 'colarNaPlanilha', 'diferencasEdicao'].map(extrairFuncao),
].join('\n');
const ctx = vm.createContext({});
vm.runInContext(`${fonte}\nthis.f = { COLUNAS_LOTE, COLUNAS_EDICAO, colunasNaTela, camposComErro, htmlCampoPlanilha, celulasDaColagem, valorColadoNaColuna, colarNaPlanilha, diferencasEdicao };`, ctx);
const f = ctx.f;
const col = campo => f.COLUNAS_LOTE.find(c => c.campo === campo);

describe('painel: planilha do lote e da edição em estoque', () => {
  it('a conferência do lote tem a sua própria janela (antes abria a da conferência de estoque)', () => {
    assert.match(html, /<div id="modalConferenciaLote"[^>]*aria-labelledby="tituloConferenciaLote"/);
    assert.match(html, /abrirModalSimples\('modalConferenciaLote'\)/);
    assert.match(html, /fecharModalSimples\('modalConferenciaLote'\)/);
    const ids = [...html.matchAll(/ id="([^"$]+)"/g)].map(m => m[1]);
    const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(repetidos, [], 'nenhum id repetido no painel');
  });

  it('esconde colunas, mas Nome, SKU e coluna com erro sempre aparecem', () => {
    const campos = f.colunasNaTela(f.COLUNAS_LOTE, ['nome', 'codigo_sku', 'fornecedor', 'estilo', 'tipo'], ['tipo']).map(c => c.campo);
    assert.ok(campos.includes('nome') && campos.includes('codigo_sku'));
    assert.ok(!campos.includes('fornecedor') && !campos.includes('estilo'));
    assert.ok(campos.includes('tipo'));
    assert.equal(f.colunasNaTela(f.COLUNAS_LOTE, []).length, f.COLUNAS_LOTE.length);
    assert.deepEqual([...f.camposComErro([{ nome: 'x' }, undefined, { nome: 'y', preco_venda: 'z' }])], ['nome', 'preco_venda']);
  });

  it('lê várias células copiadas da planilha; uma célula só fica com a colagem normal', () => {
    assert.equal(f.celulasDaColagem('Aviador'), null);
    assert.deepEqual(JSON.parse(JSON.stringify(f.celulasDaColagem('A\t10,00\r\nB\t20,00\r\n'))), [['A', '10,00'], ['B', '20,00']]);
    assert.deepEqual(JSON.parse(JSON.stringify(f.celulasDaColagem('Preto\nAzul\n'))), [['Preto'], ['Azul']]);
  });

  it('nas colunas de opções aceita o texto da planilha', () => {
    assert.equal(f.valorColadoNaColuna(col('disponibilidade'), 'Sob encomenda'), 'SOB_ENCOMENDA');
    assert.equal(f.valorColadoNaColuna(col('status'), 'esgotado'), 'ESGOTADO');
    assert.equal(f.valorColadoNaColuna(col('genero'), 'fem'), 'FEMININO');
    const promocoes = [['', '—'], ['3', 'Black Nix'], ['4', 'Dia das Mães']];
    const promo = f.COLUNAS_EDICAO.find(c => c.campo === 'anuncio_id');
    assert.equal(f.valorColadoNaColuna(promo, 'black nix', promocoes), '3');
    assert.equal(f.valorColadoNaColuna(promo, '4', promocoes), '4');
    assert.equal(f.valorColadoNaColuna(promo, 'Não existe', promocoes), '');
  });

  it('cola a partir da célula escolhida, para a direita e para baixo', () => {
    const linhas = [{ nome: 'A', preco_custo: '', preco_venda: '' }, { nome: 'B', preco_custo: '', preco_venda: '' }];
    const colunas = [col('nome'), col('preco_custo'), col('preco_venda')];
    const n = f.colarNaPlanilha(linhas, colunas, 'preco_custo', [['50,00', '149,90', 'sobra'], ['60,00'], ['linha a mais']]);
    assert.equal(n, 3);
    assert.equal(linhas[0].preco_custo, '50,00');
    assert.equal(linhas[0].preco_venda, '149,90');
    assert.equal(linhas[1].preco_custo, '60,00');
    assert.equal(linhas[1].preco_venda, '');
    assert.equal(f.colarNaPlanilha(linhas, colunas, 'nao_existe', [['x']]), 0);
  });

  it('lista o que mudou na linha (antes → depois) para conferir antes de salvar', () => {
    const original = { id: 1, nome: 'Nix Raptor', preco_venda: '149,90', estoque: '2', cor_armacao: 'Preto' };
    const linha = { ...original, preco_venda: '169,90', estoque: '2 ', cor_armacao: 'Azul' };
    const difs = JSON.parse(JSON.stringify(f.diferencasEdicao(linha, original)));
    assert.deepEqual(difs, [
      { campo: 'preco_venda', antes: '149,90', depois: '169,90' },
      { campo: 'cor_armacao', antes: 'Preto', depois: 'Azul' },
    ]);
    assert.deepEqual([...f.diferencasEdicao(linha, undefined)], []);
  });

  it('as células escapam o que foi digitado', () => {
    const PAYLOAD = '"><img src=x onerror=alert(1)>';
    const campo = f.htmlCampoPlanilha(col('nome'), PAYLOAD, 'data-x');
    assert.doesNotMatch(campo, /<img src=x/);
    const lista = f.htmlCampoPlanilha(col('genero'), 'FEMININO', 'data-x', [['FEMININO', PAYLOAD]]);
    assert.doesNotMatch(lista, /<img src=x/);
    assert.match(lista, /value="FEMININO" selected/);
    assert.match(f.htmlCampoPlanilha(col('preco_venda'), '', ''), /inputmode="decimal"/);
    assert.match(f.htmlCampoPlanilha(col('quantidade'), '', ''), /inputmode="numeric"/);
  });

  it('a tela tem o botão Colunas, as caixinhas de marcar, o rascunho e a conferência antes de salvar', () => {
    for (const id of ['loteColunas', 'edicaoColunas', 'loteMarcadasBarra', 'edicaoMarcadasBarra', 'loteMassaCampo', 'btnLoteMassaMarcadas',
      'btnEdicaoMassaMarcados', 'loteRascunhoAviso', 'modalRevisaoEdicao', 'btnRevisaoSalvar']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /abrirRevisaoEdicao\(alteradas\)/);
  });
});
