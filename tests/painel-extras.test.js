// Funções do painel (admin/index.html) das melhorias de operação: botão "Link"
// do fornecedor, variação de custo, importação, fotos por SKU e resumo da maleta.
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

const funcoes = ['escapeHtml', 'linkSeguro', 'botaoLinkFornecedor', 'variacaoCusto', 'htmlVariacao', 'htmlUltimaCompra',
  'camposDaImportacao', 'associarFotosPorSku', 'montarResumoMaleta'];
const ctx = vm.createContext({ Number, String, Math, Map, Set, Object, URL, Intl });
vm.runInContext(`
  const MAX_FOTOS = 4;
  const formatarMoeda = (valor) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor || 0);
  const formatarDia = (iso) => { const m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(String(iso || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : '-'; };
  ${funcoes.map(extrairFuncao).join('\n')}
  ${funcoes.map(f => `this.${f} = ${f};`).join('\n')}
`, ctx);

describe('painel: botão Link do fornecedor', () => {
  it('abre o link em nova aba, sem dar acesso à janela do painel', () => {
    const b = ctx.botaoLinkFornecedor('https://clush.com.br/p?a=1&b="2"');
    assert.match(b, /^<a href="https:\/\/clush\.com\.br\/p\?a=1&amp;b=%222%22" target="_blank" rel="noopener noreferrer"/);
    assert.match(b, />Link<\/a>$/);
  });

  it('sem link (ou com link perigoso) mostra o botão desativado', () => {
    for (const v of ['', null, 'javascript:alert(1)', '" onmouseover="alert(1)']) {
      const b = ctx.botaoLinkFornecedor(v);
      assert.doesNotMatch(b, /<a /);
      assert.doesNotMatch(b, /alert/);
      assert.match(b, /cursor-not-allowed/);
    }
  });
});

describe('painel: última compra e variação de custo', () => {
  it('calcula a variação da última compra sobre a anterior', () => {
    assert.equal(ctx.variacaoCusto({ custo_ultima_compra: '110.00', custo_compra_anterior: '100.00' }), 10);
    assert.equal(ctx.variacaoCusto({ custo_ultima_compra: '45.00', custo_compra_anterior: '50.00' }), -10);
    assert.equal(ctx.variacaoCusto({ custo_ultima_compra: '33.33', custo_compra_anterior: '30.00' }), 11.1);
    assert.equal(ctx.variacaoCusto({ custo_ultima_compra: '50.00', custo_compra_anterior: null }), null);
    assert.equal(ctx.variacaoCusto({ custo_ultima_compra: '50.00', custo_compra_anterior: '0.00' }), null);
  });

  it('mostra data e seta de alta/baixa', () => {
    const alta = ctx.htmlUltimaCompra({ ultima_compra: '2026-10-12', custo_ultima_compra: '110', custo_compra_anterior: '100', total_compras: 2 });
    assert.match(alta, /Últ\. compra 12\/10\/2026/);
    assert.match(alta, /text-red-600.*▲ 10%/);
    const baixa = ctx.htmlUltimaCompra({ ultima_compra: '2026-10-12', custo_ultima_compra: '94.5', custo_compra_anterior: '100', total_compras: 2 });
    assert.match(baixa, /text-green-600.*▼ 5,5%/);
    assert.equal(ctx.htmlUltimaCompra({ ultima_compra: null }), '');
    assert.doesNotMatch(ctx.htmlUltimaCompra({ ultima_compra: '2026-10-12', custo_compra_anterior: null }), /▲|▼/);
  });
});

