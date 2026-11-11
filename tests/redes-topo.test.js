// Botões de WhatsApp e Instagram logo abaixo do título da vitrine. O WhatsApp usa o
// número de pedidos (Configurações > Geral) e o Instagram vem de Dados da loja; cada
// botão só aparece quando a loja tem o dado.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const { montarLoja, lerInstagram, renderizarPagina } = require('../loja');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const admin = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

function lojaDaPagina(pagina) {
  const m = pagina.match(/<script>window\.LOJA = (\{.*?\});<\/script>/);
  assert.ok(m, 'window.LOJA na página');
  return JSON.parse(m[1]);
}

describe('Botões de WhatsApp e Instagram no topo', () => {
  it('lerInstagram aceita @, usuário ou link do perfil; recusa o que o Instagram não aceita', () => {
    assert.equal(lerInstagram('@NixGlasses'), 'nixglasses');
    assert.equal(lerInstagram(' nix.glasses_ '), 'nix.glasses_');
    assert.equal(lerInstagram('https://www.instagram.com/nixglasses/?hl=pt-br'), 'nixglasses');
    assert.equal(lerInstagram('instagram.com/nixglasses'), 'nixglasses');
    assert.equal(lerInstagram(''), '');
    assert.equal(lerInstagram(undefined), '');
    assert.equal(lerInstagram('nix glasses'), null);
    assert.equal(lerInstagram('<script>'), null);
    assert.equal(lerInstagram('.nix'), null);
    assert.equal(lerInstagram('a'.repeat(31)), null);
    assert.equal(lerInstagram(12), null);
  });

  it('montarLoja leva o Instagram e o WhatsApp (só dígitos) para window.LOJA', () => {
    const loja = montarLoja({ slug: 'nix', padrao: true }, [
      { chave: 'loja_instagram', valor: 'nixglasses' },
      { chave: 'whatsapp_number', valor: '55 (11) 99999-0000' },
    ]);
    assert.equal(loja.instagram, 'nixglasses');
    assert.equal(loja.whatsapp, '5511999990000');
    const publico = lojaDaPagina(renderizarPagina('<html><head></head><body></body></html>', loja));
    assert.equal(publico.instagram, 'nixglasses');
    assert.equal(publico.whatsapp, '5511999990000');
    const vazia = montarLoja({ slug: 'outra', nome: 'Outra' }, []);
    assert.equal(vazia.instagram, '');
    assert.equal(vazia.whatsapp, '');
  });

  it('vitrine: os botões ficam logo abaixo do título, escondidos até ter o dado', () => {
    const titulo = html.indexOf('data-loja="chamada"');
    const redes = html.indexOf('id="redesTopo"');
    const descricao = html.indexOf('data-loja="descricao"');
    assert.ok(titulo > 0 && titulo < redes && redes < descricao, 'entre o título e o texto de baixo');
    assert.match(html, /<div id="redesTopo" class="redes-topo hidden/);
    assert.match(html, /<a id="topoWhatsapp"[^>]*class="btn-rede btn-rede-whatsapp hidden"/);
    assert.match(html, /<a id="topoInstagram"[^>]*class="btn-rede btn-rede-instagram hidden"/);
    assert.match(html, /'https:\/\/www\.instagram\.com\/' \+ ig \+ '\/'/);
    assert.match(html, /'https:\/\/wa\.me\/' \+ n \+ '\?text='/);
    assert.match(html, /window\.ligarWhatsappTopo\(whatsappNumero\)/, 'o número que chega depois também liga o botão');
  });

  it('vitrine: "Ver coleção" fica na mesma linha do WhatsApp e mostra a linha', () => {
    const redes = html.indexOf('id="redesTopo"');
    const colecao = html.indexOf('id="heroColecao"');
    const zap = html.indexOf('id="topoWhatsapp"');
    assert.ok(redes < colecao && colecao < zap, 'dentro de #redesTopo, antes do WhatsApp');
    assert.match(html, /<a href="#catalogo" id="heroColecao" class="btn-rede btn-rede-colecao hidden"/);
    assert.match(html, /getElementById\('heroColecao'\)\.classList\.remove\('hidden'\);\s*document\.getElementById\('redesTopo'\)\.classList\.remove\('hidden'\)/);
  });

  it('painel: campo Instagram em Dados da loja, salvo junto com os outros', () => {
    assert.match(admin, /<input type="text" id="loja_instagram" data-campo-loja="instagram"/);
  });
});

describe('API: Instagram e WhatsApp do topo', () => {
  let srv;
  let token;
  const limpar = () => h.pool.query(`DELETE FROM configuracoes WHERE chave = 'loja_instagram'`);

  before(async () => {
    await limpar();
    srv = await h.iniciarServidor();
    token = await h.login(srv);
  });
  after(async () => {
    await srv.parar();
    await limpar();
    await h.fecharBanco();
  });

  async function enviar(metodo, caminho, body) {
    const res = await fetch(srv.url(caminho), {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
  const pagina = async () => lojaDaPagina(await (await fetch(srv.url('/'))).text());

  it('salva o Instagram, recusa inválido e vazio tira o botão', async () => {
    assert.equal((await pagina()).instagram, '');
    assert.equal((await enviar('PUT', '/api/admin/loja', { instagram: 'nix glasses' })).status, 400);
    const salvo = await enviar('PUT', '/api/admin/loja', { instagram: 'https://instagram.com/NixGlasses/' });
    assert.equal(salvo.status, 200);
    assert.equal(salvo.body.instagram, 'nixglasses');
    assert.equal((await pagina()).instagram, 'nixglasses');
    // Salvar outro campo sem o Instagram não apaga
    await enviar('PUT', '/api/admin/loja', { chamada: 'Outra chamada' });
    assert.equal((await pagina()).instagram, 'nixglasses');
    await enviar('PUT', '/api/admin/loja', { instagram: '' });
    assert.equal((await pagina()).instagram, '');
  });

  it('trocar o número do WhatsApp já muda o botão do topo', async () => {
    await pagina(); // dados da loja em cache
    assert.equal((await enviar('POST', '/api/config/whatsapp', { whatsapp: '5511912345678' })).status, 200);
    assert.equal((await pagina()).whatsapp, '5511912345678');
  });
});
