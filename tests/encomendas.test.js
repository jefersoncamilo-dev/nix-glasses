// Menu Encomendas: alimentado pelo checkout (itens sob encomenda), pelo botão
// "Encomendar" num pedido ou lançado à mão; status do fabricante até a entrega.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('./helpers');

let srv;
let tokenAdmin;

before(async () => {
  srv = await h.iniciarServidor();
  tokenAdmin = await h.login(srv);
});
beforeEach(h.limparBanco);
after(async () => {
  await srv.parar();
  await h.fecharBanco();
});

async function api(method, p, { body, token = tokenAdmin } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

async function criarProduto(sku, preco = 100, disponibilidade = 'PRONTA_ENTREGA') {
  const form = new FormData();
  for (const [k, v] of Object.entries({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: 10, preco_venda: preco, disponibilidade })) form.append(k, String(v));
  const res = await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${tokenAdmin}` }, body: form });
  return (await res.json()).id;
}

async function pedir(itens, token = null) {
  const r = await api('POST', '/api/maleta/checkout', {
    token,
    body: { itens, contato: { nome: 'Ana Lima', telefone: '11999990000' } },
  });
  assert.equal(r.status, 200);
  return r.body.pedido.id;
}

describe('encomendas vindas do site', () => {
  it('o checkout cria uma encomenda por item sob encomenda, ligada ao pedido e à cliente', async () => {
    const a = await criarProduto('A');
    const e = await criarProduto('E', 320, 'SOB_ENCOMENDA');
    const cad = await api('POST', '/api/clientes/cadastro', { token: null, body: { email: 'ana@nix.com', senha: 'senha-forte-1', nome: 'Ana' } });
    const pedido = await pedir([{ id: a, intencao: 'COMPRA' }, { id: e, intencao: 'ENCOMENDA' }], cad.body.token);
    const r = await api('GET', '/api/admin/encomendas');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    const enc = r.body[0];
    assert.deepEqual([enc.pedido_id, enc.cliente_id, enc.produto_id, enc.origem, enc.nome_cliente, enc.modelo, enc.codigo_sku, enc.valor, enc.status],
      [pedido, cad.body.cliente.id, e, 'SITE', 'Ana Lima', 'Óculos E', 'E', '320.00', 'AGUARDANDO_FABRICANTE']);
    const lista = await api('GET', '/api/admin/pedidos');
    assert.deepEqual(lista.body[0].encomendas, [{ id: enc.id, produto_id: e, status: 'AGUARDANDO_FABRICANTE' }]);
    assert.deepEqual((await api('GET', `/api/admin/encomendas?cliente=${cad.body.cliente.id}`)).body.map(x => x.id), [enc.id]);
  });
});

describe('botão Encomendar no pedido', () => {
  it('o item vira encomenda no pedido (sai da maleta e do fechamento) e entra no painel', async () => {
    const a = await criarProduto('A', 200);
    const b = await criarProduto('B', 100);
    const pedido = await pedir([{ id: a, intencao: 'COMPRA' }, { id: b, intencao: 'CONDICIONAL' }]);
    const r = await api('POST', `/api/admin/pedidos/${pedido}/encomendar`, { body: { produto_id: b, especificacoes: 'cor vinho' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.encomenda.origem, 'PEDIDO');
    assert.equal(r.body.encomenda.especificacoes, 'cor vinho');
    assert.equal(r.body.encomenda.valor, '100.00');

    const p = (await h.pool.query('SELECT * FROM pedidos WHERE id = $1', [pedido])).rows[0];
    assert.deepEqual(p.itens.map(i => [i.codigo_sku, i.intencao, i.encomenda, i.sinal]), [['A', 'COMPRA', false, 0], ['B', 'ENCOMENDA', true, 50]]);
    assert.deepEqual([p.total_prova, p.total_compra, p.total_encomendas, p.sinal, p.total], ['0.00', '200.00', '100.00', '50.00', '300.00']);
    // Sem peça para provar, não há maleta; o fechamento cobra só a compra direta
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/enviar-maleta`)).status, 400);
    const f = await api('PUT', `/api/admin/pedidos/${pedido}/fechamento`, { body: {} });
    assert.equal(f.body.fechamento.subtotal_itens, 200);

    // Repetir não duplica
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/encomendar`, { body: { produto_id: b } })).status, 200);
    assert.equal((await api('GET', '/api/admin/encomendas')).body.length, 1);
  });

  it('recusa peça na maleta, vendida no acerto, fora do pedido ou pedido fechado', async () => {
    const a = await criarProduto('A');
    const b = await criarProduto('B');
    const pedido = await pedir([{ id: a, intencao: 'CONDICIONAL' }, { id: b, intencao: 'CONDICIONAL' }]);
    await api('POST', `/api/admin/pedidos/${pedido}/enviar-maleta`);
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/encomendar`, { body: { produto_id: a } })).status, 409);
    await api('POST', '/api/admin/acerto', { body: { comprados: [a], devolvidos: [b], pedido_id: pedido } });
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/encomendar`, { body: { produto_id: a } })).status, 409);
    // devolvida pode ser encomendada (ex.: outra cor)
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/encomendar`, { body: { produto_id: b } })).status, 200);
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/encomendar`, { body: { produto_id: 999 } })).status, 400);
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/encomendar`, { body: { produto_id: 'x' } })).status, 400);
    await api('PUT', `/api/admin/pedidos/${pedido}/fechamento`, { body: { concluir: true } });
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/encomendar`, { body: { produto_id: b } })).status, 409);
    assert.equal((await api('POST', '/api/admin/pedidos/999/encomendar', { body: { produto_id: b } })).status, 404);
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/encomendar`, { token: null, body: { produto_id: b } })).status, 401);
  });
});

