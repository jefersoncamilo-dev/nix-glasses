// Detalhes do produto na vitrine: WhatsApp em todas as disponibilidades e Compartilhar
// com o link direto do produto (?produto=<id>), que abre os detalhes ao entrar.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extrairFuncao(nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}
function carregar(funcoes, globais) {
  const ctx = vm.createContext({ promocaoFiltro: 0, anuncios: [], ...globais, Intl, Number, String, Math, URLSearchParams });
  vm.runInContext(`${funcoes.map(extrairFuncao).join('\n')}\n${funcoes.map(f => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

const DETALHES = ['ordemTamanho', 'agruparCards', 'variaPorCor', 'coresCard', 'botoesCor', 'promocaoDoGrupo', 'htmlSeloPromocao', 'nomeModelo', 'grupoDoProduto', 'botoesTamanho', 'escapeHtml', 'fotosDoProduto', 'fotoProvador', 'indiceCircular', 'ehSobEncomenda', 'calcularSinal', 'linkWhatsappEncomenda', 'precoDe', 'precoAntes', 'etiquetaProduto', 'especificacoesProduto', 'renderizarDetalhes'];
const produto = (extra) => ({ id: 7, nome: 'NIX Fossil Polarizado Redondo', codigo_sku: 'NIX-F', preco_venda: '169.90', status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA', fotos: [], grade: '', ...extra });

function detalhesDe(p, whatsappNumero = '5511999990000') {
  const detalhesConteudo = { innerHTML: '' };
  const ctx = carregar(DETALHES, {
    NICHO: 'oculos', rotulos: { formato: 'Formato da lente', material: 'Material', tipo: 'Tipo' }, ORDEM_TAMANHOS: [],
    produtos: [p], maleta: { itens: [] }, detalhes: { id: 7, indice: 0 }, detalhesConteudo, whatsappNumero,
    location: { protocol: 'https:', origin: 'https://loja.exemplo' },
    formatarMoeda: v => `R$ ${v}`, fecharDetalhes: () => assert.fail('fechou'),
  });
  ctx.renderizarDetalhes();
  return detalhesConteudo.innerHTML;
}

describe('detalhes do produto: WhatsApp e Compartilhar', () => {
  it('pronta entrega e condicional ganham o botão de WhatsApp com o link do produto', () => {
    for (const extra of [{}, { status: 'CONDICIONAL' }]) {
      const h = detalhesDe(produto(extra));
      const link = /data-whatsapp-produto href="([^"]+)"/.exec(h);
      assert.ok(link, 'botão de WhatsApp');
      assert.match(decodeURIComponent(link[1]), /\*NIX Fossil Polarizado Redondo\*[\s\S]*https:\/\/loja\.exemplo\/\?produto=7/);
      assert.match(h, /data-compartilhar onclick="compartilharProduto\(7\)"/);
      assert.ok(h.indexOf('data-compartilhar') > h.indexOf('data-whatsapp-produto'), 'Compartilhar logo abaixo do WhatsApp');
    }
  });

  it('encomenda mantém o WhatsApp do aviso (sem repetir) e também compartilha', () => {
    const h = detalhesDe(produto({ disponibilidade: 'SOB_ENCOMENDA' }));
    assert.match(h, /data-whatsapp-encomenda/);
    assert.doesNotMatch(h, /data-whatsapp-produto/);
    assert.match(h, /data-compartilhar/);
    // logo abaixo do WhatsApp do aviso, antes das cores e do botão da maleta
    assert.ok(h.indexOf('data-compartilhar') > h.indexOf('data-whatsapp-encomenda'));
    assert.ok(h.indexOf('data-compartilhar') < h.indexOf('btn-maleta'));
  });

  it('loja sem número de WhatsApp: só o Compartilhar', () => {
    const h = detalhesDe(produto(), '');
    assert.doesNotMatch(h, /data-whatsapp/);
    assert.match(h, /data-compartilhar/);
  });
});

describe('link direto do produto', () => {
  it('linkDoProduto monta /?produto=<id>', () => {
    const ctx = carregar(['linkDoProduto'], {});
    assert.equal(ctx.linkDoProduto({ id: 218 }, 'https://nixglasses.temcatalogo.com.br'), 'https://nixglasses.temcatalogo.com.br/?produto=218');
    assert.equal(ctx.linkDoProduto(null, 'x'), '');
  });

  it('?produto=<id> abre os detalhes uma vez e limpa a barra (mantém UTMs)', () => {
    const abertos = [];
    const trocas = [];
    const ctx = carregar(['abrirProdutoDaUrl'], {
      produtos: [{ id: 218, codigo_sku: 'NIX-BEU-RAP-AZUL' }],
      location: { search: '?produto=218&utm_source=whatsapp', pathname: '/', hash: '' },
      history: { state: null, replaceState: (s, t, url) => trocas.push(url) },
      abrirDetalhes: id => abertos.push(id),
      mostrarToast: () => assert.fail('não devia avisar'),
    });
    vm.runInContext('var produtoDaUrlAberto = false;', ctx);
    ctx.abrirProdutoDaUrl();
    ctx.abrirProdutoDaUrl();
    assert.deepEqual(abertos, [218]);
    assert.deepEqual(trocas, ['/?utm_source=whatsapp']);
  });

  it('produto que saiu da vitrine: avisa em vez de abrir', () => {
    const avisos = [];
    const ctx = carregar(['abrirProdutoDaUrl'], {
      produtos: [], location: { search: '?produto=999', pathname: '/', hash: '' },
      history: { state: null, replaceState() {} }, abrirDetalhes: () => assert.fail('abriu'), mostrarToast: (m) => avisos.push(m),
    });
    vm.runInContext('var produtoDaUrlAberto = false;', ctx);
    ctx.abrirProdutoDaUrl();
    assert.equal(avisos.length, 1);
  });
});
