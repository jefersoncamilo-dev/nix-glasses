// Excluir de vez nas abas Encomendas, Acessórios e Clientes (como o Acerto de estoque
// dos produtos): confere antes, EXCLUIR digitado, e o que quebraria um pedido ou uma
// maleta em aberto barra a exclusão inteira. Também: Métricas sem os Sob Encomenda.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
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

async function criarProduto(sku, { custo = 10, venda = 100, disponibilidade = 'PRONTA_ENTREGA', estoque } = {}) {
  const form = new FormData();
  const campos = { nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: custo, preco_venda: venda, disponibilidade };
  if (estoque !== undefined) campos.estoque = estoque;
  for (const [k, v] of Object.entries(campos)) form.append(k, String(v));
  const res = await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${tokenAdmin}` }, body: form });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}

const cadastrar = async (email = 'ana@nix.com') =>
  (await api('POST', '/api/clientes/cadastro', { token: null, body: { email, senha: 'senha-forte-1', nome: 'Ana Lima' } })).body;
const pedir = async (itens, token = null) =>
  (await api('POST', '/api/maleta/checkout', { token, body: { itens, contato: { nome: 'Ana Lima', telefone: '11999990000' } } })).body.pedido.id;
const acessorio = async (nome = 'Flanela', estoque = 5) =>
  (await api('POST', '/api/admin/acessorios', { body: { nome, preco_venda: 15, estoque } })).body;
const encomenda = async (dados = {}) =>
  (await api('POST', '/api/admin/encomendas', { body: { nome_cliente: 'Bia', telefone: '11988887777', modelo: 'Aviador', valor: 300, ...dados } })).body;
const contar = async (tabela) => Number((await h.pool.query(`SELECT COUNT(*) FROM ${tabela}`)).rows[0].count);
const excluir = (rota, ids, confirmacao = 'EXCLUIR') => api('POST', `/api/admin/${rota}/excluir`, { body: { ids, confirmacao } });
const conferir = (rota, ids) => api('POST', `/api/admin/${rota}/excluir/conferir`, { body: { ids } });

describe('excluir encomendas, acessórios e clientes', () => {
  it('exige login, EXCLUIR e lista válida', async () => {
    const a = await acessorio();
    for (const rota of ['encomendas', 'acessorios', 'clientes']) {
      for (const sufixo of ['/excluir', '/excluir/conferir']) {
        const r = await api('POST', `/api/admin/${rota}${sufixo}`, { token: null, body: { ids: [1], confirmacao: 'EXCLUIR' } });
        assert.equal(r.status, 401, rota + sufixo);
      }
      for (const corpo of [{ ids: [a.id] }, { ids: [a.id], confirmacao: 'excluir' }, { ids: [], confirmacao: 'EXCLUIR' },
        { ids: ['x'], confirmacao: 'EXCLUIR' }, { confirmacao: 'EXCLUIR' }]) {
        assert.equal((await api('POST', `/api/admin/${rota}/excluir`, { body: corpo })).status, 400, `${rota} ${JSON.stringify(corpo)}`);
      }
    }
    assert.equal(await contar('acessorios'), 1);
  });

  it('encomenda: avisa sinal e status aberto, apaga só a escolhida', async () => {
    const e1 = await encomenda({ sinal_pago: 150 });
    const e2 = await encomenda({ modelo: 'Redondo' });
    const c = await conferir('encomendas', [e1.id]);
    assert.equal(c.status, 200);
    assert.deepEqual(c.body.itens[0].bloqueios, []);
    assert.match(c.body.itens[0].avisos.join(' '), /em aberto.*R\$ 150,00 de sinal/);
    const r = await excluir('encomendas', [e1.id]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.excluidos.map((x) => x.id), [e1.id]);
    assert.deepEqual((await api('GET', '/api/admin/encomendas')).body.map((x) => x.id), [e2.id]);
  });

  it('encomenda de pedido aberto não sai; depois do pedido cancelado sai, e o pedido fica', async () => {
    const prod = await criarProduto('ENC', { disponibilidade: 'SOB_ENCOMENDA' });
    const p = await pedir([{ id: prod, intencao: 'ENCOMENDA' }]);
    const [enc] = (await api('GET', '/api/admin/encomendas')).body;
    const r = await excluir('encomendas', [enc.id]);
    assert.equal(r.status, 409);
    assert.match(r.body.itens[0].bloqueios[0], new RegExp(`pedido aberto #${p}`));
    assert.equal(await contar('encomendas'), 1);

    assert.equal((await api('PATCH', `/api/admin/pedidos/${p}/status`, { body: { status: 'CANCELADO' } })).status, 200);
    assert.equal((await excluir('encomendas', [enc.id])).status, 200);
    assert.equal(await contar('encomendas'), 0);
    assert.equal(await contar('pedidos'), 1);
  });

  it('acessório no fechamento de pedido aberto não sai; o de pedido entregue sai e o pedido guarda o lançamento', async () => {
    const prod = await criarProduto('A1');
    const fl = await acessorio('Flanela', 5);
    const es = await acessorio('Estojo', 2);
    const p = await pedir([{ id: prod, intencao: 'COMPRA' }]);
    const f = await api('PUT', `/api/admin/pedidos/${p}/fechamento`, { body: { extras: [{ acessorio_id: fl.id, quantidade: 2 }] } });
    assert.equal(f.status, 200);

    const r = await excluir('acessorios', [fl.id, es.id]);
    assert.equal(r.status, 409, 'tudo ou nada');
    assert.match(r.body.itens.find((x) => x.id === fl.id).bloqueios[0], new RegExp(`pedido aberto #${p}`));
    assert.equal(await contar('acessorios'), 2);

    // Entregue: pode excluir, e salvar o fechamento de novo mantém a flanela cobrada
    const fim = await api('PUT', `/api/admin/pedidos/${p}/fechamento`, { body: { extras: [{ acessorio_id: fl.id, quantidade: 2 }], concluir: true } });
    assert.equal(fim.status, 200);
    const total = Number(fim.body.total_final);
    assert.equal((await excluir('acessorios', [fl.id, es.id])).status, 200);
    assert.equal(await contar('acessorios'), 0);
    const de_novo = await api('PUT', `/api/admin/pedidos/${p}/fechamento`, { body: { extras: [{ acessorio_id: fl.id, quantidade: 2 }] } });
    assert.equal(de_novo.status, 200);
    assert.equal(Number(de_novo.body.total_final), total);
    assert.deepEqual(de_novo.body.extras.map((x) => [x.nome, x.quantidade]), [['Flanela', 2]]);
  });

  it('cliente com maleta, pedido ou encomenda aberta não sai; sem pendência sai e o histórico fica sem conta', async () => {
    const prod = await criarProduto('M1');
    const { token, cliente } = await cadastrar();
    const outra = (await cadastrar('bia@nix.com')).cliente;
    const p = await pedir([{ id: prod, intencao: 'CONDICIONAL' }], token);
    await api('POST', `/api/admin/pedidos/${p}/enviar-maleta`);

    let r = await excluir('clientes', [cliente.id, outra.id]);
    assert.equal(r.status, 409);
    const bloq = r.body.itens.find((x) => x.id === cliente.id).bloqueios.join(' ');
    assert.match(bloq, /maleta do pedido/);
    assert.match(bloq, /pedido aberto/);
    assert.equal(await contar('clientes'), 2);

    // Encomenda aberta ligada à conta também barra
    await encomenda({ cliente_id: outra.id });
    r = await conferir('clientes', [outra.id]);
    assert.match(r.body.itens[0].bloqueios.join(' '), /encomenda em aberto/);

    // Acerto + entrega: pode excluir a Ana; pedido continua sem conta
    await api('POST', '/api/admin/acerto', { body: { comprados: [prod], devolvidos: [], pedido_id: p } });
    assert.equal((await api('PUT', `/api/admin/pedidos/${p}/fechamento`, { body: { concluir: true } })).status, 200);
    r = await conferir('clientes', [cliente.id]);
    assert.deepEqual(r.body.itens[0].bloqueios, []);
    assert.match(r.body.itens[0].avisos.join(' '), /1 pedido\(s\) antigos continuam/);
    assert.equal((await excluir('clientes', [cliente.id])).status, 200);
    assert.deepEqual((await h.pool.query('SELECT cliente_id FROM pedidos')).rows, [{ cliente_id: null }]);
    assert.equal((await api('GET', '/api/clientes/me', { token })).status, 401);
    assert.deepEqual((await api('GET', '/api/admin/clientes')).body.map((x) => x.id), [outra.id]);
  });

  it('id que não existe: 409 e nada sai', async () => {
    const a = await acessorio();
    const r = await excluir('acessorios', [a.id, 999]);
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.nao_encontrados, [999]);
    assert.equal(await contar('acessorios'), 1);
  });
});

describe('métricas sem os produtos Sob Encomenda', () => {
  it('Sob Encomenda fica fora de peças, investido e lucro', async () => {
    await criarProduto('PE', { custo: 50, venda: 200, estoque: 2 });
    await criarProduto('SE', { custo: 80, venda: 300, disponibilidade: 'SOB_ENCOMENDA', estoque: 1 });
    const m = (await api('GET', '/api/admin/metrics')).body;
    assert.equal(m.totalEstoque, 2);
    assert.equal(m.valorInvestido, 100);
    assert.equal(m.lucroPotencial, 300);
    assert.equal(m.modelosSobEncomenda, 1);
  });
});
