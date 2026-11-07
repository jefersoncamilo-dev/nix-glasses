// "Editar em estoque": a segunda opção da aba Cadastro em Lote. API
// (PUT /api/admin/produtos/lote, tudo ou nada) e as funções do painel
// (produto -> linha, o que mudou, validação, o que vai para o servidor).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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

const linha = (sku, extra = {}) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: 50, preco_venda: 120, ...extra });
const cadastrar = async (...linhas) => (await api('POST', '/api/admin/produtos/lote', { body: { produtos: linhas } })).body.produtos;
const editar = (produtos, opts) => api('PUT', '/api/admin/produtos/lote', { body: { produtos }, ...opts });

describe('editar em estoque (API)', () => {
  it('exige login', async () => {
    assert.equal((await editar([{ id: 1, ...linha('X') }], { auth: false })).status, 401);
  });

  it('grava várias edições de uma vez e o status sai do estoque', async () => {
    const [a, b] = await cadastrar(linha('ED-1', { fornecedor: 'Forn', formato: 'Aviador', quantidade: 2 }), linha('ED-2', { cor_armacao: 'Preto' }));
    const r = await editar([
      { ...linha('ED-1'), id: a.id, nome: 'Aviador Novo', preco_venda: 149.9, disponibilidade: 'SOB_ENCOMENDA', formato: 'Aviador', fornecedor: 'Forn', diametro_cm: 5.5, genero: 'UNISSEX', estoque: 5 },
      { ...linha('ED-2b'), id: b.id, cor_armacao: 'Azul', estoque: 0 },
    ]);
    assert.equal(r.status, 200);
    const porId = new Map(r.body.produtos.map(p => [p.id, p]));
    const pa = porId.get(a.id);
    assert.equal(pa.nome, 'Aviador Novo');
    assert.equal(Number(pa.preco_venda), 149.9);
    assert.equal(pa.disponibilidade, 'SOB_ENCOMENDA');
    assert.equal(Number(pa.diametro_cm), 5.5);
    assert.equal(pa.genero, 'UNISSEX');
    assert.equal(pa.estoque, 5);
    assert.equal(pa.status, 'DISPONIVEL');
    const pb = porId.get(b.id);
    assert.equal(pb.codigo_sku, 'ED-2b');
    assert.equal(pb.cor_armacao, 'Azul');
    assert.equal(pb.estoque, 0);
    assert.equal(pb.status, 'ESGOTADO');
  });

  it('sem estoque na linha, o estoque não muda', async () => {
    const [a] = await cadastrar(linha('ES-1', { quantidade: 3 }));
    const r = await editar([{ ...linha('ES-1'), id: a.id, nome: 'Outro nome' }]);
    assert.equal(r.status, 200);
    assert.equal(r.body.produtos[0].estoque, 3);
  });

  it('tudo ou nada: erro em uma linha não grava nenhuma e diz a linha e o campo', async () => {
    const [a, b, c] = await cadastrar(linha('T-1'), linha('T-2'), linha('T-3'));
    // preço inválido e estoque negativo
    let r = await editar([{ ...linha('T-1'), id: a.id, nome: 'Mudou' }, { ...linha('T-2'), id: b.id, preco_venda: 'abc', estoque: -1 }]);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.erros.map(e => [e.linha, e.campo]), [[1, 'preco_venda'], [1, 'estoque']]);
    // SKU que já é de outro produto (fora das linhas enviadas)
    r = await editar([{ ...linha('T-1'), id: a.id, nome: 'Mudou' }, { ...linha('t-3'), id: b.id }]);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.erros.map(e => [e.linha, e.campo, e.mensagem]), [[1, 'codigo_sku', 'SKU já é de outro produto']]);
    // SKU repetido entre as linhas e produto que não existe
    r = await editar([{ ...linha('Z'), id: a.id }, { ...linha('z'), id: b.id }, { ...linha('NOVO'), id: 999999 }]);
    assert.equal(r.status, 400);
    assert.equal(r.body.erros[0].linha, 1);
    assert.match(r.body.erros[0].mensagem, /repetido na linha 1/);
    r = await editar([{ ...linha('T-1'), id: a.id }, { ...linha('NOVO'), id: 999999 }]);
    assert.equal(r.status, 400);
    assert.match(r.body.erros[0].mensagem, /não encontrado/);
    const nomes = (await h.pool.query('SELECT nome FROM produtos ORDER BY id')).rows.map(x => x.nome);
    assert.deepEqual(nomes, ['Óculos T-1', 'Óculos T-2', 'Óculos T-3']);
    assert.ok(c);
  });

  it('dois produtos podem trocar de nome e o SKU de um continua livre para ele mesmo', async () => {
    const [a] = await cadastrar(linha('MESMO'));
    const r = await editar([{ ...linha('mesmo'), id: a.id }]);
    assert.equal(r.status, 200);
    assert.equal(r.body.produtos[0].codigo_sku, 'mesmo');
  });

  it('recusa lote vazio e acima do limite', async () => {
    assert.equal((await editar([])).status, 400);
    assert.equal((await api('PUT', '/api/admin/produtos/lote', { body: {} })).status, 400);
    assert.equal((await editar(Array.from({ length: 101 }, (_, i) => ({ ...linha(`M-${i}`), id: i + 1 })))).status, 400);
  });
});

