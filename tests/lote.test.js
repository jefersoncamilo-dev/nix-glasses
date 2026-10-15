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

  it('recusa SKU repetido no lote e SKU já cadastrado', async () => {
    await criarProduto(linha('EXISTE'));
    const r = await lote([linha('NOVO'), linha('novo'), linha('EXISTE')]);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.erros.map(e => [e.linha, e.campo, e.mensagem]), [
      [1, 'codigo_sku', 'SKU repetido na linha 1'],
      [2, 'codigo_sku', 'SKU já cadastrado'],
    ]);
    assert.equal(await contar(), 1);
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
  const funcoes = ['escapeHtml', 'linhaLoteVazia', 'linhaLoteEstaVazia', 'lerPreco', 'lerDisponibilidade', 'lerStatus', 'linhasDaPlanilha', 'validarLote', 'renderizarLote'];
  const fonte = `${colunas}\nconst MAX_LOTE = 100;\n${funcoes.map(f => extrairFuncao(html, f)).join('\n')}`;
  const ctx = vm.createContext({ Number, String, Math, Map, Set, Object, ...globais });
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

  it('transforma linhas coladas da planilha, ignorando o cabeçalho', () => {
    const texto = [
      'Nome\tSKU\tFornecedor\tCód. fornecedor\tCusto\tVenda\tDisponibilidade\tStatus',
      'Aviador Gold\tAV-1\tAtacado SP\tX-9\t50,00\tR$ 199,90\tSob encomenda\tCondicional\tAviador\tClássico\tDourado',
      '',
      'Redondo\tRD-1\t\t\t30\t89,9',
    ].join('\r\n');
    const linhas = ctx.linhasDaPlanilha(texto);
    assert.equal(linhas.length, 2);
    assert.equal(linhas[0].nome, 'Aviador Gold');
    assert.equal(linhas[0].fornecedor, 'Atacado SP');
    assert.equal(linhas[0].codigo_fornecedor, 'X-9');
    assert.equal(linhas[0].preco_venda, 'R$ 199,90');
    assert.equal(linhas[0].disponibilidade, 'SOB_ENCOMENDA');
    assert.equal(linhas[0].status, 'CONDICIONAL');
    assert.equal(linhas[0].cor_armacao, 'Dourado');
    assert.equal(linhas[1].disponibilidade, 'PRONTA_ENTREGA');
    assert.equal(linhas[1].status, 'DISPONIVEL');
    assert.equal(linhas[1].fornecedor, '');
  });

  it('aceita CSV com ponto e vírgula', () => {
    const [l] = ctx.linhasDaPlanilha('Clubmaster;CM-1;Forn;C1;40;150');
    assert.equal(l.codigo_sku, 'CM-1');
    assert.equal(l.preco_venda, '150');
  });

  it('valida cada linha preenchida e ignora as vazias', () => {
    const l = (extra) => ({ ...ctx.linhaLoteVazia(), nome: 'X', preco_custo: '10', preco_venda: '20', ...extra });
    const erros = ctx.validarLote([
      l({ codigo_sku: 'A' }),
      ctx.linhaLoteVazia(),
      l({ codigo_sku: 'a' }),
      l({ codigo_sku: 'JA', nome: ' ', preco_venda: 'x' }),
      l({ codigo_sku: '' }),
    ], new Set(['ja']));
    assert.deepEqual({ ...erros[0] }, {});
    assert.deepEqual({ ...erros[1] }, {});
    assert.equal(erros[2].codigo_sku, 'SKU repetido na linha 1');
    assert.equal(erros[3].codigo_sku, 'SKU já cadastrado');
    assert.equal(erros[3].nome, 'Informe o nome');
    assert.equal(erros[3].preco_venda, 'Preço inválido');
    assert.equal(erros[4].codigo_sku, 'Informe o SKU');
  });

  it('escapa o que foi digitado ou colado ao redesenhar a tabela', () => {
    const PAYLOAD = '"><img src=x onerror=alert(1)>';
    const tabelaLote = { innerHTML: '' };
    const resumo = { textContent: '' };
    const linha = { ...carregarPainel().linhaLoteVazia(), nome: PAYLOAD, codigo_sku: PAYLOAD, fornecedor: PAYLOAD, codigo_fornecedor: PAYLOAD, preco_custo: PAYLOAD, formato: PAYLOAD };
    const painel = carregarPainel({
      tabelaLote,
      document: { getElementById: () => resumo },
      linhasLote: [linha],
      errosLote: [{ nome: PAYLOAD }],
    });
    painel.renderizarLote();
    assert.doesNotMatch(tabelaLote.innerHTML, /<img src=x/);
    assert.match(tabelaLote.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(resumo.textContent, /1 produto\(s\) preenchido\(s\)/);
  });
});
