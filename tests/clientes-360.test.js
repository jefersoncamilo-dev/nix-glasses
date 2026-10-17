// Perfil 360 da cliente (pedidos, encomendas, maletas, acertos, histórico de provas e
// pendências) e relatório de conversão das maletas.
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

async function cadastrar(email = 'ana@nix.com') {
  return (await api('POST', '/api/clientes/cadastro', { token: null, body: { email, senha: 'senha-forte-1', nome: 'Ana Lima' } })).body;
}

async function pedir(itens, token = null, telefone = '11999990000') {
  const r = await api('POST', '/api/maleta/checkout', { token, body: { itens, contato: { nome: 'Ana Lima', telefone } } });
  return r.body.pedido.id;
}

const prova = (id) => ({ id, intencao: 'CONDICIONAL' });

describe('perfil 360 da cliente', () => {
  it('junta pedidos, encomendas, maletas, acertos, provas e pendências', async () => {
    const [a, b, c, d] = [await criarProduto('A', 100), await criarProduto('B', 150), await criarProduto('C', 200), await criarProduto('D', 50)];
    const e = await criarProduto('E', 300, 'SOB_ENCOMENDA');
    const { token, cliente } = await cadastrar();

    // Maleta 1: comprou A, devolveu B; pedido entregue com desconto
    const p1 = await pedir([prova(a), prova(b)], token);
    await api('POST', `/api/admin/pedidos/${p1}/enviar-maleta`);
    await api('POST', '/api/admin/acerto', { body: { comprados: [a], devolvidos: [b], pedido_id: p1, observacoes: 'Pix' } });
    await api('PUT', `/api/admin/pedidos/${p1}/fechamento`, { body: { desconto: { tipo: 'VALOR', valor: 10 }, concluir: true } });

    // Maleta 2 ainda com ela (C e B de novo), há 5 dias; encomenda aberta
    const p2 = await pedir([prova(c), prova(b), { id: e, intencao: 'ENCOMENDA' }], token);
    await api('POST', `/api/admin/pedidos/${p2}/enviar-maleta`);
    await h.pool.query(`UPDATE pedidos SET maleta_enviada_em = CURRENT_TIMESTAMP - interval '5 days' WHERE id = $1`, [p2]);
    // Pedido de outra pessoa não entra
    await pedir([prova(d)], null, '21900000000');

    const r = await api('GET', `/api/admin/clientes/${cliente.id}/perfil`);
    assert.equal(r.status, 200);
    const p = r.body;
    assert.equal(p.cliente.email, 'ana@nix.com');
    assert.ok(!('senha_hash' in p.cliente));
    assert.deepEqual(p.pedidos.map(x => x.id), [p2, p1]);
    assert.deepEqual(p.encomendas.map(x => [x.pedido_id, x.produto_id]), [[p2, e]]);
    assert.deepEqual(p.resumo, { pedidos: 2, entregues: 1, total_comprado: 90, enviadas: 4, vendidas: 1, devolvidas: 1, com_cliente: 2, valor_vendido: 100, taxa: 50 });
    assert.deepEqual(p.provas.map(x => [x.codigo_sku, x.resultado, x.pedido_id]),
      [['A', 'VENDIDA', p1], ['B', 'DEVOLVIDA', p1], ['C', 'COM_CLIENTE', p2], ['B', 'COM_CLIENTE', p2]]);
    assert.deepEqual(p.acertos.map(x => [x.pedido_id, x.comprados.map(y => y.codigo_sku), x.devolvidos.map(y => y.codigo_sku), x.observacoes]), [[p1, ['A'], ['B'], 'Pix']]);
    assert.deepEqual(p.pendencias.map(x => [x.tipo, x.ref]), [['MALETA', p2], ['PEDIDO', p2], ['ENCOMENDA', p.encomendas[0].id]]);
    assert.match(p.pendencias[0].texto, /com a cliente há 5 dia\(s\): 2 peça\(s\) sem acerto/);

    // O pedido novo avisa que ela já devolveu B antes
    const lista = await api('GET', `/api/admin/pedidos?cliente=${cliente.id}`);
    assert.deepEqual(lista.body.find(x => x.id === p2).ja_devolvidos, [b]);
    assert.deepEqual(lista.body.find(x => x.id === p1).ja_devolvidos, []);

    // Lista de clientes com o resumo das pendências
    const cli = (await api('GET', '/api/admin/clientes')).body[0];
    assert.deepEqual([cli.pedidos_abertos, cli.encomendas_abertas, cli.maletas_na_rua], [1, 1, 1]);
  });

  it('reconhece devolução anterior pelo telefone mesmo sem conta', async () => {
    const b = await criarProduto('B');
    const p1 = await pedir([prova(b)], null, '(11) 98888-7777');
    await api('POST', `/api/admin/pedidos/${p1}/enviar-maleta`);
    await api('POST', '/api/admin/acerto', { body: { comprados: [], devolvidos: [b], pedido_id: p1 } });
    const p2 = await pedir([prova(b)], null, '11 988887777');
    const lista = await api('GET', '/api/admin/pedidos');
    assert.deepEqual(lista.body.find(x => x.id === p2).ja_devolvidos, [b]);
  });

  it('404, 400 e só admin', async () => {
    assert.equal((await api('GET', '/api/admin/clientes/999/perfil')).status, 404);
    assert.equal((await api('GET', '/api/admin/clientes/x/perfil')).status, 400);
    const { token, cliente } = await cadastrar();
    assert.equal((await api('GET', `/api/admin/clientes/${cliente.id}/perfil`, { token })).status, 401);
    assert.equal((await api('GET', `/api/admin/clientes/${cliente.id}/perfil`, { token: null })).status, 401);
  });
});

