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
  'formatarMedida', 'nomeArquivoSku', 'precoVendaSugerido', 'proximoSku', 'produtoJaCadastrado', 'camposDaImportacao', 'aplicarImportacao', 'associarFotosPorSku', 'montarResumoMaleta', 'calcularAcerto'];
const ctx = vm.createContext({ Number, String, Math, Map, Set, Object, URL, Intl });
vm.runInContext(`
  const MAX_FOTOS = 4;
  const CAMPOS_MEDIDA = ['diametro_cm', 'ponte_cm', 'largura_total_cm'];
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
    assert.deepEqual({ ...c }, {
      nome: 'Aviador', nome_fornecedor: 'Aviador', preco_custo: '79.90', preco_venda: '', imagem_fornecedor: '', codigo_fornecedor: 'CL-1', fornecedor: 'Clush', link_fornecedor: 'https://clush.com.br/p',
      formato: '', estilo: '', cor_armacao: '', material: '', tipo: '', genero: '', diametro_cm: '', ponte_cm: '', largura_total_cm: '',
    });
    // Especificações da descrição: medidas com vírgula, gênero só se for um código válido
    const e = ctx.camposDaImportacao({
      nome: 'Máscara Nitro', nome_fornecedor: 'Máscara Nitro - Injetado', diametro_cm: 6.2, ponte_cm: 1, largura_total_cm: 16,
      material: 'Injetado', formato: 'Máscara', tipo: 'UV400', genero: 'UNISSEX',
    });
    assert.equal(e.nome_fornecedor, 'Máscara Nitro - Injetado');
    assert.deepEqual([e.diametro_cm, e.ponte_cm, e.largura_total_cm], ['6,2', '1,0', '16,0']);
    assert.deepEqual([e.material, e.formato, e.tipo, e.genero], ['Injetado', 'Máscara', 'UV400', 'UNISSEX']);
    assert.equal(ctx.camposDaImportacao({ genero: '<b>' }).genero, '');
    const vazio = ctx.camposDaImportacao({ nome: 'X', preco_custo: null, link_fornecedor: 'javascript:alert(1)' });
    assert.equal(vazio.preco_custo, '');
    assert.equal(vazio.link_fornecedor, '');
  });
});

describe('painel: importar um segundo link no mesmo formulário', () => {
  it('troca o que veio do link anterior, apaga o que a nova página não tem e não mexe no que foi digitado', () => {
    const vazio = { nome: '', nome_fornecedor: '', codigo_fornecedor: '', estilo: '', material: '', fornecedor: '', preco_custo: '' };
    const p1 = ctx.aplicarImportacao(vazio, { nome: 'Gatinho Venice', nome_fornecedor: 'Gatinho Venice', codigo_fornecedor: 'WF1', material: 'Acetato', fornecedor: 'Clush', preco_custo: '29.90' }, {});
    assert.equal(p1.valores.nome, 'Gatinho Venice');
    assert.equal(p1.valores.material, 'Acetato');

    // Usuário digitou o nome e o estilo; o 2º link não tem material
    const atuais = { ...p1.valores, nome: 'NIX Compso', estilo: 'Meu estilo' };
    const p2 = ctx.aplicarImportacao(atuais, { nome: 'Máscara Nitro', nome_fornecedor: 'Máscara Nitro', codigo_fornecedor: 'DJY8Z', fornecedor: 'Clush', preco_custo: '39.90', estilo: '' }, p1.importados);
    assert.equal(p2.valores.nome, 'NIX Compso');
    assert.equal(p2.valores.nome_fornecedor, 'Máscara Nitro');
    assert.equal(p2.valores.codigo_fornecedor, 'DJY8Z');
    assert.equal(p2.valores.preco_custo, '39.90');
    assert.equal(p2.valores.material, '');
    assert.equal(p2.valores.estilo, 'Meu estilo');

    // Nome ainda igual ao importado antes: troca pelo novo
    const p3 = ctx.aplicarImportacao({ ...p1.valores }, { nome: 'Máscara Nitro' }, p1.importados);
    assert.equal(p3.valores.nome, 'Máscara Nitro');
  });
});

describe('painel: SKU, reposição e venda sugerida na importação', () => {
  it('foto baixada com o nome do SKU', () => {
    assert.equal(ctx.nomeArquivoSku('NIX023', 'jpg'), 'NIX023.jpg');
    assert.equal(ctx.nomeArquivoSku(' NIX 023/A ', 'png'), 'NIX_023_A.png');
    assert.equal(ctx.nomeArquivoSku('../..', 'jpg'), 'produto.jpg');
    assert.equal(ctx.camposDaImportacao({ nome: 'X', imagens: ['https://cdn.clush.com.br/a.jpg'] }).imagem_fornecedor, 'https://cdn.clush.com.br/a.jpg');
    assert.equal(ctx.camposDaImportacao({ nome: 'X', imagens: ['javascript:alert(1)'] }).imagem_fornecedor, '');
  });

  it('preço de venda: valor sugerido ou o meio da faixa terminando em ,90', () => {
    assert.equal(ctx.precoVendaSugerido({ min: 59.9, max: 199.9 }), '129.90');
    assert.equal(ctx.precoVendaSugerido({ min: 129.9, max: 129.9 }), '129.90');
    assert.equal(ctx.precoVendaSugerido(null), '');
    assert.equal(ctx.camposDaImportacao({ nome: 'X', preco_venda_sugerido: { min: 59.9, max: 199.9 } }).preco_venda, '129.90');
  });

  it('próximo SKU segue a sequência mais usada, contando as linhas do lote', () => {
    const produtos = [{ codigo_sku: 'NIX001' }, { codigo_sku: 'NIX022' }, { codigo_sku: 'nix009' }, { codigo_sku: 'AV-1' }, { codigo_sku: 'TESTE' }];
    assert.equal(ctx.proximoSku(produtos), 'NIX023');
    assert.equal(ctx.proximoSku(produtos, ['NIX023', '']), 'NIX024');
    assert.equal(ctx.proximoSku([{ codigo_sku: 'NIX099' }, { codigo_sku: 'NIX100' }]), 'NIX101');
    assert.equal(ctx.proximoSku([]), '');
  });

  it('reconhece produto já cadastrado pelo link ou pelo código no mesmo fornecedor', () => {
    const produtos = [
      { id: 5, codigo_sku: 'NIX005', fornecedor: 'Clush', codigo_fornecedor: 'DJY8Z', link_fornecedor: '' },
      { id: 7, codigo_sku: 'NIX007', fornecedor: 'Outro', codigo_fornecedor: 'ABC', link_fornecedor: 'https://www.clush.com.br/produtos/turbo-ab12c/' },
    ];
    assert.equal(ctx.produtoJaCadastrado(produtos, { fornecedor: 'clush', codigo_fornecedor: 'djy8z' }).id, 5);
    assert.equal(ctx.produtoJaCadastrado(produtos, { fornecedor: 'Clush', codigo_fornecedor: 'X', link_fornecedor: 'https://www.clush.com.br/produtos/turbo-ab12c' }).id, 7);
    assert.equal(ctx.produtoJaCadastrado(produtos, { fornecedor: 'Outra loja', codigo_fornecedor: 'DJY8Z' }), null);
    assert.equal(ctx.produtoJaCadastrado(produtos, { fornecedor: 'Clush', codigo_fornecedor: '' }), null);
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
    assert.match(t, /sem valor a pagar/);
    assert.match(t, /Devolvidos \(1\)/);
  });

  it('acerto parcial lista o que ainda está com a cliente', () => {
    const t = ctx.montarResumoMaleta(pecas, [1], []);
    assert.match(t, /Total a pagar: R\$ 199,90/);
    assert.match(t, /Ainda com você \(2\):\*\n1\. Redondo Preto[\s\S]*2\. Gatinho/);
    assert.doesNotMatch(ctx.montarResumoMaleta(pecas, [1, 2], [3]), /Ainda com você/);
  });
});

describe('painel: placar do acerto', () => {
  const pecas = [
    { id: 1, preco_venda: '0.10' },
    { id: 2, preco_venda: '0.20' },
    { id: 3, preco_venda: '100.00' },
    { id: 4, preco_venda: '50.00' },
  ];

  it('separa comprados, devolvidos e pendentes e soma o total sem erro de centavos', () => {
    const a = ctx.calcularAcerto(pecas, new Map([[1, 'comprado'], [2, 'comprado'], [3, 'devolvido']]));
    assert.deepEqual(a.comprados.map(p => p.id), [1, 2]);
    assert.deepEqual(a.devolvidos.map(p => p.id), [3]);
    assert.deepEqual(a.pendentes.map(p => p.id), [4]);
    assert.equal(a.total, 0.3);
  });

  it('sem marcações, tudo fica pendente e o total é zero', () => {
    const a = ctx.calcularAcerto(pecas, new Map());
    assert.equal(a.pendentes.length, 4);
    assert.equal(a.total, 0);
  });
});
