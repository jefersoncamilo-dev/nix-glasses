// Encomendas > Aguardando pedido ao fornecedor: fila por fornecedor com o pedido mínimo
// (Tassia: R$99, personalização grátis a partir de R$350, taxa de R$70 abaixo disso),
// marcar como pedido e o prazo das encomendas na vitrine.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { montarFila, regraDoFornecedor, lerValorRegra } = require('../fila-encomendas');

describe('montarFila (contas da fila)', () => {
  const linha = (id, fornecedor, custo, extra = {}) => ({ id, modelo: `M${id}`, codigo_sku: `S${id}`, nome_cliente: 'Ana', valor: '200', sinal_pago: '0', produto_id: id, fornecedor, preco_custo: custo, ...extra });

  it('Tassia começa com a política dela; outros fornecedores sem mínimo', () => {
    assert.deepEqual(regraDoFornecedor('Tassia Nunes Atacado'), { minimo: 99, personalizacao_gratis: 350, taxa_personalizacao: 70, padrao: true });
    assert.deepEqual(regraDoFornecedor('Clush'), { minimo: 0, personalizacao_gratis: 0, taxa_personalizacao: 0, padrao: true });
    assert.deepEqual(regraDoFornecedor('clush', { clush: { minimo: 150, personalizacao_gratis: 0, taxa_personalizacao: 0 } }).minimo, 150);
  });

  it('soma o custo por fornecedor e diz quanto falta para o mínimo e para a personalização', () => {
    const [tassia, semForn] = montarFila([
      linha(1, 'Tassia Nunes Atacado', '45.50'),
      linha(2, 'tassia nunes atacado ', '30'),
      linha(3, '', null, { produto_id: null }),
    ]);
    assert.equal(tassia.fornecedor, 'Tassia Nunes Atacado');
    assert.deepEqual([tassia.pecas, tassia.custo_total, tassia.atingiu_minimo, tassia.faltam_minimo, tassia.faltam_personalizacao, tassia.taxa_personalizacao],
      [2, 75.5, false, 23.5, 274.5, 70]);
    assert.equal(tassia.valor_clientes, 400);
    assert.equal(semForn.sem_fornecedor, true);
    assert.equal(semForn.fornecedor, 'Sem fornecedor');
    assert.equal(semForn.sem_custo, 1);
  });

  it('acima de R$350 não cobra a taxa', () => {
    const [g] = montarFila([linha(1, 'Tassia', '200'), linha(2, 'Tassia', '150')]);
    assert.deepEqual([g.atingiu_minimo, g.faltam_minimo, g.faltam_personalizacao, g.taxa_personalizacao], [true, 0, 0, 0]);
  });

  it('lê valores em R$ com vírgula e recusa negativos', () => {
    assert.equal(lerValorRegra('99,90'), 99.9);
    assert.equal(lerValorRegra(''), 0);
    assert.equal(lerValorRegra('-1'), null);
    assert.equal(lerValorRegra('abc'), null);
  });
});

