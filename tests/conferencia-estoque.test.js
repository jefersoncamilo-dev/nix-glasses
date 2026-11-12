// Conferência de estoque (Produtos): vendido, baixa, Sob Encomenda ou esgotado,
// com conferência antes e nada gravado se algum produto não puder.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let srv;
let token;

before(async () => {
  srv = await h.iniciarServidor();
  token = await h.login(srv);
});
beforeEach(() => h.limparBanco());
after(async () => {
  await srv.parar();
  await h.fecharBanco();
});

async function api(method, p, body) {
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(srv.url(p), opts);
  return { status: res.status, body: await res.json() };
}

// Produto com N peças na loja, vindo do pedido do fornecedor informado
async function produto(sku, estoque = 1, { pedido = '', fornecedor = 'Tassia', disponibilidade = 'PRONTA_ENTREGA', venda = 199.9 } = {}) {
  const { rows: [p] } = await h.pool.query(
    `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, estoque, disponibilidade, fornecedor, status)
     VALUES ($1, $2, 50, $3, $4, $5, $6, CASE WHEN $4 > 0 THEN 'DISPONIVEL' ELSE 'ESGOTADO' END) RETURNING *`,
    [`Óculos ${sku}`, sku, venda, estoque, disponibilidade, fornecedor]
  );
  if (pedido) {
    await h.pool.query(
      `INSERT INTO compras_fornecedor (produto_id, fornecedor, preco_custo, quantidade, origem, pedido_fornecedor)
       VALUES ($1, $2, 50, $3, 'CADASTRO', $4)`, [p.id, fornecedor, Math.max(estoque, 1), pedido]
    );
  }
  return p;
}

const linha = async (id) => (await h.pool.query('SELECT estoque, status, disponibilidade FROM produtos WHERE id = $1', [id])).rows[0];
const movimentos = async () => (await h.pool.query('SELECT * FROM movimentos_estoque ORDER BY id')).rows;
const vitrine = async () => (await (await fetch(srv.url('/api/produtos'))).json()).map((p) => p.codigo_sku).sort();

