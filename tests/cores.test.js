// Cores de um modelo: no cadastro, cada cor (com a sua foto e a sua quantidade) vira um
// produto com SKU próprio e o mesmo código do modelo (grade). A vitrine junta as cores num
// card e o cliente escolhe a cor pela foto; maleta, pedido e venda seguem por produto,
// então a baixa sai só do estoque da cor comprada.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('./helpers');

let srv;
let token;

before(async () => {
  await h.pool.query(`DELETE FROM configuracoes WHERE chave IN ('loja_nicho', 'loja_oculos')`);
  srv = await h.iniciarServidor();
  token = await h.login(srv);
});
beforeEach(h.limparBanco);
after(async () => {
  await srv.parar();
  await h.fecharBanco();
});

async function api(method, p, body, auth = true) {
  const headers = auth ? { Authorization: `Bearer ${token}` } : {};
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
const oculos = { nome: 'Nix Rex Aviador', codigo_sku: 'NIX-010', preco_custo: '30', preco_venda: '129.90', formato: 'Aviador', cor_armacao: 'ignorada', estoque: '9' };
const cores = [{ cor: 'Preto', estoque: 2 }, { cor: 'Tartaruga', estoque: 1 }, { cor: 'Azul-claro', estoque: 0 }];

describe('cadastro por cores', () => {
  it('cria um produto por cor, com cor, estoque, SKU, nome e a foto da cor como capa', async () => {
    const r = await enviar('POST', '/api/produtos', { ...oculos, cores },
      { foto1: png(1), foto2: png(2), foto4: png(4), foto_cor_1: png(11), foto_cor_2: png(12) });
    assert.equal(r.status, 201);
    assert.equal(r.body.produtos.length, 3);
    const porSku = Object.fromEntries(r.body.produtos.map((p) => [p.codigo_sku, p]));
    assert.deepEqual(Object.keys(porSku).sort(), ['NIX-010-AZUL-CLARO', 'NIX-010-PRETO', 'NIX-010-TARTARUGA']);
    const preto = porSku['NIX-010-PRETO'];
    const tartaruga = porSku['NIX-010-TARTARUGA'];
    const azul = porSku['NIX-010-AZUL-CLARO'];
    assert.equal(preto.nome, 'Nix Rex Aviador - Preto');
    assert.deepEqual(r.body.produtos.map((p) => p.cor_armacao), ['Preto', 'Tartaruga', 'Azul-claro']);
    assert.deepEqual(r.body.produtos.map((p) => p.estoque), [2, 1, 0]);
    assert.deepEqual(r.body.produtos.map((p) => p.status), ['DISPONIVEL', 'DISPONIVEL', 'ESGOTADO']);
    for (const p of r.body.produtos) {
      assert.equal(p.grade, 'NIX-010');
      assert.equal(p.formato, 'Aviador');
      assert.equal(p.fotos.length, 4);
      // Foto 2 e a foto do provador (4) valem para todas as cores
      assert.equal(p.fotos[1], preto.fotos[1]);
      assert.equal(p.fotos[3], preto.fotos[3]);
    }
    // Cada cor com foto própria tem a sua capa; a cor sem foto usa a foto 1 do formulário
    assert.notEqual(preto.fotos[0], tartaruga.fotos[0]);
    assert.equal(preto.imagem_url, preto.fotos[0]);
    assert.notEqual(azul.fotos[0], preto.fotos[0]);
    assert.equal(Buffer.from(await (await fetch(srv.url(preto.fotos[0]))).arrayBuffer()).at(-1), 11);
    assert.equal(Buffer.from(await (await fetch(srv.url(azul.fotos[0]))).arrayBuffer()).at(-1), 1);

    // Vitrine: só as cores com peça, com a cor e o código do modelo
    const pub = (await api('GET', '/api/produtos', undefined, false)).body;
    assert.deepEqual(pub.map((p) => p.cor_armacao).sort(), ['Preto', 'Tartaruga']);
    assert.ok(pub.every((p) => p.grade === 'NIX-010'));
  });

  it('com foto em todas as cores, a foto 1 do formulário não é gravada', async () => {
    const r = await enviar('POST', '/api/produtos', { ...oculos, cores: cores.slice(0, 2) },
      { foto1: png(1), foto_cor_1: png(11), foto_cor_2: png(12) });
    assert.equal(r.status, 201);
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM imagens');
    assert.equal(rows[0].n, 2);
  });

  it('recusa cores inválidas, cores junto com tamanhos e não deixa cor pela metade', async () => {
    for (const ruim of [[{ cor: 'Preto', estoque: 1 }, { cor: 'preto', estoque: 1 }], [{ cor: '', estoque: 1 }], [{ cor: 'Preto', estoque: 'dois' }], 'x']) {
      assert.equal((await enviar('POST', '/api/produtos', { ...oculos, cores: ruim })).status, 400);
    }
    const ambos = await enviar('POST', '/api/produtos', { ...oculos, cores, tamanhos: [{ tamanho: 'P', estoque: 1 }] });
    assert.equal(ambos.status, 400);
    assert.match(ambos.body.error, /tamanhos ou por cores/);

    await enviar('POST', '/api/produtos', { ...oculos, nome: 'Outro', codigo_sku: 'NIX-010-TARTARUGA' });
    const conflito = await enviar('POST', '/api/produtos', { ...oculos, cores });
    assert.equal(conflito.status, 400);
    assert.match(conflito.body.error, /alguma cor já existe/);
    const { rows } = await h.pool.query('SELECT codigo_sku FROM produtos ORDER BY id');
    assert.deepEqual(rows.map((x) => x.codigo_sku), ['NIX-010-TARTARUGA']);
  });

  it('cores que dão o mesmo SKU ganham um número', async () => {
    const r = await enviar('POST', '/api/produtos', { ...oculos, cores: [{ cor: 'Café', estoque: 1 }, { cor: 'Cafe!', estoque: 1 }] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.produtos.map((p) => p.codigo_sku), ['NIX-010-CAFE', 'NIX-010-CAFE-2']);
  });

  it('trocar a foto de uma cor não mexe nas fotos das outras cores do modelo', async () => {
    const r = await enviar('POST', '/api/produtos', { ...oculos, cores: cores.slice(0, 2) }, { foto_cor_1: png(11), foto_cor_2: png(12) });
    const [preto, tartaruga] = r.body.produtos;
    const ed = await enviar('PUT', `/api/produtos/${preto.id}`, { fotos_manter: [null, null, null, null] }, { foto1: png(21) });
    assert.equal(ed.status, 200);
    assert.notEqual(ed.body.fotos[0], preto.fotos[0]);
    const lista = (await api('GET', '/api/admin/produtos')).body;
    assert.deepEqual(lista.find((x) => x.id === tartaruga.id).fotos, tartaruga.fotos);
    // A foto antiga do preto saiu do banco; a do tartaruga continua
    assert.equal((await fetch(srv.url(preto.fotos[0]))).status, 404);
    assert.equal((await fetch(srv.url(tartaruga.fotos[0]))).status, 200);
  });

  it('o pedido leva a cor e a foto dela, e a venda baixa só o estoque da cor comprada', async () => {
    const r = await enviar('POST', '/api/produtos', { ...oculos, cores: cores.slice(0, 2) }, { foto_cor_1: png(11), foto_cor_2: png(12) });
    const [preto, tartaruga] = r.body.produtos;
    const pedido = await api('POST', '/api/maleta/checkout', { itens: [{ id: tartaruga.id, intencao: 'COMPRA' }], contato: { nome: 'Bia', telefone: '11988887777' } }, false);
    assert.equal(pedido.status, 200);
    const { rows } = await h.pool.query('SELECT itens FROM pedidos');
    assert.equal(rows[0].itens[0].nome, 'Nix Rex Aviador - Tartaruga');
    assert.equal(rows[0].itens[0].imagem_url ?? rows[0].itens[0].imagem ?? tartaruga.imagem_url, tartaruga.imagem_url);
    const fechar = await api('PUT', `/api/admin/pedidos/${pedido.body.pedido.id}/fechamento`, { concluir: true });
    assert.equal(fechar.status, 200);
    const depois = (await api('GET', '/api/admin/produtos')).body;
    const est = (id) => { const p = depois.find((x) => x.id === id); return [p.estoque, p.status]; };
    assert.deepEqual(est(tartaruga.id), [0, 'ESGOTADO']);
    assert.deepEqual(est(preto.id), [2, 'DISPONIVEL']);
  });
});

// ---------- Vitrine: um card por modelo, a cor escolhida pela foto ----------

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
  const ctx = vm.createContext({ NICHO: nicho, produtos, maleta: { itens: [] }, Number, String, Array });
  const funcoes = ['ordemTamanho', 'agruparCards', 'grupoDoProduto', 'variaPorCor', 'nomeModelo', 'nomeCard', 'escapeHtml', 'ehSobEncomenda', 'botaoGrupoCard', 'fotosDoProduto', 'coresCard', 'botoesCor'];
  vm.runInContext(`${ORDEM}\n${funcoes.map((f) => extrairFuncao(HTML, f)).join('\n')}\n${funcoes.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

describe('cores: vitrine', () => {
  const pecas = [
    { id: 1, nome: 'Nix Rex - Preto', cor_armacao: 'Preto', grade: 'NIX-010', fotos: ['/imagens/preto'], tamanho: '' },
    { id: 2, nome: 'Nix Spino', cor_armacao: 'Rosa', grade: '', fotos: ['/imagens/rosa'], tamanho: '' },
    { id: 3, nome: 'Nix Rex - Tartaruga', cor_armacao: 'Tartaruga', grade: 'NIX-010', fotos: ['/imagens/tart'], tamanho: '' },
  ];

  it('junta as cores do mesmo modelo num card; sem código do modelo, cada produto é um card', () => {
    const ctx = vitrine('oculos', pecas);
    const grupos = JSON.parse(JSON.stringify(ctx.agruparCards(pecas)));
    assert.deepEqual(grupos.map((g) => g.map((p) => p.id)), [[1, 3], [2]]);
    assert.equal(ctx.variaPorCor(ctx.grupoDoProduto(pecas[2])), true);
    assert.equal(ctx.variaPorCor([pecas[1]]), false);
    assert.equal(ctx.nomeModelo(pecas[0]), 'Nix Rex');
    // Produto avulso com "- Cor" no nome continua com o nome inteiro
    assert.equal(ctx.nomeModelo({ nome: 'Nix Spino - Rosa', cor_armacao: 'Rosa', grade: '' }), 'Nix Spino - Rosa');
  });

  it('o card mostra a foto de cada cor e o botão pede a cor', () => {
    const ctx = vitrine('oculos', pecas);
    const grupo = ctx.grupoDoProduto(pecas[0]);
    const bolinhas = ctx.coresCard(grupo);
    assert.match(bolinhas, /data-cores-card/);
    assert.match(bolinhas, /\/imagens\/preto[\s\S]*\/imagens\/tart/);
    assert.equal(ctx.coresCard([pecas[1]]), '');
    assert.match(ctx.botaoGrupoCard(grupo), /Escolher cor/);
    ctx.maleta.itens.push({ id: 3 });
    assert.match(ctx.botaoGrupoCard(grupo), /Na Maleta · Tartaruga/);
    assert.match(ctx.botaoGrupoCard(grupo), /abrirDetalhes\(3\)/);
  });

  it('nos detalhes, cada cor é um botão com a foto dela; a escolhida fica marcada', () => {
    const ctx = vitrine('oculos', pecas);
    const html = ctx.botoesCor(ctx.grupoDoProduto(pecas[0]), 3);
    assert.match(html, /escolherTamanho\(1\)[\s\S]*aria-pressed="false"[\s\S]*\/imagens\/preto/);
    assert.match(html, /escolherTamanho\(3\)" aria-pressed="true"/);
  });

  it('roupas com tamanhos continuam pedindo o tamanho', () => {
    const roupas = [{ id: 1, nome: 'Vestido - P', tamanho: 'P', grade: 'V1' }, { id: 2, nome: 'Vestido - M', tamanho: 'M', grade: 'V1' }];
    const ctx = vitrine('roupas', roupas);
    assert.equal(ctx.variaPorCor(ctx.grupoDoProduto(roupas[0])), false);
    assert.match(ctx.botaoGrupoCard(ctx.grupoDoProduto(roupas[0])), /Escolher tamanho/);
  });
});
