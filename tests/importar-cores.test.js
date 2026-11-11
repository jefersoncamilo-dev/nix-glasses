// Importação pelo link com cores (Tassia Nunes e outras lojas Nuvemshop): as variações
// de cor do produto, com a foto de cada uma e as fotos comuns, viram uma linha do
// Cadastro em Lote por cor (linhasDasCores), todas com o mesmo Código do modelo.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extrairDadosProduto } = require('../importar-produto');

const URL_TASSIA = 'https://tassianunesatacado.com.br/produtos/oculos-de-sol-nv1720-geometrico-polarizado-unissex-esporte-11i37/';
const CDN = '//dcdn-us.mitiendanube.com/stores/001/111/products';
const NOME = 'Óculos de Sol NV1720 Geométrico Polarizado Unissex Esporte';

// Página no formato da Nuvemshop: data-variants (JSON com &quot;), galeria com data-image e select "Cor"
function paginaNuvemshop(variacoes, { rotulo = 'Cor', slides = true } = {}) {
  const attr = JSON.stringify(variacoes).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const galeria = !slides ? '' : [['101', 'preto'], ['102', 'marrom'], ['103', 'azul'], ['104', 'lateral'], ['105', 'caixa'], ['106', 'medidas']]
    .map(([id, f]) => `<div class="js-product-slide swiper-slide" data-image="${id}" data-image-position="0">
      <a href="${CDN}/${f}-1024-1024.webp" data-fancybox="product-gallery"><img src="data:image/gif;base64,R0lG" data-srcset="${CDN}/${f}-480-0.webp 480w" class="lazyload"></a></div>`).join('\n');
  return `<!doctype html><html><head><title>${NOME} - Comprar em Tassia Nunes Atacado</title>
<meta property="og:site_name" content="Tassia Nunes Atacado">
<meta property="og:title" content="${NOME}">
<script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product","name":"${NOME}","image":"https:${CDN}/preto-1024-1024.webp","offers":{"@type":"Offer","price":"29.90","priceCurrency":"BRL"}}</script>
</head><body>
<div id="single-product" class="js-product-detail js-product-container" data-variants="${attr}" data-store="product-detail">
${galeria}
<form id="product_form" class="js-product-form" method="post" action="/comprar/">
  <div class="js-product-variants">
    <div class="js-product-variants-group" data-variation-id="0">
      <div class="form-group"><label class="form-label" for="variation_1">${rotulo}: <strong class="js-insta-variation-label">Preto</strong></label>
      <select id="variation_1" class="form-select js-variation-option" name="variation[0]"><option value="Preto">Preto</option></select></div>
    </div>
  </div>
</form>
</div>
<section class="js-related-products"><div class="js-item-product" data-product-id="999"><img src="${CDN}/outro-480-0.webp"></div></section>
</body></html>`;
}

const variacoes = [
  { product_id: 1, price_short: 'R$29,90', price_number: 29.9, stock: 5, available: true, option0: 'Preto', option1: null, option2: null, id: 11, image: 101, image_url: `${CDN}/preto-1024-1024.webp`, sku: null },
  { product_id: 1, price_short: 'R$29,90', price_number: 29.9, stock: 0, available: false, option0: 'Marrom', option1: null, option2: null, id: 12, image: 102, image_url: null, sku: null },
  { product_id: 1, price_short: 'R$31,90', price_number: 31.9, stock: null, available: true, option0: 'Azul', option1: null, option2: null, id: 13, image: 103, image_url: `${CDN}/azul-480-0.webp`, sku: 'NV1720-AZ' },
];

