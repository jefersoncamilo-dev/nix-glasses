// Estoque em unidades: lote com Quantidade (estoque inicial ou reposição de
// produto já cadastrado), peças de um mesmo produto em várias maletas, acerto,
// compra direta e métricas contando peças.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

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

async function api(method, p, { body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

const linha = (sku, extra = {}) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: '20', preco_venda: '129.90', fornecedor: 'Forn', ...extra });
const lote = (produtos) => api('POST', '/api/admin/produtos/lote', { body: { produtos } });
const produtoPorSku = async (sku) => (await api('GET', '/api/admin/produtos')).body.find(p => p.codigo_sku === sku);
const compras = async (id) => (await api('GET', `/api/admin/produtos/${id}/compras`)).body;

async function pedir(ids) {
  const r = await api('POST', '/api/maleta/checkout', { auth: false, body: { produtoIds: ids, contato: { nome: 'Ana', telefone: '11999990000' } } });
  return r.body.pedido.id;
}

describe('cadastro em lote com quantidade', () => {
  it('quantidade vira o estoque inicial e a compra do cadastro guarda pedido e data', async () => {
    const r = await lote([linha('NIX001', { quantidade: '4', pedido_fornecedor: '14563', data_compra: '09/11/2025' }), linha('NIX002')]);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.produtos.map(p => [p.codigo_sku, p.estoque, p.status]), [['NIX001', 4, 'DISPONIVEL'], ['NIX002', 1, 'DISPONIVEL']]);
    const c = await compras(r.body.produtos[0].id);
    assert.deepEqual(c.map(x => [x.origem, x.quantidade, x.pedido_fornecedor, x.data_compra]), [['CADASTRO', 4, '14563', '2025-11-09']]);
  });

  it('produto já cadastrado (pelo SKU ou pelo código do fornecedor) soma no estoque com o custo da linha', async () => {
    await lote([linha('NIX001', { codigo_fornecedor: 'XFG836', quantidade: 2 })]);
    const r = await lote([
      linha('NIX001', { nome: 'Outro nome', preco_custo: '29.90', quantidade: 3, pedido_fornecedor: '14563' }),
      linha('NIX099', { codigo_fornecedor: 'xfg836', preco_custo: '31', quantidade: 1 }),
    ]);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.produtos, []);
    assert.deepEqual(r.body.ignorados, []);
    assert.deepEqual(r.body.repostos.map(x => [x.linha, x.codigo_sku, x.quantidade, x.estoque]), [[0, 'NIX001', 3, 5], [1, 'NIX001', 1, 6]]);
    const p = await produtoPorSku('NIX001');
    assert.equal(p.nome, 'Óculos NIX001');
    assert.equal(p.estoque, 6);
    assert.equal(Number(p.preco_custo), 31);
    const c = await compras(p.id);
    assert.deepEqual(c.map(x => [x.origem, Number(x.preco_custo), x.quantidade]), [['REPOSICAO', 31, 1], ['REPOSICAO', 29.9, 3], ['CADASTRO', 20, 2]]);
  });

  it('linha repetida no mesmo lote soma no produto criado acima', async () => {
    const r = await lote([linha('NIX005', { codigo_fornecedor: '976', quantidade: 1 }), linha('NIX006', { codigo_fornecedor: '976', preco_custo: '39.90', quantidade: 2 })]);
    assert.equal(r.body.produtos.length, 1);
    assert.deepEqual(r.body.repostos.map(x => [x.codigo_sku, x.estoque]), [['NIX005', 3]]);
  });

  it('sem quantidade o duplicado continua ignorado; quantidade inválida barra o lote', async () => {
    await lote([linha('NIX001')]);
    const r = await lote([linha('NIX001')]);
    assert.equal(r.status, 200);
    assert.equal(r.body.ignorados.length, 1);
    assert.equal((await produtoPorSku('NIX001')).estoque, 1);
    for (const quantidade of ['0', '-1', '1.5', 'dois']) {
      const e = await lote([linha('NIX002', { quantidade })]);
      assert.equal(e.status, 400, quantidade);
      assert.equal(e.body.erros[0].campo, 'quantidade');
    }
    const d = await lote([linha('NIX002', { data_compra: '31/02/2025' })]);
    assert.equal(d.body.erros[0].campo, 'data_compra');
  });
});

