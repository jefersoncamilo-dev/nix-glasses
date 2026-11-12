// Chave do Provador Virtual (Configurações > Dados da loja): desligada, a vitrine
// esconde o card do topo, o pop-up e o botão "Provar virtualmente". As fotos ficam.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('./helpers');
const { montarLoja } = require('../loja');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const admin = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

function extrairFuncao(fonte, nome) {
  const inicio = fonte.search(new RegExp(`function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = fonte.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (fonte[i] === '{') nivel++;
    else if (fonte[i] === '}' && --nivel === 0) return fonte.slice(inicio, i + 1);
  }
}

describe('Provador Virtual ligado/desligado', () => {
  it('montarLoja: ligado por padrão; loja_provador = 0 desliga', () => {
    const nix = { slug: 'nix', padrao: true };
    assert.equal(montarLoja(nix, []).provador, true);
    assert.equal(montarLoja(nix, [{ chave: 'loja_provador', valor: '1' }]).provador, true);
    assert.equal(montarLoja(nix, [{ chave: 'loja_provador', valor: '0' }]).provador, false);
    assert.equal(montarLoja(nix, [{ chave: 'loja_provador', valor: '0' }]).oculos, true, 'continua loja de óculos');
  });

  it('vitrine: provadorLigado só com loja de óculos e a chave ligada', () => {
    const ctx = vm.createContext({});
    vm.runInContext(`${extrairFuncao(html, 'provadorLigado')}\nthis.provadorLigado = provadorLigado;`, ctx);
    const ligado = ctx.provadorLigado;
    assert.equal(ligado(undefined), true, 'sem window.LOJA segue como antes');
    assert.equal(ligado({ oculos: true, provador: true }), true);
    assert.equal(ligado({ oculos: true }), true);
    assert.equal(ligado({ oculos: true, provador: false }), false);
    assert.equal(ligado({ oculos: false, provador: true }), false);
  });

  it('vitrine: card, pop-up, botão dos detalhes e a câmera respeitam a chave', () => {
    assert.match(html, /if \(!provadorLigado\(\)\) \{\s*document\.getElementById\('bannerProvador'\)\.classList\.add\('hidden'\);\s*document\.getElementById\('heroColecao'\)\.classList\.remove\('hidden'\);/);
    assert.match(html, /devePopupProvador\(window\.innerWidth, provadorLigado\(\),/);
    assert.match(html, /\$\{fotoProvador\(produto\) && provadorLigado\(\) \? `<button[^`]*Provar virtualmente/);
    assert.match(extrairFuncao(html, 'abrirProvador'), /^function abrirProvador\(produtoId\) \{\s*if \(!provadorLigado\(\)\) return;/);
  });

  it('painel: a chave fica em Dados da loja, só na loja de óculos', () => {
    assert.match(admin, /<div data-so-nicho="oculos">\s*<label[^>]*>\s*<input type="checkbox" id="loja_provador"/);
    assert.match(admin, /if \(corpo\.nicho === 'oculos'\) corpo\.provador = document\.getElementById\('loja_provador'\)\.checked;/);
  });
});

describe('API: salvar a chave do Provador Virtual', () => {
  let srv;
  let token;
  const limpar = () => h.pool.query(`DELETE FROM configuracoes WHERE chave IN ('loja_provador', 'loja_nicho', 'loja_oculos')`);

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

  async function salvar(body) {
    const res = await fetch(srv.url('/api/admin/loja'), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('desliga, a vitrine recebe provador:false; religa e volta', async () => {
    assert.equal((await salvar({ provador: 'nao' })).status, 400);
    const desligado = await salvar({ provador: false });
    assert.equal(desligado.status, 200);
    assert.equal(desligado.body.provador, false);
    assert.equal(desligado.body.oculos, true);
    let pagina = await (await fetch(srv.url('/'))).text();
    assert.match(pagina, /window\.LOJA = \{[^}]*"provador":false[,}]/);
    // Salvar outros dados sem mandar a chave não religa
    assert.equal((await salvar({ chamada: 'Nova chamada' })).body.provador, false);
    const ligado = await salvar({ provador: true });
    assert.equal(ligado.body.provador, true);
    pagina = await (await fetch(srv.url('/'))).text();
    assert.match(pagina, /window\.LOJA = \{[^}]*"provador":true[,}]/);
    await h.pool.query(`DELETE FROM configuracoes WHERE chave = 'loja_chamada'`);
  });
});