describe('painel: importação pelo link', () => {
  it('converte os dados importados para os campos do formulário', () => {
    const c = ctx.camposDaImportacao({ nome: 'Aviador', preco_custo: 79.9, codigo_fornecedor: 'CL-1', fornecedor: 'Clush', link_fornecedor: 'https://clush.com.br/p' });
    assert.deepEqual({ ...c }, { nome: 'Aviador', preco_custo: '79.90', codigo_fornecedor: 'CL-1', fornecedor: 'Clush', link_fornecedor: 'https://clush.com.br/p' });
    const vazio = ctx.camposDaImportacao({ nome: 'X', preco_custo: null, link_fornecedor: 'javascript:alert(1)' });
    assert.equal(vazio.preco_custo, '');
    assert.equal(vazio.link_fornecedor, '');
  });
});

describe('painel: fotos por SKU', () => {
  const produtos = [
    { id: 1, codigo_sku: 'AV-1' },
    { id: 2, codigo_sku: 'AV-10' },
    { id: 3, codigo_sku: 'RD 2' },
    { id: 4, codigo_sku: '' },
  ];

  it('liga cada arquivo ao SKU do nome, em ordem natural', () => {
    const nomes = ['AV-1_10.jpg', 'av-1.JPG', 'AV-10.png', 'AV-1 (2).webp', 'rd 2-frente.jpeg', 'XYZ.jpg', 'AV-100.jpg', 'AV-1.heic'];
    const r = ctx.associarFotosPorSku(nomes, produtos);
    const porSku = Object.fromEntries(r.grupos.map(g => [g.produto.codigo_sku, [...g.arquivos].map(i => nomes[i])]));
    assert.deepEqual(porSku['AV-1'], ['av-1.JPG', 'AV-1.heic', 'AV-1 (2).webp', 'AV-1_10.jpg']);
    assert.deepEqual(porSku['AV-10'], ['AV-10.png']);
    assert.deepEqual(porSku['RD 2'], ['rd 2-frente.jpeg']);
    assert.deepEqual([...r.semProduto].map(i => nomes[i]), ['XYZ.jpg', 'AV-100.jpg']);
  });

  it('sem produtos, tudo fica sem produto', () => {
    const r = ctx.associarFotosPorSku(['a.jpg'], []);
    assert.equal(r.grupos.length, 0);
    assert.deepEqual([...r.semProduto], [0]);
  });
});

describe('painel: resumo da maleta para WhatsApp', () => {
  const pecas = [
    { id: 1, nome: 'Aviador Gold', codigo_sku: 'AV-1', preco_venda: '199.90' },
    { id: 2, nome: 'Redondo Preto', codigo_sku: 'RD-2', preco_venda: '149.90' },
    { id: 3, nome: 'Gatinho', codigo_sku: 'GT-3', preco_venda: '100.00' },
  ];

  it('sem itens marcados, lista as peças enviadas com modelo, SKU, preço e total', () => {
    const t = ctx.montarResumoMaleta(pecas, [], []);
    assert.match(t, /^\*Nix Glasses: sua maleta\*/);
    assert.match(t, /1\. Aviador Gold\n {3}SKU: AV-1 \| R\$ 199,90/);
    assert.match(t, /3\. Gatinho\n {3}SKU: GT-3 \| R\$ 100,00/);
    assert.match(t, /Total: 3 peça\(s\) \| R\$ 449,80/);
    assert.doesNotMatch(t, / /); // sem espaço especial do Intl (WhatsApp mostra estranho)
  });

  it('com itens marcados, vira o resumo do acerto', () => {
    const t = ctx.montarResumoMaleta(pecas, [1, 3], [2]);
    assert.match(t, /acerto da maleta/);
    assert.match(t, /Ficou com \(2\):\*\n1\. Aviador Gold[\s\S]*2\. Gatinho/);
    assert.match(t, /Total a pagar: R\$ 299,90/);
    assert.match(t, /Devolvidos \(1\):\*\n1\. Redondo Preto/);
  });

  it('só devolvidos: sem total a pagar', () => {
    const t = ctx.montarResumoMaleta(pecas, [], [1]);
    assert.doesNotMatch(t, /Total a pagar/);
    assert.match(t, /Devolvidos \(1\)/);
  });
});