describe('API: conferência de estoque', () => {
  it('exige login', async () => {
    for (const [m, p] of [['POST', '/api/admin/estoque/conferencia/conferir'], ['POST', '/api/admin/estoque/conferencia'], ['GET', '/api/admin/estoque/movimentos']]) {
      const res = await fetch(srv.url(p), { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 401, p);
    }
  });

  it('pedido inválido não grava nada', async () => {
    const a = await produto('A1', 2);
    for (const corpo of [
      { itens: [{ id: a.id }] },
      { acao: 'VENDER', itens: [{ id: a.id }] },
      { acao: 'VENDIDO', itens: [] },
      { acao: 'VENDIDO', itens: [{ id: 'x' }] },
      { acao: 'VENDIDO', itens: [{ id: a.id, quantidade: 0 }] },
      { acao: 'VENDIDO', itens: [{ id: a.id, quantidade: 1.5 }] },
      { acao: 'VENDIDO', itens: [{ id: a.id }, { id: a.id }] },
      { acao: 'VENDIDO', itens: [{ id: a.id }], depois: 'SUMIR' },
    ]) {
      const r = await api('POST', '/api/admin/estoque/conferencia', corpo);
      assert.equal(r.status, 400, JSON.stringify(corpo));
    }
    assert.equal((await linha(a.id)).estoque, 2);
    assert.equal((await movimentos()).length, 0);
  });

  it('conferir mostra o que vai acontecer e não grava', async () => {
    const a = await produto('A1', 3);
    const b = await produto('B2', 1);
    const r = await api('POST', '/api/admin/estoque/conferencia/conferir', {
      acao: 'VENDIDO', depois: 'ENCOMENDA', itens: [{ id: a.id, quantidade: 2 }, { id: b.id, quantidade: 1 }, { id: 999 }],
    });
    assert.equal(r.status, 200);
    const por = Object.fromEntries(r.body.itens.map((i) => [i.codigo_sku, i]));
    assert.equal(por.A1.fica, 1);
    assert.equal(por.A1.depois, '', 'não zera: a escolha não vale');
    assert.equal(por.B2.fica, 0);
    assert.equal(por.B2.depois, 'ENCOMENDA');
    assert.match(por.B2.resultado, /Sob Encomenda/);
    assert.deepEqual(r.body.nao_encontrados, [999]);
    assert.equal(r.body.totais.pecas, 3);
    assert.equal(r.body.totais.valor_venda, 599.7);
    assert.equal((await linha(a.id)).estoque, 3, 'conferir não grava');
    assert.equal((await movimentos()).length, 0);
  });

  it('vendido tira as peças da loja, registra a venda e, ao zerar, fica esgotado', async () => {
    const a = await produto('A1', 3, { pedido: '14314' });
    const b = await produto('B2', 1, { pedido: '14314' });
    const r = await api('POST', '/api/admin/estoque/conferencia', {
      acao: 'VENDIDO', depois: 'ESGOTADO', pedido_fornecedor: '14314', fornecedor: 'Tassia',
      itens: [{ id: a.id, quantidade: 2 }, { id: b.id, quantidade: 1 }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await linha(a.id), { estoque: 1, status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA' });
    assert.deepEqual(await linha(b.id), { estoque: 0, status: 'ESGOTADO', disponibilidade: 'PRONTA_ENTREGA' });
    assert.deepEqual(await vitrine(), ['A1']);
    const m = await movimentos();
    assert.deepEqual(m.map((x) => [x.codigo_sku, x.tipo, x.quantidade, x.estoque_antes, x.estoque_depois, x.depois, x.pedido_fornecedor]),
      [['A1', 'VENDIDO', 2, 3, 1, '', '14314'], ['B2', 'VENDIDO', 1, 1, 0, 'ESGOTADO', '14314']]);
    assert.equal(m[0].usuario, 'admin-teste');

    const hist = await api('GET', '/api/admin/estoque/movimentos?numero=14314&fornecedor=Tassia');
    assert.equal(hist.status, 200);
    assert.equal(hist.body.movimentos.length, 2);
    assert.equal(hist.body.totais.vendidas, 3);
    assert.equal(hist.body.totais.valor_vendido, 599.7);
    const outro = await api('GET', '/api/admin/estoque/movimentos?numero=99999');
    assert.equal(outro.body.movimentos.length, 0);
  });

  it('baixa que zera pode deixar o produto disponível para encomenda', async () => {
    const a = await produto('A1', 2);
    const r = await api('POST', '/api/admin/estoque/conferencia', {
      acao: 'BAIXA', depois: 'ENCOMENDA', motivo: 'Lente riscada', itens: [{ id: a.id, quantidade: 2 }],
    });
    assert.equal(r.status, 200);
    const l = await linha(a.id);
    assert.equal(l.disponibilidade, 'SOB_ENCOMENDA');
    assert.equal(l.status, 'DISPONIVEL', 'aparece na vitrine como encomenda');
    assert.deepEqual(await vitrine(), ['A1']);
    const [m] = await movimentos();
    assert.deepEqual([m.tipo, m.quantidade, m.estoque_depois, m.depois, m.motivo], ['BAIXA', 2, 0, 'ENCOMENDA', 'Lente riscada']);
    // Métricas não contam o estoque do cadastro de Sob Encomenda como peça
    const met = await api('GET', '/api/admin/metrics');
    assert.equal(met.body.totalEstoque, 0);
  });

  it('quantidade maior que a loja, produto sem peça ou Sob Encomenda sem peça guardada barra tudo (409)', async () => {
    const a = await produto('A1', 1);
    const b = await produto('B2', 3);
    const c = await produto('C3', 0);
    const d = await produto('D4', 0, { disponibilidade: 'SOB_ENCOMENDA' });
    const e = await produto('E5', 2, { disponibilidade: 'SOB_ENCOMENDA' });
    const r = await api('POST', '/api/admin/estoque/conferencia', {
      acao: 'BAIXA', itens: [{ id: a.id, quantidade: 2 }, { id: b.id, quantidade: 1 }, { id: c.id }, { id: d.id }, { id: e.id }],
    });
    assert.equal(r.status, 409);
    const por = Object.fromEntries(r.body.itens.map((i) => [i.codigo_sku, i]));
    assert.match(por.A1.bloqueios[0], /Só tem 1 peça/);
    assert.deepEqual(por.B2.bloqueios, []);
    assert.match(por.C3.bloqueios[0], /Não tem peça/);
    assert.match(por.D4.bloqueios[0], /Sob Encomenda e não tem peça guardada/);
    assert.deepEqual(por.E5.bloqueios, [], 'Sob Encomenda com peça guardada na loja pode dar baixa');
    assert.equal((await linha(b.id)).estoque, 3, 'nada foi gravado');
    assert.equal((await movimentos()).length, 0);
  });

  it('peças em maleta não entram; a última peça da loja num pedido aberto barra', async () => {
    const a = await produto('A1', 1);
    const b = await produto('B2', 2);
    const fechado = (await h.pool.query(`INSERT INTO pedidos (nome, itens, status) VALUES ('Ana', '[]', 'ENTREGUE') RETURNING id`)).rows[0].id;
    await h.pool.query('INSERT INTO maleta_pecas (produto_id, pedido_id) VALUES ($1, $2)', [a.id, fechado]);
    const ped = (await h.pool.query(`INSERT INTO pedidos (nome, itens, status) VALUES ('Maria', $1, 'NOVO') RETURNING id`,
      [JSON.stringify([{ produto_id: b.id }])])).rows[0].id;

    const conf = await api('POST', '/api/admin/estoque/conferencia/conferir', { acao: 'VENDIDO', itens: [{ id: a.id }, { id: b.id, quantidade: 2 }] });
    const por = Object.fromEntries(conf.body.itens.map((i) => [i.codigo_sku, i]));
    assert.deepEqual(por.A1.bloqueios, []);
    assert.match(por.A1.avisos.join(' '), /maleta/);
    assert.match(por.A1.resultado, /segue em maleta/);
    assert.match(por.B2.bloqueios[0], new RegExp(`pedido aberto #${ped}`));

    // Uma peça só do B2 (fica 1 na loja) passa, com aviso
    const ok = await api('POST', '/api/admin/estoque/conferencia', { acao: 'VENDIDO', itens: [{ id: a.id }, { id: b.id, quantidade: 1 }] });
    assert.equal(ok.status, 200);
    assert.deepEqual(await linha(a.id), { estoque: 0, status: 'CONDICIONAL', disponibilidade: 'PRONTA_ENTREGA' });
    assert.equal((await h.pool.query('SELECT COUNT(*)::int AS n FROM maleta_pecas')).rows[0].n, 1, 'maleta não muda');
    assert.equal((await linha(b.id)).estoque, 1);
  });

  it('disponibilizar para encomenda: não precisa zerar, as peças da loja ficam guardadas', async () => {
    const a = await produto('A1', 0);
    const b = await produto('B2', 2);
    const conf = await api('POST', '/api/admin/estoque/conferencia/conferir', { acao: 'ENCOMENDA', itens: [{ id: a.id }, { id: b.id }] });
    const doB = conf.body.itens.find((i) => i.id === b.id);
    assert.deepEqual(doB.bloqueios, []);
    assert.match(doB.avisos.join(' '), /2 peças ficam guardadas/);
    assert.match(doB.resultado, /Sob Encomenda \(2 peças guardadas na loja\)/);

    const r = await api('POST', '/api/admin/estoque/conferencia', { acao: 'ENCOMENDA', itens: [{ id: a.id }, { id: b.id }] });
    assert.equal(r.status, 200);
    assert.deepEqual(await linha(a.id), { estoque: 0, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' });
    assert.deepEqual(await linha(b.id), { estoque: 2, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' });
    assert.deepEqual(await vitrine(), ['A1', 'B2'], 'na vitrine como encomenda, mesmo com 0 na loja');
    assert.deepEqual((await movimentos()).map((m) => [m.codigo_sku, m.tipo, m.quantidade, m.estoque_antes, m.estoque_depois]),
      [['A1', 'ENCOMENDA', 0, 0, 0], ['B2', 'ENCOMENDA', 0, 2, 2]]);

    // Vender a última peça guardada: continua Sob Encomenda (o fornecedor tem)
    const v = await api('POST', '/api/admin/estoque/conferencia', { acao: 'VENDIDO', depois: 'ESGOTADO', itens: [{ id: b.id, quantidade: 2 }] });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.deepEqual(await linha(b.id), { estoque: 0, status: 'DISPONIVEL', disponibilidade: 'SOB_ENCOMENDA' });
  });

  it('marcar como esgotado: zera a loja (vira baixa) e tira Sob Encomenda da vitrine', async () => {
    const a = await produto('A1', 2);
    const b = await produto('B2', 1, { disponibilidade: 'SOB_ENCOMENDA' });
    const c = await produto('C3', 0);
    const d = await produto('D4', 0, { disponibilidade: 'SOB_ENCOMENDA' });
    const r = await api('POST', '/api/admin/estoque/conferencia', { acao: 'ESGOTADO', itens: [{ id: a.id }, { id: b.id }, { id: c.id }, { id: d.id }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await linha(a.id), { estoque: 0, status: 'ESGOTADO', disponibilidade: 'PRONTA_ENTREGA' });
    assert.deepEqual(await linha(b.id), { estoque: 0, status: 'ESGOTADO', disponibilidade: 'PRONTA_ENTREGA' });
    assert.deepEqual(await linha(d.id), { estoque: 0, status: 'ESGOTADO', disponibilidade: 'PRONTA_ENTREGA' });
    assert.deepEqual(await vitrine(), []);
    assert.deepEqual((await movimentos()).map((m) => [m.codigo_sku, m.tipo, m.quantidade, m.motivo]),
      [['A1', 'BAIXA', 2, 'Marcado como esgotado'], ['B2', 'BAIXA', 1, 'Marcado como esgotado'], ['D4', 'ESGOTADO', 0, '']],
      'C3 já estava zerado: nada muda; a peça guardada do Sob Encomenda vira baixa');
  });

  it('histórico continua depois que o produto é excluído', async () => {
    const a = await produto('A1', 1);
    await api('POST', '/api/admin/estoque/conferencia', { acao: 'VENDIDO', itens: [{ id: a.id }] });
    const del = await api('POST', '/api/admin/produtos/excluir', { ids: [a.id], confirmacao: 'EXCLUIR' });
    assert.equal(del.status, 200);
    const hist = await api('GET', '/api/admin/estoque/movimentos');
    assert.deepEqual(hist.body.movimentos.map((m) => [m.codigo_sku, m.produto_id]), [['A1', null]]);
  });

  it('usuário sem a tela Produtos não acessa', async () => {
    await h.pool.query('TRUNCATE admin_usuarios RESTART IDENTITY');
    const criar = await api('POST', '/api/admin/usuarios', { nome: 'Vend', login: 'vend', senha: 'senha-forte-123', permissoes: ['pedidos'] });
    assert.equal(criar.status, 201, JSON.stringify(criar.body));
    const login = await fetch(srv.url('/api/admin/login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'vend', password: 'senha-forte-123' }),
    });
    const t = (await login.json()).token;
    const a = await produto('A1', 1);
    const res = await fetch(srv.url('/api/admin/estoque/conferencia'), {
      method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ acao: 'VENDIDO', itens: [{ id: a.id }] }),
    });
    assert.equal(res.status, 403);
    assert.equal((await linha(a.id)).estoque, 1);
    await h.pool.query('TRUNCATE admin_usuarios RESTART IDENTITY');
  });
});
