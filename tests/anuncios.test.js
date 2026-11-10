// Promoções (Configurações > POP Anúncio): anúncios com selo, imagem do pop-up, texto do
// botão e chave Ativo; o produto escolhe a promoção; a vitrine só vê os anúncios ativos e o
// pop-up escolhido para a tela inicial.
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
const produto = (sku, extra = {}) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: '30', preco_venda: '99.90', formato: 'Aviador', estoque: '2', ...extra });

async function novoAnuncio(campos = {}, arquivos = { selo: png(1), imagem: png(2) }) {
  const r = await enviar('POST', '/api/admin/anuncios', { nome: 'Black Friday', botao_texto: 'Ver ofertas', ...campos }, arquivos);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

describe('API: anúncios (POP Anúncio)', () => {
  it('cria com selo, imagem e botão; o painel lista com a contagem de produtos', async () => {
    const a = await novoAnuncio();
    assert.equal(a.nome, 'Black Friday');
    assert.equal(a.botao_texto, 'Ver ofertas');
    assert.equal(a.ativo, true);
    assert.match(a.selo_url, /^\/imagens\/[0-9a-f]{32}$/);
    assert.match(a.imagem_url, /^\/imagens\/[0-9a-f]{32}$/);
    const img = await fetch(srv.url(a.selo_url));
    assert.equal(img.status, 200);
    const lista = await api('GET', '/api/admin/anuncios');
    assert.equal(lista.status, 200);
    assert.equal(lista.body.anuncios.length, 1);
    assert.equal(lista.body.anuncios[0].produtos, 0);
    assert.equal(lista.body.popup, 'nenhum', 'sem escolha, a tela inicial fica sem pop-up');
  });

  it('pede o nome, confere a imagem e usa o texto padrão no botão', async () => {
    assert.equal((await enviar('POST', '/api/admin/anuncios', { nome: '  ' })).status, 400);
    const falsa = await enviar('POST', '/api/admin/anuncios', { nome: 'X' }, { selo: Buffer.from('não é imagem nenhuma') });
    assert.equal(falsa.status, 400);
    const a = await novoAnuncio({ botao_texto: '' }, {});
    assert.equal(a.botao_texto, 'Ver produtos da promoção');
    assert.equal(a.selo_url, null);
  });

  it('edita só o que vier, troca a imagem e apaga a antiga', async () => {
    const a = await novoAnuncio();
    const r = await enviar('PUT', `/api/admin/anuncios/${a.id}`, { botao_texto: 'Comprar agora', ativo: 'false' }, { selo: png(9) });
    assert.equal(r.status, 200);
    assert.equal(r.body.nome, 'Black Friday');
    assert.equal(r.body.botao_texto, 'Comprar agora');
    assert.equal(r.body.ativo, false);
    assert.notEqual(r.body.selo_url, a.selo_url);
    assert.equal(r.body.imagem_url, a.imagem_url);
    assert.equal((await fetch(srv.url(a.selo_url))).status, 404, 'selo antigo apagado');
    const sem = await enviar('PUT', `/api/admin/anuncios/${a.id}`, { remover_imagem: 'true' });
    assert.equal(sem.body.imagem_url, null);
    assert.equal((await fetch(srv.url(a.imagem_url))).status, 404);
    assert.equal((await enviar('PUT', '/api/admin/anuncios/999', { nome: 'x' })).status, 404);
  });

  it('produto com promoção: a vitrine vê o anuncio_id só enquanto o anúncio está ativo', async () => {
    const a = await novoAnuncio();
    const criado = await enviar('POST', '/api/produtos', produto('NIX-001', { anuncio_id: String(a.id) }));
    assert.equal(criado.status, 201);
    assert.equal(criado.body.anuncio_id, a.id);
    await enviar('POST', '/api/produtos', produto('NIX-002'));
    let vitrine = (await api('GET', '/api/produtos', undefined, false)).body;
    assert.deepEqual(vitrine.map((p) => [p.codigo_sku, p.anuncio_id]).sort(), [['NIX-001', a.id], ['NIX-002', null]]);
    let pub = (await api('GET', '/api/anuncios', undefined, false)).body;
    assert.deepEqual(pub.anuncios.map((x) => [x.id, x.nome, x.produtos]), [[a.id, 'Black Friday', 1]]);
    assert.equal(pub.anuncios[0].ativo, undefined);

    // inativo: some da vitrine (selo, botão e pop-up), mas o produto continua ligado
    await enviar('PUT', `/api/admin/anuncios/${a.id}`, { ativo: 'false' });
    vitrine = (await api('GET', '/api/produtos', undefined, false)).body;
    assert.ok(vitrine.every((p) => p.anuncio_id === null));
    pub = (await api('GET', '/api/anuncios', undefined, false)).body;
    assert.deepEqual(pub.anuncios, []);
    const admin = (await api('GET', '/api/admin/produtos')).body;
    assert.equal(admin.find((p) => p.codigo_sku === 'NIX-001').anuncio_id, a.id);
  });

  it('editar o produto troca ou tira a promoção, e vale para todas as cores do modelo', async () => {
    const a = await novoAnuncio();
    const b = await novoAnuncio({ nome: 'Dia das Mães' });
    const r = await enviar('POST', '/api/produtos', { ...produto('NIX-010'), cores: [{ cor: 'Preto', estoque: 1 }, { cor: 'Azul', estoque: 1 }], anuncio_id: String(a.id) });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.produtos.map((p) => p.anuncio_id), [a.id, a.id]);
    const [preto, azul] = r.body.produtos;
    await enviar('PUT', `/api/produtos/${preto.id}`, { anuncio_id: String(b.id) });
    let admin = (await api('GET', '/api/admin/produtos')).body;
    assert.equal(admin.find((p) => p.id === azul.id).anuncio_id, b.id, 'a outra cor acompanha');
    await enviar('PUT', `/api/produtos/${azul.id}`, { anuncio_id: '' });
    admin = (await api('GET', '/api/admin/produtos')).body;
    assert.ok(admin.every((p) => p.anuncio_id === null));
    // editar outro campo sem mandar anuncio_id não mexe na promoção
    await enviar('PUT', `/api/produtos/${preto.id}`, { anuncio_id: String(a.id) });
    await enviar('PUT', `/api/produtos/${preto.id}`, { preco_venda: '120' });
    admin = (await api('GET', '/api/admin/produtos')).body;
    assert.equal(admin.find((p) => p.id === preto.id).anuncio_id, a.id);
    assert.equal((await enviar('PUT', `/api/produtos/${preto.id}`, { anuncio_id: '999' })).status, 400);
    assert.equal((await enviar('POST', '/api/produtos', produto('NIX-020', { anuncio_id: 'abc' }))).status, 400);
  });

  it('pop-up da tela inicial: nenhum, provador ou um anúncio ativo com imagem', async () => {
    const a = await novoAnuncio();
    const semImagem = await novoAnuncio({ nome: 'Sem imagem' }, { selo: png(3) });
    assert.equal((await api('PUT', '/api/admin/anuncios/popup', { popup: semImagem.id })).status, 400);
    assert.equal((await api('PUT', '/api/admin/anuncios/popup', { popup: 'qualquer' })).status, 400);
    assert.equal((await api('PUT', '/api/admin/anuncios/popup', { popup: a.id })).status, 200);
    assert.deepEqual((await api('GET', '/api/anuncios', undefined, false)).body.popup, { tipo: 'anuncio', anuncio_id: a.id });
    assert.equal((await api('GET', '/api/admin/anuncios')).body.popup, a.id);
    // inativo: a vitrine fica sem pop-up, mas a escolha continua guardada
    await enviar('PUT', `/api/admin/anuncios/${a.id}`, { ativo: 'false' });
    assert.equal((await api('GET', '/api/anuncios', undefined, false)).body.popup, null);
    await enviar('PUT', `/api/admin/anuncios/${a.id}`, { ativo: 'true' });
    assert.equal((await api('PUT', '/api/admin/anuncios/popup', { popup: 'provador' })).status, 200);
    assert.deepEqual((await api('GET', '/api/anuncios', undefined, false)).body.popup, { tipo: 'provador' });
    assert.equal((await api('PUT', '/api/admin/anuncios/popup', { popup: 'nenhum' })).status, 200);
    assert.equal((await api('GET', '/api/anuncios', undefined, false)).body.popup, null);
  });

  it('excluir: os produtos ficam sem promoção, as imagens saem e o pop-up volta a nenhum', async () => {
    const a = await novoAnuncio();
    const p = (await enviar('POST', '/api/produtos', produto('NIX-030', { anuncio_id: String(a.id) }))).body;
    await api('PUT', '/api/admin/anuncios/popup', { popup: a.id });
    const r = await api('DELETE', `/api/admin/anuncios/${a.id}`);
    assert.equal(r.status, 200);
    assert.equal((await fetch(srv.url(a.selo_url))).status, 404);
    assert.equal((await fetch(srv.url(a.imagem_url))).status, 404);
    const admin = (await api('GET', '/api/admin/produtos')).body;
    assert.equal(admin.find((x) => x.id === p.id).anuncio_id, null);
    assert.equal((await api('GET', '/api/admin/anuncios')).body.popup, 'nenhum');
    assert.equal((await api('DELETE', `/api/admin/anuncios/${a.id}`)).status, 404);
  });

  it('zerar tudo mantém os anúncios e as imagens deles', async () => {
    const a = await novoAnuncio();
    await enviar('POST', '/api/produtos', produto('NIX-040', { anuncio_id: String(a.id) }), { foto1: png(5) });
    const z = await api('POST', '/api/admin/zerar', { confirmacao: 'ZERAR', escopo: 'tudo' });
    assert.equal(z.status, 200);
    assert.equal((await fetch(srv.url(a.selo_url))).status, 200);
    assert.equal((await fetch(srv.url(a.imagem_url))).status, 200);
    assert.equal((await api('GET', '/api/admin/anuncios')).body.anuncios.length, 1);
  });

  it('só quem tem Configurações mexe nos anúncios; Produtos só lê a lista', async () => {
    await h.pool.query('TRUNCATE admin_usuarios RESTART IDENTITY');
    const criar = await api('POST', '/api/admin/usuarios', { nome: 'Cadastro', login: 'cadastro', senha: 'senha-forte-123', permissoes: ['produtos'] });
    assert.equal(criar.status, 201, JSON.stringify(criar.body));
    const entrar = await fetch(srv.url('/api/admin/login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'cadastro', password: 'senha-forte-123' }),
    });
    const t = (await entrar.json()).token;
    const comToken = (method, p, body) => fetch(srv.url(p), {
      method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
    });
    assert.equal((await comToken('GET', '/api/admin/anuncios')).status, 200);
    assert.equal((await comToken('PUT', '/api/admin/anuncios/popup', { popup: 'nenhum' })).status, 403);
    assert.equal((await comToken('DELETE', '/api/admin/anuncios/1')).status, 403);
    assert.equal((await api('POST', '/api/admin/anuncios', { nome: 'x' }, false)).status, 401);
    await h.pool.query('TRUNCATE admin_usuarios RESTART IDENTITY');
  });
});

