// Importação pelo link com cores (Tassia Nunes e outras lojas Nuvemshop): as variações
// de cor do produto, com a foto de cada uma e as fotos comuns, viram uma linha do
// Cadastro em Lote numa linha só por modelo, com o estoque de cada cor (Cores cor:qtd).
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

// ---------- Painel: o modelo com as cores numa linha do lote ----------
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
const funcoes = ['linkSeguro', 'precoVendaPadrao', 'ehPolarizado', 'proximoSku', 'nomeCurtoDino', 'nomeNix', 'nomeTematico', 'camposDaImportacao', 'formatarMedida', 'linhaLoteVazia', 'linhaLoteEstaVazia',
  'conflitosLote', 'produtoJaCadastrado', 'lerCoresLote', 'textoCoresLote', 'linhaDoModeloComCores', 'planoCoresLote', 'resumoCoresLote', 'expandirCoresLote',
  'agruparCoresPorModelo', 'nomeDoModelo', 'coresDoModeloDe', 'lerCoresModelo', 'lerPreco', 'lerMedida', 'lerDataCompra', 'validarLote', 'campoDoCabecalho', 'linhasDaPlanilha', 'lerDisponibilidade', 'lerStatus', 'lerGenero'];
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
const json = (v) => JSON.parse(JSON.stringify(v));

