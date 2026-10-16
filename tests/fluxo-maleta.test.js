// Achados do teste ponta a ponta (cliente monta a maleta -> admin faz o acerto):
// número do WhatsApp sem o 55, vitrine que continuava mostrando a maleta cheia
// depois de finalizar, e o "Enviar resumo" do acerto que perdia o número da cliente.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ler = (arquivo) => fs.readFileSync(path.join(__dirname, '..', ...arquivo.split('/')), 'utf8');

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

for (const arquivo of ['index.html', 'admin/index.html']) {
  describe(`${arquivo}: sanitizeWhatsapp`, () => {
    const ctx = vm.createContext({ String });
    vm.runInContext(`${extrairFuncao(ler(arquivo), 'sanitizeWhatsapp')}\nthis.f = sanitizeWhatsapp;`, ctx);

    it('põe o 55 em celular e fixo brasileiros digitados só com DDD', () => {
      assert.equal(ctx.f('(11) 98888-7777'), '5511988887777');
      assert.equal(ctx.f('11 3333-4444'), '551133334444');
      assert.equal(ctx.f('55 98888-7777'), '5555988887777'); // DDD 55 (RS) sem o código do país
    });

    it('mantém número que já vem com o código do país', () => {
      assert.equal(ctx.f('+55 (11) 98888-7777'), '5511988887777');
      assert.equal(ctx.f('551133334444'), '551133334444');
    });

    it('vazio continua vazio', () => {
      assert.equal(ctx.f(''), '');
      assert.equal(ctx.f(null), '');
    });
  });
}

describe('vitrine: finalizar pedido', () => {
  const html = ler('index.html');
  const inicio = html.indexOf("finalizarPedido.addEventListener('click'");
  const handler = html.slice(inicio, html.indexOf('\n    });', inicio));

  it('zera o contador e os botões dos cards depois de esvaziar a maleta', () => {
    const limpa = handler.indexOf('maleta = { itens: [] }');
    assert.ok(limpa > 0);
    assert.ok(handler.indexOf('atualizarMaletaUI()', limpa) > limpa);
    assert.ok(handler.indexOf('renderizarCatalogo()', limpa) > limpa);
  });

  it('abre o WhatsApp na mesma aba quando o navegador bloqueia a nova', () => {
    assert.match(handler, /if \(!window\.open\(url, '_blank'\)\) window\.location\.href = url;/);
  });
});

describe('admin: acerto', () => {
  const html = ler('admin/index.html');

  it('o "Enviar resumo" depois de salvar reaproveita o WhatsApp digitado', () => {
    const ctx = vm.createContext({});
    const campos = { resumoMaletaTitulo: {}, resumoMaletaTexto: {}, resumoMaletaTelefone: { value: '' } };
    ctx.document = { getElementById: (id) => campos[id] };
    ctx.abrirModalSimples = () => {};
    vm.runInContext(`${extrairFuncao(html, 'abrirResumoMaleta')}\nthis.f = abrirResumoMaleta;`, ctx);
    ctx.f('Fechamento do acerto', 'texto', '11988887777');
    assert.equal(campos.resumoMaletaTelefone.value, '11988887777');
    campos.resumoMaletaTelefone.value = 'digitado';
    ctx.f('Conferência da maleta', 'texto');
    assert.equal(campos.resumoMaletaTelefone.value, 'digitado');
    assert.match(html, /abrirResumoMaleta\('Fechamento do acerto', resumo, telefone\)/);
  });

  it('o título do topo acompanha a aba aberta', () => {
    assert.match(html, /getElementById\('pageTitle'\)\.textContent = tab\.textContent\.trim\(\)/);
  });
});
