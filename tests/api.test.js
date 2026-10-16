// Fluxos principais da API: cadastro, vitrine, maleta, acerto, WhatsApp e métricas.
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

// O admin envia o cadastro como multipart (FormData), igual ao navegador
async function criarProduto(campos) {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, String(v));
  const res = await fetch(srv.url('/api/produtos'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

const base = (sku, extra = {}) => ({
  nome: `Óculos ${sku}`,
  codigo_sku: sku,
  preco_custo: 50,
  preco_venda: 120,
  formato: 'Redondo',
  estilo: 'Casual',
  cor_armacao: 'Preto',
  ...extra,
});

async function definirStatus(id, status) {
  const r = await api('PUT', `/api/produtos/${id}`, { body: { status } });
  assert.equal(r.status, 200);
}

describe('cadastro e edição de produtos', () => {
  it('cadastra com os valores enviados e status DISPONIVEL', async () => {
    const { status, body } = await criarProduto(base('SKU-1'));
    assert.equal(status, 201);
    assert.equal(body.codigo_sku, 'SKU-1');
    assert.equal(body.status, 'DISPONIVEL');
    assert.equal(Number(body.preco_venda), 120);
    assert.equal(body.vezes_em_maleta, 0);
    assert.equal(body.imagem_url, null);
  });

  it('aceita "sku" no lugar de "codigo_sku" e JSON no lugar de multipart', async () => {
    const r = await api('POST', '/api/products', { body: { nome: 'X', sku: 'EN-1', preco_custo: 1, preco_venda: 2 } });
    assert.equal(r.status, 201);
    assert.equal(r.body.codigo_sku, 'EN-1');
  });

  it('recusa SKU repetido com 400', async () => {
    await criarProduto(base('DUP'));
    const { status, body } = await criarProduto(base('DUP'));
    assert.equal(status, 400);
    assert.equal(body.error, 'SKU já cadastrado');
  });

  it('atualiza só os campos enviados', async () => {
    const { body: p } = await criarProduto(base('ED-1'));
    const r = await api('PUT', `/api/produtos/${p.id}`, { body: { preco_venda: 150 } });
    assert.equal(r.status, 200);
    assert.equal(Number(r.body.preco_venda), 150);
    assert.equal(r.body.nome, p.nome);
    assert.equal(Number(r.body.preco_custo), 50);
  });

  it('recusa SKU repetido na edição', async () => {
    await criarProduto(base('A'));
    const { body: b } = await criarProduto(base('B'));
    const r = await api('PUT', `/api/produtos/${b.id}`, { body: { codigo_sku: 'A' } });
    assert.equal(r.status, 400);
  });

  it('responde 400 sem campos e 404 para produto inexistente', async () => {
    const { body: p } = await criarProduto(base('ED-2'));
    assert.equal((await api('PUT', `/api/produtos/${p.id}`, { body: {} })).status, 400);
    assert.equal((await api('PUT', '/api/produtos/999999', { body: { nome: 'x' } })).status, 404);
  });

  it('exige login para cadastrar e editar', async () => {
    assert.equal((await api('POST', '/api/produtos', { auth: false, body: base('NOAUTH') })).status, 401);
    assert.equal((await api('PUT', '/api/produtos/1', { auth: false, body: { nome: 'x' } })).status, 401);
  });
});

describe('vitrine pública', () => {
  it('lista só DISPONIVEL e CONDICIONAL, sem preço de custo', async () => {
    const { body: a } = await criarProduto(base('V-DISP'));
    const { body: b } = await criarProduto(base('V-COND'));
    const { body: c } = await criarProduto(base('V-ESG'));
    await definirStatus(b.id, 'CONDICIONAL');
    await definirStatus(c.id, 'ESGOTADO');

    for (const rota of ['/api/produtos', '/api/products']) {
      const r = await api('GET', rota, { auth: false });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.map((p) => p.id).sort(), [a.id, b.id].sort());
      for (const p of r.body) {
        assert.equal(p.preco_custo, undefined);
        assert.equal(p.vezes_em_maleta, undefined);
      }
    }
  });

  it('a lista do admin traz todos os produtos com custo', async () => {
    const { body: a } = await criarProduto(base('ADM-1'));
    await definirStatus(a.id, 'ESGOTADO');
    const r = await api('GET', '/api/admin/produtos');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    assert.equal(Number(r.body[0].preco_custo), 50);
    assert.equal((await api('GET', '/api/admin/produtos', { auth: false })).status, 401);
  });
});

describe('maleta', () => {
  it('soma 1 em vezes_em_maleta de cada produto enviado', async () => {
    const { body: a } = await criarProduto(base('M-1'));
    const { body: b } = await criarProduto(base('M-2'));
    const r = await api('POST', '/api/maleta/checkout', { auth: false, body: { produtoIds: [a.id, b.id] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.atualizados.length, 2);

    await api('POST', '/api/case/checkout', { auth: false, body: { productIds: [a.id] } });
    const { rows } = await h.pool.query('SELECT id, vezes_em_maleta FROM produtos ORDER BY id');
    assert.deepEqual(rows, [
      { id: a.id, vezes_em_maleta: 2 },
      { id: b.id, vezes_em_maleta: 1 },
    ]);
  });

  it('recusa lista vazia ou ausente', async () => {
    for (const body of [{}, { produtoIds: [] }, { produtoIds: 'x' }]) {
      assert.equal((await api('POST', '/api/maleta/checkout', { auth: false, body })).status, 400);
    }
  });

  it('responde 400 e não altera nada com ID inválido', async () => {
    const { body: a } = await criarProduto(base('M-3'));
    const r = await api('POST', '/api/maleta/checkout', { auth: false, body: { ids: [a.id, 'abc'] } });
    assert.equal(r.status, 400);
    const { rows } = await h.pool.query('SELECT vezes_em_maleta FROM produtos WHERE id = $1', [a.id]);
    assert.equal(rows[0].vezes_em_maleta, 0);
  });
});

describe('acerto', () => {
  it('lista os produtos em condicional com os nomes em inglês também', async () => {
    const { body: a } = await criarProduto(base('C-1'));
    await criarProduto(base('C-2'));
    await definirStatus(a.id, 'CONDICIONAL');
    for (const rota of ['/api/admin/products/conditional', '/api/admin/produtos/condicional']) {
      const r = await api('GET', rota);
      assert.equal(r.status, 200);
      assert.equal(r.body.length, 1);
      assert.equal(r.body[0].sku, 'C-1');
      assert.equal(r.body[0].codigoSku, 'C-1');
      assert.equal(Number(r.body[0].precoVenda), 120);
    }
    assert.equal((await api('GET', '/api/admin/products/conditional', { auth: false })).status, 401);
  });

  it('marca comprados como ESGOTADO e devolvidos como DISPONIVEL', async () => {
    const { body: a } = await criarProduto(base('AC-1'));
    const { body: b } = await criarProduto(base('AC-2'));
    await definirStatus(a.id, 'CONDICIONAL');
    await definirStatus(b.id, 'CONDICIONAL');

    const r = await api('POST', '/api/admin/acerto', { body: { comprados: [a.id], devolvidos: [b.id] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.sucesso, true);
    assert.deepEqual(r.body.comprados, [a.id]);
    assert.deepEqual(r.body.devolvidos, [b.id]);
    assert.equal(r.body.total_vendido, 120);

    const { rows } = await h.pool.query('SELECT id, status FROM produtos ORDER BY id');
    assert.deepEqual(rows, [
      { id: a.id, status: 'ESGOTADO' },
      { id: b.id, status: 'DISPONIVEL' },
    ]);
  });

  it('total_vendido soma só o que estava em condicional, sem erro de centavos', async () => {
    const { body: a } = await criarProduto(base('TV-1', { preco_venda: 0.1 }));
    const { body: b } = await criarProduto(base('TV-2', { preco_venda: 0.2 }));
    const { body: c } = await criarProduto(base('TV-3'));
    await definirStatus(a.id, 'CONDICIONAL');
    await definirStatus(b.id, 'CONDICIONAL');

    const r = await api('POST', '/api/admin/acerto', { body: { comprados: [a.id, b.id, c.id] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.total_vendido, 0.3);
    assert.deepEqual(r.body.ignorados, [c.id]);

    const s = await api('POST', '/api/admin/acerto', { body: { devolvidos: [a.id] } });
    assert.equal(s.status, 409);
  });

  it('aceita o formato do acerto.html (itens por SKU com bought/returned)', async () => {
    const { body: a } = await criarProduto(base('IT-1'));
    const { body: b } = await criarProduto(base('IT-2'));
    await definirStatus(a.id, 'CONDICIONAL');
    await definirStatus(b.id, 'CONDICIONAL');

    const r = await api('POST', '/api/admin/acerto', {
      body: { itens: [{ sku: 'IT-1', bought: true }, { id: b.id, returned: true }, { sku: 'NAO-EXISTE', bought: true }] },
    });
    assert.equal(r.status, 200);
    const { rows } = await h.pool.query('SELECT codigo_sku, status FROM produtos ORDER BY id');
    assert.deepEqual(rows, [
      { codigo_sku: 'IT-1', status: 'ESGOTADO' },
      { codigo_sku: 'IT-2', status: 'DISPONIVEL' },
    ]);
  });

  it('recusa IDs inválidos sem alterar nada', async () => {
    const { body: a } = await criarProduto(base('TX-1'));
    await definirStatus(a.id, 'CONDICIONAL');
    const r = await api('POST', '/api/admin/acerto', { body: { comprados: [a.id], devolvidos: ['abc'] } });
    assert.equal(r.status, 400);
    const { rows } = await h.pool.query('SELECT status FROM produtos WHERE id = $1', [a.id]);
    assert.equal(rows[0].status, 'CONDICIONAL');
  });

  it('recusa o mesmo produto como comprado e devolvido', async () => {
    const { body: a } = await criarProduto(base('DUP-1'));
    await definirStatus(a.id, 'CONDICIONAL');
    const r = await api('POST', '/api/admin/acerto', { body: { comprados: [a.id], devolvidos: [a.id] } });
    assert.equal(r.status, 400);
    const { rows } = await h.pool.query('SELECT status FROM produtos WHERE id = $1', [a.id]);
    assert.equal(rows[0].status, 'CONDICIONAL');
  });

  it('não devolve para DISPONIVEL um produto já vendido', async () => {
    const { body: a } = await criarProduto(base('ESG-1'));
    const { body: b } = await criarProduto(base('ESG-2'));
    await definirStatus(a.id, 'ESGOTADO');
    await definirStatus(b.id, 'CONDICIONAL');

    const r = await api('POST', '/api/admin/acerto', { body: { devolvidos: [a.id, b.id] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ignorados, [a.id]);
    const { rows } = await h.pool.query('SELECT id, status FROM produtos ORDER BY id');
    assert.deepEqual(rows, [
      { id: a.id, status: 'ESGOTADO' },
      { id: b.id, status: 'DISPONIVEL' },
    ]);

    const s = await api('POST', '/api/admin/acerto', { body: { devolvidos: [a.id] } });
    assert.equal(s.status, 409);
  });

  it('grava o histórico com as observações', async () => {
    const { body: a } = await criarProduto(base('HI-1'));
    const { body: b } = await criarProduto(base('HI-2'));
    await definirStatus(a.id, 'CONDICIONAL');
    await definirStatus(b.id, 'CONDICIONAL');

    await api('POST', '/api/admin/acerto', { body: { comprados: [a.id], devolvidos: [b.id], observacoes: '  cliente Ana  ' } });
    const r = await api('GET', '/api/admin/acertos');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    assert.deepEqual(r.body[0].comprados, [a.id]);
    assert.deepEqual(r.body[0].devolvidos, [b.id]);
    assert.equal(r.body[0].observacoes, 'cliente Ana');
    assert.equal((await api('GET', '/api/admin/acertos', { auth: false })).status, 401);
  });

  it('recusa corpo sem comprados/devolvidos e exige login', async () => {
    assert.equal((await api('POST', '/api/admin/acerto', { body: {} })).status, 400);
    assert.equal((await api('POST', '/api/admin/acerto', { auth: false, body: { comprados: [1] } })).status, 401);
  });
});

describe('WhatsApp', () => {
  it('salva só os dígitos e devolve o número na rota pública', async () => {
    const r = await api('POST', '/api/config/whatsapp', { body: { whatsapp: '+55 (11) 98765-4321' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.whatsapp, '5511987654321');

    const pub = await api('GET', '/api/config/whatsapp', { auth: false });
    assert.equal(pub.status, 200);
    assert.deepEqual(pub.body, { whatsapp: '5511987654321', valor: '5511987654321', number: '5511987654321' });
  });

  it('aceita "valor"/"number" e recusa número vazio', async () => {
    assert.equal((await api('POST', '/api/admin/whatsapp', { body: { number: '11 9999-0000' } })).body.whatsapp, '1199990000');
    assert.equal((await api('POST', '/api/config/whatsapp', { body: { valor: 'abc' } })).status, 400);
    assert.equal((await api('POST', '/api/config/whatsapp', { body: {} })).status, 400);
  });

  it('exige login para alterar', async () => {
    const r = await api('POST', '/api/config/whatsapp', { auth: false, body: { whatsapp: '11999990000' } });
    assert.equal(r.status, 401);
    const pub = await api('GET', '/api/config/whatsapp', { auth: false });
    assert.equal(pub.body.whatsapp, '');
  });
});

describe('métricas', () => {
  it('calcula estoque, investimento, lucro, valor em rua e ranking da maleta', async () => {
    const { body: a } = await criarProduto(base('MT-1', { preco_custo: 40, preco_venda: 100 }));
    const { body: b } = await criarProduto(base('MT-2', { preco_custo: 60, preco_venda: 150 }));
    const { body: c } = await criarProduto(base('MT-3', { preco_custo: 1000, preco_venda: 2000 }));
    await definirStatus(b.id, 'CONDICIONAL');
    await definirStatus(c.id, 'ESGOTADO');
    await api('POST', '/api/maleta/checkout', { auth: false, body: { produtoIds: [a.id, b.id] } });
    await api('POST', '/api/maleta/checkout', { auth: false, body: { produtoIds: [b.id] } });

    for (const rota of ['/api/admin/metrics', '/api/admin/popularity', '/api/admin/popularidade']) {
      const r = await api('GET', rota);
      assert.equal(r.status, 200);
      assert.equal(r.body.totalEstoque, 2);
      assert.equal(r.body.valorInvestido, 100);
      assert.equal(r.body.lucroPotencial, 150);
      assert.equal(r.body.valorEmRua, 150);
      assert.deepEqual(r.body.topAdicionadosMaleta.map((p) => [p.codigo_sku, p.vezes_em_maleta]), [
        ['MT-2', 2],
        ['MT-1', 1],
      ]);
      assert.equal(r.body.totalStock, r.body.totalEstoque);
    }
    assert.equal((await api('GET', '/api/admin/metrics', { auth: false })).status, 401);
  });
});
