// Especificações técnicas do produto (diâmetro, ponte, largura total em cm,
// material, tipo; formato da lente e cor reaproveitam formato/cor_armacao):
// API (formulário, edição, lote), funções do painel e exibição na vitrine.
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

const base = (sku) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: 50, preco_venda: 120 });
const exemplo = {
  diametro_cm: '5,0', ponte_cm: '2,0', largura_total_cm: '14,0',
  material: 'Metal', formato: 'Hexagonal', cor_armacao: 'Preto', tipo: 'Polarizado Premium',
};

describe('especificações técnicas: API', () => {
  it('grava no cadastro (vírgula ou "cm"), aparece na vitrine e no painel', async () => {
    const { status, body } = await criarProduto({ ...base('ESP-1'), ...exemplo, largura_total_cm: '14 cm' });
    assert.equal(status, 201);
    assert.equal(Number(body.diametro_cm), 5);
    assert.equal(Number(body.ponte_cm), 2);
    assert.equal(Number(body.largura_total_cm), 14);
    assert.equal(body.material, 'Metal');
    assert.equal(body.tipo, 'Polarizado Premium');

    const publico = (await api('GET', '/api/produtos', { auth: false })).body[0];
    assert.equal(publico.diametro_cm, '5.0');
    assert.equal(publico.ponte_cm, '2.0');
    assert.equal(publico.largura_total_cm, '14.0');
    assert.equal(publico.material, 'Metal');
    assert.equal(publico.formato, 'Hexagonal');
    assert.equal(publico.cor_armacao, 'Preto');
    assert.equal(publico.tipo, 'Polarizado Premium');

    const admin = (await api('GET', '/api/admin/produtos')).body[0];
    assert.equal(admin.diametro_cm, '5.0');
    assert.equal(admin.tipo, 'Polarizado Premium');
  });

  it('sem especificações o produto fica com medidas vazias', async () => {
    const { status, body } = await criarProduto(base('ESP-0'));
    assert.equal(status, 201);
    assert.equal(body.diametro_cm, null);
    assert.equal(body.material, '');
    assert.equal(body.tipo, '');
  });

  it('edição altera, apaga e não mexe no que não foi enviado', async () => {
    const { body } = await criarProduto({ ...base('ESP-2'), ...exemplo });
    const editado = await api('PUT', `/api/produtos/${body.id}`, { body: { diametro_cm: '5.4', ponte_cm: '', material: 'Acetato' } });
    assert.equal(editado.status, 200);
    assert.equal(editado.body.diametro_cm, '5.4');
    assert.equal(editado.body.ponte_cm, null);
    assert.equal(editado.body.material, 'Acetato');
    assert.equal(editado.body.tipo, 'Polarizado Premium');

    const soStatus = await api('PUT', `/api/produtos/${body.id}`, { body: { status: 'CONDICIONAL' } });
    assert.equal(soStatus.body.diametro_cm, '5.4');
    assert.equal(soStatus.body.largura_total_cm, '14.0');
  });

  it('recusa medida inválida no cadastro e na edição', async () => {
    for (const ruim of ['abc', '-1', '0', '100', '5,0,1', '1e2']) {
      const r = await criarProduto({ ...base('ESP-X'), diametro_cm: ruim });
      assert.equal(r.status, 400, ruim);
      assert.match(r.body.error, /Diâmetro inválido/);
    }
    const { body } = await criarProduto(base('ESP-3'));
    const r = await api('PUT', `/api/produtos/${body.id}`, { body: { largura_total_cm: 'grande' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Largura total inválido/);
  });

  it('cadastro em lote grava as especificações e aponta a medida inválida', async () => {
    const ok = await api('POST', '/api/admin/produtos/lote', {
      body: { produtos: [{ ...base('L-1'), ...exemplo, diametro_cm: 5, ponte_cm: 2 }, base('L-2')] },
    });
    assert.equal(ok.status, 201);
    const [p1, p2] = ok.body.produtos;
    assert.equal(p1.diametro_cm, '5.0');
    assert.equal(p1.largura_total_cm, '14.0');
    assert.equal(p1.tipo, 'Polarizado Premium');
    assert.equal(p2.ponte_cm, null);

    const ruim = await api('POST', '/api/admin/produtos/lote', { body: { produtos: [base('L-3'), { ...base('L-4'), ponte_cm: 'x' }] } });
    assert.equal(ruim.status, 400);
    assert.deepEqual(ruim.body.erros.map((e) => [e.linha, e.campo]), [[1, 'ponte_cm']]);
  });
});

// ---------- Painel (admin/index.html) e vitrine (index.html) ----------

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

function carregar(arquivo, funcoes, prefixo = '') {
  const html = fs.readFileSync(path.join(__dirname, '..', arquivo), 'utf8');
  const ctx = vm.createContext({ todosProdutos: [] });
  vm.runInContext(`${prefixo(html)}\n${funcoes.map((f) => extrairFuncao(html, f)).join('\n')}\n${funcoes.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

describe('especificações técnicas: painel', () => {
  const painel = carregar('admin/index.html',
    ['escapeHtml', 'linhaLoteVazia', 'linhaLoteEstaVazia', 'lerPreco', 'lerMedida', 'formatarMedida', 'lerDisponibilidade', 'lerStatus', 'lerGenero', 'campoDoCabecalho', 'linhasDaPlanilha', 'linkSeguro', 'validarLote'],
    (html) => `${html.match(/const COLUNAS_LOTE = \[[\s\S]*?\n {4}\];/)[0]}\n${html.match(/const CAMPOS_MEDIDA = \[.*\];/)[0]}`);

  it('lê e formata medidas em cm', () => {
    assert.equal(painel.lerMedida('5,0'), 5);
    assert.equal(painel.lerMedida('14 cm'), 14);
    assert.equal(painel.lerMedida('2.05'), 2.1);
    assert.equal(painel.lerMedida(''), null);
    assert.ok(Number.isNaN(painel.lerMedida('abc')));
    assert.ok(Number.isNaN(painel.lerMedida('0')));
    assert.ok(Number.isNaN(painel.lerMedida('100')));
    assert.equal(painel.formatarMedida('5.0'), '5,0');
    assert.equal(painel.formatarMedida(null), '');
  });

  it('planilha com cabeçalho preenche as especificações', () => {
    const texto = [
      'Nome\tSKU\tCusto\tVenda\tDiâmetro (cm)\tPonte\tLargura Total\tMaterial\tFormato da lente\tCor\tTipo',
      'Hexa\tHX-1\t50\t120\t5,0\t2,0\t14,0\tMetal\tHexagonal\tPreto\tPolarizado Premium',
    ].join('\n');
    const [l] = painel.linhasDaPlanilha(texto);
    assert.equal(l.diametro_cm, '5,0');
    assert.equal(l.ponte_cm, '2,0');
    assert.equal(l.largura_total_cm, '14,0');
    assert.equal(l.material, 'Metal');
    assert.equal(l.formato, 'Hexagonal');
    assert.equal(l.cor_armacao, 'Preto');
    assert.equal(l.tipo, 'Polarizado Premium');
  });

  it('validação marca medida inválida e linha só com especificação não é vazia', () => {
    const linha = { ...painel.linhaLoteVazia(), nome: 'A', codigo_sku: 'A', preco_custo: '1', preco_venda: '2', diametro_cm: 'cinco' };
    assert.match(painel.validarLote([linha])[0].diametro_cm, /Medida inválida/);
    assert.equal(painel.linhaLoteEstaVazia({ ...painel.linhaLoteVazia(), tipo: 'Polarizado' }), false);
  });
});

describe('especificações técnicas: vitrine', () => {
  const vitrine = carregar('index.html', ['escapeHtml', 'especificacoesProduto'], () => "const rotulos = { formato: 'Formato da lente', formatos: 'Todos os formatos', material: 'Material', tipo: 'Tipo' };");

  it('lista só o que foi preenchido, com medidas em "5,0 cm"', () => {
    const produto = { diametro_cm: '5.0', ponte_cm: '2.0', largura_total_cm: '14.0', material: 'Metal', formato: 'Hexagonal', cor_armacao: 'Preto', tipo: 'Polarizado Premium' };
    assert.deepEqual(JSON.parse(JSON.stringify(vitrine.especificacoesProduto(produto))), [
      ['Diâmetro', '5,0 cm'],
      ['Ponte', '2,0 cm'],
      ['Largura Total', '14,0 cm'],
      ['Material', 'Metal'],
      ['Formato da lente', 'Hexagonal'],
      ['Cor', 'Preto'],
      ['Tipo', 'Polarizado Premium'],
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(vitrine.especificacoesProduto({ diametro_cm: null, material: '', cor_armacao: 'Preto' }))), [['Cor', 'Preto']]);
  });
});