describe('painel: Cadastro em Lote com as cores do link (um produto, estoque por cor)', () => {
  const dados = extrairDadosProduto(paginaNuvemshop(variacoes), URL_TASSIA);

  it('lê e escreve "cor:qtd"', () => {
    assert.deepEqual(json(ctx.lerCoresLote('Preto:2, Azul claro : 3; Rosa')), [{ cor: 'Preto', qtd: 2, disp: 'PRONTA_ENTREGA' }, { cor: 'Azul claro', qtd: 3, disp: 'PRONTA_ENTREGA' }, { cor: 'Rosa', qtd: 1, disp: 'PRONTA_ENTREGA' }]);
    assert.deepEqual(json(ctx.lerCoresLote('Preto:0, Rosa:0:encomenda, Azul:2:encomenda, Verde:3:esgotado, Lilás:1:disponível')), [
      { cor: 'Preto', qtd: 0, disp: 'ESGOTADO' }, { cor: 'Rosa', qtd: 0, disp: 'SOB_ENCOMENDA' }, { cor: 'Azul', qtd: 2, disp: 'SOB_ENCOMENDA' },
      { cor: 'Verde', qtd: 0, disp: 'ESGOTADO' }, { cor: 'Lilás', qtd: 1, disp: 'PRONTA_ENTREGA' }]);
    assert.equal(ctx.lerCoresLote('Preto:1:qualquer'), null, 'disponibilidade desconhecida');
    assert.equal(ctx.textoCoresLote([{ cor: 'Preto', qtd: 0, disp: 'ESGOTADO' }, { cor: 'Rosa', qtd: 0, disp: 'SOB_ENCOMENDA' }]), 'Preto:0:esgotado, Rosa:0:encomenda');
    assert.deepEqual(json(ctx.lerCoresLote('')), []);
    assert.equal(ctx.lerCoresLote('Preto:1, preto:2'), null, 'cor repetida');
    assert.equal(ctx.lerCoresLote('Preto:x'), null);
    assert.equal(ctx.textoCoresLote([{ cor: 'Preto', qtd: 2 }, { cor: 'Rosa', qtd: 1 }]), 'Preto:2, Rosa:1');
  });

  it('importação: UMA linha para o modelo, com as cores disponíveis (1 de cada) e a foto de cada cor', () => {
    const r = ctx.linhaDoModeloComCores(linhaBase(dados), dados, [], []);
    assert.deepEqual([...r.esgotadas], ['Marrom']);
    const l = r.linha;
    // Nome NIX + nome curto + tipo + formato da lente (sem a cor; cada cor ganha " - <cor>")
    assert.equal(l.nome, 'NIX Deinony Polarizado Geométrico');
    assert.equal(l.codigo_sku, 'NIX-NV1-RAP');
    assert.equal(l.cores, 'Preto:1, Marrom:0:esgotado, Azul:1', 'esgotada no site entra como Esgotado');
    assert.equal(l.cor_armacao, '');
    assert.equal(l.codigo_fornecedor, 'NV1720');
    assert.deepEqual(json(l.fotos_cores), { preto: `https:${CDN}/preto-1024-1024.webp`, marrom: `https:${CDN}/marrom-1024-1024.webp`, azul: `https:${CDN}/azul-1024-1024.webp` });
    assert.deepEqual(json(l.imagens_extras), [`https:${CDN}/lateral-1024-1024.webp`, `https:${CDN}/caixa-1024-1024.webp`]);
    assert.equal(ctx.resumoCoresLote(l, []), 'Um produto com 3 cor(es), 2 peça(s) na loja: Preto (1), Marrom (esgotado), Azul (1)');
    assert.deepEqual(json(ctx.validarLote([l])), [{}]);
    assert.equal(ctx.conflitosLote([l, { ...l }], []).length, 0, 'linha com cores não abre a conferência');
  });

  it('ao salvar, modelo novo vira um cadastro por cor por dentro, todos com o mesmo Código do modelo', () => {
    const l = { ...ctx.linhaDoModeloComCores(linhaBase(dados), dados, [], []).linha, cores: 'Preto:2, Azul:1' };
    const e = ctx.expandirCoresLote([l], []);
    assert.equal(e.incluir.length, 0);
    assert.deepEqual([...e.origens], [0, 0]);
    const [preto, azul] = e.produtos;
    assert.equal(preto.nome, 'NIX Deinony Polarizado Geométrico - Preto');
    assert.equal(preto.codigo_sku, 'NIX-NV1-RAP-PRETO');
    assert.equal(preto.grade, 'NIX-NV1-RAP');
    assert.equal(preto.cor_armacao, 'Preto');
    assert.equal(preto.quantidade, '2');
    assert.equal(preto.cadastrar_novo, true);
    assert.equal(preto.imagem_fornecedor, `https:${CDN}/preto-1024-1024.webp`);
    assert.equal(preto.cores, undefined);
    assert.equal(azul.codigo_sku, 'NIX-NV1-RAP-AZUL');
    assert.equal(azul.quantidade, '1');
  });

  it('mesmo cód. do fornecedor já cadastrado: soma nas cores que ele tem e inclui as novas no modelo', () => {
    const existentes = [
      { id: 5, nome: 'Nix Raptor NV1720 - Preto', codigo_sku: 'NIX-NV1-RAP-PRETO', cor_armacao: 'preto', grade: 'NIX-NV1-RAP', fornecedor: 'Tassia Nunes Atacado', codigo_fornecedor: 'NV1720', link_fornecedor: '', tamanho: '' },
      { id: 6, nome: 'Outro', codigo_sku: 'OUTRO', cor_armacao: 'Azul', grade: '', fornecedor: 'Tassia Nunes Atacado', codigo_fornecedor: 'X1', tamanho: '' },
    ];
    const l = ctx.linhaDoModeloComCores(linhaBase(dados), dados, existentes, []).linha;
    assert.equal(l.codigo_sku, 'NIX-NV1-RAP', 'usa o código do modelo cadastrado');
    assert.equal(l.nome, 'Nix Raptor NV1720');
    assert.equal(ctx.resumoCoresLote(l, existentes), 'Já cadastrado (NIX-NV1-RAP-PRETO): inclui a(s) cor(es) Marrom (esgotado), Azul (1); soma no estoque de Preto (1)');
    const e = ctx.expandirCoresLote([l], existentes);
    assert.equal(e.produtos.length, 1);
    assert.equal(e.produtos[0].codigo_sku, 'NIX-NV1-RAP-PRETO');
    assert.equal(e.produtos[0].quantidade, '1');
    assert.equal(e.produtos[0].imagem_fornecedor, '', 'reposição não troca a foto');
    assert.equal(e.incluir.length, 1);
    assert.equal(e.incluir[0].produto.id, 5);
    assert.deepEqual(json(e.incluir[0].cores), [
      { cor: 'Marrom', estoque: 0, disponibilidade: 'ESGOTADO', foto: `https:${CDN}/marrom-1024-1024.webp` },
      { cor: 'Azul', estoque: 1, disponibilidade: 'PRONTA_ENTREGA', foto: `https:${CDN}/azul-1024-1024.webp` }]);
  });

  it('cor nova esgotada ou sob encomenda entra sem peça e com a disponibilidade', () => {
    const l = { ...ctx.linhaDoModeloComCores(linhaBase(dados), dados, [], []).linha, cores: 'Preto:2, Marrom:0:esgotado, Azul:0:encomenda' };
    assert.deepEqual(json(ctx.validarLote([l])), [{}]);
    const [preto, marrom, azul] = ctx.expandirCoresLote([l], []).produtos;
    assert.equal(preto.disponibilidade, 'PRONTA_ENTREGA');
    assert.equal(preto.sem_estoque, undefined);
    assert.equal(marrom.sem_estoque, true);
    assert.equal(marrom.disponibilidade, 'PRONTA_ENTREGA', 'esgotada = pronta entrega sem peça');
    assert.equal(azul.sem_estoque, true);
    assert.equal(azul.disponibilidade, 'SOB_ENCOMENDA');
  });

  it('editar produto: um cabeçalho e a lista de cores do modelo, a cor aberta primeiro', () => {
    const produtos = [
      { id: 1, nome: 'Nix Raptor NV1720 - Preto', codigo_sku: 'NIX-NV1-RAP-PRETO', cor_armacao: 'Preto', grade: 'NIX-NV1-RAP', tamanho: '', estoque: 2, disponibilidade: 'PRONTA_ENTREGA' },
      { id: 2, nome: 'Nix Raptor NV1720 - Azul', codigo_sku: 'NIX-NV1-RAP-AZUL', cor_armacao: 'Azul', grade: 'nix-nv1-rap', tamanho: '', estoque: 0, disponibilidade: 'PRONTA_ENTREGA' },
      { id: 3, nome: 'Nix Raptor NV1720 - Rosa', codigo_sku: 'NIX-NV1-RAP-ROSA', cor_armacao: 'Rosa', grade: 'NIX-NV1-RAP', tamanho: '', estoque: 0, disponibilidade: 'SOB_ENCOMENDA' },
      { id: 4, nome: 'Outro', codigo_sku: 'OUTRO', cor_armacao: 'Preto', grade: 'OUTRO', tamanho: '', estoque: 1 },
    ];
    const cores = ctx.coresDoModeloDe(produtos[1], produtos);
    assert.deepEqual(json(cores.map(c => [c.produto.id, c.cor, c.estoque, c.disponibilidade])), [[2, 'Azul', '0', 'ESGOTADO'], [1, 'Preto', '2', 'PRONTA_ENTREGA'], [3, 'Rosa', '0', 'SOB_ENCOMENDA']]);
    assert.equal(ctx.coresDoModeloDe({ ...produtos[0], grade: '' }, produtos).length, 0, 'sem Código do modelo: edição como sempre');
    assert.equal(ctx.coresDoModeloDe({ ...produtos[0], tamanho: 'M' }, produtos).length, 0, 'por tamanho não é por cor');

    cores[0].disponibilidade = 'PRONTA_ENTREGA'; cores[0].estoque = '3';
    cores[2].estoque = '1';
    assert.deepEqual(json(ctx.lerCoresModelo(cores).map(c => [c.cor, c.estoque, c.disponibilidade])), [['Azul', 3, 'PRONTA_ENTREGA'], ['Preto', 2, 'PRONTA_ENTREGA'], ['Rosa', 1, 'SOB_ENCOMENDA']]);
    cores[1].disponibilidade = 'ESGOTADO';
    assert.equal(ctx.lerCoresModelo(cores)[1].estoque, 0, 'Esgotado grava 0 peças');
    assert.equal(ctx.lerCoresModelo(cores, [{ cor: 'rosa' }]), null, 'cor nova repetida');
    assert.equal(ctx.lerCoresModelo([{ ...cores[0], cor: ' ' }]), null);
    assert.equal(ctx.lerCoresModelo([{ ...cores[0], estoque: '1,5' }]), null);
  });

  it('produto antigo sem Código do modelo e mesmo cód. do fornecedor: as cores entram nele', () => {
    const antigo = [{ id: 9, nome: 'Nix Rex Velho - Onyx Black', codigo_sku: 'NIX-VEL', cor_armacao: 'Preto', grade: '', fornecedor: 'Tassia Nunes Atacado', codigo_fornecedor: 'nv1720', tamanho: '' }];
    const plano = ctx.planoCoresLote({ ...ctx.linhaLoteVazia(), codigo_sku: 'NIX-NOVO', fornecedor: 'Tassia Nunes Atacado', codigo_fornecedor: 'NV1720', cores: 'Preto:1, Rosa:2' }, antigo);
    assert.equal(plano.modelo, 'NIX-VEL');
    assert.deepEqual(json(plano.itens.map(i => [i.cor, i.acao])), [['Preto', 'repor'], ['Rosa', 'incluir']]);
  });

  it('planilha: coluna "Cores" pelo cabeçalho; cor e tamanho juntos é erro', () => {
    const [l] = ctx.linhasDaPlanilha('Nome\tSKU\tCusto\tVenda\tCores\nNix X\tNIX-X\t10\t20\tPreto:2, Rosa:1');
    assert.equal(l.cores, 'Preto:2, Rosa:1');
    const erros = ctx.validarLote([{ ...l, preco_custo: '10', preco_venda: '20', cores: 'Preto:a' }, { ...l, tamanho: 'M' }]);
    assert.match(erros[0].cores, /Cores inválidas/);
    assert.match(erros[1].cores, /cores ou tamanho/);
  });

  it('lista de Produtos: as cores de um modelo numa linha só', () => {
    const lista = [
      { id: 1, nome: 'Nix A - Preto', cor_armacao: 'Preto', grade: 'NIX-A', tamanho: '' },
      { id: 2, nome: 'Avulso', cor_armacao: 'Azul', grade: '', tamanho: '' },
      { id: 3, nome: 'Nix A - Rosa', cor_armacao: 'Rosa', grade: 'nix-a', tamanho: '' },
      { id: 4, nome: 'Vestido - M', cor_armacao: '', grade: 'VEST', tamanho: 'M' },
      { id: 5, nome: 'Vestido - G', cor_armacao: '', grade: 'VEST', tamanho: 'G' },
      { id: 6, nome: 'Nix B - Preto', cor_armacao: 'Preto', grade: 'NIX-B', tamanho: '' },
    ];
    const itens = ctx.agruparCoresPorModelo(lista);
    assert.deepEqual(json(itens.map(i => i.cores ? i.cores.map(c => c.id) : i.produto.id)), [[1, 3], 2, 4, 5, 6]);
    assert.equal(ctx.nomeDoModelo(lista[0]), 'Nix A');
  });
});

