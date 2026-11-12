// Arquivar produtos: o produto sai da lista do painel, da vitrine, das Métricas,
// do Editar em estoque e da Conferência de estoque, mas fica guardado e pode ser
// desarquivado. Peça em maleta ou pedido aberto barra (tudo ou nada).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('./helpers');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

function extrairFuncao(nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

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
  if (body instanceof FormData) opts.body = body;
  else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(srv.url(p), opts);
  return { status: res.status, body: await res.json() };
}

async function cadastrar(sku, extra = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: '50', preco_venda: '199.90', estoque: '1', ...extra })) form.append(k, v);
  const r = await api('POST', '/api/produtos', form);
  assert.equal(r.status, 201);
  return r.body;
}

const vitrine = async () => (await (await fetch(srv.url('/api/produtos'))).json()).map((p) => p.codigo_sku).sort();
const arquivados = async () => (await h.pool.query('SELECT codigo_sku FROM produtos WHERE arquivado ORDER BY codigo_sku')).rows.map((r) => r.codigo_sku);

describe('API: arquivar produtos', () => {
  it('exige login', async () => {
    for (const p of ['/api/admin/produtos/arquivar', '/api/admin/produtos/arquivar/conferir']) {
      const res = await fetch(srv.url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [1] }) });
      assert.equal(res.status, 401, p);
    }
  });

  it('lista inválida não mexe em nada', async () => {
    await cadastrar('A1');
    for (const corpo of [{}, { ids: [] }, { ids: ['x'] }]) {
      const r = await api('POST', '/api/admin/produtos/arquivar', corpo);
      assert.equal(r.status, 400, JSON.stringify(corpo));
      assert.match(r.body.error, /arquivar|inválida/);
    }
    assert.deepEqual(await arquivados(), []);
  });

  it('arquivado some da vitrine e das Métricas, mas fica no painel marcado; desarquivar traz de volta', async () => {
    const a = await cadastrar('A1', { estoque: '2' });
    await cadastrar('B2', { estoque: '3' });
    await h.pool.query('UPDATE produtos SET vezes_em_maleta = 5 WHERE id = $1', [a.id]);
    let m = (await api('GET', '/api/admin/metrics')).body;
    assert.equal(m.totalEstoque, 5);
    assert.equal(m.topAdicionadosMaleta.length, 1);

    const r = await api('POST', '/api/admin/produtos/arquivar', { ids: [a.id] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.arquivados.map((p) => p.codigo_sku), ['A1']);
    assert.deepEqual(await vitrine(), ['B2']);
    m = (await api('GET', '/api/admin/metrics')).body;
    assert.equal(m.totalEstoque, 3, 'estoque do arquivado sai das Métricas');
    assert.equal(m.topAdicionadosMaleta.length, 0, 'arquivado sai do Top 10');

    const painel = (await api('GET', '/api/admin/produtos')).body;
    const pa = painel.find((p) => p.id === a.id);
    assert.equal(pa.arquivado, true);
    assert.match(pa.arquivado_em, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(painel.find((p) => p.codigo_sku === 'B2').arquivado, false);

    const d = await api('POST', '/api/admin/produtos/arquivar', { ids: [a.id], arquivado: false });
    assert.equal(d.status, 200);
    assert.deepEqual(d.body.desarquivados.map((p) => p.codigo_sku), ['A1']);
    assert.deepEqual(await vitrine(), ['A1', 'B2']);
    assert.deepEqual(await arquivados(), []);
    assert.equal((await h.pool.query('SELECT arquivado_em FROM produtos WHERE id = $1', [a.id])).rows[0].arquivado_em, null);
  });

  it('conferir avisa o que barra (maleta, pedido aberto) e o que só alerta (encomenda, estoque)', async () => {
    const a = await cadastrar('A1');
    const b = await cadastrar('B2');
    const c = await cadastrar('C3', { estoque: '0' });
    const ped = (await h.pool.query(`INSERT INTO pedidos (nome, itens, status) VALUES ('Maria', $1, 'NOVO') RETURNING id`,
      [JSON.stringify([{ produto_id: b.id }])])).rows[0].id;
    await h.pool.query('INSERT INTO maleta_pecas (produto_id) VALUES ($1)', [a.id]);
    await h.pool.query(`INSERT INTO encomendas (produto_id, modelo) VALUES ($1, 'X')`, [c.id]);

    const r = await api('POST', '/api/admin/produtos/arquivar/conferir', { ids: [a.id, b.id, c.id] });
    assert.equal(r.status, 200);
    const por = Object.fromEntries(r.body.produtos.map((p) => [p.codigo_sku, p]));
    assert.match(por.A1.bloqueios[0], /maleta/);
    assert.match(por.B2.bloqueios[0], new RegExp(`#${ped}`));
    assert.match(por.B2.avisos[0], /1 peça\(s\) em estoque/);
    assert.deepEqual(por.C3.bloqueios, []);
    assert.match(por.C3.avisos[0], /encomenda aberta.*continua normalmente/i);

    const tudo = await api('POST', '/api/admin/produtos/arquivar', { ids: [a.id, b.id, c.id] });
    assert.equal(tudo.status, 409, 'algum barrado: nada é arquivado');
    assert.deepEqual(await arquivados(), []);
    const so = await api('POST', '/api/admin/produtos/arquivar', { ids: [c.id] });
    assert.equal(so.status, 200);
    assert.deepEqual(await arquivados(), ['C3']);
  });

  it('comprar de novo (reposição) desarquiva o produto', async () => {
    const a = await cadastrar('A1', { estoque: '0' });
    await api('POST', '/api/admin/produtos/arquivar', { ids: [a.id] });
    const r = await api('POST', `/api/admin/produtos/${a.id}/compras`, { preco_custo: '40', quantidade: 2 });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    assert.deepEqual(await arquivados(), []);
    assert.deepEqual(await vitrine(), ['A1']);
  });

  it('vendas já feitas continuam (o histórico não depende de o produto estar na lista)', async () => {
    const a = await cadastrar('A1', { estoque: '0' });
    await api('POST', '/api/admin/produtos/arquivar', { ids: [a.id] });
    const p = (await h.pool.query('SELECT nome, fotos FROM produtos WHERE id = $1', [a.id])).rows[0];
    assert.equal(p.nome, 'Óculos A1', 'o cadastro fica guardado');
  });
});

