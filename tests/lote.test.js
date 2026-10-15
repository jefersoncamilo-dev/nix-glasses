// Fornecedor / código do fornecedor e cadastro de produtos em lote:
// API (POST /api/admin/produtos/lote, tudo ou nada) e as funções da aba
// "Cadastro em Lote" do painel (colagem da planilha, preços, validação, escape).
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

async function criarProduto(campos) {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, String(v));
  const res = await fetch(srv.url('/api/produtos'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json() };
}

const linha = (sku, extra = {}) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: 50, preco_venda: 120, ...extra });
const lote = (produtos, opts) => api('POST', '/api/admin/produtos/lote', { body: { produtos }, ...opts });
const contar = async () => Number((await h.pool.query('SELECT count(*) FROM produtos')).rows[0].count);

describe('fornecedor e código do fornecedor', () => {
  it('são gravados no cadastro, editados e aparecem só na lista do admin', async () => {
    const { status, body } = await criarProduto({ ...linha('F-1'), fornecedor: '  Atacado  SP ', codigo_fornecedor: 'AT-778' });
    assert.equal(status, 201);
    assert.equal(body.fornecedor, 'Atacado SP');
    assert.equal(body.codigo_fornecedor, 'AT-778');

    const admin = await api('GET', '/api/admin/produtos');
    assert.equal(admin.body[0].fornecedor, 'Atacado SP');
    assert.equal(admin.body[0].codigo_fornecedor, 'AT-778');

    // Fornecedor é dado interno: não sai na vitrine
    const publico = await api('GET', '/api/produtos', { auth: false });
    assert.equal(publico.body[0].fornecedor, undefined);
    assert.equal(publico.body[0].codigo_fornecedor, undefined);

    const editado = await api('PUT', `/api/produtos/${body.id}`, { body: { fornecedor: 'Outro', codigo_fornecedor: '' } });
    assert.equal(editado.status, 200);
    assert.equal(editado.body.fornecedor, 'Outro');
    assert.equal(editado.body.codigo_fornecedor, '');

    // PUT sem os campos não mexe neles
    const soStatus = await api('PUT', `/api/produtos/${body.id}`, { body: { status: 'CONDICIONAL' } });
    assert.equal(soStatus.body.fornecedor, 'Outro');
  });

  it('link do fornecedor: grava, edita, apaga, recusa javascript: e não sai na vitrine', async () => {
    const { status, body } = await criarProduto({ ...linha('LNK'), link_fornecedor: 'https://loja.exemplo.com/p/1?cor=preto' });
    assert.equal(status, 201);
    assert.equal(body.link_fornecedor, 'https://loja.exemplo.com/p/1?cor=preto');

    for (const ruim of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.com/a', 'https://user:senha@x.com/', 'nada']) {
      const r = await api('PUT', `/api/produtos/${body.id}`, { body: { link_fornecedor: ruim } });
      assert.equal(r.status, 400, ruim);
    }
    assert.equal((await criarProduto({ ...linha('LNK2'), link_fornecedor: 'javascript:alert(1)' })).status, 400);

    const outro = await api('PUT', `/api/produtos/${body.id}`, { body: { link_fornecedor: 'http://outra.com/x' } });
    assert.equal(outro.body.link_fornecedor, 'http://outra.com/x');
    const admin = await api('GET', '/api/admin/produtos');
    assert.equal(admin.body[0].link_fornecedor, 'http://outra.com/x');
    const publico = await api('GET', '/api/produtos', { auth: false });
    assert.equal(publico.body[0].link_fornecedor, undefined);

    const apagado = await api('PUT', `/api/produtos/${body.id}`, { body: { link_fornecedor: '' } });
    assert.equal(apagado.body.link_fornecedor, '');
  });

  it('produto sem fornecedor fica com texto vazio', async () => {
    const { body } = await criarProduto(linha('F-2'));
    assert.equal(body.fornecedor, '');
    assert.equal(body.codigo_fornecedor, '');
  });
});

