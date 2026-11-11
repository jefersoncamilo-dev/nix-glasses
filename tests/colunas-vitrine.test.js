// Produtos por linha na vitrine (Configurações > Dados da loja): um número para o
// celular (1 a 4, padrão 3) e outro para o computador (2 a 6, padrão 4).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const { montarLoja, colunasVitrine, lerColunas, renderizarPagina } = require('../loja');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const admin = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

describe('Produtos por linha na vitrine', () => {
  const nix = { slug: 'nix', padrao: true };

  it('montarLoja: padrão 3 no celular e 4 no computador; valores fora da faixa voltam ao padrão', () => {
    const padrao = montarLoja(nix, []);
    assert.equal(padrao.colunas_celular, 3);
    assert.equal(padrao.colunas_computador, 4);
    const salvo = montarLoja(nix, [{ chave: 'loja_colunas_celular', valor: '2' }, { chave: 'loja_colunas_computador', valor: '5' }]);
    assert.equal(salvo.colunas_celular, 2);
    assert.equal(salvo.colunas_computador, 5);
    const ruim = montarLoja(nix, [{ chave: 'loja_colunas_celular', valor: '9' }, { chave: 'loja_colunas_computador', valor: 'x' }]);
    assert.equal(ruim.colunas_celular, 3);
    assert.equal(ruim.colunas_computador, 4);
    assert.equal(montarLoja({ slug: 'outra', nome: 'Outra Loja' }, []).colunas_celular, 3);
  });

  it('lerColunas: celular 1 a 4, computador 2 a 6', () => {
    assert.equal(lerColunas('celular', 1), 1);
    assert.equal(lerColunas('celular', 4), 4);
    assert.equal(lerColunas('celular', 5), null);
    assert.equal(lerColunas('celular', 0), null);
    assert.equal(lerColunas('celular', 2.5), null);
    assert.equal(lerColunas('computador', 1), null);
    assert.equal(lerColunas('computador', 6), 6);
    assert.equal(lerColunas('computador', 7), null);
    assert.equal(lerColunas('computador', '3'), 3);
  });

  it('tablet usa o do celular, no mínimo 3 e no máximo o do computador', () => {
    assert.deepEqual(colunasVitrine({ colunas_celular: 3, colunas_computador: 4 }), { celular: 3, tablet: 3, computador: 4 });
    assert.deepEqual(colunasVitrine({ colunas_celular: 1, colunas_computador: 5 }), { celular: 1, tablet: 3, computador: 5 });
    assert.deepEqual(colunasVitrine({ colunas_celular: 4, colunas_computador: 6 }), { celular: 4, tablet: 4, computador: 6 });
    assert.deepEqual(colunasVitrine({ colunas_celular: 2, colunas_computador: 2 }), { celular: 2, tablet: 2, computador: 2 });
  });

  it('a página sai com as colunas da loja no <head>', () => {
    const loja = montarLoja(nix, [{ chave: 'loja_colunas_celular', valor: '2' }]);
    const pagina = renderizarPagina('<html><head></head><body><div id="catalogoGrid"></div></body></html>', loja);
    assert.match(pagina, /--colunas-celular: 2; --colunas-tablet: 3; --colunas-computador: 4;/);
    assert.doesNotMatch(renderizarPagina('<html><head></head><body></body></html>', loja), /--colunas-/, 'só a vitrine ganha');
    assert.doesNotMatch(pagina, /selo-card/, 'selo normal com 2 por linha');
    const quatro = montarLoja(nix, [{ chave: 'loja_colunas_celular', valor: '4' }]);
    assert.match(renderizarPagina('<html><head></head><body><div id="catalogoGrid"></div></body></html>', quatro), /#catalogoGrid \.selo-card \{ font-size: 7px;/, 'selo menor com 4 no celular');
  });

  it('vitrine: a grade usa as variáveis, com 3 e 4 quando faltam', () => {
    assert.match(html, /<div id="catalogoGrid" class="grid gap-2 sm:gap-5">/);
    assert.match(html, /#catalogoGrid \{ grid-template-columns: repeat\(var\(--colunas-celular, 3\), minmax\(0, 1fr\)\); \}/);
    assert.match(html, /@media \(min-width: 640px\) \{ #catalogoGrid \{ grid-template-columns: repeat\(var\(--colunas-tablet, 3\)/);
    assert.match(html, /@media \(min-width: 1024px\) \{ #catalogoGrid \{ grid-template-columns: repeat\(var\(--colunas-computador, 4\)/);
  });

  it('painel: os dois campos ficam em Dados da loja e vão no salvar', () => {
    assert.match(admin, /<select id="loja_colunas_celular"[\s\S]*?<option value="1">1 produto<\/option>[\s\S]*?<option value="3">3 produtos \(padrão\)<\/option>[\s\S]*?<option value="4">4 produtos<\/option>\s*<\/select>/);
    assert.match(admin, /<select id="loja_colunas_computador"[\s\S]*?<option value="2">2 produtos<\/option>[\s\S]*?<option value="4">4 produtos \(padrão\)<\/option>[\s\S]*?<option value="6">6 produtos<\/option>\s*<\/select>/);
    assert.match(admin, /corpo\.colunas_celular = Number\(document\.getElementById\('loja_colunas_celular'\)\.value\);/);
    assert.match(admin, /corpo\.colunas_computador = Number\(document\.getElementById\('loja_colunas_computador'\)\.value\);/);
  });
});

describe('API: salvar produtos por linha', () => {
  let srv;
  let token;
  const limpar = () => h.pool.query(`DELETE FROM configuracoes WHERE chave IN ('loja_colunas_celular', 'loja_colunas_computador', 'loja_chamada')`);

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

  it('recusa fora da faixa, salva e a vitrine já sai com as colunas', async () => {
    let pagina = await (await fetch(srv.url('/'))).text();
    assert.match(pagina, /--colunas-celular: 3; --colunas-tablet: 3; --colunas-computador: 4;/, 'loja que nunca mexeu continua igual');
    assert.equal((await salvar({ colunas_celular: 5 })).status, 400);
    assert.equal((await salvar({ colunas_computador: 1 })).status, 400);
    assert.equal((await salvar({ colunas_celular: 'dois' })).status, 400);
    const salvo = await salvar({ colunas_celular: 2, colunas_computador: 5 });
    assert.equal(salvo.status, 200);
    assert.equal(salvo.body.colunas_celular, 2);
    assert.equal(salvo.body.colunas_computador, 5);
    pagina = await (await fetch(srv.url('/'))).text();
    assert.match(pagina, /--colunas-celular: 2; --colunas-tablet: 3; --colunas-computador: 5;/);
    // Salvar outros dados sem mandar as colunas não muda nada
    const outro = await salvar({ chamada: 'Nova chamada' });
    assert.equal(outro.body.colunas_celular, 2);
    assert.equal(outro.body.colunas_computador, 5);
  });
});
