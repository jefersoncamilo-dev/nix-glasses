// Cadastro em lote: conferência de produto que já existe ou linha repetida.
// Painel: conflitosLote (quem precisa conferir) e aplicarConferenciaLote (mesmo produto
// = reposição; outro produto = cadastro à parte). API: cadastrar_novo não junta
// pelo cód. do fornecedor, e a linha juntada soma no estoque do produto.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('./helpers');

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

function carregarPainel() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const funcoes = ['linhaLoteVazia', 'linhaLoteEstaVazia', 'conflitosLote', 'aplicarConferenciaLote'];
  const colunas = html.match(/const COLUNAS_LOTE = \[[\s\S]*?\n {4}\];/)[0];
  const ctx = vm.createContext({ Number, String, Math, Map, Set, Object, URL });
  vm.runInContext(`${colunas}\n${funcoes.map(f => extrairFuncao(html, f)).join('\n')}\n${funcoes.map(f => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

describe('painel: conferência do cadastro em lote', () => {
  const ctx = carregarPainel();
  const l = (extra) => ({ ...ctx.linhaLoteVazia(), nome: 'X', preco_custo: '10', preco_venda: '20', ...extra });
  const ecoWood = { id: 7, nome: 'Nix Rex Eco Wood - Onyx Black', codigo_sku: 'NIX-EWO-REX-BLK', fornecedor: '', codigo_fornecedor: 'XFG2205', cor_armacao: 'Preto (haste de bambu)', estoque: 2 };

  it('acha o produto cadastrado pelo cód. do fornecedor mesmo com outro fornecedor', () => {
    const linhas = [l({ nome: 'Eco Wood', codigo_sku: 'NOVO-1', fornecedor: 'Tassia Nunes Atacado', codigo_fornecedor: 'xfg2205', cor_armacao: 'Preto (haste de bambu)', quantidade: '4' })];
    const [c, ...resto] = ctx.conflitosLote(linhas, [ecoWood]);
    assert.equal(resto.length, 0);
    assert.equal(c.linha, 0);
    assert.equal(c.alvo.tipo, 'produto');
    assert.equal(c.alvo.produto.id, 7);
    assert.equal(c.sugestao, 'mesmo');
    assert.match(c.motivo, /Mesmo cód\. do fornecedor/);

    ctx.aplicarConferenciaLote(linhas, c, 'mesmo', [ecoWood]);
    assert.equal(linhas[0].codigo_sku, 'NIX-EWO-REX-BLK');
    assert.equal(linhas[0].nome, ecoWood.nome);
    assert.equal(linhas[0].quantidade, '4');
    assert.equal(linhas[0].cadastrar_novo, undefined);
    assert.match(linhas[0].conferencia.texto, /soma 4 no estoque/);
    assert.equal(ctx.conflitosLote(linhas, [ecoWood]).length, 0);
  });

  it('duas linhas iguais no pedido (Megan 2750): a segunda confere com a primeira e soma nela', () => {
    const megan = { nome: 'Nix Dilo Megan', codigo_sku: 'NIX-MEG-DIL', fornecedor: 'Tassia', codigo_fornecedor: '2750', cor_armacao: 'Rose' };
    const linhas = [l({ ...megan, quantidade: '1' }), l({ ...megan }), ctx.linhaLoteVazia()];
    const conflitos = ctx.conflitosLote(linhas, []);
    assert.equal(conflitos.length, 1);
    assert.equal(conflitos[0].linha, 1);
    assert.equal(conflitos[0].alvo.tipo, 'linha');
    assert.equal(conflitos[0].alvo.linha, 0);
    ctx.aplicarConferenciaLote(linhas, conflitos[0], 'mesmo', []);
    assert.equal(linhas[1].codigo_sku, 'NIX-MEG-DIL');
    assert.equal(linhas[1].quantidade, '1'); // sem quantidade: 1 peça
    assert.match(linhas[1].conferencia.texto, /linha 1/);
  });

  it('mesmo código com outra cor sugere cadastrar à parte; escolher "outro" troca o SKU repetido', () => {
    const p = { id: 3, nome: 'Nexa Tartaruga', codigo_sku: 'NIX-NEX', fornecedor: 'Tassia', codigo_fornecedor: 'XFG5136', cor_armacao: 'Tartaruga' };
    const linhas = [l({ codigo_sku: 'NIX-NEX', fornecedor: 'Tassia', codigo_fornecedor: 'XFG5136', cor_armacao: 'Preto' })];
    const [c] = ctx.conflitosLote(linhas, [p, { codigo_sku: 'NIX-NEX-2' }]);
    assert.equal(c.sugestao, 'novo');
    assert.match(c.motivo, /cor é diferente/);
    ctx.aplicarConferenciaLote(linhas, c, 'novo', [p, { codigo_sku: 'NIX-NEX-2' }]);
    assert.equal(linhas[0].cadastrar_novo, true);
    assert.equal(linhas[0].codigo_sku, 'NIX-NEX-3');
    assert.equal(ctx.conflitosLote(linhas, [p]).length, 0);
  });

  it('linha juntada a um produto não vira alvo: a próxima confere com o produto', () => {
    const linhas = [
      l({ codigo_sku: 'A', codigo_fornecedor: 'XFG2205' }),
      l({ codigo_sku: 'B', codigo_fornecedor: 'XFG2205' }),
    ];
    ctx.aplicarConferenciaLote(linhas, ctx.conflitosLote(linhas, [ecoWood])[0], 'mesmo', [ecoWood]);
    const [c] = ctx.conflitosLote(linhas, [ecoWood]);
    assert.equal(c.linha, 1);
    assert.equal(c.alvo.tipo, 'produto');
  });

  it('acha pelo SKU e pelo link; produto sem relação não aparece', () => {
    const produtos = [{ codigo_sku: 'SKU-1', link_fornecedor: 'https://loja.com/produto/oculos-x/' }, { codigo_sku: 'Z', codigo_fornecedor: 'Q' }];
    const c = ctx.conflitosLote([
      l({ codigo_sku: 'sku-1' }),
      l({ codigo_sku: 'NOVO', link_fornecedor: 'https://loja.com/produto/oculos-x?cor=1' }),
      l({ codigo_sku: 'OUTRO', codigo_fornecedor: 'R' }),
    ], produtos);
    assert.deepEqual(JSON.parse(JSON.stringify(c.map(x => [x.linha, x.motivo]))), [[0, 'Mesmo SKU (SKU-1)'], [1, 'Mesmo link do fornecedor']]);
  });
});

describe('API: lote depois da conferência', () => {
  let srv;
  let token;
  before(async () => {
    srv = await h.iniciarServidor();
    token = await h.login(srv);
  });
  beforeEach(h.limparBanco);
  after(async () => {
    await srv.parar();
    await h.fecharBanco();
  });
  const lote = async (produtos) => {
    const res = await fetch(srv.url('/api/admin/produtos/lote'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ produtos }),
    });
    return { status: res.status, body: await res.json() };
  };
  const linha = (sku, extra = {}) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: 50, preco_venda: 120, fornecedor: 'Tassia', codigo_fornecedor: 'XFG5136', ...extra });

  it('cadastrar_novo grava outro produto com o mesmo cód. do mesmo fornecedor', async () => {
    await lote([linha('NEX-1', { cor_armacao: 'Tartaruga' })]);
    const r = await lote([linha('NEX-2', { cor_armacao: 'Preto', quantidade: 2, cadastrar_novo: true })]);
    assert.equal(r.status, 201);
    assert.equal(r.body.produtos.length, 1);
    assert.equal(r.body.repostos.length, 0);
    assert.equal(r.body.produtos[0].estoque, 2);
    // Sem a conferência, o mesmo código vira reposição (como antes)
    const sem = await lote([linha('NEX-3', { quantidade: 1 })]);
    assert.equal(sem.body.produtos.length, 0);
    assert.equal(sem.body.repostos[0].codigo_sku, 'NEX-1');
  });

  it('linha conferida como o mesmo produto (SKU dele) soma no estoque, até de outro fornecedor', async () => {
    await lote([linha('EWO', { fornecedor: '', codigo_fornecedor: 'XFG2205', quantidade: 1 })]);
    const r = await lote([
      linha('EWO', { codigo_fornecedor: 'XFG2205', quantidade: 4, pedido_fornecedor: '14563' }),
      linha('MEG', { codigo_fornecedor: '2750', quantidade: 1 }),
      linha('MEG', { codigo_fornecedor: '2750', quantidade: 1 }),
    ]);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.produtos.map(p => [p.codigo_sku, p.estoque]), [['MEG', 1]]);
    assert.deepEqual(r.body.repostos.map(p => [p.codigo_sku, p.estoque]), [['EWO', 5], ['MEG', 2]]);
  });
});
