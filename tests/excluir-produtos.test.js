// Acerto de estoque: excluir produtos de vez, um ou vários, sem zerar a loja.
// Só sai o que foi escolhido; peça em maleta ou pedido aberto barra tudo.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let srv;
let token;

before(async () => {
  srv = await h.iniciarServidor();
  token = await h.login(srv);
});
beforeEach(async () => {
  await h.limparBanco();
  await h.pool.query(`DELETE FROM configuracoes WHERE chave = 'loja_logo'`);
});
after(async () => {
  await h.pool.query(`DELETE FROM configuracoes WHERE chave = 'loja_logo'`);
  await srv.parar();
  await h.fecharBanco();
});

const png = (n) => Buffer.concat([h.PNG_1x1, Buffer.from([n])]);

async function api(method, p, body) {
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body instanceof FormData) opts.body = body;
  else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(srv.url(p), opts);
  return { status: res.status, body: await res.json() };
}

let nFoto = 0;
async function cadastrar(sku) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: '50', preco_venda: '199.90' })) form.append(k, v);
  form.append('foto1', new Blob([png(++nFoto)], { type: 'image/png' }), 'f.png');
  const r = await api('POST', '/api/produtos', form);
  assert.equal(r.status, 201);
  return r.body;
}

const contar = async (sql, params = []) => Number((await h.pool.query(sql, params)).rows[0].count);
const skus = async () => (await h.pool.query('SELECT codigo_sku FROM produtos ORDER BY codigo_sku')).rows.map((r) => r.codigo_sku);

