// Gênero do produto (Masculino, Feminino, Unissex): API (formulário, edição, lote),
// leitura da planilha no painel e filtro/detalhes na vitrine.
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

async function api(method, p, body) {
  const headers = { Authorization: `Bearer ${token}` };
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

const base = (sku) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: 50, preco_venda: 120 });

describe('gênero: API', () => {
  it('cadastra, mostra na vitrine e edita', async () => {
    const r = await criarProduto({ ...base('G-1'), genero: 'Unissex' });
    assert.equal(r.status, 201);
    assert.equal(r.body.genero, 'UNISSEX');
    const sem = await criarProduto(base('G-2'));
    assert.equal(sem.body.genero, '');

    const pub = await (await fetch(srv.url('/api/produtos'))).json();
    assert.equal(pub.find((p) => p.codigo_sku === 'G-1').genero, 'UNISSEX');

    const ed = await api('PUT', `/api/produtos/${r.body.id}`, { genero: 'FEMININO' });
    assert.equal(ed.status, 200);
    assert.equal(ed.body.genero, 'FEMININO');
    // PUT sem o campo não mexe no gênero
    const ed2 = await api('PUT', `/api/produtos/${r.body.id}`, { nome: 'Outro' });
    assert.equal(ed2.body.genero, 'FEMININO');
  });

  it('recusa gênero inválido', async () => {
    const r = await criarProduto({ ...base('G-3'), genero: 'criança' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Gênero inválido/);
  });

  it('cadastro em lote grava o gênero e aponta o inválido', async () => {
    const ok = await api('POST', '/api/admin/produtos/lote', {
      produtos: [{ ...base('L-1'), genero: 'MASCULINO' }, { ...base('L-2'), genero: 'unisex' }, base('L-3')],
    });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.produtos.map((p) => p.genero), ['MASCULINO', 'UNISSEX', '']);

    const ruim = await api('POST', '/api/admin/produtos/lote', { produtos: [base('L-4'), { ...base('L-5'), genero: 'x' }] });
    assert.equal(ruim.status, 400);
    assert.deepEqual(ruim.body.erros.map((e) => [e.linha, e.campo]), [[1, 'genero']]);
  });
});

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

function carregar(arquivo, funcoes, prefixo = () => '') {
  const html = fs.readFileSync(path.join(__dirname, '..', arquivo), 'utf8');
  const ctx = vm.createContext({ todosProdutos: [] });
  vm.runInContext(`${prefixo(html)}\n${funcoes.map((f) => extrairFuncao(html, f)).join('\n')}\n${funcoes.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

describe('gênero: painel', () => {
  const painel = carregar('admin/index.html',
    ['linhaLoteVazia', 'linhaLoteEstaVazia', 'lerPreco', 'lerMedida', 'lerDisponibilidade', 'lerStatus', 'lerGenero', 'campoDoCabecalho', 'linhasDaPlanilha', 'linkSeguro', 'validarLote'],
    (html) => `${html.match(/const COLUNAS_LOTE = \[[\s\S]*?\n {4}\];/)[0]}\n${html.match(/const CAMPOS_MEDIDA = \[.*\];/)[0]}`);

  it('lê o gênero da planilha pelo título da coluna', () => {
    const linhas = painel.linhasDaPlanilha([
      'Nome;SKU;Custo;Venda;Gênero',
      'A;A1;10;20;Masculino',
      'B;B1;10;20;Feminino',
      'C;C1;10;20;Unisex',
      'D;D1;10;20;',
      'E;E1;10;20;Infantil',
    ].join('\n'));
    assert.deepEqual([...linhas].map((l) => String(l.genero)), ['MASCULINO', 'FEMININO', 'UNISSEX', '', 'Infantil']);
    const erros = painel.validarLote(linhas);
    assert.deepEqual(JSON.parse(JSON.stringify(erros.map((e) => Object.keys(e)))), [[], [], [], [], ['genero']]);
  });
});

describe('gênero: vitrine', () => {
  const vitrine = carregar('index.html', ['passaFiltroGenero', 'especificacoesProduto']);

  it('Masculino e Feminino também mostram os Unissex', () => {
    const p = (genero) => ({ genero });
    assert.equal(vitrine.passaFiltroGenero(p('MASCULINO'), ''), true);
    assert.equal(vitrine.passaFiltroGenero(p('MASCULINO'), 'MASCULINO'), true);
    assert.equal(vitrine.passaFiltroGenero(p('UNISSEX'), 'MASCULINO'), true);
    assert.equal(vitrine.passaFiltroGenero(p('FEMININO'), 'MASCULINO'), false);
    assert.equal(vitrine.passaFiltroGenero(p(''), 'FEMININO'), false);
    assert.equal(vitrine.passaFiltroGenero(p('MASCULINO'), 'UNISSEX'), false);
  });

  it('mostra o gênero nos detalhes', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(vitrine.especificacoesProduto({ genero: 'UNISSEX' }))), [['Gênero', 'Unissex']]);
    assert.deepEqual(JSON.parse(JSON.stringify(vitrine.especificacoesProduto({ genero: '' }))), []);
  });
});