describe('importação: cores da Nuvemshop (Tassia Nunes)', () => {
  it('lê as cores com a foto de cada uma, disponibilidade e preço', () => {
    const d = extrairDadosProduto(paginaNuvemshop(variacoes), URL_TASSIA);
    assert.equal(d.nome_fornecedor, NOME);
    assert.equal(d.fornecedor, 'Tassia Nunes Atacado');
    assert.equal(d.codigo_fornecedor, 'NV1720', 'código do modelo escrito no nome');
    assert.deepEqual(d.cores.map(c => [c.cor, c.disponivel, c.preco]), [['Preto', true, 29.9], ['Marrom', false, 29.9], ['Azul', true, 31.9]]);
    assert.equal(d.cores[0].imagem, `https:${CDN}/preto-1024-1024.webp`);
    assert.equal(d.cores[1].imagem, `https:${CDN}/marrom-1024-1024.webp`, 'sem image_url: pela foto da galeria com o mesmo id');
    assert.equal(d.cores[2].imagem, `https:${CDN}/azul-1024-1024.webp`, 'foto pequena vira a grande');
    assert.deepEqual(d.fotos_comuns, ['lateral', 'caixa', 'medidas'].map(f => `https:${CDN}/${f}-1024-1024.webp`));
  });

  it('mesma cor em vários tamanhos vira uma cor só; outra opção (Tamanho) não é cor', () => {
    const v = [
      { option0: 'P', option1: 'Preto', available: false, image_url: `${CDN}/preto-1024-1024.webp` },
      { option0: 'M', option1: 'Preto', available: true },
      { option0: 'P', option1: 'Rosa', available: true, image: 105 },
    ];
    const pagina = paginaNuvemshop(v).replace('<div class="js-product-variants-group" data-variation-id="0">',
      '<div class="js-product-variants-group" data-variation-id="0"><label class="form-label">Tamanho</label></div><div class="js-product-variants-group" data-variation-id="1">');
    const d = extrairDadosProduto(pagina, URL_TASSIA);
    assert.deepEqual(d.cores.map(c => [c.cor, c.disponivel]), [['Preto', true], ['Rosa', true]]);
    assert.equal(d.cores[1].imagem, `https:${CDN}/caixa-1024-1024.webp`);
  });

  it('sem rótulo, a opção com nomes de cor é a cor; produto sem variação não tem cores', () => {
    const semRotulo = paginaNuvemshop(variacoes).replace(/<form[\s\S]*<\/form>/, '');
    assert.deepEqual(extrairDadosProduto(semRotulo, URL_TASSIA).cores.map(c => c.cor), ['Preto', 'Marrom', 'Azul']);
    const simples = extrairDadosProduto(`<title>${NOME}</title><script type="application/ld+json">{"@type":"Product","name":"${NOME}"}</script>`, URL_TASSIA);
    assert.deepEqual(simples.cores, []);
    assert.deepEqual(simples.fotos_comuns, []);
  });

  it('variações só de tamanho (com rótulo) não viram cores', () => {
    const v = [{ option0: 'P' }, { option0: 'M' }];
    assert.deepEqual(extrairDadosProduto(paginaNuvemshop(v, { rotulo: 'Tamanho' }), URL_TASSIA).cores, []);
  });

  it('JSON-LD ProductGroup com hasVariant também traz as cores', () => {
    const pagina = `<script type="application/ld+json">{"@type":"ProductGroup","name":"Óculos X","hasVariant":[
      {"@type":"Product","color":"Preto","image":"https://cdn.loja.com/x-preto.jpg","offers":{"price":"20.00","availability":"https://schema.org/InStock"}},
      {"@type":"Product","color":"Rosa","image":"https://cdn.loja.com/x-rosa.jpg","offers":{"price":"20.00","availability":"https://schema.org/OutOfStock"}}]}</script>`;
    const d = extrairDadosProduto(pagina, 'https://loja.com/p/x');
    assert.deepEqual(d.cores.map(c => [c.cor, c.imagem, c.disponivel]), [['Preto', 'https://cdn.loja.com/x-preto.jpg', true], ['Rosa', 'https://cdn.loja.com/x-rosa.jpg', false]]);
  });

  it('UV400 no nome não é código do modelo', () => {
    const d = extrairDadosProduto('<title>Óculos Aviador UV400 Dourado</title>', 'https://www.clush.com.br/produtos/oculos-aviador-djy8z/');
    assert.equal(d.codigo_fornecedor, 'DJY8Z');
  });
});

// ---------- Painel: linhas do lote por cor ----------
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
const funcoes = ['linkSeguro', 'precoVendaPadrao', 'proximoSku', 'nomeTematico', 'camposDaImportacao', 'formatarMedida', 'linhaLoteVazia', 'linhaLoteEstaVazia', 'conflitosLote', 'linhasDasCores'];
const ctx = vm.createContext({ Number, String, Math, Map, Set, Object, URL, Array, JSON });
vm.runInContext(`
  const ACRESCIMO_VENDA = 100;
  const CAMPOS_MEDIDA = ['diametro_cm', 'ponte_cm', 'largura_total_cm'];
  ${html.match(/const COLUNAS_LOTE = \[[\s\S]*?\n {4}\];/)[0]}
  ${funcoes.map(extrairFuncao).join('\n')}
  ${funcoes.map(f => `this.${f} = ${f};`).join('\n')}
`, ctx);