// ---------- Em conferência: importado pelo link fica fora da vitrine ----------
const h = require('./helpers');
describe('API: produto importado fica em conferência até liberar', () => {
  let srv;
  let token;
  const { before, after } = require('node:test');
  before(async () => {
    await h.limparBanco();
    srv = await h.iniciarServidor();
    token = await h.login(srv);
  });
  after(async () => {
    await srv.parar();
    await h.fecharBanco();
  });
  const api = (p, opts = {}) => fetch(srv.url(p), { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  const vitrine = async () => (await (await fetch(srv.url('/api/produtos'))).json()).map((p) => p.codigo_sku);

  it('lote com em_conferencia não aparece na vitrine; liberar mostra', async () => {
    const base = { preco_custo: 29.9, preco_venda: 129.9, quantidade: '2' };
    const res = await api('/api/admin/produtos/lote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ produtos: [
        { ...base, nome: 'Nix A - Preto', codigo_sku: 'NIX-A-PRETO', cor_armacao: 'Preto', grade: 'NIX-A', em_conferencia: true },
        { ...base, nome: 'Avulso', codigo_sku: 'AVULSO' },
      ] }),
    });
    assert.equal(res.status, 201);
    const criados = (await res.json()).produtos;
    assert.deepEqual(await vitrine(), ['AVULSO']);
    const admin = await (await api('/api/admin/produtos')).json();
    assert.equal(admin.find((p) => p.codigo_sku === 'NIX-A-PRETO').em_conferencia, true);

    // cores novas incluídas pela importação também ficam em conferência
    const preto = criados.find((p) => p.codigo_sku === 'NIX-A-PRETO');
    const fd = new FormData();
    fd.append('cores', JSON.stringify([{ cor: 'Rosa', estoque: 1 }]));
    fd.append('em_conferencia', 'true');
    const rc = await api(`/api/produtos/${preto.id}/cores`, { method: 'POST', body: fd });
    assert.equal(rc.status, 201);
    const rosa = (await rc.json()).produtos[0];
    assert.equal(rosa.em_conferencia, true);
    assert.deepEqual(await vitrine(), ['AVULSO']);

    const lib = await api('/api/admin/produtos/conferencia', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [preto.id, rosa.id], em_conferencia: false }),
    });
    assert.deepEqual(await lib.json(), { atualizados: 2 });
    assert.deepEqual((await vitrine()).sort(), ['AVULSO', 'NIX-A-PRETO', 'NIX-A-ROSA']);
  });

  it('cores com disponibilidade: esgotada e sob encomenda entram sem peça e sem compra', async () => {
    const base = { preco_custo: 29.9, preco_venda: 129.9, quantidade: '1', grade: 'NIX-B', cadastrar_novo: true };
    const res = await api('/api/admin/produtos/lote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ produtos: [
        { ...base, nome: 'Nix B - Preto', codigo_sku: 'NIX-B-PRETO', cor_armacao: 'Preto' },
        { ...base, nome: 'Nix B - Azul', codigo_sku: 'NIX-B-AZUL', cor_armacao: 'Azul', sem_estoque: true },
        { ...base, nome: 'Nix B - Rosa', codigo_sku: 'NIX-B-ROSA', cor_armacao: 'Rosa', sem_estoque: true, disponibilidade: 'SOB_ENCOMENDA' },
      ] }),
    });
    assert.equal(res.status, 201);
    const [preto, azul, rosa] = (await res.json()).produtos;
    assert.deepEqual([preto.estoque, azul.estoque, rosa.estoque].map(Number), [1, 0, 0]);
    assert.equal(azul.status, 'ESGOTADO');
    assert.equal(rosa.disponibilidade, 'SOB_ENCOMENDA');
    const compras = await (await api(`/api/admin/produtos/${azul.id}/compras`)).json();
    assert.equal(compras.length, 0, 'cor sem peça não lança compra');

    const fd = new FormData();
    fd.append('cores', JSON.stringify([{ cor: 'Verde', estoque: 0, disponibilidade: 'SOB_ENCOMENDA' }, { cor: 'Lilás', estoque: 5, disponibilidade: 'ESGOTADO' }]));
    const rc = await api(`/api/produtos/${preto.id}/cores`, { method: 'POST', body: fd });
    assert.equal(rc.status, 201);
    const [verde, lilas] = (await rc.json()).produtos;
    assert.equal(verde.disponibilidade, 'SOB_ENCOMENDA');
    assert.equal(Number(lilas.estoque), 0, 'Esgotado grava 0 peças');
    assert.equal(lilas.disponibilidade, 'PRONTA_ENTREGA');

    const ruim = new FormData();
    ruim.append('cores', JSON.stringify([{ cor: 'Cinza', estoque: 1, disponibilidade: 'QUALQUER' }]));
    assert.equal((await api(`/api/produtos/${preto.id}/cores`, { method: 'POST', body: ruim })).status, 400);

    // Editar produto salva o cabeçalho nas outras cores do modelo pelo lote
    const up = await api('/api/admin/produtos/lote', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ produtos: [{ id: azul.id, nome: 'Nix B Novo - Azul', codigo_sku: 'NIX-B-AZUL', preco_custo: 30, preco_venda: 139.9, disponibilidade: 'SOB_ENCOMENDA', cor_armacao: 'Azul', grade: 'NIX-B', estoque: 2 }] }),
    });
    assert.equal(up.status, 200);
    const [azul2] = (await up.json()).produtos;
    assert.equal(azul2.nome, 'Nix B Novo - Azul');
    assert.equal(Number(azul2.preco_venda), 139.9);
    assert.equal(Number(azul2.estoque), 2);
    assert.equal(azul2.disponibilidade, 'SOB_ENCOMENDA');
  });

  it('liberar exige login e ids válidos', async () => {
    const semLogin = await fetch(srv.url('/api/admin/produtos/conferencia'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":[1]}' });
    assert.equal(semLogin.status, 401);
    const r = await api('/api/admin/produtos/conferencia', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":["x"]}' });
    assert.equal(r.status, 400);
  });
});
