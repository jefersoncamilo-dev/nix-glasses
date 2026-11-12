// Sob Encomenda no painel: não tem estoque físico (a cliente paga parte do sinal e só
// então o pedido vai para o fornecedor). A lista de Produtos, o Editar produto, o
// Editar em estoque e a Conferência mostram "sem estoque físico" no lugar das peças,
// e o produto com peça de verdade na loja não vira Sob Encomenda direto.
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

describe('Sob Encomenda no painel: sem estoque físico', () => {
  const ctx = carregar(['escapeHtml', 'linkSeguro', 'botaoLinkFornecedor', 'variacaoCusto', 'htmlVariacao', 'htmlUltimaCompra', 'contarFotos', 'anuncioPorId',
    'temPrecoPromocional', 'htmlPromocaoProduto', 'nomeDoModelo', 'htmlLinhaModeloCores', 'htmlLinhaProduto', 'htmlEmConferencia', 'htmlArquivado', 'botaoArquivar',
    'ehSobEncomendaAdmin', 'seloSobEncomenda', 'ajudaSobEncomenda', 'textoEstoqueAdmin', 'erroVirarEncomenda', 'textoAvisoSinal'], {
    modoAcertoEstoque: false, marcadosAcerto: new Set(), anunciosAdmin: [], formatarMoeda, formatarDia: v => String(v), statusClass: () => '',
  });
  const base = { id: 1, nome: 'Nix Raptor - Preto', codigo_sku: 'NIX-1', preco_custo: 50, preco_venda: 139.9, status: 'DISPONIVEL', estoque: 1, cor_armacao: 'Preto' };

  it('na lista de Produtos: selo "sem estoque físico" no lugar de "1 em estoque"', () => {
    const enc = ctx.htmlLinhaProduto({ ...base, disponibilidade: 'SOB_ENCOMENDA' });
    assert.match(enc, /SOB ENCOMENDA · sem estoque físico/);
    assert.match(enc, /Sem estoque físico: pede ao fornecedor depois do sinal/);
    assert.doesNotMatch(enc, /\d+ em estoque/);
    assert.doesNotMatch(enc, />DISPONIVEL</, 'o selo toma o lugar do DISPONIVEL');
    const pronta = ctx.htmlLinhaProduto({ ...base, disponibilidade: 'PRONTA_ENTREGA', estoque: 3 });
    assert.match(pronta, /3 em estoque/);
    assert.doesNotMatch(pronta, /SOB ENCOMENDA/);
  });

  it('no modelo com cores: a cor Sob Encomenda fica fora da soma do estoque', () => {
    const cores = [
      { ...base, disponibilidade: 'PRONTA_ENTREGA', estoque: 2 },
      { ...base, id: 2, nome: 'Nix Raptor - Rosa', codigo_sku: 'NIX-1-ROSA', cor_armacao: 'Rosa', disponibilidade: 'SOB_ENCOMENDA', estoque: 1 },
    ];
    const out = ctx.htmlLinhaModeloCores({ grade: 'NIX-1', cores });
    assert.match(out, /2 em estoque \(cores pronta entrega\)/);
    assert.match(out, /1 cor sob encomenda/);
    assert.match(out, /Rosa <strong class="text-blue-700">encomenda<\/strong>/);
    const todas = ctx.htmlLinhaModeloCores({ grade: 'NIX-1', cores: cores.map(c => ({ ...c, disponibilidade: 'SOB_ENCOMENDA' })) });
    assert.match(todas, /Sob encomenda, sem estoque físico/);
  });

  it('textos: estoque, ajuda do sinal e bloqueio de virar Sob Encomenda com peça na loja', () => {
    assert.equal(ctx.textoEstoqueAdmin({ estoque: 1, disponibilidade: 'SOB_ENCOMENDA' }), 'sob encomenda, sem estoque físico');
    assert.equal(ctx.textoEstoqueAdmin({ estoque: 4, disponibilidade: 'PRONTA_ENTREGA' }), '4 em estoque');
    assert.match(ctx.textoAvisoSinal(139.9), /^Sem estoque físico\. Você recebe parte do sinal e só então faz o pedido ao fornecedor\. Sinal de R\$ 69\.95 \(50%\)/);
    assert.match(ctx.erroVirarEncomenda({ estoque: 3, disponibilidade: 'PRONTA_ENTREGA', cor_armacao: 'Preto' }, 'SOB_ENCOMENDA'), /Preto: ainda tem 3 peça\(s\) na loja/);
    assert.equal(ctx.erroVirarEncomenda({ estoque: 0, disponibilidade: 'PRONTA_ENTREGA' }, 'SOB_ENCOMENDA'), '');
    assert.equal(ctx.erroVirarEncomenda({ estoque: 1, disponibilidade: 'SOB_ENCOMENDA' }, 'SOB_ENCOMENDA'), '');
    assert.equal(ctx.erroVirarEncomenda({ estoque: 3, disponibilidade: 'PRONTA_ENTREGA' }, 'PRONTA_ENTREGA'), '');
  });

  it('cores Sob Encomenda gravam 1 (só para aparecer na vitrine), sem pedir quantidade', () => {
    const c = carregar(['lerCoresModelo']);
    const lidas = c.lerCoresModelo([
      { produto: { id: 1 }, cor: 'Preto', estoque: '2', disponibilidade: 'PRONTA_ENTREGA' },
      { produto: { id: 2 }, cor: 'Rosa', estoque: '', disponibilidade: 'SOB_ENCOMENDA' },
      { produto: { id: 3 }, cor: 'Azul', estoque: '5', disponibilidade: 'ESGOTADO' },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(lidas.map(x => [x.cor, x.estoque, x.disponibilidade]))),
      [['Preto', 2, 'PRONTA_ENTREGA'], ['Rosa', 1, 'SOB_ENCOMENDA'], ['Azul', 0, 'PRONTA_ENTREGA']]);
  });
});