// Vitrine: funções puras do index.html (selo do card, botões das promoções e pop-up)
describe('vitrine: promoções', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  function extrairFuncao(nome) {
    const inicio = html.search(new RegExp(`function ${nome}\\(`));
    assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
    let i = html.indexOf('{', inicio);
    for (let nivel = 0; ; i++) {
      if (html[i] === '{') nivel++;
      else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
    }
  }
  const FUNCOES = ['escapeHtml', 'promocaoDoGrupo', 'htmlSeloPromocao', 'promocoesComModelos', 'anuncioDoPopup'];
  const ctx = vm.createContext({});
  vm.runInContext(`${FUNCOES.map(extrairFuncao).join('\n')}\n${FUNCOES.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);
  const lista = [
    { id: 1, nome: 'Black <b>Friday</b>', selo_url: '/imagens/aa', imagem_url: '/imagens/bb', botao_texto: 'Ver' },
    { id: 2, nome: 'Sem selo', selo_url: null, imagem_url: null, botao_texto: 'Ver' },
  ];

  it('o card pega a promoção do modelo e mostra o selo em imagem (ou o nome, sem imagem)', () => {
    assert.equal(ctx.promocaoDoGrupo([{ id: 9, anuncio_id: null }, { id: 10, anuncio_id: 1 }], lista).id, 1);
    assert.equal(ctx.promocaoDoGrupo([{ id: 9, anuncio_id: 7 }], lista), null, 'promoção inativa não vem na lista');
    const img = ctx.htmlSeloPromocao(lista[0]);
    assert.match(img, /^<img data-selo-promocao="1" src="\/imagens\/aa" alt="Promoção: Black &lt;b&gt;Friday&lt;\/b&gt;"/);
    assert.match(ctx.htmlSeloPromocao(lista[1]), /<span data-selo-promocao="2" class="selo-promocao-texto[^"]*"[^>]*>Sem selo<\/span>/);
    assert.equal(ctx.htmlSeloPromocao(null), '');
  });

  it('botões da tela inicial só para promoções com modelo na vitrine; pop-up só com imagem', () => {
    assert.deepEqual(ctx.promocoesComModelos(lista, [{ anuncio_id: 2 }, { anuncio_id: null }]).map((a) => a.id), [2]);
    assert.equal(ctx.anuncioDoPopup({ tipo: 'anuncio', anuncio_id: 1 }, lista).id, 1);
    assert.equal(ctx.anuncioDoPopup({ tipo: 'anuncio', anuncio_id: 2 }, lista), null);
    assert.equal(ctx.anuncioDoPopup({ tipo: 'provador' }, lista), null);
    assert.equal(ctx.anuncioDoPopup(null, lista), null);
  });

  it('o catálogo filtra pela promoção e o pop-up do anúncio fecha pelo Voltar', () => {
    assert.match(html, /if \(promocaoFiltro && Number\(p\.anuncio_id\) !== promocaoFiltro\) return false;/);
    assert.match(html, /popupAnuncio: \(\) => fecharPopupAnuncio\(\)/);
    const popup = html.match(/<div id="popupAnuncio"[\s\S]*?id="agoraNaoPopupAnuncio"[^>]*>/);
    assert.ok(popup, 'faltou o pop-up do anúncio');
    for (const parte of ['role="dialog"', 'aria-modal="true"', 'id="fecharPopupAnuncio"', 'id="imgPopupAnuncio"', 'id="botaoPopupAnuncio"']) assert.ok(popup[0].includes(parte), parte);
    assert.match(html, /<div id="promocoesVitrine" class="hidden/);
  });
});