describe('API: excluir produtos definitivamente (Acerto de estoque)', () => {
  it('exige login', async () => {
    for (const p of ['/api/admin/produtos/excluir', '/api/admin/produtos/excluir/conferir']) {
      const res = await fetch(srv.url(p), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [1], confirmacao: 'EXCLUIR' }),
      });
      assert.equal(res.status, 401, p);
    }
  });

  it('sem EXCLUIR ou com lista inválida não apaga nada', async () => {
    const a = await cadastrar('A1');
    for (const corpo of [{ ids: [a.id] }, { ids: [a.id], confirmacao: 'excluir' }, { ids: [], confirmacao: 'EXCLUIR' },
      { ids: ['x'], confirmacao: 'EXCLUIR' }, { confirmacao: 'EXCLUIR' }]) {
      const r = await api('POST', '/api/admin/produtos/excluir', corpo);
      assert.equal(r.status, 400, JSON.stringify(corpo));
    }
    assert.deepEqual(await skus(), ['A1']);
  });

  it('apaga só os escolhidos, com fotos e compras, e mantém os outros', async () => {
    const a = await cadastrar('A1');
    const b = await cadastrar('B2');
    await cadastrar('C3');
    const r = await api('POST', '/api/admin/produtos/excluir', { ids: [a.id, b.id], confirmacao: 'EXCLUIR' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.excluidos.map((p) => p.codigo_sku).sort(), ['A1', 'B2']);
    assert.deepEqual(await skus(), ['C3']);
    assert.equal(await contar('SELECT COUNT(*) FROM compras_fornecedor WHERE produto_id = ANY($1)', [[a.id, b.id]]), 0);
    assert.equal(await contar('SELECT COUNT(*) FROM imagens'), 1, 'fica só a foto do C3');
    assert.equal((await fetch(srv.url(a.imagem_url))).status, 404);
    // A vitrine não mostra mais
    const vitrine = await (await fetch(srv.url('/api/produtos'))).json();
    assert.deepEqual(vitrine.map((p) => p.codigo_sku), ['C3']);
  });

  it('não apaga foto que outro produto ainda usa', async () => {
    const a = await cadastrar('A1');
    const b = await cadastrar('B2');
    await h.pool.query('UPDATE produtos SET fotos = $1, imagem_url = $2 WHERE id = $3', [[a.imagem_url], a.imagem_url, b.id]);
    const r = await api('POST', '/api/admin/produtos/excluir', { ids: [a.id], confirmacao: 'EXCLUIR' });
    assert.equal(r.status, 200);
    assert.equal((await fetch(srv.url(a.imagem_url))).status, 200);
  });

  it('conferir avisa o que barra (maleta, pedido aberto) e o que só alerta (encomenda)', async () => {
    const a = await cadastrar('A1');
    const b = await cadastrar('B2');
    const c = await cadastrar('C3');
    const d = await cadastrar('D4');
    const ped = (await h.pool.query(`INSERT INTO pedidos (nome, itens, status) VALUES ('Maria', $1, 'NOVO') RETURNING id`,
      [JSON.stringify([{ produto_id: b.id }])])).rows[0].id;
    const fechado = (await h.pool.query(`INSERT INTO pedidos (nome, itens, status) VALUES ('Ana', $1, 'ENTREGUE') RETURNING id`,
      [JSON.stringify([{ produto_id: d.id }])])).rows[0].id;
    await h.pool.query('INSERT INTO maleta_pecas (produto_id, pedido_id) VALUES ($1, $2)', [a.id, fechado]);
    await h.pool.query(`INSERT INTO encomendas (produto_id, modelo) VALUES ($1, 'X')`, [c.id]);

    const r = await api('POST', '/api/admin/produtos/excluir/conferir', { ids: [a.id, b.id, c.id, d.id, 999] });
    assert.equal(r.status, 200);
    const por = Object.fromEntries(r.body.produtos.map((p) => [p.codigo_sku, p]));
    assert.match(por.A1.bloqueios[0], /maleta/);
    assert.match(por.B2.bloqueios[0], new RegExp(`#${ped}`));
    assert.deepEqual(por.C3.bloqueios, []);
    assert.match(por.C3.avisos[0], /encomenda/i);
    assert.deepEqual(por.D4.bloqueios, [], 'pedido entregue não barra');
    assert.deepEqual(r.body.nao_encontrados, [999]);
    assert.equal(await contar('SELECT COUNT(*) FROM produtos'), 4, 'conferir não apaga');
  });

  it('se algum escolhido está em maleta, não apaga nenhum', async () => {
    const a = await cadastrar('A1');
    const b = await cadastrar('B2');
    await h.pool.query('INSERT INTO maleta_pecas (produto_id) VALUES ($1)', [a.id]);
    const r = await api('POST', '/api/admin/produtos/excluir', { ids: [a.id, b.id], confirmacao: 'EXCLUIR' });
    assert.equal(r.status, 409);
    assert.equal(r.body.produtos.find((p) => p.id === a.id).bloqueios.length, 1);
    assert.deepEqual(await skus(), ['A1', 'B2']);
  });

  it('produto que já não existe faz a exclusão inteira parar', async () => {
    const a = await cadastrar('A1');
    const r = await api('POST', '/api/admin/produtos/excluir', { ids: [a.id, 999], confirmacao: 'EXCLUIR' });
    assert.equal(r.status, 409);
    assert.deepEqual(await skus(), ['A1']);
  });

  it('encomenda aberta não barra: ela fica, sem o produto', async () => {
    const a = await cadastrar('A1');
    await h.pool.query(`INSERT INTO encomendas (produto_id, modelo, codigo_sku) VALUES ($1, 'Óculos A1', 'A1')`, [a.id]);
    const r = await api('POST', '/api/admin/produtos/excluir', { ids: [a.id], confirmacao: 'EXCLUIR' });
    assert.equal(r.status, 200);
    const enc = (await h.pool.query('SELECT produto_id, codigo_sku FROM encomendas')).rows[0];
    assert.deepEqual(enc, { produto_id: null, codigo_sku: 'A1' });
  });

  it('o SKU excluído pode ser cadastrado de novo', async () => {
    const a = await cadastrar('A1');
    await api('POST', '/api/admin/produtos/excluir', { ids: [a.id], confirmacao: 'EXCLUIR' });
    await cadastrar('A1');
    assert.deepEqual(await skus(), ['A1']);
  });
});