describe('encomendas lançadas e atualizadas no painel', () => {
  it('cria à mão, avança o status e marca a data de entrega', async () => {
    const c = await api('POST', '/api/admin/encomendas', {
      body: { nome_cliente: 'Bia', telefone: '11988887777', modelo: 'Aviador grau', especificacoes: 'OD -1,25', valor: '450,00', sinal_pago: '225' },
    });
    assert.equal(c.status, 201);
    assert.deepEqual([c.body.origem, c.body.status, c.body.valor, c.body.sinal_pago, c.body.pedido_id], ['MANUAL', 'AGUARDANDO_FABRICANTE', '450.00', '225.00', null]);
    const id = c.body.id;
    for (const status of ['EM_TRANSITO', 'PRONTO_ENTREGA']) {
      const r = await api('PUT', `/api/admin/encomendas/${id}`, { body: { status } });
      assert.equal(r.body.status, status);
      assert.equal(r.body.entregue_em, null);
      assert.equal(r.body.modelo, 'Aviador grau');
    }
    const ent = await api('PUT', `/api/admin/encomendas/${id}`, { body: { status: 'ENTREGUE', sinal_pago: 450 } });
    assert.ok(ent.body.entregue_em);
    assert.equal(ent.body.sinal_pago, '450.00');
    assert.deepEqual((await api('GET', '/api/admin/encomendas?status=ENTREGUE')).body.map(e => e.id), [id]);
    assert.deepEqual((await api('GET', '/api/admin/encomendas?status=EM_TRANSITO')).body, []);
  });

  it('valida campos e exige admin', async () => {
    const ok = (await api('POST', '/api/admin/encomendas', { body: { nome_cliente: 'Bia', modelo: 'X', valor: 100 } })).body.id;
    for (const body of [{ nome_cliente: 'Bia' }, { modelo: 'X' }, { nome_cliente: 'Bia', modelo: 'X', valor: 'abc' },
      { nome_cliente: 'Bia', modelo: 'X', status: 'PERDIDA' }, { nome_cliente: 'Bia', modelo: 'X', valor: 10, sinal_pago: 20 },
      { nome_cliente: 'Bia', modelo: 'X', cliente_id: 'a' }]) {
      assert.equal((await api('POST', '/api/admin/encomendas', { body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await api('PUT', `/api/admin/encomendas/${ok}`, { body: { sinal_pago: 150 } })).status, 400);
    assert.equal((await api('PUT', `/api/admin/encomendas/${ok}`, { body: {} })).status, 400);
    assert.equal((await api('PUT', `/api/admin/encomendas/${ok}`, { body: { modelo: '' } })).status, 400);
    assert.equal((await api('PUT', '/api/admin/encomendas/999', { body: { status: 'EM_TRANSITO' } })).status, 404);
    assert.equal((await api('GET', '/api/admin/encomendas?status=x')).status, 400);
    assert.equal((await api('GET', '/api/admin/encomendas', { token: null })).status, 401);
    assert.equal((await api('PUT', `/api/admin/encomendas/${ok}`, { token: null, body: { status: 'ENTREGUE' } })).status, 401);
  });
});

// ---------- Painel ----------

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}
const ADMIN = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
function carregar(funcoes, globais = {}) {
  const ctx = vm.createContext({ Intl, Number, String, Math, ...globais });
  vm.runInContext(`${funcoes.map(f => extrairFuncao(ADMIN, f)).join('\n')}\n${funcoes.map(f => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}
const formatarMoeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v).replace(/ /g, ' ');

describe('painel de encomendas', () => {
  it('o card escapa os dados e mostra o próximo passo e quanto falta pagar', () => {
    const PAYLOAD = '"><img src=x onerror=alert(1)>';
    const ctx = carregar(['escapeHtml', 'proximoStatusEncomenda', 'origemEncomenda', 'htmlEncomenda'], {
      formatarMoeda, formatarData: String, STATUS_ENCOMENDA: [['PRONTO_ENTREGA', 'Pronta para entrega', '']],
    });
    const html = ctx.htmlEncomenda({ id: '3" x="', modelo: PAYLOAD, codigo_sku: PAYLOAD, nome_cliente: PAYLOAD, telefone: PAYLOAD, especificacoes: PAYLOAD,
      observacoes: PAYLOAD, status: 'PRONTO_ENTREGA', valor: '450.00', sinal_pago: '225.00', origem: 'SITE', pedido_id: 7, created_at: PAYLOAD });
    assert.doesNotMatch(html, /<img|x="/);
    assert.match(html, /data-novo-status="ENTREGUE"/);
    assert.match(html, /data-avisar-encomenda="NaN"/);
    assert.match(html, /Falta pagar<\/p><p class="font-medium text-orange-700">R\$ 225,00/);
    assert.match(html, /Site · pedido #7/);
  });

  it('filtra em aberto, por status e busca; monta o aviso de chegada', () => {
    const ctx = carregar(['filtrarEncomendas', 'textoAvisoEncomenda'], { formatarMoeda, ENCOMENDA_ABERTA: ['AGUARDANDO_FABRICANTE', 'EM_TRANSITO', 'PRONTO_ENTREGA'] });
    const lista = [
      { id: 1, status: 'AGUARDANDO_FABRICANTE', nome_cliente: 'Ana', modelo: 'Aviador' },
      { id: 2, status: 'PRONTO_ENTREGA', nome_cliente: 'Bia', modelo: 'Gatinho', telefone: '(11) 98888-7777' },
      { id: 3, status: 'ENTREGUE', nome_cliente: 'Caio', modelo: 'Aviador' },
    ];
    const ids = (f, b) => ctx.filtrarEncomendas(lista, f, b).map(e => e.id);
    assert.deepEqual(ids('ABERTAS', ''), [1, 2]);
    assert.deepEqual(ids('TODAS', 'aviador'), [1, 3]);
    assert.deepEqual(ids('TODAS', '98888'), [2]);
    assert.deepEqual(ids('ENTREGUE', ''), [3]);
    assert.equal(ctx.textoAvisoEncomenda({ nome_cliente: 'Bia Souza', modelo: 'Gatinho', especificacoes: 'cor vinho', valor: '300', sinal_pago: '150' }),
      'Olá, Bia! Sua encomenda chegou na Nix Glasses:\n*Gatinho*\ncor vinho\n\nValor restante: R$ 150,00\n\nVamos combinar a entrega?');
  });

  it('item aberto do pedido tem botão Encomendar; item encomendado mostra o status da encomenda', () => {
    const lista = { innerHTML: '' };
    const ctx = carregar(['escapeHtml', 'intencaoItemPedido', 'etiquetaIntencao', 'badgeStatusPedido', 'rotuloStatusEncomenda', 'htmlPedido', 'renderizarPedidos'], {
      document: { getElementById: () => lista }, formatarMoeda, formatarData: String, STATUS_PEDIDO: [], Array,
    });
    ctx.renderizarPedidos([{ id: 5, status: 'NOVO', total: 2, encomendas: [{ id: 9, produto_id: 2, status: 'EM_TRANSITO' }],
      itens: [{ produto_id: 1, nome: 'A', codigo_sku: 'A', preco: 1, intencao: 'COMPRA' }, { produto_id: 2, nome: 'B', codigo_sku: 'B', preco: 1, encomenda: true, intencao: 'ENCOMENDA' }] }]);
    assert.match(lista.innerHTML, /data-encomendar-item="5" data-produto="1"/);
    assert.doesNotMatch(lista.innerHTML, /data-produto="2"/);
    assert.match(lista.innerHTML, /Encomenda #9: Em trânsito/);
  });
});