function linhaBase(dados) {
  const c = ctx.camposDaImportacao({ ...dados, link_fornecedor: URL_TASSIA });
  return { ...ctx.linhaLoteVazia(), ...c, preco_custo: c.preco_custo.replace('.', ','), preco_venda: c.preco_venda.replace('.', ',') };
}

describe('painel: Cadastro em Lote com as cores do link', () => {
  const dados = extrairDadosProduto(paginaNuvemshop(variacoes), URL_TASSIA);

  it('uma linha por cor disponível, mesmo Código do modelo, nome/SKU Nix com a cor e fotos', () => {
    const r = ctx.linhasDasCores(linhaBase(dados), dados, [], []);
    assert.deepEqual([...r.esgotadas], ['Marrom']);
    assert.equal(r.linhas.length, 2);
    const [preto, azul] = r.linhas;
    assert.equal(preto.cor_armacao, 'Preto');
    assert.equal(preto.nome, 'Nix Raptor NV1720 - Onyx Black');
    assert.equal(preto.codigo_sku, 'NIX-NV1-RAP-BLK');
    assert.equal(azul.nome, 'Nix Raptor NV1720 - Ocean Blue');
    assert.equal(azul.codigo_sku, 'NIX-NV1-RAP-BLU');
    assert.equal(preto.grade, 'NIX-NV1-RAP');
    assert.equal(azul.grade, 'NIX-NV1-RAP');
    assert.equal(preto.nome_fornecedor, `${NOME} - Preto`);
    assert.equal(preto.codigo_fornecedor, 'NV1720');
    assert.equal(preto.fornecedor, 'Tassia Nunes Atacado');
    assert.equal(preto.imagem_fornecedor, `https:${CDN}/preto-1024-1024.webp`);
    assert.equal(azul.imagem_fornecedor, `https:${CDN}/azul-1024-1024.webp`);
    assert.deepEqual([...preto.imagens_extras], [`https:${CDN}/lateral-1024-1024.webp`, `https:${CDN}/caixa-1024-1024.webp`]);
    assert.equal(preto.preco_custo, '29,90');
    assert.equal(azul.preco_custo, '31,90', 'preço da variação');
    assert.equal(azul.preco_venda, '131,90');
    assert.equal(preto.cadastrar_novo, true, 'não junta com a outra cor pelo cód. do fornecedor');
  });

  it('as cores do mesmo modelo não pedem conferência entre si', () => {
    const r = ctx.linhasDasCores(linhaBase(dados), dados, [], []);
    assert.equal(ctx.conflitosLote(r.linhas, []).length, 0);
  });

  it('cor já cadastrada vira reposição de 1 no SKU dela; as outras são novas', () => {
    const existentes = [{ id: 5, nome: 'Nix Raptor NV1720 - Onyx Black', codigo_sku: 'NIX-NV1-RAP-BLK', cor_armacao: 'preto', grade: 'NIX-NV1-RAP', fornecedor: 'Tassia Nunes Atacado', codigo_fornecedor: 'NV1720', link_fornecedor: URL_TASSIA }];
    const r = ctx.linhasDasCores(linhaBase(dados), dados, existentes, []);
    const [preto, azul] = r.linhas;
    assert.equal(preto.codigo_sku, 'NIX-NV1-RAP-BLK');
    assert.equal(preto.quantidade, '1');
    assert.equal(preto.cadastrar_novo, undefined);
    assert.equal(azul.cadastrar_novo, true);
    // A cor nova do modelo já cadastrado não pede conferência
    assert.deepEqual(ctx.conflitosLote([azul], existentes).length, 0);
  });

  it('cor que o padrão Nix não conhece entra como está no nome e no SKU; todas esgotadas = todas entram', () => {
    const d = { ...dados, cores: [{ cor: 'C1 Fumê Degradê', disponivel: false }, { cor: 'Mix', disponivel: false }] };
    const r = ctx.linhasDasCores(linhaBase(d), d, [], []);
    assert.equal(r.linhas.length, 2);
    assert.deepEqual([...r.esgotadas], []);
    assert.equal(r.linhas[0].nome, 'Nix Raptor NV1720 - Smoke Gradient');
    assert.equal(r.linhas[1].nome, 'Nix Raptor NV1720 - Mix');
    assert.equal(r.linhas[1].codigo_sku, 'NIX-NV1-RAP-MIX');
    assert.notEqual(r.linhas[0].codigo_sku, r.linhas[1].codigo_sku);
  });
});