describe('peças do mesmo produto em várias maletas', () => {
  it('cada maleta leva uma peça; sem peça na loja fica CONDICIONAL; o acerto devolve ou vende', async () => {
    const [p] = (await lote([linha('NIX010', { quantidade: 2 })])).body.produtos;
    const m1 = await pedir([p.id]);
    const m2 = await pedir([p.id]);
    const m3 = await pedir([p.id]);
    assert.deepEqual((await api('POST', `/api/admin/pedidos/${m1}/enviar-maleta`)).body.na_maleta, [p.id]);
    let atual = await produtoPorSku('NIX010');
    assert.deepEqual([atual.estoque, atual.status, atual.em_maleta], [1, 'DISPONIVEL', 1]);
    assert.equal((await api('POST', `/api/admin/pedidos/${m2}/enviar-maleta`)).status, 200);
    atual = await produtoPorSku('NIX010');
    assert.deepEqual([atual.estoque, atual.status, atual.maletas], [0, 'CONDICIONAL', [m1, m2]]);
    // Repetir não tira outra peça
    await api('POST', `/api/admin/pedidos/${m2}/enviar-maleta`);
    assert.equal((await produtoPorSku('NIX010')).em_maleta, 2);
    assert.equal((await api('POST', `/api/admin/pedidos/${m3}/enviar-maleta`)).status, 409);

    // A cliente do pedido 2 compra; a do pedido 1 devolve
    const a2 = await api('POST', '/api/admin/acerto', { body: { comprados: [p.id], devolvidos: [], pedido_id: m2 } });
    assert.equal(a2.status, 200);
    atual = await produtoPorSku('NIX010');
    assert.deepEqual([atual.estoque, atual.status, atual.maletas], [0, 'CONDICIONAL', [m1]]);
    await api('POST', '/api/admin/acerto', { body: { comprados: [], devolvidos: [p.id], pedido_id: m1 } });
    atual = await produtoPorSku('NIX010');
    assert.deepEqual([atual.estoque, atual.status, atual.em_maleta, atual.pedido_condicional_id], [1, 'DISPONIVEL', 0, null]);
    // Sem peça em maleta, outro acerto não mexe no estoque
    assert.equal((await api('POST', '/api/admin/acerto', { body: { comprados: [p.id], devolvidos: [] } })).status, 409);
  });

  it('compra direta entregue tira uma peça do estoque; a última esgota', async () => {
    const [p] = (await lote([linha('NIX020', { quantidade: 2 })])).body.produtos;
    for (const esperado of [[1, 'DISPONIVEL'], [0, 'ESGOTADO']]) {
      const r = await api('POST', '/api/maleta/checkout', { auth: false, body: { itens: [{ id: p.id, intencao: 'COMPRA' }], contato: { nome: 'Bia', telefone: '11988887777' } } });
      const fechar = await api('PUT', `/api/admin/pedidos/${r.body.pedido.id}/fechamento`, { body: { concluir: true } });
      assert.equal(fechar.status, 200);
      const atual = await produtoPorSku('NIX020');
      assert.deepEqual([atual.estoque, atual.status], esperado);
    }
    const vitrine = (await api('GET', '/api/produtos', { auth: false })).body;
    assert.ok(!vitrine.some(x => x.id === p.id));
  });
});

describe('estoque no painel', () => {
  it('edita o estoque; status igual ao atual não mexe nas peças', async () => {
    const [p] = (await lote([linha('NIX030', { quantidade: 3 })])).body.produtos;
    let r = await api('PUT', `/api/produtos/${p.id}`, { body: { nome: 'Rex', status: 'DISPONIVEL' } });
    assert.deepEqual([r.body.nome, r.body.estoque], ['Rex', 3]);
    r = await api('PUT', `/api/produtos/${p.id}`, { body: { estoque: 0 } });
    assert.deepEqual([r.body.estoque, r.body.status], [0, 'ESGOTADO']);
    r = await api('PUT', `/api/produtos/${p.id}`, { body: { estoque: 5 } });
    assert.deepEqual([r.body.estoque, r.body.status], [5, 'DISPONIVEL']);
    assert.equal((await api('PUT', `/api/produtos/${p.id}`, { body: { estoque: -1 } })).status, 400);
    assert.equal((await api('PUT', `/api/produtos/${p.id}`, { body: { status: 'VENDIDO' } })).status, 400);
  });

  it('métricas contam peças, não cadastros', async () => {
    const [a, b] = (await lote([linha('NIX040', { quantidade: 3, preco_custo: '10', preco_venda: '100' }), linha('NIX041', { preco_custo: '20', preco_venda: '50' })])).body.produtos;
    await api('POST', `/api/admin/pedidos/${await pedir([a.id])}/enviar-maleta`);
    const m = (await api('GET', '/api/admin/metrics')).body;
    assert.equal(m.totalEstoque, 4);
    assert.equal(m.valorInvestido, 50);
    assert.equal(m.lucroPotencial, 300);
    assert.equal(m.valorEmRua, 100);
    assert.ok(b);
  });
});