describe('painel: arquivar', () => {
  const ctx = vm.createContext({});
  vm.runInContext(`${extrairFuncao('esgotadosParaArquivar')}\nthis.f = esgotadosParaArquivar;`, ctx);
  const esgotados = (lista) => ctx.f(lista).map((p) => p.codigo_sku);

  it('"Arquivar todos os esgotados" pega só esgotado fora de conferência e com o modelo inteiro esgotado', () => {
    const lista = [
      { codigo_sku: 'A', status: 'ESGOTADO' },
      { codigo_sku: 'B', status: 'DISPONIVEL' },
      { codigo_sku: 'C', status: 'ESGOTADO', em_conferencia: true },
      { codigo_sku: 'D', status: 'ESGOTADO', arquivado: true },
      { codigo_sku: 'M1-PRETO', grade: 'M1', status: 'ESGOTADO' },
      { codigo_sku: 'M1-AZUL', grade: 'M1', status: 'DISPONIVEL' },
      { codigo_sku: 'M2-PRETO', grade: 'M2', status: 'ESGOTADO' },
      { codigo_sku: 'M2-AZUL', grade: 'm2 ', status: 'ESGOTADO' },
      { codigo_sku: 'M3-PRETO', grade: 'M3', status: 'ESGOTADO' },
      { codigo_sku: 'M3-AZUL', grade: 'M3', status: 'DISPONIVEL', arquivado: true },
      { codigo_sku: 'E', status: 'CONDICIONAL' },
    ];
    assert.deepEqual(esgotados(lista), ['A', 'M2-PRETO', 'M2-AZUL', 'M3-PRETO']);
  });

  it('a tela tem o filtro Arquivados, o atalho, o modal e o botão no acerto', () => {
    assert.match(html, /<option value="ARQUIVADO">Arquivados<\/option>/);
    for (const id of ['btnArquivarEsgotados', 'modalArquivar', 'btnConfirmarArquivar', 'btnArquivarMarcados', 'btnArquivarFlutuante']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
  });

  it('a lista esconde os arquivados fora do filtro, e Editar em estoque e Conferência de estoque também', () => {
    assert.match(html, /if \(statusFiltro === 'ARQUIVADO'\) \{ if \(!p\.arquivado\) return false; \}\s*else if \(p\.arquivado\) return false;/);
    assert.match(html, /linhasEdicao = todosProdutos\.filter\(p => !p\.arquivado\)/);
    assert.match(extrairFuncao('filtrarConferencia'), /if \(p\.arquivado\) return false;/);
  });
});