describe('relatório de conversão das maletas', () => {
  it('conta peças enviadas, vendidas, devolvidas e com a cliente, por maleta e no total', async () => {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await criarProduto(`P${i}`, 100 + i * 10));
    const m1 = await pedir([prova(ids[0]), prova(ids[1]), prova(ids[2]), prova(ids[3])]);
    const m2 = await pedir([prova(ids[4]), prova(ids[5])]);
    await api('POST', `/api/admin/pedidos/${m1}/enviar-maleta`);
    await api('POST', `/api/admin/pedidos/${m2}/enviar-maleta`);
    await api('POST', '/api/admin/acerto', { body: { comprados: [ids[0], ids[1], ids[2]], devolvidos: [ids[3]], pedido_id: m1 } });
    // Maleta antiga, fora dos 30 dias
    await h.pool.query(`UPDATE pedidos SET maleta_enviada_em = CURRENT_TIMESTAMP - interval '60 days' WHERE id = $1`, [m2]);
    // Acerto sem pedido fica à parte
    const avulsa = await criarProduto('AV');
    await api('PUT', `/api/produtos/${avulsa}`, { body: { status: 'CONDICIONAL' } });
    await api('POST', '/api/admin/acerto', { body: { comprados: [avulsa], devolvidos: [] } });

    const tudo = await api('GET', '/api/admin/relatorios/maletas');
    assert.equal(tudo.status, 200);
    assert.deepEqual(tudo.body.total, { enviadas: 6, vendidas: 3, devolvidas: 1, com_cliente: 2, valor_vendido: 330, taxa: 75 });
    assert.deepEqual(tudo.body.maletas.map(m => [m.pedido_id, m.enviadas, m.vendidas, m.devolvidas, m.com_cliente, m.taxa]),
      [[m1, 4, 3, 1, 0, 75], [m2, 2, 0, 0, 2, null]]);
    assert.ok(!('pecas' in tudo.body.maletas[0]));
    assert.deepEqual(tudo.body.sem_pedido, { vendidas: 1, devolvidas: 0, acertos: 1 });
    assert.equal(tudo.body.produtos.length, 6);

    const mes = await api('GET', '/api/admin/relatorios/maletas?dias=30');
    assert.deepEqual(mes.body.maletas.map(m => m.pedido_id), [m1]);
    assert.equal((await api('GET', '/api/admin/relatorios/maletas?dias=7')).status, 400);
    assert.equal((await api('GET', '/api/admin/relatorios/maletas', { token: null })).status, 401);
  });
});

