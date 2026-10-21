// Loja de roupas: tipo de loja (nicho) nos dados da loja, cadastro por grade de
// tamanhos (um produto por tamanho, cada um com o seu estoque), fotos da grade e,
// na vitrine, os tamanhos de um modelo num card só.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('./helpers');
const { montarLoja } = require('../loja');

let srv;
let token;

async function limparNicho() {
  await h.pool.query(`DELETE FROM configuracoes WHERE chave IN ('loja_nicho', 'loja_oculos')`);
}

before(async () => {
  await limparNicho();
  srv = await h.iniciarServidor();
  token = await h.login(srv);
});
beforeEach(h.limparBanco);
after(async () => {
  await srv.parar();
  await limparNicho();
  await h.fecharBanco();
});

async function api(method, p, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

async function enviar(method, p, campos, arquivos = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  for (const [k, buf] of Object.entries(arquivos)) form.append(k, new Blob([buf], { type: 'image/png' }), `${k}.png`);
  const res = await fetch(srv.url(p), { method, headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json() };
}

const png = (n) => Buffer.concat([h.PNG_1x1, Buffer.from([n])]);
const vestido = { nome: 'Vestido Floral', codigo_sku: 'VEST-01', preco_custo: '60', preco_venda: '159.90', formato: 'Vestido', cor_armacao: 'Azul', material: 'Viscose' };

describe('tipo de loja (nicho)', () => {
  it('montarLoja: loja_nicho manda; sem ele, segue o loja_oculos de antes', () => {
    const outra = { slug: 'moda', padrao: false, nome: 'Moda Bela' };
    assert.equal(montarLoja(outra, []).nicho, 'geral');
    assert.equal(montarLoja({ slug: 'nix', padrao: true }, []).nicho, 'oculos');
    assert.equal(montarLoja(outra, [{ chave: 'loja_oculos', valor: '1' }]).nicho, 'oculos');
    const roupas = montarLoja(outra, [{ chave: 'loja_oculos', valor: '1' }, { chave: 'loja_nicho', valor: 'roupas' }]);
    assert.equal(roupas.nicho, 'roupas');
    assert.equal(roupas.oculos, false);
    // Textos de partida das roupas, só onde a loja não escreveu os seus
    assert.match(roupas.descricao, /tamanhos/);
    const comTexto = montarLoja(outra, [{ chave: 'loja_nicho', valor: 'roupas' }, { chave: 'loja_chamada', valor: 'Nova coleção' }]);
    assert.equal(comTexto.chamada, 'Nova coleção');
    assert.equal(montarLoja(outra, [{ chave: 'loja_nicho', valor: 'xx' }]).nicho, 'geral');
  });

  it('o painel salva o tipo de loja e a vitrine recebe window.LOJA com o nicho', async () => {
    assert.equal((await api('PUT', '/api/admin/loja', { nicho: 'sapatos' })).status, 400);
    const salvo = await api('PUT', '/api/admin/loja', { nicho: 'roupas' });
    assert.equal(salvo.status, 200);
    assert.equal(salvo.body.nicho, 'roupas');
    assert.equal(salvo.body.oculos, false);
    const pagina = await (await fetch(srv.url('/'))).text();
    assert.match(pagina, /window\.LOJA = \{[^}]*"oculos":false,"nicho":"roupas"\}/);
    // O campo antigo (oculos: true/false) continua valendo
    const oculos = await api('PUT', '/api/admin/loja', { oculos: true });
    assert.equal(oculos.body.nicho, 'oculos');
    await limparNicho();
  });
});

describe('roupas: cadastro por grade de tamanhos', () => {
  it('cria um produto por tamanho, com estoque, SKU, nome e as mesmas fotos', async () => {
    const r = await enviar('POST', '/api/produtos',
      { ...vestido, tamanhos: [{ tamanho: 'm', estoque: 3 }, { tamanho: 'P', estoque: 2 }, { tamanho: 'G', estoque: 0 }] },
      { foto1: png(1), foto2: png(2) });
    assert.equal(r.status, 201);
    assert.equal(r.body.produtos.length, 3);
    const porSku = Object.fromEntries(r.body.produtos.map((p) => [p.codigo_sku, p]));
    assert.deepEqual(Object.keys(porSku).sort(), ['VEST-01-G', 'VEST-01-M', 'VEST-01-P']);
    assert.equal(porSku['VEST-01-M'].nome, 'Vestido Floral - M');
    assert.equal(porSku['VEST-01-M'].tamanho, 'M');
    assert.equal(porSku['VEST-01-M'].estoque, 3);
    assert.equal(porSku['VEST-01-M'].status, 'DISPONIVEL');
    assert.equal(porSku['VEST-01-G'].status, 'ESGOTADO');
    for (const p of r.body.produtos) {
      assert.equal(p.grade, 'VEST-01');
      assert.equal(p.formato, 'Vestido');
      assert.deepEqual(p.fotos, r.body.produtos[0].fotos);
    }
    assert.equal(r.body.produtos[0].fotos.length, 2);

    // Vitrine: os tamanhos com peça, com tamanho e grade
    const pub = await (await fetch(srv.url('/api/produtos'))).json();
    assert.deepEqual(pub.map((p) => p.tamanho).sort(), ['M', 'P']);
    assert.ok(pub.every((p) => p.grade === 'VEST-01'));
  });

  it('recusa grade inválida e não deixa tamanho pela metade', async () => {
    const repetido = await enviar('POST', '/api/produtos', { ...vestido, tamanhos: [{ tamanho: 'P', estoque: 1 }, { tamanho: 'p', estoque: 1 }] });
    assert.equal(repetido.status, 400);
    const semNumero = await enviar('POST', '/api/produtos', { ...vestido, tamanhos: [{ tamanho: 'P', estoque: 'dois' }] });
    assert.equal(semNumero.status, 400);
    assert.equal((await enviar('POST', '/api/produtos', { ...vestido, tamanhos: 'x' })).status, 400);

    await enviar('POST', '/api/produtos', { ...vestido, nome: 'Outro', codigo_sku: 'VEST-01-G' });
    const conflito = await enviar('POST', '/api/produtos', { ...vestido, tamanhos: [{ tamanho: 'P', estoque: 1 }, { tamanho: 'G', estoque: 1 }] });
    assert.equal(conflito.status, 400);
    assert.match(conflito.body.error, /SKU já cadastrado/);
    const { rows } = await h.pool.query(`SELECT codigo_sku FROM produtos ORDER BY id`);
    assert.deepEqual(rows.map((r) => r.codigo_sku), ['VEST-01-G']);
  });

  it('sem grade é o produto de sempre; tamanho e código do modelo também vêm do formulário e do lote', async () => {
    const r = await enviar('POST', '/api/produtos', { ...vestido, tamanho: 'gg', grade: 'VEST-01' });
    assert.equal(r.status, 201);
    assert.equal(r.body.produtos, undefined);
    assert.equal(r.body.tamanho, 'GG');
    assert.equal(r.body.grade, 'VEST-01');
    const ed = await api('PUT', `/api/produtos/${r.body.id}`, { tamanho: '42' });
    assert.equal(ed.body.tamanho, '42');
    assert.equal(ed.body.grade, 'VEST-01');

    const lote = await api('POST', '/api/admin/produtos/lote', {
      produtos: [{ nome: 'Calça - 38', codigo_sku: 'CAL-38', preco_custo: '40', preco_venda: '99', tamanho: '38', grade: 'CAL', quantidade: '2' }],
    });
    assert.equal(lote.status, 201);
    assert.equal(lote.body.produtos[0].tamanho, '38');
    assert.equal(lote.body.produtos[0].grade, 'CAL');
    assert.equal(lote.body.produtos[0].estoque, 2);
  });

  it('trocar as fotos de um tamanho troca as do modelo todo, sem apagar as que ainda são usadas', async () => {
    const r = await enviar('POST', '/api/produtos',
      { ...vestido, tamanhos: [{ tamanho: 'P', estoque: 1 }, { tamanho: 'M', estoque: 1 }] }, { foto1: png(1) });
    const [p, m] = r.body.produtos;
    const fotoAntiga = p.fotos[0];
    // Mantém a foto 1 e acrescenta outra no tamanho P: o M ganha as duas
    const ed = await enviar('PUT', `/api/produtos/${p.id}`, { fotos_manter: [fotoAntiga, null, null, null] }, { foto2: png(2) });
    assert.equal(ed.status, 200);
    assert.equal(ed.body.fotos.length, 2);
    const lista = await api('GET', '/api/admin/produtos');
    assert.deepEqual(lista.body.find((x) => x.id === m.id).fotos, ed.body.fotos);
    // Tira a foto antiga: some do modelo todo e sai do banco
    const ed2 = await enviar('PUT', `/api/produtos/${m.id}`, { fotos_manter: [ed.body.fotos[1], null, null, null] });
    assert.deepEqual(ed2.body.fotos, [ed.body.fotos[1]]);
    assert.equal((await fetch(srv.url(fotoAntiga))).status, 404);
    assert.equal((await fetch(srv.url(ed.body.fotos[1]))).status, 200);
  });

  it('o pedido da maleta leva o tamanho no nome da peça', async () => {
    const r = await enviar('POST', '/api/produtos', { ...vestido, tamanhos: [{ tamanho: 'M', estoque: 1 }, { tamanho: 'G', estoque: 1 }] });
    const [m, g] = r.body.produtos;
    const contato = { nome: 'Ana', telefone: '(11) 99999-0000', cep: '01001-000', rua: 'Rua A', numero: '10', bairro: 'Centro', cidade: 'São Paulo' };
    const res = await fetch(srv.url('/api/maleta/checkout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ produtoIds: [m.id, g.id], contato }),
    });
    assert.equal(res.status, 200);
    const { rows } = await h.pool.query('SELECT itens FROM pedidos');
    assert.deepEqual(rows[0].itens.map((i) => i.nome).sort(), ['Vestido Floral - G', 'Vestido Floral - M']);
  });
});

// ---------- Vitrine: um card por modelo ----------

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const ORDEM = HTML.match(/const ORDEM_TAMANHOS = \[.*\];/)[0];

function vitrine(nicho, produtos) {
  const ctx = vm.createContext({ NICHO: nicho, produtos, maleta: { itens: [] }, Number, String });
  const funcoes = ['ordemTamanho', 'ordenarTamanhos', 'agruparCards', 'grupoDoProduto', 'nomeModelo', 'escapeHtml', 'ehSobEncomenda', 'botaoGrupoCard', 'tamanhosCard'];
  vm.runInContext(`${ORDEM}\n${funcoes.map((f) => extrairFuncao(HTML, f)).join('\n')}\n${funcoes.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

describe('roupas: vitrine', () => {
  const pecas = [
    { id: 1, nome: 'Vestido - G', tamanho: 'G', grade: 'V1' },
    { id: 2, nome: 'Vestido - PP', tamanho: 'PP', grade: 'V1' },
    { id: 3, nome: 'Blusa', tamanho: '', grade: '' },
    { id: 4, nome: 'Vestido - M', tamanho: 'M', grade: 'V1' },
    { id: 5, nome: 'Calça - 40', tamanho: '40', grade: 'C1' },
    { id: 6, nome: 'Calça - 38', tamanho: '38', grade: 'C1' },
  ];

  it('junta os tamanhos do mesmo modelo num card, do menor para o maior', () => {
    const ctx = vitrine('roupas', pecas);
    const grupos = JSON.parse(JSON.stringify(ctx.agruparCards(pecas)));
    assert.deepEqual(grupos.map((g) => g.map((p) => p.id)), [[2, 4, 1], [3], [6, 5]]);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.ordenarTamanhos(['GG', '38', 'Único', 'P', '36', 'M']))), ['P', 'M', 'GG', 'Único', '36', '38']);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.grupoDoProduto(pecas[0]).map((p) => p.id))), [2, 4, 1]);
    assert.equal(ctx.nomeModelo(pecas[0]), 'Vestido');
    assert.equal(ctx.nomeModelo({ nome: 'Blusa', tamanho: '' }), 'Blusa');
  });

  it('nas outras lojas cada produto continua sendo um card', () => {
    const ctx = vitrine('oculos', pecas);
    assert.equal(ctx.agruparCards(pecas).length, pecas.length);
    assert.equal(ctx.tamanhosCard([pecas[0]]).length, 0);
  });

  it('o botão do card pede o tamanho e mostra os que já estão na maleta', () => {
    const ctx = vitrine('roupas', pecas);
    const grupo = ctx.agruparCards(pecas)[0];
    assert.match(ctx.botaoGrupoCard(grupo), /Escolher tamanho/);
    assert.match(ctx.botaoGrupoCard(grupo), /abrirDetalhes\(2\)/);
    ctx.maleta.itens.push({ id: 4 }, { id: 1 });
    const botao = ctx.botaoGrupoCard(grupo);
    assert.match(botao, /Na Maleta · M, G/);
    assert.match(botao, /abrirDetalhes\(4\)/);
  });
});
