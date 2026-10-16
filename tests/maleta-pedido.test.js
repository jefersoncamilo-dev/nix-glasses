// "Enviar maleta": o pedido da vitrine põe as peças de pronta entrega em
// condicional ligadas a ele, e o acerto trabalha por maleta (pedido).
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

async function criarProduto(sku, disponibilidade = 'PRONTA_ENTREGA') {
  const form = new FormData();
  for (const [k, v] of Object.entries({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: 10, preco_venda: 100, disponibilidade })) form.append(k, String(v));
  const res = await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${tokenAdmin}` }, body: form });
  return (await res.json()).id;
}

async function pedir(ids) {
  const r = await api('POST', '/api/maleta/checkout', { token: null, body: { produtoIds: ids, contato: { nome: 'Ana', telefone: '11999990000' } } });
  return r.body.pedido.id;
}

const status = async () => Object.fromEntries((await h.pool.query('SELECT codigo_sku, status, pedido_condicional_id FROM produtos')).rows
  .map(r => [r.codigo_sku, `${r.status}:${r.pedido_condicional_id ?? '-'}`]));

describe('POST /api/admin/pedidos/:id/enviar-maleta', () => {
  it('põe só as peças de pronta entrega em condicional, ligadas ao pedido', async () => {
    const a = await criarProduto('A');
    const b = await criarProduto('B');
    const e = await criarProduto('E', 'SOB_ENCOMENDA');
    const pedido = await pedir([a, b, e]);
    const r = await api('POST', `/api/admin/pedidos/${pedido}/enviar-maleta`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.enviados.sort(), [a, b].sort());
    assert.deepEqual(r.body.indisponiveis, []);
    assert.ok(r.body.maleta_enviada_em);
    assert.deepEqual(await status(), { A: `CONDICIONAL:${pedido}`, B: `CONDICIONAL:${pedido}`, E: 'DISPONIVEL:-' });

    const lista = await api('GET', '/api/admin/pedidos');
    assert.ok(lista.body[0].maleta_enviada_em);
    const produtos = await api('GET', '/api/admin/produtos');
    assert.equal(produtos.body.find(p => p.id === a).pedido_condicional_id, pedido);
  });

  it('repetir não muda nada; peça já na maleta de outra cliente volta como indisponível', async () => {
    const a = await criarProduto('A');
    const b = await criarProduto('B');
    const p1 = await pedir([a]);
    const p2 = await pedir([a, b]);
    await api('POST', `/api/admin/pedidos/${p1}/enviar-maleta`);
    const de_novo = await api('POST', `/api/admin/pedidos/${p1}/enviar-maleta`);
    assert.equal(de_novo.status, 200);
    assert.deepEqual(de_novo.body.enviados, []);
    assert.deepEqual(de_novo.body.na_maleta, [a]);

    const r = await api('POST', `/api/admin/pedidos/${p2}/enviar-maleta`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.na_maleta, [b]);
    assert.deepEqual(r.body.indisponiveis.map(i => i.codigo_sku), ['A']);
    assert.deepEqual(await status(), { A: `CONDICIONAL:${p1}`, B: `CONDICIONAL:${p2}` });
  });

  it('409 quando nenhuma peça está disponível, sem marcar o pedido', async () => {
    const a = await criarProduto('A');
    const pedido = await pedir([a]);
    await h.pool.query(`UPDATE produtos SET status = 'ESGOTADO'`);
    const r = await api('POST', `/api/admin/pedidos/${pedido}/enviar-maleta`);
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.indisponiveis.map(i => i.codigo_sku), ['A']);
    assert.equal((await h.pool.query('SELECT maleta_enviada_em FROM pedidos')).rows[0].maleta_enviada_em, null);
  });

  it('400 para pedido só de encomendas ou id inválido, 404 para pedido inexistente, 401 sem admin', async () => {
    const e = await criarProduto('E', 'SOB_ENCOMENDA');
    const pedido = await pedir([e]);
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/enviar-maleta`)).status, 400);
    assert.equal((await api('POST', '/api/admin/pedidos/abc/enviar-maleta')).status, 400);
    assert.equal((await api('POST', '/api/admin/pedidos/0/enviar-maleta')).status, 400);
    assert.equal((await api('POST', '/api/admin/pedidos/999/enviar-maleta')).status, 404);
    assert.equal((await api('POST', `/api/admin/pedidos/${pedido}/enviar-maleta`, { token: null })).status, 401);
  });
});