describe('API da fila de encomendas', () => {
  let srv;
  let token;
  before(async () => {
    srv = await h.iniciarServidor();
    token = await h.login(srv);
  });
  beforeEach(async () => {
    await h.limparBanco();
    await h.pool.query(`DELETE FROM configuracoes WHERE chave IN ('fornecedor_regras', 'loja_prazo_encomenda')`);
  });
  after(async () => {
    await srv.parar();
    await h.fecharBanco();
  });

  async function api(method, p, body) {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const texto = await res.text();
    return { status: res.status, body: texto ? JSON.parse(texto) : null };
  }

  async function produto(sku, custo, fornecedor) {
    const form = new FormData();
    for (const [k, v] of Object.entries({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: custo, preco_venda: custo * 3, disponibilidade: 'SOB_ENCOMENDA', fornecedor, codigo_fornecedor: `F-${sku}` })) form.append(k, String(v));
    const res = await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return (await res.json()).id;
  }

  async function checkout(ids) {
    const r = await api('POST', '/api/maleta/checkout', { itens: ids.map((id) => ({ id, intencao: 'ENCOMENDA' })), contato: { nome: 'Bia', telefone: '11999990000' } });
    assert.equal(r.status, 200);
  }

  it('encomendas do site entram na fila do fornecedor; marcar como pedido tira da fila e desfazer devolve', async () => {
    const a = await produto('A', 40, 'Tassia Nunes Atacado');
    const b = await produto('B', 35, 'Tassia Nunes Atacado');
    const c = await produto('C', 50, 'Clush');
    await checkout([a, b, c]);

    let fila = (await api('GET', '/api/admin/encomendas/fila')).body.grupos;
    assert.deepEqual(fila.map((g) => [g.fornecedor, g.pecas, g.custo_total]), [['Tassia Nunes Atacado', 2, 75], ['Clush', 1, 50]]);
    assert.equal(fila[0].faltam_minimo, 24);
    assert.equal(fila[0].encomendas[0].codigo_fornecedor, 'F-A');

    const ids = fila[0].encomendas.map((e) => e.id);
    const r = await api('POST', '/api/admin/encomendas/pedido-fornecedor', { ids, referencia: '17001' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ids, ids);
    assert.equal((await api('POST', '/api/admin/encomendas/pedido-fornecedor', { ids })).status, 409);

    fila = (await api('GET', '/api/admin/encomendas/fila')).body.grupos;
    assert.deepEqual(fila.map((g) => g.fornecedor), ['Clush']);
    const lista = (await api('GET', '/api/admin/encomendas')).body;
    const pedida = lista.find((e) => e.id === ids[0]);
    assert.equal(pedida.status, 'AGUARDANDO_FABRICANTE');
    assert.equal(pedida.pedido_fornecedor_ref, '17001');
    assert.ok(pedida.pedido_fornecedor_em);

    assert.equal((await api('POST', '/api/admin/encomendas/pedido-fornecedor', { ids: [ids[0]], desfazer: true })).status, 200);
    fila = (await api('GET', '/api/admin/encomendas/fila')).body.grupos;
    assert.deepEqual(fila.map((g) => [g.fornecedor, g.pecas]), [['Clush', 1], ['Tassia Nunes Atacado', 1]]);
  });

  it('em trânsito sai da fila e não pode ser marcada como pedido', async () => {
    await checkout([await produto('A', 40, 'Tassia')]);
    const [enc] = (await api('GET', '/api/admin/encomendas')).body;
    await api('PUT', `/api/admin/encomendas/${enc.id}`, { status: 'EM_TRANSITO' });
    assert.deepEqual((await api('GET', '/api/admin/encomendas/fila')).body.grupos, []);
    assert.equal((await api('POST', '/api/admin/encomendas/pedido-fornecedor', { ids: [enc.id] })).status, 409);
    assert.equal((await api('POST', '/api/admin/encomendas/pedido-fornecedor', { ids: ['x'] })).status, 400);
  });

  it('salva o pedido mínimo de um fornecedor', async () => {
    await checkout([await produto('C', 50, 'Clush')]);
    const r = await api('PUT', '/api/admin/encomendas/regras-fornecedor', { fornecedor: 'Clush', minimo: '150', personalizacao_gratis: '', taxa_personalizacao: '0' });
    assert.equal(r.status, 200);
    assert.equal(r.body.regra.minimo, 150);
    const [g] = (await api('GET', '/api/admin/encomendas/fila')).body.grupos;
    assert.deepEqual([g.regra.minimo, g.faltam_minimo, g.faltam_personalizacao], [150, 100, 0]);
    assert.equal((await api('PUT', '/api/admin/encomendas/regras-fornecedor', { fornecedor: 'Clush', minimo: '-5' })).status, 400);
    assert.equal((await api('PUT', '/api/admin/encomendas/regras-fornecedor', { minimo: '5' })).status, 400);
  });

  it('prazo das encomendas: padrão de 3 a 5 dias úteis, editável em Dados da loja e enviado à vitrine', async () => {
    let pagina = await (await fetch(srv.url('/'))).text();
    assert.match(pagina, /"prazo_encomenda":"Fazemos o pedido ao fornecedor junto com o próximo lote\. Depois disso, o envio leva de 3 a 5 dias úteis\."/);
    const r = await api('PUT', '/api/admin/loja', { prazo_encomenda: 'Chega em até 10 dias úteis.' });
    assert.equal(r.status, 200);
    assert.equal(r.body.prazo_encomenda, 'Chega em até 10 dias úteis.');
    pagina = await (await fetch(srv.url('/'))).text();
    assert.match(pagina, /<span data-loja="prazo_encomenda">Chega em até 10 dias úteis\.<\/span>/);
    assert.match(pagina, /"prazo_encomenda":"Chega em até 10 dias úteis\."/);
  });
});
