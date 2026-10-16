// Pedidos no painel: intenção de cada item no carrinho (compra direta, maleta ou
// encomenda), status do pedido, fechamento na entrega (desconto e acessórios com
// estoque próprio) e o mesmo cálculo no painel e no servidor.
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

async function pedir(itens) {
  const r = await api('POST', '/api/maleta/checkout', {
    token: null,
    body: { produtoIds: itens.map(i => i.id), itens, contato: { nome: 'Ana', telefone: '11999990000' } },
  });
  assert.equal(r.status, 200);
  return r.body.pedido.id;
}

async function acessorio(nome, preco, estoque) {
  const r = await api('POST', '/api/admin/acessorios', { body: { nome, preco_venda: preco, estoque } });
  assert.equal(r.status, 201);
  return r.body.id;
}

const pedidoDoBanco = async (id) => (await h.pool.query('SELECT * FROM pedidos WHERE id = $1', [id])).rows[0];
const estoqueAcessorio = async (id) => (await h.pool.query('SELECT estoque FROM acessorios WHERE id = $1', [id])).rows[0].estoque;
const statusProdutos = async () => Object.fromEntries((await h.pool.query('SELECT codigo_sku, status FROM produtos')).rows.map(r => [r.codigo_sku, r.status]));

describe('checkout com intenção por item', () => {
  it('grava compra direta, maleta e encomenda com totais separados e status NOVO', async () => {
    const a = await criarProduto('A', 100);
    const b = await criarProduto('B', 50.5);
    const e = await criarProduto('E', 300, 'SOB_ENCOMENDA');
    const id = await pedir([{ id: a, intencao: 'COMPRA' }, { id: b, intencao: 'CONDICIONAL' }, { id: e, intencao: 'COMPRA' }]);
    const p = await pedidoDoBanco(id);
    assert.equal(p.status, 'NOVO');
    assert.deepEqual(p.itens.map(i => [i.codigo_sku, i.intencao, i.encomenda]), [['A', 'COMPRA', false], ['B', 'CONDICIONAL', false], ['E', 'ENCOMENDA', true]]);
    assert.equal(p.total_compra, '100.00');
    assert.equal(p.total_prova, '50.50');
    assert.equal(p.total_encomendas, '300.00');
    assert.equal(p.sinal, '150.00');
    assert.equal(p.total, '450.50');
  });

  it('aceita só itens (sem produtoIds) e trata intenção desconhecida como maleta', async () => {
    const a = await criarProduto('A');
    const r = await api('POST', '/api/maleta/checkout', { token: null, body: { itens: [{ id: a, intencao: 'GRATIS' }] } });
    assert.equal(r.status, 200);
    assert.equal((await pedidoDoBanco(r.body.pedido.id)).itens[0].intencao, 'CONDICIONAL');
    assert.equal((await api('POST', '/api/maleta/checkout', { token: null, body: { itens: [{ id: 'x' }] } })).status, 400);
  });

  it('enviar maleta leva só as peças para provar e passa o pedido para em andamento', async () => {
    const a = await criarProduto('A');
    const b = await criarProduto('B');
    const id = await pedir([{ id: a, intencao: 'COMPRA' }, { id: b, intencao: 'CONDICIONAL' }]);
    const r = await api('POST', `/api/admin/pedidos/${id}/enviar-maleta`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.enviados, [b]);
    assert.equal(r.body.status, 'EM_ANDAMENTO');
    assert.deepEqual(await statusProdutos(), { A: 'DISPONIVEL', B: 'CONDICIONAL' });

    const soCompra = await pedir([{ id: a, intencao: 'COMPRA' }]);
    assert.equal((await api('POST', `/api/admin/pedidos/${soCompra}/enviar-maleta`)).status, 400);
  });
});