describe('cadastro em lote', () => {
  it('exige login de admin', async () => {
    assert.equal((await lote([linha('L-1')], { auth: false })).status, 401);
    assert.equal(await contar(), 0);
  });

  it('cadastra todas as linhas com todos os campos', async () => {
    const r = await lote([
      linha('L-1', { fornecedor: 'Forn A', codigo_fornecedor: 'A-1', disponibilidade: 'SOB_ENCOMENDA', status: 'CONDICIONAL', formato: 'Redondo', estilo: 'Casual', cor_armacao: 'Preto' }),
      linha('L-2', { preco_custo: '10.5', preco_venda: '99.90' }),
    ]);
    assert.equal(r.status, 201);
    assert.equal(r.body.produtos.length, 2);
    const [a, b] = r.body.produtos;
    assert.equal(a.codigo_sku, 'L-1');
    assert.equal(a.fornecedor, 'Forn A');
    assert.equal(a.codigo_fornecedor, 'A-1');
    assert.equal(a.disponibilidade, 'SOB_ENCOMENDA');
    assert.equal(a.status, 'CONDICIONAL');
    assert.equal(a.formato, 'Redondo');
    assert.equal(b.status, 'DISPONIVEL');
    assert.equal(b.disponibilidade, 'PRONTA_ENTREGA');
    assert.equal(Number(b.preco_custo), 10.5);
    assert.equal(Number(b.preco_venda), 99.9);
    assert.deepEqual(b.fotos, []);
    assert.equal(await contar(), 2);
  });

  it('com erro em qualquer linha não grava nada e diz linha e campo', async () => {
    const r = await lote([
      linha('OK-1'),
      linha('', { nome: '' }),
      linha('OK-3', { preco_venda: 'abc', disponibilidade: 'X', status: 'Y' }),
    ]);
    assert.equal(r.status, 400);
    const pares = r.body.erros.map(e => `${e.linha}:${e.campo}`);
    assert.deepEqual(pares.sort(), ['1:codigo_sku', '1:nome', '2:disponibilidade', '2:preco_venda', '2:status']);
    assert.equal(await contar(), 0);
  });

  it('ignora SKU já cadastrado ou repetido no lote, grava o resto e diz o que ignorou', async () => {
    await criarProduto(linha('EXISTE'));
    const r = await lote([linha('NOVO'), linha('novo'), linha('existe'), linha('OUTRO')]);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.produtos.map(p => p.codigo_sku), ['NOVO', 'OUTRO']);
    assert.deepEqual(r.body.ignorados.map(e => [e.linha, e.codigo_sku, e.campo, e.motivo]), [
      [1, 'novo', 'codigo_sku', 'SKU repetido na linha 1'],
      [2, 'existe', 'codigo_sku', 'SKU já cadastrado'],
    ]);
    assert.equal(await contar(), 3);
  });

  it('ignora código do fornecedor já cadastrado no mesmo fornecedor', async () => {
    await criarProduto({ ...linha('A-1'), fornecedor: 'Clush', codigo_fornecedor: 'CL-77' });
    const r = await lote([
      linha('B-1', { fornecedor: 'clush', codigo_fornecedor: 'cl-77' }), // mesmo fornecedor e código: ignora
      linha('B-2', { fornecedor: 'Outro', codigo_fornecedor: 'CL-77' }), // outro fornecedor: pode
      linha('B-3', { fornecedor: 'Outro', codigo_fornecedor: 'cl-77' }), // repete a linha anterior
      linha('B-4', { fornecedor: 'Clush', codigo_fornecedor: '' }), // sem código: nunca é duplicado
      linha('B-5', { fornecedor: 'Clush', codigo_fornecedor: '' }),
    ]);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.produtos.map(p => p.codigo_sku), ['B-2', 'B-4', 'B-5']);
    assert.deepEqual(r.body.ignorados.map(e => [e.linha, e.codigo_fornecedor, e.campo, e.motivo]), [
      [0, 'cl-77', 'codigo_fornecedor', 'Cód. fornecedor já cadastrado'],
      [2, 'cl-77', 'codigo_fornecedor', 'Cód. fornecedor repetido na linha 2'],
    ]);
  });

  it('lote só de duplicados responde 200 sem gravar nada', async () => {
    await criarProduto(linha('JA'));
    const r = await lote([linha('JA')]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.produtos, []);
    assert.equal(r.body.ignorados.length, 1);
    assert.equal(await contar(), 1);
  });

  it('grava o link do fornecedor e recusa link que não é http/https', async () => {
    const ok = await lote([linha('LK-1', { link_fornecedor: ' https://clush.com.br/produtos/oculos-x ' }), linha('LK-2')]);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.produtos[0].link_fornecedor, 'https://clush.com.br/produtos/oculos-x');
    assert.equal(ok.body.produtos[1].link_fornecedor, '');

    const ruim = await lote([linha('LK-3', { link_fornecedor: 'javascript:alert(1)' }), linha('LK-4', { link_fornecedor: 'clush.com.br/x' })]);
    assert.equal(ruim.status, 400);
    assert.deepEqual(ruim.body.erros.map(e => `${e.linha}:${e.campo}`), ['0:link_fornecedor', '1:link_fornecedor']);
    assert.equal(await contar(), 2);
  });

  it('recusa preço negativo, lote vazio e lote acima do limite', async () => {
    assert.equal((await lote([linha('N', { preco_custo: -1 })])).status, 400);
    assert.equal((await lote([])).status, 400);
    assert.equal((await api('POST', '/api/admin/produtos/lote', { body: {} })).status, 400);
    const muitos = Array.from({ length: 101 }, (_, i) => linha(`M-${i}`));
    assert.equal((await lote(muitos)).status, 400);
    assert.equal(await contar(), 0);
  });

  it('aceita 100 produtos de uma vez', async () => {
    const r = await lote(Array.from({ length: 100 }, (_, i) => linha(`C-${i}`, { fornecedor: 'Forn' })));
    assert.equal(r.status, 201);
    assert.equal(await contar(), 100);
  });
});