// ---------- Painel e funções puras ----------

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
  const fonte = fs.readFileSync(path.join(__dirname, '..', ...arquivo.split('/')), 'utf8');
  const ctx = vm.createContext({ Intl, Number, String, Math, Array, Date, ...globais });
  vm.runInContext(`${funcoes.map(f => extrairFuncao(fonte, f)).join('\n')}\n${funcoes.map(f => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}
const formatarMoeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v).replace(/ /g, ' ');
const PAYLOAD = '"><img src=x onerror=alert(1)>';

describe('pendências e conversão (servidor)', () => {
  const s = carregar('server.js', ['intencaoDoItem', 'resultadoMaleta', 'resumoConversao', 'pendenciasDoCliente'], { INTENCOES: ['COMPRA', 'CONDICIONAL', 'ENCOMENDA'] });
  it('peça que não saiu não conta; taxa ignora as que estão com a cliente', () => {
    const itens = [{ produto_id: 1, preco: 10 }, { produto_id: 2, preco: 20 }, { produto_id: 3, preco: 30 }, { produto_id: 4, preco: 40 }];
    const pecas = s.resultadoMaleta(itens, [1], [2], [3]);
    assert.deepEqual([...pecas].map(p => p.resultado), ['VENDIDA', 'DEVOLVIDA', 'COM_CLIENTE']);
    assert.deepEqual({ ...s.resumoConversao(pecas) }, { enviadas: 3, vendidas: 1, devolvidas: 1, com_cliente: 1, valor_vendido: 10, taxa: 50 });
    assert.equal(s.resumoConversao([]).taxa, null);
  });
  it('lista pendências da mais antiga para a mais nova', () => {
    const agora = Date.parse('2026-10-16T12:00:00Z');
    const lista = s.pendenciasDoCliente(
      [{ id: 1, status: 'NOVO', created_at: '2026-10-15T12:00:00Z' }, { id: 2, status: 'ENTREGUE', created_at: '2026-10-01T00:00:00Z' }],
      [{ pedido_id: 3, com_cliente: 2, enviada_em: '2026-10-06T12:00:00Z' }, { pedido_id: 4, com_cliente: 0, enviada_em: '2026-10-01T00:00:00Z' }],
      [{ id: 9, status: 'PRONTO_ENTREGA', modelo: 'Aviador', created_at: '2026-10-13T12:00:00Z' }, { id: 10, status: 'ENTREGUE', modelo: 'X', created_at: '2026-10-01T00:00:00Z' }],
      agora);
    assert.deepEqual([...lista].map(p => [p.tipo, p.ref, p.dias]), [['MALETA', 3, 10], ['ENCOMENDA', 9, 3], ['PEDIDO', 1, 1]]);
    assert.equal(lista[1].texto, 'Encomenda #9 (Aviador) pronta para entrega');
  });
});

describe('painel: perfil e relatório escapam dados', () => {
  it('perfil da cliente', () => {
    const alvo = { innerHTML: '' };
    const ctx = carregar('admin/index.html', ['escapeHtml', 'rotuloResultadoProva', 'htmlProvas', 'htmlAcertos', 'renderizarPerfil'], {
      formatarMoeda, formatarData: String, document: { getElementById: () => alvo },
      htmlPedido: () => '<div>pedido</div>', htmlEncomenda: () => '<div>encomenda</div>',
    });
    const perfil = {
      cliente: { id: 1, nome: PAYLOAD, email: PAYLOAD, created_at: PAYLOAD },
      resumo: { pedidos: 1, total_comprado: 90, enviadas: 2, vendidas: 1, devolvidas: 1, taxa: 50 },
      pendencias: [{ tipo: 'MALETA', texto: PAYLOAD }],
      pedidos: [{}], encomendas: [{}],
      provas: [{ produto_id: 1, nome: PAYLOAD, codigo_sku: PAYLOAD, imagem_url: `x" onerror="alert(1)`, resultado: 'DEVOLVIDA', pedido_id: 2, data: PAYLOAD, preco: 10 },
        { produto_id: 1, nome: PAYLOAD, codigo_sku: PAYLOAD, resultado: 'DEVOLVIDA', pedido_id: 3, data: PAYLOAD, preco: 10 }],
      acertos: [{ id: 1, pedido_id: 2, created_at: PAYLOAD, observacoes: PAYLOAD, comprados: [{ nome: PAYLOAD }], devolvidos: [] }],
    };
    for (const aba of ['pedidos', 'encomendas', 'provas', 'acertos']) {
      ctx.renderizarPerfil(perfil, aba);
      assert.doesNotMatch(alvo.innerHTML, /<img src=x|onerror="alert/, aba);
    }
    ctx.renderizarPerfil(perfil, 'provas');
    assert.match(alvo.innerHTML, /Modelos que ela devolveu \(evite reenviar\)/);
    assert.equal((alvo.innerHTML.match(/bg-white border border-red-200/g) || []).length, 1); // modelo repetido aparece uma vez
    assert.match(alvo.innerHTML, /data-aba-perfil="provas" aria-selected="true"/);
  });

  it('relatório e etiquetas de pendência', () => {
    const ctx = carregar('admin/index.html', ['escapeHtml', 'htmlRelatorioMaletas', 'badgesPendencias'], { formatarMoeda, formatarData: String });
    const html = ctx.htmlRelatorioMaletas({
      total: { enviadas: 6, vendidas: 3, devolvidas: 1, com_cliente: 2, valor_vendido: 330, taxa: 75 },
      maletas: [{ pedido_id: 1, nome: PAYLOAD, enviada_em: PAYLOAD, enviadas: 4, vendidas: 3, devolvidas: 1, com_cliente: 0, valor_vendido: 330, taxa: 75 }],
      sem_pedido: { vendidas: 1, devolvidas: 0, acertos: 1 },
      produtos: [{ nome: PAYLOAD, codigo_sku: PAYLOAD, enviadas: 1, vendidas: 1, devolvidas: 0 }],
    });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /75%/);
    assert.match(html, /Acertos sem pedido no período: 1 vendida/);
    assert.match(ctx.badgesPendencias({ maletas_na_rua: 1, pedidos_abertos: 0, encomendas_abertas: 2 }), /1 maleta\(s\) com ela.*2 encomenda\(s\)/s);
    assert.match(ctx.badgesPendencias({}), /Nenhuma/);
  });

  it('pedido avisa quando ela já devolveu o modelo', () => {
    const lista = { innerHTML: '' };
    const ctx = carregar('admin/index.html', ['escapeHtml', 'intencaoItemPedido', 'etiquetaIntencao', 'badgeStatusPedido', 'rotuloStatusEncomenda', 'htmlPedido', 'renderizarPedidos'], {
      document: { getElementById: () => lista }, formatarMoeda, formatarData: String, STATUS_PEDIDO: [],
    });
    ctx.renderizarPedidos([{ id: 5, status: 'NOVO', total: 2, ja_devolvidos: [2],
      itens: [{ produto_id: 1, nome: 'A', codigo_sku: 'A', preco: 1, intencao: 'CONDICIONAL' }, { produto_id: 2, nome: 'B', codigo_sku: 'B', preco: 1, intencao: 'CONDICIONAL' }] }]);
    assert.equal((lista.innerHTML.match(/já devolveu este modelo/g) || []).length, 1);
  });
});
