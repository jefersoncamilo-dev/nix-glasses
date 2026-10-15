// Até 4 fotos por produto: upload em foto1..foto4, edição por posição
// (trocar/remover), limpeza das imagens que saem, migração da foto única
// antiga e o carrossel da vitrine.
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

// PNGs diferentes entre si (o byte extra depois do IEND não atrapalha a detecção do tipo)
const png = (n) => Buffer.concat([h.PNG_1x1, Buffer.from([n])]);

function formulario(campos = {}, arquivos = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  for (const [k, buf] of Object.entries(arquivos)) form.append(k, new Blob([buf], { type: 'image/png' }), `${k}.png`);
  return form;
}

async function enviar(method, p, form) {
  const res = await fetch(srv.url(p), { method, headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json() };
}

const base = (sku) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: '50', preco_venda: '199.90' });

async function bytes(url) {
  const res = await fetch(srv.url(url));
  return res.ok ? Buffer.from(await res.arrayBuffer()) : res.status;
}

describe('API: até 4 fotos por produto', () => {
  it('cadastra 4 fotos na ordem e a 1ª vira imagem_url', async () => {
    const { status, body } = await enviar('POST', '/api/produtos',
      formulario(base('F4'), { foto1: png(1), foto2: png(2), foto3: png(3), foto4: png(4) }));
    assert.equal(status, 201);
    assert.equal(body.fotos.length, 4);
    assert.equal(body.imagem_url, body.fotos[0]);
    for (let i = 0; i < 4; i++) assert.deepEqual(await bytes(body.fotos[i]), png(i + 1));

    const pub = await (await fetch(srv.url('/api/produtos'))).json();
    assert.deepEqual(pub[0].fotos, body.fotos);
  });

  it('pula posições vazias e aceita o campo antigo "imagem" como foto 1', async () => {
    const a = await enviar('POST', '/api/produtos', formulario(base('A'), { foto3: png(3) }));
    assert.equal(a.status, 201);
    assert.equal(a.body.fotos.length, 1);
    assert.deepEqual(await bytes(a.body.imagem_url), png(3));

    const b = await enviar('POST', '/api/produtos', formulario(base('B'), { imagem: png(9) }));
    assert.equal(b.body.fotos.length, 1);
    assert.deepEqual(await bytes(b.body.fotos[0]), png(9));

    const c = await enviar('POST', '/api/produtos', formulario(base('C')));
    assert.deepEqual(c.body.fotos, []);
    assert.equal(c.body.imagem_url, null);
  });

  it('recusa mais de 4 arquivos e arquivo que não é imagem', async () => {
    const r = await enviar('POST', '/api/produtos',
      formulario(base('X'), { imagem: png(0), foto1: png(1), foto2: png(2), foto3: png(3), foto4: png(4) }));
    assert.equal(r.status, 400);

    const form = formulario(base('Y'), { foto1: png(1) });
    form.append('foto2', new Blob(['<svg/>'], { type: 'image/png' }), 'x.png');
    assert.equal((await enviar('POST', '/api/produtos', form)).status, 400);
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM produtos');
    assert.equal(rows[0].n, 0);
  });

  it('na edição troca a foto 2, remove a 3, mantém a ordem e apaga as que saíram', async () => {
    const { body: p } = await enviar('POST', '/api/produtos',
      formulario(base('ED'), { foto1: png(1), foto2: png(2), foto3: png(3) }));
    const [f1, f2, f3] = p.fotos;

    const r = await enviar('PUT', `/api/produtos/${p.id}`,
      formulario({ nome: 'Novo nome', fotos_manter: [f1, null, null, null] }, { foto2: png(22), foto4: png(4) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.nome, 'Novo nome');
    assert.equal(r.body.fotos.length, 3);
    assert.equal(r.body.fotos[0], f1);
    assert.deepEqual(await bytes(r.body.fotos[1]), png(22));
    assert.deepEqual(await bytes(r.body.fotos[2]), png(4));
    assert.equal(await bytes(f2), 404);
    assert.equal(await bytes(f3), 404);
  });

  it('remover a foto 1 promove a seguinte a capa', async () => {
    const { body: p } = await enviar('POST', '/api/produtos', formulario(base('CAPA'), { foto1: png(1), foto2: png(2) }));
    const r = await enviar('PUT', `/api/produtos/${p.id}`, formulario({ fotos_manter: [null, p.fotos[1]] }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.fotos, [p.fotos[1]]);
    assert.equal(r.body.imagem_url, p.fotos[1]);
    assert.equal(await bytes(p.fotos[0]), 404);
  });

  it('sem fotos_manter, arquivo novo só substitui a sua posição', async () => {
    const { body: p } = await enviar('POST', '/api/produtos', formulario(base('POS'), { foto1: png(1), foto2: png(2) }));
    const r = await enviar('PUT', `/api/produtos/${p.id}`, formulario({}, { foto1: png(11) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.fotos[1], p.fotos[1]);
    assert.deepEqual(await bytes(r.body.fotos[0]), png(11));
    assert.equal(await bytes(p.fotos[0]), 404);
  });

  it('atualização só de status (JSON) não mexe nas fotos', async () => {
    const { body: p } = await enviar('POST', '/api/produtos', formulario(base('ST'), { foto1: png(1), foto2: png(2) }));
    const res = await fetch(srv.url(`/api/produtos/${p.id}`), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ESGOTADO' }),
    });
    const body = await res.json();
    assert.equal(body.status, 'ESGOTADO');
    assert.deepEqual(body.fotos, p.fotos);
  });

  it('não aceita "manter" URL que não é do produto', async () => {
    const { body: outro } = await enviar('POST', '/api/produtos', formulario(base('OUT'), { foto1: png(5) }));
    const { body: p } = await enviar('POST', '/api/produtos', formulario(base('MEU'), { foto1: png(1) }));
    const r = await enviar('PUT', `/api/produtos/${p.id}`,
      formulario({ fotos_manter: [p.fotos[0], outro.fotos[0], 'javascript:alert(1)'] }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.fotos, p.fotos);
    assert.deepEqual(await bytes(outro.fotos[0]), png(5));
  });

  it('recusa fotos_manter malformado', async () => {
    const { body: p } = await enviar('POST', '/api/produtos', formulario(base('MAL')));
    for (const v of ['nao-e-json', '{"a":1}', '[1]', '["a","b","c","d","e"]']) {
      const r = await enviar('PUT', `/api/produtos/${p.id}`, formulario({ fotos_manter: v }));
      assert.equal(r.status, 400, v);
    }
  });

  it('migra a foto única dos produtos antigos para a foto 1', async () => {
    const { body: p } = await enviar('POST', '/api/produtos', formulario(base('OLD'), { foto1: png(1) }));
    await h.pool.query('ALTER TABLE produtos DROP COLUMN fotos');
    const outro = await h.iniciarServidor();
    try {
      const pub = await (await fetch(outro.url('/api/produtos'))).json();
      assert.deepEqual(pub[0].fotos, [p.imagem_url]);
    } finally {
      await outro.parar();
    }
  });
});

// ---------- Vitrine (index.html) num DOM mínimo ----------

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

const FUNCOES = ['escapeHtml', 'fotosDoProduto', 'indiceCircular', 'ehSobEncomenda', 'calcularSinal', 'passaFiltroStatus',
  'etiquetaProduto', 'renderizarCatalogo', 'trocarFotoCard', 'especificacoesProduto', 'renderizarDetalhes', 'mostrarFotoDetalhes'];

function vitrine(produtos) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const cards = [];
  const elemento = () => ({ innerHTML: '', value: '', dataset: {}, classList: { add() {}, remove() {} } });
  const ctx = vm.createContext({
    produtos,
    maleta: { itens: [] },
    fotoCard: {},
    detalhes: null,
    filtroStatus: { value: '' },
    filtroFormato: { value: '' },
    catalogoGrid: { innerHTML: '', classList: { add() {}, remove() {} }, appendChild: (c) => cards.push(c), querySelector: () => null },
    emptyState: elemento(),
    detalhesConteudo: elemento(),
    document: { createElement: elemento },
    formatarMoeda: (v) => `R$ ${v}`,
    fecharDetalhes() {},
  });
  vm.runInContext(`${FUNCOES.map((f) => extrairFuncao(html, f)).join('\n')}\n${FUNCOES.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);
  ctx.renderizarCatalogo();
  return { ctx, cards };
}

const fotos = ['/imagens/' + 'a'.repeat(32), '/imagens/' + 'b'.repeat(32), '/imagens/' + 'c'.repeat(32)];
const produto = { id: 1, nome: 'Aviador', codigo_sku: 'AV-01', preco_venda: '199.99', status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA', imagem_url: fotos[0], fotos };

describe('vitrine: carrossel de fotos', () => {
  it('card mostra a capa, setas e um ponto por foto', () => {
    const { cards } = vitrine([produto]);
    const html = cards[0].innerHTML;
    assert.match(html, new RegExp(`data-foto-card src="${fotos[0]}"`));
    assert.match(html, /trocarFotoCard\(1, -1\)/);
    assert.match(html, /trocarFotoCard\(1, 1\)/);
    assert.equal(html.match(/data-dot/g).length, 3);
    assert.match(html, /abrirDetalhes\(1\)/);
  });

  it('card de produto com uma foto (ou só imagem_url antiga) não tem setas', () => {
    const { cards } = vitrine([{ ...produto, fotos: undefined }]);
    assert.match(cards[0].innerHTML, new RegExp(`src="${fotos[0]}"`));
    assert.doesNotMatch(cards[0].innerHTML, /trocarFotoCard|data-dot/);
  });

  it('detalhes mostram a foto escolhida, miniaturas e contador, e as setas dão a volta', () => {
    const { ctx } = vitrine([produto]);
    ctx.detalhes = { id: 1, indice: 0 };
    ctx.mostrarFotoDetalhes(-1);
    const html = ctx.detalhesConteudo.innerHTML;
    assert.match(html, new RegExp(`<img src="${fotos[2]}" alt="Aviador - foto 3 de 3"`));
    assert.match(html, /3\/3/);
    assert.equal(html.match(/mostrarFotoDetalhes\(\d\)" class="flex-shrink-0/g).length, 3);
    assert.match(html, /aria-current="true"/);
    assert.equal(ctx.fotoCard[1], 2);

    ctx.mostrarFotoDetalhes(3);
    assert.match(ctx.detalhesConteudo.innerHTML, new RegExp(`<img src="${fotos[0]}"`));
  });

  it('detalhes de encomenda mostram o sinal e o botão de encomendar pela maleta', () => {
    const { ctx } = vitrine([{ ...produto, disponibilidade: 'SOB_ENCOMENDA' }]);
    ctx.detalhes = { id: 1, indice: 0 };
    ctx.renderizarDetalhes();
    assert.match(ctx.detalhesConteudo.innerHTML, /50% sinal \+ 50% na entrega/);
    assert.match(ctx.detalhesConteudo.innerHTML, /toggleMaleta\(1\)/);
    assert.match(ctx.detalhesConteudo.innerHTML, /Encomendar \(adicionar à Maleta\)/);
    assert.doesNotMatch(ctx.detalhesConteudo.innerHTML, /encomendarProduto/);
  });
});