// ---------- Funções da aba "Cadastro em Lote" (admin/index.html) ----------

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

function carregarPainel(globais = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const colunas = html.match(/const COLUNAS_LOTE = \[[\s\S]*?\n {4}\];/)[0];
  const funcoes = ['escapeHtml', 'linhaLoteVazia', 'linhaLoteEstaVazia', 'lerPreco', 'lerDisponibilidade', 'lerStatus', 'campoDoCabecalho', 'linhasDaPlanilha', 'linkSeguro', 'validarLote', 'avisosDuplicidade', 'renderizarLote'];
  const fonte = `${colunas}\nconst MAX_LOTE = 100;\n${funcoes.map(f => extrairFuncao(html, f)).join('\n')}`;
  const ctx = vm.createContext({ Number, String, Math, Map, Set, Object, URL, todosProdutos: [], ...globais });
  vm.runInContext(`${fonte}\n${funcoes.map(f => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

describe('painel: cadastro em lote', () => {
  const ctx = carregarPainel();

  it('lê preços no formato brasileiro', () => {
    assert.equal(ctx.lerPreco('199,90'), 199.9);
    assert.equal(ctx.lerPreco('R$ 1.234,56'), 1234.56);
    assert.equal(ctx.lerPreco('199.90'), 199.9);
    assert.equal(ctx.lerPreco('1.234'), 1234);
    assert.equal(ctx.lerPreco('80'), 80);
    assert.ok(Number.isNaN(ctx.lerPreco('')));
    assert.ok(Number.isNaN(ctx.lerPreco('abc')));
    assert.ok(Number.isNaN(ctx.lerPreco('-5')));
  });

  it('transforma linhas coladas da planilha sem cabeçalho, na ordem das colunas', () => {
    const texto = [
      'Aviador Gold\tAV-1\tAtacado SP\tX-9\thttps://forn.com/av1\t50,00\tR$ 199,90\tSob encomenda\tCondicional\tAviador\tClássico\tDourado',
      '',
      'Redondo\tRD-1\t\t\t\t30\t89,9',
    ].join('\r\n');
    const linhas = ctx.linhasDaPlanilha(texto);
    assert.equal(linhas.length, 2);
    assert.equal(linhas[0].nome, 'Aviador Gold');
    assert.equal(linhas[0].fornecedor, 'Atacado SP');
    assert.equal(linhas[0].codigo_fornecedor, 'X-9');
    assert.equal(linhas[0].link_fornecedor, 'https://forn.com/av1');
    assert.equal(linhas[0].preco_venda, 'R$ 199,90');
    assert.equal(linhas[0].disponibilidade, 'SOB_ENCOMENDA');
    assert.equal(linhas[0].status, 'CONDICIONAL');
    assert.equal(linhas[0].cor_armacao, 'Dourado');
    assert.equal(linhas[1].disponibilidade, 'PRONTA_ENTREGA');
    assert.equal(linhas[1].status, 'DISPONIVEL');
    assert.equal(linhas[1].fornecedor, '');
  });

  it('com cabeçalho, lê as colunas pelo título em qualquer ordem (planilha antiga sem link)', () => {
    const texto = [
      'Nome\tSKU\tFornecedor\tCód. fornecedor\tCusto\tVenda\tDisponibilidade\tStatus',
      'Aviador Gold\tAV-1\tAtacado SP\tX-9\t50,00\tR$ 199,90\tSob encomenda\tCondicional',
    ].join('\n');
    const [a] = ctx.linhasDaPlanilha(texto);
    assert.equal(a.codigo_fornecedor, 'X-9');
    assert.equal(a.link_fornecedor, '');
    assert.equal(a.preco_custo, '50,00');
    assert.equal(a.status, 'CONDICIONAL');

    const [b] = ctx.linhasDaPlanilha('Produto;Link;Preço de custo;Código;Preço de venda\nClub;https://f.com/c;40;CM-9;150');
    assert.equal(b.nome, 'Club');
    assert.equal(b.link_fornecedor, 'https://f.com/c');
    assert.equal(b.preco_custo, '40');
    assert.equal(b.codigo_sku, 'CM-9');
    assert.equal(b.preco_venda, '150');
  });

  it('aceita CSV com ponto e vírgula', () => {
    const [l] = ctx.linhasDaPlanilha('Clubmaster;CM-1;Forn;C1;;40;150');
    assert.equal(l.codigo_sku, 'CM-1');
    assert.equal(l.preco_venda, '150');
  });

  it('valida cada linha preenchida e ignora as vazias', () => {
    const l = (extra) => ({ ...ctx.linhaLoteVazia(), nome: 'X', preco_custo: '10', preco_venda: '20', ...extra });
    const erros = ctx.validarLote([
      l({ codigo_sku: 'A' }),
      ctx.linhaLoteVazia(),
      l({ codigo_sku: 'JA', nome: ' ', preco_venda: 'x' }),
      l({ codigo_sku: '' }),
      l({ codigo_sku: 'B', link_fornecedor: 'javascript:alert(1)' }),
      l({ codigo_sku: 'C', link_fornecedor: 'https://ok.com/x' }),
    ]);
    assert.deepEqual({ ...erros[0] }, {});
    assert.deepEqual({ ...erros[1] }, {});
    assert.equal(erros[2].nome, 'Informe o nome');
    assert.equal(erros[2].preco_venda, 'Preço inválido');
    assert.equal(erros[3].codigo_sku, 'Informe o SKU');
    assert.match(erros[4].link_fornecedor, /Link inválido/);
    assert.deepEqual({ ...erros[5] }, {});
  });

  it('avisa (sem bloquear) quais linhas são duplicadas e serão ignoradas', () => {
    const l = (extra) => ({ ...ctx.linhaLoteVazia(), nome: 'X', preco_custo: '10', preco_venda: '20', ...extra });
    const avisos = ctx.avisosDuplicidade([
      l({ codigo_sku: 'A' }),
      l({ codigo_sku: 'a' }),
      l({ codigo_sku: 'JA' }),
      l({ codigo_sku: 'N1', fornecedor: 'clush', codigo_fornecedor: 'cl-1' }),
      l({ codigo_sku: 'N2', fornecedor: 'Outro', codigo_fornecedor: 'CL-1' }),
      l({ codigo_sku: 'N3', fornecedor: 'Outro', codigo_fornecedor: 'cl-1' }),
      ctx.linhaLoteVazia(),
    ], [{ codigo_sku: 'ja', fornecedor: 'Clush', codigo_fornecedor: 'CL-1' }]);
    assert.deepEqual([...avisos], [
      '',
      'SKU repetido na linha 1: será ignorado',
      'SKU já cadastrado: será ignorado',
      'Cód. fornecedor já cadastrado: será ignorado',
      '',
      'Cód. fornecedor repetido na linha 5: será ignorado',
      '',
    ]);
  });

  it('linkSeguro só aceita http/https', () => {
    assert.equal(ctx.linkSeguro(' https://a.com/x '), 'https://a.com/x');
    assert.equal(ctx.linkSeguro('http://a.com'), 'http://a.com/');
    for (const ruim of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'a.com', '', null, 'https://u:p@a.com']) {
      assert.equal(ctx.linkSeguro(ruim), '', String(ruim));
    }
  });

  it('escapa o que foi digitado ou colado ao redesenhar a tabela', () => {
    const PAYLOAD = '"><img src=x onerror=alert(1)>';
    const tabelaLote = { innerHTML: '' };
    const resumo = { textContent: '' };
    const linha = { ...carregarPainel().linhaLoteVazia(), nome: PAYLOAD, codigo_sku: PAYLOAD, fornecedor: PAYLOAD, codigo_fornecedor: PAYLOAD, link_fornecedor: PAYLOAD, preco_custo: PAYLOAD, formato: PAYLOAD };
    const painel = carregarPainel({
      tabelaLote,
      document: { getElementById: () => resumo },
      linhasLote: [linha, { ...linha }],
      errosLote: [{ nome: PAYLOAD }],
    });
    painel.renderizarLote();
    assert.match(tabelaLote.innerHTML, /lote-aviso/); // a 2ª linha repete o SKU da 1ª
    assert.doesNotMatch(tabelaLote.innerHTML, /<img src=x/);
    assert.match(tabelaLote.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(resumo.textContent, /2 produto\(s\) preenchido\(s\) de 2 linha\(s\), 1 duplicado/);
  });
});