describe('acerto com a maleta do pedido', () => {
  it('solta a peça do pedido e grava o pedido no histórico', async () => {
    const a = await criarProduto('A');
    const b = await criarProduto('B');
    const pedido = await pedir([a, b]);
    await api('POST', `/api/admin/pedidos/${pedido}/enviar-maleta`);
    const r = await api('POST', '/api/admin/acerto', { body: { comprados: [a], devolvidos: [b], pedido_id: pedido } });
    assert.equal(r.status, 200);
    assert.deepEqual(await status(), { A: 'ESGOTADO:-', B: 'DISPONIVEL:-' });
    const hist = await api('GET', '/api/admin/acertos');
    assert.equal(hist.body[0].pedido_id, pedido);
  });

  it('pedido_id é opcional; inválido dá 400; inexistente fica sem pedido', async () => {
    const a = await criarProduto('A');
    await h.pool.query(`UPDATE produtos SET status = 'CONDICIONAL'`);
    assert.equal((await api('POST', '/api/admin/acerto', { body: { devolvidos: [a], pedido_id: 'x' } })).status, 400);
    const r = await api('POST', '/api/admin/acerto', { body: { devolvidos: [a], pedido_id: 999 } });
    assert.equal(r.status, 200);
    assert.equal((await api('GET', '/api/admin/acertos')).body[0].pedido_id, null);
  });

  it('tirar a peça de condicional pela edição também solta do pedido', async () => {
    const a = await criarProduto('A');
    const pedido = await pedir([a]);
    await api('POST', `/api/admin/pedidos/${pedido}/enviar-maleta`);
    const form = new FormData();
    form.append('status', 'DISPONIVEL');
    await fetch(srv.url(`/api/produtos/${a}`), { method: 'PUT', headers: { Authorization: `Bearer ${tokenAdmin}` }, body: form });
    assert.deepEqual(await status(), { A: 'DISPONIVEL:-' });
  });
});

// ---------- painel ----------

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
  const ctx = vm.createContext({ Number, String, Map, Array, ...globais });
  vm.runInContext(`${funcoes.map(f => extrairFuncao(ADMIN, f)).join('\n')}\n${funcoes.map(f => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

describe('painel: maleta no acerto', () => {
  const produtos = [
    { id: 1, status: 'CONDICIONAL', pedido_condicional_id: 7 },
    { id: 2, status: 'CONDICIONAL', pedido_condicional_id: 7 },
    { id: 3, status: 'CONDICIONAL', pedido_condicional_id: 9 },
    { id: 4, status: 'CONDICIONAL', pedido_condicional_id: null },
    { id: 5, status: 'DISPONIVEL', pedido_condicional_id: null },
  ];

  it('lista uma opção por pedido e as peças sem pedido', () => {
    const ctx = carregar(['opcoesMaleta']);
    const ops = ctx.opcoesMaleta(produtos, new Map([[7, { nome: 'Ana' }]]));
    assert.deepEqual([...ops.map(o => o.valor)], ['', '7', '9', 'avulsas']);
    assert.equal(ops[0].texto, 'Todas as peças em condicional (4)');
    assert.equal(ops[1].texto, 'Pedido #7 · Ana (2 peça(s))');
    assert.equal(ops[3].texto, 'Sem pedido (1 peça(s))');
  });

  it('sem pedidos, só a opção de todas', () => {
    const ctx = carregar(['opcoesMaleta']);
    assert.deepEqual([...ctx.opcoesMaleta([{ id: 1, status: 'CONDICIONAL' }], new Map()).map(o => o.valor)], ['']);
  });

  it('filtra as peças pela maleta escolhida', () => {
    const ids = (maletaAcerto) => carregar(['condicionaisDoAcerto'], { todosProdutos: produtos, maletaAcerto }).condicionaisDoAcerto().map(p => p.id);
    assert.deepEqual(ids(''), [1, 2, 3, 4]);
    assert.deepEqual(ids('7'), [1, 2]);
    assert.deepEqual(ids('avulsas'), [4]);
  });

  it('o WhatsApp vem do pedido escolhido', () => {
    const pedidosMaleta = new Map([[7, { telefone: '11999990000' }]]);
    const tel = (maletaAcerto) => carregar(['telefoneDaMaleta'], { pedidosMaleta, maletaAcerto }).telefoneDaMaleta();
    assert.equal(tel('7'), '11999990000');
    assert.equal(tel(''), '');
    assert.equal(tel('avulsas'), '');
  });

  it('pedido com maleta enviada mostra "Fazer acerto" no lugar de "Enviar maleta"', () => {
    const lista = { innerHTML: '' };
    const ctx = carregar(['escapeHtml', 'renderizarPedidos'], {
      document: { getElementById: () => lista }, formatarMoeda: v => `R$ ${v}`, formatarData: v => String(v),
    });
    const itens = [{ nome: 'A', codigo_sku: 'A', preco: 1, encomenda: false }];
    ctx.renderizarPedidos([{ id: 4, itens, total: 1, maleta_enviada_em: '2026-10-16' }]);
    assert.match(lista.innerHTML, /data-acerto-pedido="4"/);
    assert.doesNotMatch(lista.innerHTML, /data-enviar-maleta/);
    ctx.renderizarPedidos([{ id: 5, itens: [{ ...itens[0], encomenda: true }], total: 1 }]);
    assert.doesNotMatch(lista.innerHTML, /data-enviar-maleta|data-acerto-pedido/);
  });
});