describe('acessórios', () => {
  it('cadastra, lista e edita; valida campos; só admin', async () => {
    const id = await acessorio('Flanela', '15,90', 10);
    const r = await api('PUT', `/api/admin/acessorios/${id}`, { body: { nome: 'Flanela microfibra', preco_venda: 16, estoque: 8, ativo: false } });
    assert.equal(r.status, 200);
    const lista = await api('GET', '/api/admin/acessorios');
    assert.deepEqual(lista.body.map(a => [a.nome, a.preco_venda, a.estoque, a.ativo]), [['Flanela microfibra', '16.00', 8, false]]);
    for (const body of [{ nome: '', preco_venda: 1 }, { nome: 'x', preco_venda: 'abc' }, { nome: 'x', preco_venda: 1, estoque: -1 }, { nome: 'x', preco_venda: 1, estoque: 1.5 }]) {
      assert.equal((await api('POST', '/api/admin/acessorios', { body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await api('PUT', '/api/admin/acessorios/999', { body: { nome: 'x', preco_venda: 1 } })).status, 404);
    assert.equal((await api('GET', '/api/admin/acessorios', { token: null })).status, 401);
    assert.equal((await api('POST', '/api/admin/acessorios', { token: null, body: { nome: 'x', preco_venda: 1 } })).status, 401);
  });
});

describe('fechamento do pedido na entrega', () => {
  it('soma acessórios, aplica desconto em R$ e em %, e dá baixa só na diferença do estoque', async () => {
    const a = await criarProduto('A', 200);
    const fl = await acessorio('Flanela', 15, 10);
    const es = await acessorio('Estojo', 35.5, 3);
    const id = await pedir([{ id: a, intencao: 'COMPRA' }]);

    let r = await api('PUT', `/api/admin/pedidos/${id}/fechamento`, {
      body: { extras: [{ acessorio_id: fl, quantidade: 2 }, { acessorio_id: es, quantidade: 1 }], desconto: { tipo: 'VALOR', valor: '20,50' } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.fechamento, { subtotal_itens: 200, total_extras: 65.5, subtotal: 265.5, desconto: 20.5, total: 245 });
    assert.equal(r.body.total_final, '245.00');
    assert.equal(r.body.status, 'NOVO');
    assert.equal(await estoqueAcessorio(fl), 8);
    assert.equal(await estoqueAcessorio(es), 2);

    // Salvar de novo com menos flanelas devolve a diferença; % sobre o subtotal
    r = await api('PUT', `/api/admin/pedidos/${id}/fechamento`, {
      body: { extras: [{ acessorio_id: fl, quantidade: 1 }], desconto: { tipo: 'PERCENTUAL', valor: 10 } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.fechamento, { subtotal_itens: 200, total_extras: 15, subtotal: 215, desconto: 21.5, total: 193.5 });
    assert.equal(await estoqueAcessorio(fl), 9);
    assert.equal(await estoqueAcessorio(es), 3);
    assert.deepEqual(r.body.extras, [{ acessorio_id: fl, nome: 'Flanela', preco: 15, quantidade: 1 }]);

    // Desconto maior que o subtotal zera, não fica negativo
    r = await api('PUT', `/api/admin/pedidos/${id}/fechamento`, { body: { desconto: { tipo: 'VALOR', valor: 9999 } } });
    assert.equal(r.body.fechamento.total, 0);
    assert.equal(await estoqueAcessorio(fl), 10);
  });

  it('recusa estoque insuficiente, acessório inativo e entradas inválidas sem mexer no estoque', async () => {
    const a = await criarProduto('A');
    const fl = await acessorio('Flanela', 15, 1);
    const inativo = await acessorio('Líquido', 20, 5);
    await api('PUT', `/api/admin/acessorios/${inativo}`, { body: { nome: 'Líquido', preco_venda: 20, estoque: 5, ativo: false } });
    const id = await pedir([{ id: a, intencao: 'COMPRA' }]);
    const url = `/api/admin/pedidos/${id}/fechamento`;

    const sem = await api('PUT', url, { body: { extras: [{ acessorio_id: fl, quantidade: 2 }] } });
    assert.equal(sem.status, 409);
    assert.match(sem.body.error, /Estoque insuficiente de Flanela \(restam 1\)/);
    assert.equal((await api('PUT', url, { body: { extras: [{ acessorio_id: inativo, quantidade: 1 }] } })).status, 400);
    for (const body of [
      { desconto: { tipo: 'PERCENTUAL', valor: 120 } }, { desconto: { tipo: 'X', valor: 1 } }, { desconto: { tipo: 'VALOR', valor: -1 } },
      { extras: [{ acessorio_id: fl, quantidade: 0 }] }, { extras: 'x' }, { removidos: ['a'] }, { extras: [{ acessorio_id: 999, quantidade: 1 }] },
    ]) {
      assert.equal((await api('PUT', url, { body })).status, 400, JSON.stringify(body));
    }
    assert.equal(await estoqueAcessorio(fl), 1);
    assert.equal(await estoqueAcessorio(inativo), 5);
    assert.equal((await api('PUT', '/api/admin/pedidos/999/fechamento', { body: {} })).status, 404);
    assert.equal((await api('PUT', url, { token: null, body: {} })).status, 401);
  });

  it('concluir marca ENTREGUE e esgota a compra direta levada; item tirado do pedido fica no estoque', async () => {
    const a = await criarProduto('A', 100);
    const b = await criarProduto('B', 80);
    const id = await pedir([{ id: a, intencao: 'COMPRA' }, { id: b, intencao: 'COMPRA' }]);
    // Só compra direta pode ser tirada
    const e = await criarProduto('E', 10, 'SOB_ENCOMENDA');
    assert.equal((await api('PUT', `/api/admin/pedidos/${id}/fechamento`, { body: { removidos: [e] } })).status, 400);

    const r = await api('PUT', `/api/admin/pedidos/${id}/fechamento`, { body: { removidos: [b], concluir: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ENTREGUE');
    assert.ok(r.body.entregue_em);
    assert.equal(r.body.total_final, '100.00');
    assert.deepEqual(await statusProdutos(), { A: 'ESGOTADO', B: 'DISPONIVEL', E: 'DISPONIVEL' });

    // Depois de entregue, dá para corrigir desconto, mas os itens levados não mudam
    const depois = await api('PUT', `/api/admin/pedidos/${id}/fechamento`, { body: { removidos: [], desconto: { tipo: 'VALOR', valor: 10 } } });
    assert.equal(depois.status, 200);
    assert.equal(depois.body.total_final, '90.00');
    assert.deepEqual(depois.body.itens_removidos, [b]);
    assert.equal((await api('PATCH', `/api/admin/pedidos/${id}/status`, { body: { status: 'NOVO' } })).status, 409);
  });

  it('não conclui com peça já vendida para outra pessoa nem com a maleta ainda com a cliente', async () => {
    const a = await criarProduto('A');
    const b = await criarProduto('B');
    const id = await pedir([{ id: a, intencao: 'COMPRA' }, { id: b, intencao: 'CONDICIONAL' }]);
    await api('POST', `/api/admin/pedidos/${id}/enviar-maleta`);

    const naRua = await api('PUT', `/api/admin/pedidos/${id}/fechamento`, { body: { concluir: true } });
    assert.equal(naRua.status, 409);
    assert.match(naRua.body.error, /acerto/);

    // Acerto: ela comprou a peça da maleta, que passa a ser cobrada no fechamento
    await api('POST', '/api/admin/acerto', { body: { comprados: [b], devolvidos: [], pedido_id: id } });
    await h.pool.query(`UPDATE produtos SET status = 'ESGOTADO' WHERE id = $1`, [a]);
    const vendida = await api('PUT', `/api/admin/pedidos/${id}/fechamento`, { body: { concluir: true } });
    assert.equal(vendida.status, 409);
    assert.deepEqual(vendida.body.indisponiveis.map(i => i.codigo_sku), ['A']);
    assert.equal((await pedidoDoBanco(id)).status, 'EM_ANDAMENTO');

    const ok = await api('PUT', `/api/admin/pedidos/${id}/fechamento`, { body: { removidos: [a], concluir: true } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.fechamento.subtotal_itens, 100);
    const lista = await api('GET', '/api/admin/pedidos');
    assert.deepEqual(lista.body[0].vendidos_acerto, [b]);
  });
});

describe('status do pedido', () => {
  it('filtra por status, cancela devolvendo acessórios e reabre', async () => {
    const a = await criarProduto('A');
    const fl = await acessorio('Flanela', 15, 5);
    const p1 = await pedir([{ id: a, intencao: 'COMPRA' }]);
    const p2 = await pedir([{ id: a, intencao: 'COMPRA' }]);
    await api('PUT', `/api/admin/pedidos/${p1}/fechamento`, { body: { extras: [{ acessorio_id: fl, quantidade: 3 }] } });
    assert.equal(await estoqueAcessorio(fl), 2);

    const c = await api('PATCH', `/api/admin/pedidos/${p1}/status`, { body: { status: 'CANCELADO' } });
    assert.deepEqual(c.body, { id: p1, status: 'CANCELADO' });
    assert.equal(await estoqueAcessorio(fl), 5);
    assert.deepEqual((await pedidoDoBanco(p1)).extras, []);
    assert.equal((await api('PUT', `/api/admin/pedidos/${p1}/fechamento`, { body: {} })).status, 409);

    const novos = await api('GET', '/api/admin/pedidos?status=NOVO');
    assert.deepEqual(novos.body.map(p => p.id), [p2]);
    assert.equal((await api('GET', '/api/admin/pedidos?status=XYZ')).status, 400);

    assert.equal((await api('PATCH', `/api/admin/pedidos/${p1}/status`, { body: { status: 'NOVO' } })).body.status, 'NOVO');
    for (const status of ['ENTREGUE', 'x', undefined]) {
      assert.equal((await api('PATCH', `/api/admin/pedidos/${p2}/status`, { body: { status } })).status, 400);
    }
    assert.equal((await api('PATCH', '/api/admin/pedidos/999/status', { body: { status: 'NOVO' } })).status, 404);
    assert.equal((await api('PATCH', `/api/admin/pedidos/${p2}/status`, { token: null, body: { status: 'NOVO' } })).status, 401);
  });

  it('não cancela com a maleta na rua', async () => {
    const a = await criarProduto('A');
    const id = await pedir([{ id: a, intencao: 'CONDICIONAL' }]);
    await api('POST', `/api/admin/pedidos/${id}/enviar-maleta`);
    assert.equal((await api('PATCH', `/api/admin/pedidos/${id}/status`, { body: { status: 'CANCELADO' } })).status, 409);
  });
});

// ---------- Páginas ----------

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

function carregar(arquivo, funcoes, globais = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', ...arquivo.split('/')), 'utf8');
  const ctx = vm.createContext({ ...globais, Intl, Number, String, Math, Array, Set });
  vm.runInContext(`${funcoes.map(f => extrairFuncao(html, f)).join('\n')}\n${funcoes.map(f => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

const formatarMoeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v).replace(/\u00a0/g, ' ');

describe('painel: cálculo e filtros dos pedidos', () => {
  const painel = carregar('admin/index.html', ['intencaoItemPedido', 'itensCobradosFechamento', 'calcularFechamentoPedido', 'filtrarPedidos']);
  const servidor = carregar('server.js', ['calcularFechamento']);

  it('o painel calcula o fechamento igual ao servidor', () => {
    const casos = [
      [[{ preco: 199.99 }, { preco: '0.01' }], [{ preco: 15.9, quantidade: 3 }], { tipo: 'PERCENTUAL', valor: 12.5 }],
      [[{ preco: 100 }], [], { tipo: 'VALOR', valor: 150 }],
      [[], [{ preco: '35.50', quantidade: 1 }], null],
      [[{ preco: 33.33 }], [], { tipo: 'PERCENTUAL', valor: 33.33 }],
    ];
    for (const [itens, extras, desconto] of casos) {
      assert.deepEqual({ ...painel.calcularFechamentoPedido(itens, extras, desconto) }, { ...servidor.calcularFechamento(itens, extras, desconto) });
    }
    assert.equal(painel.calcularFechamentoPedido([{ preco: 199.99 }, { preco: '0.01' }], [{ preco: 15.9, quantidade: 3 }], { tipo: 'PERCENTUAL', valor: 12.5 }).total, 216.74);
  });

  it('cobra compra direta levada e peça da maleta vendida no acerto, nunca encomenda', () => {
    const pedido = {
      vendidos_acerto: [2],
      itens: [
        { produto_id: 1, preco: 10, intencao: 'COMPRA' }, { produto_id: 2, preco: 20, intencao: 'CONDICIONAL' },
        { produto_id: 3, preco: 30 }, { produto_id: 4, preco: 40, encomenda: true, intencao: 'ENCOMENDA' }, { produto_id: 5, preco: 50, intencao: 'COMPRA' },
      ],
    };
    assert.deepEqual(painel.itensCobradosFechamento(pedido, new Set([5])).map(i => i.produto_id), [1, 2]);
  });

  it('filtra abertos, por status e por nome, telefone ou número', () => {
    const lista = [
      { id: 1, status: 'NOVO', nome: 'Ana Souza', telefone: '(11) 98888-7777' },
      { id: 2, status: 'EM_ANDAMENTO', nome: 'Bia', email: 'bia@nix.com' },
      { id: 3, status: 'ENTREGUE', nome: 'Caio' },
      { id: 4, status: 'CANCELADO', nome: 'Ana Lima' },
    ];
    const ids = (f, b) => painel.filtrarPedidos(lista, f, b).map(p => p.id);
    assert.deepEqual(ids('ABERTOS', ''), [1, 2]);
    assert.deepEqual(ids('TODOS', 'ana'), [1, 4]);
    assert.deepEqual(ids('ENTREGUE', ''), [3]);
    assert.deepEqual(ids('TODOS', '#3'), [3]);
    assert.deepEqual(ids('TODOS', '98888'), [1]);
    assert.deepEqual(ids('TODOS', 'BIA@'), [2]);
  });

  it('acessórios e fechamento escapam o que vem do banco', () => {
    const PAYLOAD = '"><img src=x onerror=alert(1)>';
    const tbody = { innerHTML: '' };
    const ctx = carregar('admin/index.html', ['escapeHtml', 'renderizarAcessorios'], {
      formatarMoeda, document: { getElementById: () => tbody },
    });
    ctx.renderizarAcessorios([{ id: '1" onclick="x', nome: PAYLOAD, preco_venda: '1.00', estoque: 2, ativo: true }]);
    assert.doesNotMatch(tbody.innerHTML, /<img|onclick="x/);
    assert.match(tbody.innerHTML, /data-editar-acessorio="NaN"/);

    const els = {};
    const el = (id) => (els[id] ||= { innerHTML: '', textContent: '', value: '', disabled: false, classList: { add() {}, remove() {} } });
    const f = carregar('admin/index.html', ['escapeHtml', 'intencaoItemPedido', 'etiquetaIntencao', 'itensCobradosFechamento', 'calcularFechamentoPedido', 'lerDescontoFechamento', 'renderizarFechamento'], {
      formatarMoeda, document: { getElementById: el }, todosProdutos: [],
      acessoriosCache: [{ id: 1, nome: PAYLOAD, preco_venda: '5.00', estoque: 1, ativo: true }],
      fechamento: {
        pedido: { id: 9, status: 'NOVO', sinal: 0, itens: [{ produto_id: 1, nome: PAYLOAD, preco: 10, intencao: 'COMPRA' }] },
        removidos: new Set(), extras: new Map([[1, { acessorio_id: 1, nome: PAYLOAD, preco: 5, quantidade: 2 }]]),
      },
    });
    f.renderizarFechamento();
    for (const id of ['fechamentoItens', 'fechamentoExtras', 'fechamentoAcessorio']) assert.doesNotMatch(els[id].innerHTML, /<img/);
    assert.match(els.fechamentoResumo.innerHTML, /Total final<\/span><span>R\$ 20,00/);
  });
});

describe('vitrine: intenção de cada item no carrinho', () => {
  const FUNCOES = ['escapeHtml', 'calcularSinal', 'itemEhEncomenda', 'resumoMaleta', 'definirIntencao', 'atualizarMaletaUI', 'montarTextoWhatsapp'];
  function vitrine(itens) {
    const el = () => ({ innerHTML: '', textContent: '', classList: { add() {}, remove() {} } });
    const els = { maletaVazia: el(), maletaItens: el(), maletaFormulario: el(), maletaFooter: el(), maletaTotal: el(), maletaSinal: el() };
    const guardado = {};
    const ctx = carregar('index.html', FUNCOES, {
      ...els, maleta: { itens }, formatarMoeda, document: { getElementById: el },
      salvarMaleta() { guardado.salvou = (guardado.salvou || 0) + 1; },
    });
    return { ctx, els, guardado };
  }
  const dados = { nome: 'Ana', telefone: '11', rua: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'SP' };

  it('cada peça de pronta entrega escolhe entre provar na maleta e compra direta', () => {
    const v = vitrine([
      { id: 1, nome: 'Aviador', preco: 100, encomenda: false, intencao: 'CONDICIONAL' },
      { id: 2, nome: 'Cat Eye', preco: 200, encomenda: true, intencao: 'ENCOMENDA' },
      { id: 3, nome: 'Redondo', preco: 50 },
    ]);
    v.ctx.atualizarMaletaUI();
    assert.match(v.els.maletaItens.innerHTML, /definirIntencao\(1, 'COMPRA'\)/);
    assert.doesNotMatch(v.els.maletaItens.innerHTML, /definirIntencao\(2,/);
    v.ctx.definirIntencao(1, 'COMPRA');
    v.ctx.definirIntencao(2, 'COMPRA'); // encomenda não muda
    assert.deepEqual(v.ctx.maleta.itens.map(i => i.intencao), ['COMPRA', 'ENCOMENDA', undefined]);
    assert.equal(v.guardado.salvou, 1);
    assert.match(v.els.maletaItens.innerHTML, /1 para provar · 1 compra direta · 1 encomenda\(s\)/);

    const r = v.ctx.resumoMaleta(v.ctx.maleta.itens);
    assert.deepEqual([r.compras.length, r.prova.length, r.encomendas.length, r.totalCompra, r.totalProva], [1, 1, 1, 100, 50]);
    const msg = v.ctx.montarTextoWhatsapp(v.ctx.maleta, dados);
    assert.match(msg, /\*Compra direta \(pronta entrega\):\*\n1\. Aviador - R\$ 100,00\n\*Subtotal da compra direta:\* R\$ 100,00\n/);
    assert.match(msg, /\*Para provar \(pronta entrega\):\*\n1\. Redondo - R\$ 50,00/);
  });

  it('o checkout manda a intenção de cada item', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.match(html, /body: JSON\.stringify\(\{ produtoIds: idsProdutos, itens: itensPedido,/);
  });
});