// ---------- Funções do painel (admin/index.html) ----------

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

describe('painel: editar em estoque', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const fonte = [
    html.match(/const COLUNAS_LOTE = \[[\s\S]*?\n {4}\];/)[0],
    html.match(/const CAMPOS_MEDIDA = \[.*\];/)[0],
    html.match(/const CAMPOS_SO_CADASTRO = .*;/)[0],
    html.match(/const COLUNAS_EDICAO = [\s\S]*?;\n/)[0],
    ...['escapeHtml', 'linhaLoteEstaVazia', 'lerPreco', 'lerMedida', 'formatarMedida', 'linkSeguro', 'lerDataCompra', 'validarLote',
      'precoParaTexto', 'linhaDoProduto', 'linhaEdicaoAlterada', 'validarLinhaEdicao', 'produtoDaEdicao', 'textoBuscaEdicao', 'linhasVisiveisEdicao'].map(f => extrairFuncao(html, f)),
  ].join('\n');
  const ctx = vm.createContext({});
  vm.runInContext(`${fonte}\nthis.f = { COLUNAS_EDICAO, linhaDoProduto, linhaEdicaoAlterada, validarLinhaEdicao, produtoDaEdicao, linhasVisiveisEdicao };`, ctx);
  const f = ctx.f;
  const produto = { id: 7, nome: 'Nix Raptor', codigo_sku: 'NIX-7', preco_custo: '50.00', preco_venda: '139.90', disponibilidade: 'SOB_ENCOMENDA', status: 'DISPONIVEL', estoque: 2, formato: 'Esportivo', diametro_cm: '6.0', genero: null, fornecedor: 'Clush', cor_armacao: 'Preto' };

  it('a tela tem as duas opções: Cadastrar novos e Editar em estoque', () => {
    assert.match(html, /data-modo-lote="cadastro"[^>]*>Cadastrar novos</);
    assert.match(html, /data-modo-lote="edicao"[^>]*>Editar em estoque</);
    assert.match(html, /<div id="loteModoEdicao" class="hidden">/);
    assert.match(html, /fetchAdmin\('\/api\/admin\/produtos\/lote', \{\s*method: 'PUT'/);
  });

  it('mesmas colunas do cadastro, sem os campos de compra e com Estoque no lugar do Status', () => {
    const campos = f.COLUNAS_EDICAO.map(c => c.campo);
    for (const c of ['status', 'quantidade', 'pedido_fornecedor', 'data_compra']) assert.ok(!campos.includes(c), c);
    assert.equal(campos[campos.indexOf('disponibilidade') + 1], 'estoque');
    assert.equal(campos.slice(0, 2).join(), 'nome,codigo_sku');
  });

  it('produto do banco vira linha em texto, como se digita', () => {
    const l = f.linhaDoProduto(produto);
    assert.equal(l.id, 7);
    assert.equal(l.preco_venda, '139,90');
    assert.equal(l.diametro_cm, '6,0');
    assert.equal(l.ponte_cm, '');
    assert.equal(l.genero, '');
    assert.equal(l.estoque, '2');
    assert.equal(l.disponibilidade, 'SOB_ENCOMENDA');
    assert.equal(f.linhaEdicaoAlterada(l, { ...l }), false);
    assert.equal(f.linhaEdicaoAlterada({ ...l, cor_armacao: 'Preto ' }, l), false);
    assert.equal(f.linhaEdicaoAlterada({ ...l, preco_venda: '149,90' }, l), true);
  });

  it('valida a linha (preço, estoque) e manda números para o servidor', () => {
    const l = f.linhaDoProduto(produto);
    assert.deepEqual(Object.keys(f.validarLinhaEdicao(l)), []);
    const erros = f.validarLinhaEdicao({ ...l, preco_venda: 'abc', estoque: '-1', nome: '' });
    assert.deepEqual(Object.keys(erros).sort(), ['estoque', 'nome', 'preco_venda']);
    const p = f.produtoDaEdicao({ ...l, preco_venda: 'R$ 1.234,50', estoque: ' 4 ' });
    assert.equal(p.id, 7);
    assert.equal(p.preco_venda, 1234.5);
    assert.equal(p.preco_custo, 50);
    assert.equal(p.diametro_cm, 6);
    assert.equal(p.ponte_cm, null);
    assert.equal(p.estoque, 4);
    assert.equal(p.status, undefined);
  });

  it('busca sem acento e filtro "só os alterados"', () => {
    const a = f.linhaDoProduto(produto);
    const b = f.linhaDoProduto({ ...produto, id: 8, nome: 'Óculos Gatinho', codigo_sku: 'GAT-1', fornecedor: 'Outro' });
    const originais = new Map([[7, { ...a }], [8, { ...b }]]);
    assert.deepEqual(f.linhasVisiveisEdicao([a, b], originais, 'oculos gat', false).map(l => l.id), [8]);
    assert.deepEqual(f.linhasVisiveisEdicao([a, b], originais, 'clush', false).map(l => l.id), [7]);
    assert.deepEqual(f.linhasVisiveisEdicao([a, b], originais, '', true).map(l => l.id), []);
    b.nome = 'Mudou';
    assert.deepEqual(f.linhasVisiveisEdicao([a, b], originais, '', true).map(l => l.id), [8]);
  });
});
