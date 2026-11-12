// Sob Encomenda no painel: vende pelo estoque do FORNECEDOR (a cliente paga parte do
// sinal e então o pedido vai para o fornecedor). O estoque do cadastro são as peças que a
// loja tem guardadas: trocar para Sob Encomenda não precisa zerar, e a lista de Produtos,
// o Editar produto e o Editar em estoque mostram as duas coisas.
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

function carregar(funcoes, globais = {}, extra = '') {
  const ctx = vm.createContext({ Number, String, Math, Map, Set, Object, Array, JSON, URL, ...globais });
  vm.runInContext(`${extra}\n${funcoes.map(extrairFuncao).join('\n')}\n${funcoes.map(f => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

const formatarMoeda = v => `R$ ${Number(v).toFixed(2)}`;

describe('Sob Encomenda no painel: estoque do fornecedor, peças da loja guardadas', () => {
  const ctx = carregar(['escapeHtml', 'linkSeguro', 'botaoLinkFornecedor', 'variacaoCusto', 'htmlVariacao', 'htmlUltimaCompra', 'contarFotos', 'anuncioPorId',
    'temPrecoPromocional', 'htmlPromocaoProduto', 'nomeDoModelo', 'htmlLinhaModeloCores', 'htmlLinhaProduto', 'htmlEmConferencia', 'htmlArquivado', 'botaoArquivar',
    'ehSobEncomendaAdmin', 'seloSobEncomenda', 'ajudaSobEncomenda', 'textoEstoqueAdmin', 'textoAvisoSinal'], {
    modoAcertoEstoque: false, marcadosAcerto: new Set(), anunciosAdmin: [], formatarMoeda, formatarDia: v => String(v), statusClass: () => '',
  });
  const base = { id: 1, nome: 'Nix Raptor - Preto', codigo_sku: 'NIX-1', preco_custo: 50, preco_venda: 139.9, status: 'DISPONIVEL', estoque: 0, cor_armacao: 'Preto' };

  it('na lista de Produtos: selo "estoque do fornecedor" e as peças guardadas na loja', () => {
    const enc = ctx.htmlLinhaProduto({ ...base, disponibilidade: 'SOB_ENCOMENDA' });
    assert.match(enc, /SOB ENCOMENDA · estoque do fornecedor/);
    assert.match(enc, /Estoque do fornecedor: pede a ele depois do sinal/);
    assert.doesNotMatch(enc, /\d+ guardada/);
    assert.doesNotMatch(enc, />DISPONIVEL</, 'o selo toma o lugar do DISPONIVEL');
    const comPecas = ctx.htmlLinhaProduto({ ...base, disponibilidade: 'SOB_ENCOMENDA', estoque: 2 });
    assert.match(comPecas, /2 guardadas na loja/);
    const pronta = ctx.htmlLinhaProduto({ ...base, disponibilidade: 'PRONTA_ENTREGA', estoque: 3 });
    assert.match(pronta, /3 em estoque/);
    assert.doesNotMatch(pronta, /SOB ENCOMENDA/);
  });

  it('no modelo com cores: a cor Sob Encomenda mostra "encomenda" e as peças guardadas à parte', () => {
    const cores = [
      { ...base, disponibilidade: 'PRONTA_ENTREGA', estoque: 2 },
      { ...base, id: 2, nome: 'Nix Raptor - Rosa', codigo_sku: 'NIX-1-ROSA', cor_armacao: 'Rosa', disponibilidade: 'SOB_ENCOMENDA', estoque: 1 },
    ];
    const out = ctx.htmlLinhaModeloCores({ grade: 'NIX-1', cores });
    assert.match(out, /2 em estoque \(cores pronta entrega\)/);
    assert.match(out, /1 cor sob encomenda/);
    assert.match(out, /1 guardada na loja \(cores sob encomenda\)/);
    assert.match(out, /Rosa <strong class="text-blue-700">encomenda<\/strong> <span class="text-blue-700" title="Peças guardadas na loja">\+1<\/span>/);
    const todas = ctx.htmlLinhaModeloCores({ grade: 'NIX-1', cores: cores.map(c => ({ ...c, disponibilidade: 'SOB_ENCOMENDA', estoque: 0 })) });
    assert.match(todas, /Sob encomenda \(estoque do fornecedor\)/);
    assert.doesNotMatch(todas, /\d+ guardada/);
  });

  it('textos: estoque e ajuda do sinal', () => {
    assert.equal(ctx.textoEstoqueAdmin({ estoque: 0, disponibilidade: 'SOB_ENCOMENDA' }), 'sob encomenda (estoque do fornecedor)');
    assert.equal(ctx.textoEstoqueAdmin({ estoque: 2, disponibilidade: 'SOB_ENCOMENDA' }), 'sob encomenda (fornecedor) • 2 guardadas na loja');
    assert.equal(ctx.textoEstoqueAdmin({ estoque: 4, disponibilidade: 'PRONTA_ENTREGA' }), '4 em estoque');
    assert.match(ctx.textoAvisoSinal(139.9), /^Vende pelo estoque do fornecedor: .* Sinal de R\$ 69\.95 \(50%\)/);
  });

  it('cores Sob Encomenda guardam a quantidade digitada (vazio = 0), sem precisar zerar', () => {
    const c = carregar(['lerCoresModelo']);
    const lidas = c.lerCoresModelo([
      { produto: { id: 1 }, cor: 'Preto', estoque: '2', disponibilidade: 'PRONTA_ENTREGA' },
      { produto: { id: 2 }, cor: 'Rosa', estoque: '', disponibilidade: 'SOB_ENCOMENDA' },
      { produto: { id: 3 }, cor: 'Azul', estoque: '5', disponibilidade: 'ESGOTADO' },
      { produto: { id: 4 }, cor: 'Verde', estoque: '3', disponibilidade: 'SOB_ENCOMENDA' },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(lidas.map(x => [x.cor, x.estoque, x.disponibilidade]))),
      [['Preto', 2, 'PRONTA_ENTREGA'], ['Rosa', 0, 'SOB_ENCOMENDA'], ['Azul', 0, 'PRONTA_ENTREGA'], ['Verde', 3, 'SOB_ENCOMENDA']]);
  });
});

describe('Editar em estoque: Sob Encomenda sem zerar o estoque', () => {
  const ctx2 = vm.createContext({ Number, String, Math, Map, Set, Object, JSON });
  vm.runInContext(`const CAMPOS_NUMERO_EDICAO = ['estoque']; const CAMPOS_MEDIDA = [];
    ${['aplicarEmMassaEdicao', 'valorOrdenacaoEdicao'].map(extrairFuncao).join('\n')}
    this.f = { aplicarEmMassaEdicao, valorOrdenacaoEdicao };`, ctx2);
  const f = ctx2.f;

  it('trocar para Sob Encomenda (e voltar) não mexe no estoque', () => {
    const a = { id: 1, disponibilidade: 'PRONTA_ENTREGA', estoque: '3' };
    f.aplicarEmMassaEdicao([a], 'disponibilidade', 'SOB_ENCOMENDA');
    assert.equal(a.estoque, '3');
    f.aplicarEmMassaEdicao([a], 'disponibilidade', 'PRONTA_ENTREGA');
    assert.equal(a.estoque, '3');
  });

  it('ordenar por estoque usa as peças da loja também no Sob Encomenda', () => {
    assert.equal(f.valorOrdenacaoEdicao({ disponibilidade: 'SOB_ENCOMENDA', estoque: '2' }, 'estoque'), 2);
    assert.equal(f.valorOrdenacaoEdicao({ disponibilidade: 'PRONTA_ENTREGA', estoque: '4' }, 'estoque'), 4);
  });

  it('validar: produto com peça na loja pode virar Sob Encomenda', () => {
    const fonte = [
      html.match(/const COLUNAS_LOTE = \[[\s\S]*?\n {4}\];/)[0],
      html.match(/const CAMPOS_MEDIDA = \[.*\];/)[0],
      ...['escapeHtml', 'linhaLoteEstaVazia', 'lerPreco', 'lerMedida', 'linkSeguro', 'lerDataCompra', 'validarLote', 'validarLinhaEdicao'].map(extrairFuncao),
    ].join('\n');
    const c = vm.createContext({});
    vm.runInContext(`${fonte}\nthis.validarLinhaEdicao = validarLinhaEdicao;`, c);
    const l = { id: 1, nome: 'Nix', codigo_sku: 'NIX-1', preco_custo: '50,00', preco_venda: '139,90', disponibilidade: 'SOB_ENCOMENDA', estoque: '2' };
    assert.equal(c.validarLinhaEdicao(l).disponibilidade, undefined);
    assert.equal(c.validarLinhaEdicao(l).estoque, undefined);
    assert.match(c.validarLinhaEdicao({ ...l, estoque: '' }).estoque, /Estoque inválido/);
  });
});
