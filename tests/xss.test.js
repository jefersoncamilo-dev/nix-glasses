// Regressão do XSS armazenado (auditoria 4.5): nome, SKU, formato etc. de um
// produto chegam ao innerHTML da vitrine e do painel. Rodamos as funções de
// renderização das próprias páginas num DOM mínimo e conferimos que o HTML
// cadastrado sai como texto.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PAYLOAD = '"><img src=x onerror=alert(1)>';

// Copia `function nome(...) { ... }` do HTML contando chaves.
function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

function carregar(arquivo, funcoes, globais) {
  const html = fs.readFileSync(path.join(__dirname, '..', ...arquivo.split('/')), 'utf8');
  const fonte = funcoes.map(f => extrairFuncao(html, f)).join('\n');
  const ctx = vm.createContext({ ...globais, Intl, Number, String });
  vm.runInContext(`${fonte}\n${funcoes.map(f => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

function elemento() {
  return {
    innerHTML: '',
    value: '',
    textContent: '',
    filhos: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(f) { this.filhos.push(f); },
    get html() { return this.innerHTML + this.filhos.map(f => f.innerHTML).join(''); },
  };
}

function produtoMalicioso(extra = {}) {
  return {
    id: 7,
    nome: PAYLOAD,
    codigo_sku: PAYLOAD,
    sku: PAYLOAD,
    formato: PAYLOAD,
    estilo: PAYLOAD,
    cor_armacao: PAYLOAD,
    status: 'CONDICIONAL',
    imagem_url: `x" onerror="alert(1)`,
    preco_venda: 100,
    preco_custo: 50,
    vezes_em_maleta: 3,
    ...extra,
  };
}

// Olha só as tags de verdade: tira o onerror legítimo da página e os valores
// entre aspas; sobrando qualquer onerror, o payload virou atributo ou tag.
function semInjecao(html) {
  assert.ok(html.length > 0, 'nada foi renderizado');
  for (const tag of html.match(/<[^>]*>/g)) {
    const resto = tag.replace(/onerror="imgFallback\(this\)"/g, '').replace(/"[^"]*"/g, '""');
    assert.doesNotMatch(resto, /onerror|<img src=x/i, tag);
  }
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
}

describe('vitrine (index.html) escapa dados de produto', () => {
  it('no catálogo', () => {
    const catalogoGrid = elemento();
    const ctx = carregar('index.html', ['escapeHtml', 'renderizarCatalogo'], {
      produtos: [produtoMalicioso()],
      maleta: { itens: [] },
      filtroStatus: elemento(),
      filtroFormato: elemento(),
      catalogoGrid,
      emptyState: elemento(),
      formatarMoeda: v => `R$ ${v}`,
      document: { createElement: elemento },
    });
    ctx.renderizarCatalogo();
    semInjecao(catalogoGrid.html);
  });

  it('na maleta guardada no navegador', () => {
    const maletaItens = elemento();
    const ctx = carregar('index.html', ['escapeHtml', 'atualizarMaletaUI'], {
      maleta: { itens: [{ id: 7, nome: PAYLOAD, preco: 100, imagem: `x" onerror="alert(1)` }] },
      maletaVazia: elemento(),
      maletaItens,
      maletaFormulario: elemento(),
      maletaFooter: elemento(),
      maletaTotal: elemento(),
      formatarMoeda: v => `R$ ${v}`,
      document: { getElementById: elemento },
    });
    ctx.atualizarMaletaUI();
    semInjecao(maletaItens.html);
  });
});

describe('painel (admin/index.html) escapa dados de produto', () => {
  const formatarMoeda = v => `R$ ${v}`;

  it('na tabela de produtos', () => {
    const tabelaProdutos = elemento();
    const ctx = carregar('admin/index.html', ['escapeHtml', 'renderizarTabela'], {
      todosProdutos: [produtoMalicioso({ status: PAYLOAD })],
      filtroStatusAdmin: elemento(),
      filtroFormatoAdmin: elemento(),
      buscaAdmin: elemento(),
      tabelaProdutos,
      emptyProdutos: elemento(),
      formatarMoeda,
      statusClass: () => '',
    });
    ctx.renderizarTabela();
    semInjecao(tabelaProdutos.innerHTML);
  });

  it('no ranking de métricas', async () => {
    const tbody = elemento();
    const ctx = carregar('admin/index.html', ['escapeHtml', 'carregarMetricas'], {
      fetchAdmin: async () => ({
        ok: true,
        json: async () => ({ totalEstoque: 1, valorInvestido: 1, lucroPotencial: 1, valorEmRua: 1, topAdicionadosMaleta: [produtoMalicioso()] }),
      }),
      document: { getElementById: id => (id === 'tabelaTopMaleta' ? tbody : elemento()) },
      formatarMoeda,
      mostrarToast: (m) => assert.fail(m),
      console,
    });
    await ctx.carregarMetricas();
    semInjecao(tbody.innerHTML);
  });

  it('nas listas do acerto', () => {
    const compradosList = elemento();
    const devolvidosList = elemento();
    const ctx = carregar('admin/index.html', ['escapeHtml', 'renderizarListasAcerto'], {
      todosProdutos: [produtoMalicioso()],
      compradosList,
      devolvidosList,
      formatarMoeda,
    });
    ctx.renderizarListasAcerto();
    semInjecao(compradosList.innerHTML);
    semInjecao(devolvidosList.innerHTML);
  });
});

describe('acerto (admin/acerto.html) escapa dados de produto', () => {
  it('no checklist', () => {
    const productsChecklist = elemento();
    const ctx = carregar('admin/acerto.html', ['escapeHtml', 'renderProductsChecklist'], {
      filteredProducts: [produtoMalicioso()],
      allProducts: [produtoMalicioso()],
      productsChecklist,
      finishSection: elemento(),
      loadChecklist: () => [],
      addCheckboxListeners() {},
      updateCounts() {},
    });
    ctx.renderProductsChecklist();
    semInjecao(productsChecklist.innerHTML);
  });
});
