// Relatório de estoque na tela de Produtos: totais da lista filtrada (peças,
// produtos, valor investido, valor de venda, lucro potencial), planilha e
// impressão. A conta é a mesma das Métricas (Sob Encomenda fora dos valores).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('./helpers');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

function extrairFuncao(nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

const fonte = [
  html.match(/const formatarMoeda = .*;/)[0],
  html.match(/const ROTULO_STATUS_RELATORIO = .*;/)[0],
  html.match(/const rotuloDisponibilidade = .*;/)[0],
  ...['escapeHtml', 'pecasRelatorio', 'valoresRelatorio', 'totaisRelatorioEstoque', 'descreverFiltrosRelatorio',
    'csvRelatorioEstoque', 'notaEncomendasRelatorio', 'htmlImpressaoRelatorio'].map(extrairFuncao),
].join('\n');
const ctx = vm.createContext({ Intl });
vm.runInContext(`${fonte}\nthis.f = { totaisRelatorioEstoque, descreverFiltrosRelatorio, csvRelatorioEstoque, htmlImpressaoRelatorio };`, ctx);
const f = ctx.f;

const prod = (extra) => ({ nome: 'Nix Raptor', codigo_sku: 'NIX-1', preco_custo: '50.00', preco_venda: '139.90', estoque: 2, em_maleta: 0,
  status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA', formato: 'Oval', fornecedor: 'Tassia', ...extra });

describe('painel: totais do relatório de estoque', () => {
  it('a tela de Produtos tem o quadro de totais, a planilha e o imprimir', () => {
    assert.match(html, /<div id="relatorioEstoque"/);
    for (const id of ['totalRelProdutos', 'totalRelPecas', 'totalRelInvestido', 'totalRelVenda', 'totalRelLucro', 'btnExportarRelatorio', 'btnImprimirRelatorio']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    // o quadro fica dentro da aba Produtos (mesma permissão da tela)
    const aba = html.slice(html.indexOf('<div id="tab-produtos"'), html.indexOf('<!-- Aba Cadastro em Lote -->'));
    assert.match(aba, /id="relatorioEstoque"/);
    assert.match(html, /atualizarRelatorioEstoque\(filtrados\);/);
  });

  it('soma peças da loja e das maletas, custo, venda e lucro (sem erro de centavos)', () => {
    const t = f.totaisRelatorioEstoque([
      prod({ estoque: 2, em_maleta: 1 }),
      prod({ preco_custo: '0.10', preco_venda: '0.20', estoque: 3 }),
      prod({ estoque: 0, em_maleta: 0, status: 'ESGOTADO' }),
    ]);
    assert.equal(t.produtos, 3);
    assert.deepEqual([t.pecas, t.pecasLoja, t.pecasMaleta], [6, 5, 1]);
    assert.equal(t.investido, 150.3);
    assert.equal(t.venda, 420.3);
    assert.equal(t.lucro, 270);
  });

  it('Sob Encomenda: estoque do cadastro fica fora dos valores; peça em maleta conta', () => {
    const t = f.totaisRelatorioEstoque([
      prod({ disponibilidade: 'SOB_ENCOMENDA', estoque: 5, em_maleta: 0 }),
      prod({ disponibilidade: 'SOB_ENCOMENDA', estoque: 5, em_maleta: 1 }),
    ]);
    assert.deepEqual([t.produtos, t.pecas, t.encomendas], [2, 1, 2]);
    assert.equal(t.investido, 50);
    assert.equal(t.lucro, 89.9);
  });

  it('lista vazia dá zero', () => {
    const t = f.totaisRelatorioEstoque([]);
    assert.deepEqual([t.produtos, t.pecas, t.investido, t.venda, t.lucro], [0, 0, 0, 0, 0]);
  });

  it('descreve os filtros em uso', () => {
    assert.equal(f.descreverFiltrosRelatorio({}), 'Todos os produtos');
    assert.equal(f.descreverFiltrosRelatorio({ status: 'Disponível', disponibilidade: '', formato: 'Oval', fornecedor: 'Tassia', busca: 'nix' }),
      'Filtros: Disponível • Oval • Tassia • busca "nix"');
  });

  it('planilha: ; e vírgula decimal, linha de total no fim, sem fórmula', () => {
    const csv = f.csvRelatorioEstoque([prod({ estoque: 2, em_maleta: 1 }), prod({ nome: '=HYPERLINK("x")', codigo_sku: 'NIX;2', estoque: 1 })], 'Formato da lente');
    const linhas = csv.trim().split('\r\n');
    assert.equal(linhas.length, 4);
    assert.match(linhas[0], /^Produto;SKU;Fornecedor;Cód\. fornecedor;Formato da lente;/);
    assert.equal(linhas[1], 'Nix Raptor;NIX-1;Tassia;;Oval;;Pronta Entrega;Disponível;2;1;3;50,00;139,90;150,00;419,70;269,70');
    assert.match(linhas[2], /^"'=HYPERLINK\(""x""\)";"NIX;2";/);
    assert.equal(linhas[3], 'TOTAL (2 produtos);;;;;;;;3;1;4;;;200,00;559,60;359,60');
  });

  it('impressão: escapa o texto e traz os totais', () => {
    const out = f.htmlImpressaoRelatorio([prod({ nome: '<b>x</b>' }), prod({ disponibilidade: 'SOB_ENCOMENDA' })], 'Todos os produtos', 'Nix', 'Formato', new Date(2026, 10, 9, 10, 0));
    assert.doesNotMatch(out, /<b>x<\/b>/);
    assert.match(out, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(out, /TOTAL: 2 produtos/);
    assert.match(out, /R\$\s100,00/);
    assert.match(out, /1 produto Sob Encomenda não entra/);
  });
});

describe('relatório de estoque bate com as Métricas', () => {
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

  async function api(method, p, { body, auth = true } = {}) {
    const headers = {};
    if (auth) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const texto = await res.text();
    return { status: res.status, body: texto ? JSON.parse(texto) : null };
  }

  it('todos os produtos: mesmas peças, investido e lucro', async () => {
    const linha = (sku, extra) => ({ nome: `Óculos ${sku}`, codigo_sku: sku, preco_custo: '20.10', preco_venda: '129.90', ...extra });
    const r = await api('POST', '/api/admin/produtos/lote', { body: { produtos: [
      linha('R1', { quantidade: 3 }), linha('R2', { quantidade: 1, preco_custo: '33.33' }), linha('R3', { disponibilidade: 'SOB_ENCOMENDA', quantidade: 2 }),
    ] } });
    assert.equal(r.status, 201);
    const checkout = await api('POST', '/api/maleta/checkout', { auth: false, body: { produtoIds: [r.body.produtos[0].id], contato: { nome: 'Ana', telefone: '11999990000' } } });
    assert.equal((await api('POST', `/api/admin/pedidos/${checkout.body.pedido.id}/enviar-maleta`)).status, 200);

    const produtos = (await api('GET', '/api/admin/produtos')).body;
    const m = (await api('GET', '/api/admin/metrics')).body;
    const t = f.totaisRelatorioEstoque(produtos);
    assert.equal(t.pecasMaleta, 1);
    assert.equal(t.pecas, m.totalEstoque);
    assert.equal(t.investido, m.valorInvestido);
    assert.equal(t.lucro, m.lucroPotencial);
    assert.equal(t.encomendas, m.modelosSobEncomenda);
  });
});