describe('Editar em estoque: Sob Encomenda sem estoque físico', () => {
  const originais = new Map([
    [1, { id: 1, disponibilidade: 'PRONTA_ENTREGA', estoque: '3' }],
    [2, { id: 2, disponibilidade: 'SOB_ENCOMENDA', estoque: '1' }],
  ]);
  const ctx2 = vm.createContext({ Number, String, Math, Map, Set, Object, JSON, __originais: originais });
  vm.runInContext(`const originaisEdicao = __originais; const CAMPOS_NUMERO_EDICAO = ['estoque']; const CAMPOS_MEDIDA = [];
    ${['ajustarEstoqueEdicao', 'aplicarEmMassaEdicao', 'valorOrdenacaoEdicao'].map(extrairFuncao).join('\n')}
    this.f = { ajustarEstoqueEdicao, aplicarEmMassaEdicao, valorOrdenacaoEdicao };`, ctx2);
  const f = ctx2.f;

  it('trocar para Sob Encomenda guarda 1; voltar devolve o estoque de antes (ou 0)', () => {
    const a = { id: 1, disponibilidade: 'PRONTA_ENTREGA', estoque: '3' };
    const b = { id: 2, disponibilidade: 'SOB_ENCOMENDA', estoque: '1' };
    f.aplicarEmMassaEdicao([a, b], 'disponibilidade', 'SOB_ENCOMENDA');
    assert.equal(a.estoque, '1');
    f.aplicarEmMassaEdicao([a, b], 'disponibilidade', 'PRONTA_ENTREGA');
    assert.equal(a.estoque, '3', 'volta ao que era');
    assert.equal(b.estoque, '0', 'era Sob Encomenda: não tinha peça');
  });

  it('ordenar por estoque põe o Sob Encomenda no fim (não tem peça)', () => {
    assert.equal(f.valorOrdenacaoEdicao({ disponibilidade: 'SOB_ENCOMENDA', estoque: '1' }, 'estoque'), null);
    assert.equal(f.valorOrdenacaoEdicao({ disponibilidade: 'PRONTA_ENTREGA', estoque: '4' }, 'estoque'), 4);
  });

  it('validar: produto com peça na loja não vira Sob Encomenda', () => {
    const fonte = [
      html.match(/const COLUNAS_LOTE = \[[\s\S]*?\n {4}\];/)[0],
      html.match(/const CAMPOS_MEDIDA = \[.*\];/)[0],
      ...['escapeHtml', 'linhaLoteEstaVazia', 'lerPreco', 'lerMedida', 'linkSeguro', 'lerDataCompra', 'validarLote', 'validarLinhaEdicao'].map(extrairFuncao),
    ].join('\n');
    const c = vm.createContext({});
    vm.runInContext(`${fonte}\nthis.validarLinhaEdicao = validarLinhaEdicao;`, c);
    const l = { id: 1, nome: 'Nix', codigo_sku: 'NIX-1', preco_custo: '50,00', preco_venda: '139,90', disponibilidade: 'SOB_ENCOMENDA', estoque: '1' };
    assert.match(c.validarLinhaEdicao(l, { disponibilidade: 'PRONTA_ENTREGA', estoque: '2' }).disponibilidade, /Ainda tem 2 peça\(s\) na loja/);
    assert.equal(c.validarLinhaEdicao(l, { disponibilidade: 'PRONTA_ENTREGA', estoque: '0' }).disponibilidade, undefined);
    assert.equal(c.validarLinhaEdicao(l, { disponibilidade: 'SOB_ENCOMENDA', estoque: '1' }).disponibilidade, undefined);
    assert.equal(c.validarLinhaEdicao(l).disponibilidade, undefined);
  });
});
