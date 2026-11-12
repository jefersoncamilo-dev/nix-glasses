// Pedido do fornecedor: leitura do PDF (texto, itens e fotos), lançamento no
// estoque (produto novo, reposição, acessórios), proteção contra lançar duas vezes,
// relatórios por pedido e por produto, e as funções da tela no painel.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { lerPedidoTexto, lerDescricao, lerPedidoPdf } = require('../pedido-fornecedor');
const h = require('./helpers');

// ---------- PDF de teste, montado à mão (sem dados de pedido real) ----------
// Cada item: descrição em uma ou duas linhas, "xN", o valor na linha de baixo e uma
// foto 40x40 do lado, como na página do pedido da Nuvemshop.
function montarPdf(paginas) {
  const objetos = [];
  const add = (conteudo) => { objetos.push(conteudo); return objetos.length; };
  const fonte = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const rgb = Buffer.alloc(40 * 40 * 3, 0);
  for (let i = 0; i < rgb.length; i += 3) rgb[i] = 200; // vermelho
  const imagem = add({ dict: '<< /Type /XObject /Subtype /Image /Width 40 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8', dados: rgb });
  const paginasIds = [];
  const idPaginas = objetos.length + 1 + paginas.length * 2;
  for (const pagina of paginas) {
    const ops = [];
    for (const t of pagina.textos) {
      const texto = t.s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/•/g, '\\225');
      ops.push(`BT /F1 9 Tf ${t.x || 96} ${t.y} Td (${texto}) Tj ET`);
    }
    for (const y of pagina.fotos || []) ops.push(`q 67 0 0 67 30 ${y} cm /Im1 Do Q`);
    const stream = Buffer.from(ops.join('\n'), 'latin1');
    const conteudo = add({ dict: '<<', dados: stream });
    paginasIds.push(add(`<< /Type /Page /Parent ${idPaginas} 0 R /MediaBox [0 0 595 842] /Contents ${conteudo} 0 R /Resources << /Font << /F1 ${fonte} 0 R >> /XObject << /Im1 ${imagem} 0 R >> >> >>`));
  }
  assert.equal(add(`<< /Type /Pages /Kids [${paginasIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${paginasIds.length} >>`), idPaginas);
  const catalogo = add(`<< /Type /Catalog /Pages ${idPaginas} 0 R >>`);
  const partes = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let tamanho = partes[0].length;
  objetos.forEach((o, i) => {
    const corpo = typeof o === 'string'
      ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict} /Length ${o.dados.length} >>\nstream\n`, 'latin1'), o.dados, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    offsets.push(tamanho);
    partes.push(corpo);
    tamanho += corpo.length;
  });
  const xref = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objetos.length + 1} /Root ${catalogo} 0 R >>\nstartxref\n${tamanho}\n%%EOF\n`;
  return Buffer.concat([...partes, Buffer.from(xref, 'latin1')]);
}

const PDF_TESTE = () => montarPdf([
  { textos: [{ s: 'Pedido #20001', y: 780 }, { s: 'Data:', x: 323, y: 700 }, { s: '05/11/2026', x: 343, y: 700 }] },
  {
    textos: [
      { s: 'Endereço de Envio:', x: 323, y: 760 },
      { s: 'Fulana de Tal', x: 114, y: 750 }, { s: 'Rua Teste 1', x: 114, y: 740 }, { s: '+5511999990000', x: 114, y: 730 },
      { s: 'Óculos de Sol Vogue • XFG976 •Metal • Oval', y: 640 }, { s: '• Acetato x2', y: 630 }, { s: 'R$59,80', x: 240, y: 620 },
      { s: 'Óculos de Sol Nero • XFG • 50610 • Gatinho x1', y: 540 }, { s: 'R$16,90', x: 240, y: 530 },
      { s: 'KIT COM 10 ESTOJOS • CORES VARIADAS x1', y: 440 }, { s: 'R$39,00', x: 240, y: 430 },
      { s: 'ESTOJO + FLANELA para cada óculos comprado x1', y: 340 }, { s: 'R$0,00', x: 240, y: 330 },
    ],
    fotos: [638, 538, 438],
  },
  { textos: [{ s: 'Frete (Correios): Grátis', x: 286, y: 400 }, { s: 'Desconto (CUPOM): - R$5,00', x: 400, y: 380 }, { s: 'Subtotal: R$115,70', x: 420, y: 360 }, { s: 'Total: R$110,70', x: 403, y: 340 }] },
]);

describe('leitura do pedido', () => {
  it('lê descrição, código (mesmo quebrado em pedaços) e especificações', () => {
    const d = lerDescricao('Óculos de Sol Groove • XFG • D • 805 • Metal • Oval • Tendência');
    assert.equal(d.modelo, 'Groove');
    assert.equal(d.codigo, 'XFG-D-805');
    assert.equal(d.formato, 'Oval');
    assert.equal(d.material, 'Metal');
    assert.equal(lerDescricao('Óculos de Sol Nero • XFG • 50610 • Gatinho').codigo, 'XFG50610');
    assert.equal(lerDescricao('Óculos de Sol Solano • S • 70 • Masculino').codigo, 'S-70');
    const p = lerDescricao('Óculos de Sol Cruise 2.0 • 722 • POLARIZADO METAL • AVIADOR');
    assert.deepEqual([p.modelo, p.codigo, p.tipo, p.material, p.formato], ['Cruise 2.0', '722', 'Polarizado', 'Metal', 'Aviador']);
    assert.equal(lerDescricao('Óculos de Sol Eco Wood • XFG2205 • Bambu • Polarizado • Unissex').genero, 'UNISSEX');
  });

  it('lê o formato da Clush: sem código, com cor e material depois do hífen, tudo em maiúsculas', () => {
    const d = lerDescricao('ÓCULOS DE SOL AVIADOR GOLD - MARROM DEGRADÊ/DOURADO - METAL');
    assert.deepEqual([d.modelo, d.codigo, d.cor, d.material, d.formato], ['Aviador Gold', '', 'Marrom Degradê/Dourado', 'Metal', 'Aviador']);
    const p = lerDescricao('ÓCULOS DE SOL PREMIUM POLARIZADO TIFF - CAMUFLADO - ACETATO');
    assert.deepEqual([p.cor, p.material, p.tipo], ['Camuflado', 'Acetato', 'Polarizado']);
    assert.equal(lerDescricao('ÓCULOS DE SOL PREMIUM HEXAGONAL SNAKE - PRETO DOURADO - METAL E ACETATO').material, 'Metal / Acetato');
    const linhas = ['Pedido #56543', 'Data: 02/03/2026', 'PRODUTOS', 'TAXA DE GRAVAÇÃO - ENVIE O LOGO PELO', 'WHATSAPP X 1', 'R$ 50,00',
      'ÓCULOS DE SOL OCTOGONAL ONCE -', 'PRETO/PRATA - ACETATO X2', 'R$ 39,80'].map((texto, i) => ({ texto, pagina: 1, y: 800 - i * 10 }));
    const pedido = lerPedidoTexto(linhas);
    assert.deepEqual(pedido.itens.map((i) => [i.descricao, i.quantidade, i.preco_unitario, i.oculos]), [
      ['TAXA DE GRAVAÇÃO - ENVIE O LOGO PELO WHATSAPP', 1, 50, false], ['ÓCULOS DE SOL OCTOGONAL ONCE - PRETO/PRATA - ACETATO', 2, 19.9, true],
    ]);
  });

  it('separa os itens do texto, com custo unitário e sem o endereço', () => {
    const linhas = [
      'Pedido #14563', 'Data: 09/11/2025', 'Estado: Finalizado', 'Endereço de Envio:', 'Fulana', 'Rua X 1', 'Cidade, 00000', 'Brasil', '+5546999990000',
      'Óculos de Sol Tucs • XFG07196 • UNISSEX', 'x1', 'R$16,90',
      'Óculos de Sol Harper•XFG59090• Unissex •', 'Quadrado x2', 'R$33,80',
      'Frete (Correios - PAC (via Melhor Envio)): Grátis', 'Desconto (CUPOM): - R$35,90', 'Subtotal: R$50,70', 'Total: R$14,80',
    ].map((texto, i) => ({ texto, pagina: 1, y: 800 - i * 10 }));
    const p = lerPedidoTexto(linhas);
    assert.equal(p.numero, '14563');
    assert.equal(p.data, '09/11/2025');
    assert.deepEqual([p.subtotal, p.desconto, p.frete, p.total], [50.7, 35.9, 0, 14.8]);
    assert.equal(p.frete_descricao, 'Correios - PAC (via Melhor Envio)');
    assert.equal(p.itens.length, 2);
    assert.equal(p.itens[0].descricao, 'Óculos de Sol Tucs • XFG07196 • UNISSEX');
    assert.equal(p.itens[1].quantidade, 2);
    assert.equal(p.itens[1].preco_unitario, 16.9);
    assert.equal(p.itens[1].codigo, 'XFG59090');
    assert.ok(!JSON.stringify(p).includes('Fulana'));
  });

  it('lê o PDF: itens, fotos ao lado de cada item, total e o que não é óculos', async () => {
    const p = await lerPedidoPdf(PDF_TESTE());
    assert.equal(p.numero, '20001');
    assert.equal(p.data, '05/11/2026');
    assert.equal(p.subtotal, 115.7);
    assert.deepEqual(p.itens.map((i) => [i.codigo, i.quantidade, i.preco_unitario, i.oculos]), [
      ['XFG976', 2, 29.9, true], ['XFG50610', 1, 16.9, true], ['', 1, 39, false], ['', 1, 0, false],
    ]);
    assert.ok(p.itens.slice(0, 3).every((i) => /^data:image\/png;base64,iVBOR/.test(i.foto)));
    assert.equal(p.itens[3].foto, null);
    assert.ok(!JSON.stringify(p).includes('Fulana'));
  });
});

// ---------- API ----------
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

async function api(method, p, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(srv.url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

const linhaProduto = (sku, extra = {}) => ({ nome: `Nix ${sku}`, codigo_sku: sku, preco_custo: 20, preco_venda: 120, ...extra });

describe('API: ler o PDF', () => {
  it('devolve os itens do PDF e não grava nada', async () => {
    const fd = new FormData();
    fd.append('pdf', new Blob([PDF_TESTE()], { type: 'application/pdf' }), 'pedido.pdf');
    const res = await fetch(srv.url('/api/admin/pedidos-fornecedor/ler'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    assert.equal(res.status, 200);
    const p = await res.json();
    assert.equal(p.itens.length, 4);
    assert.equal(Number((await h.pool.query('SELECT count(*) FROM produtos')).rows[0].count), 0);
  });

  it('recusa o que não é PDF e exige login', async () => {
    const fd = new FormData();
    fd.append('pdf', new Blob(['não sou pdf']), 'x.pdf');
    const res = await fetch(srv.url('/api/admin/pedidos-fornecedor/ler'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    assert.equal(res.status, 400);
    const semLogin = await fetch(srv.url('/api/admin/pedidos-fornecedor/ler'), { method: 'POST', body: new FormData() });
    assert.equal(semLogin.status, 401);
  });
});

describe('API: totais do pedido (frete, desconto, subtotal, total)', () => {
  it('guarda os totais no lançamento, mostra na lista e deixa corrigir depois', async () => {
    const r = await api('POST', '/api/admin/pedidos-fornecedor', {
      fornecedor: 'Tassia', numero: '16511', data: '21/03/2026', produtos: [linhaProduto('T-1', { quantidade: 2, preco_custo: 134 })],
      totais: { frete_descricao: 'Nuvem Envio - Jadlog Econômico', frete: '20,45', desconto: '- R$ 26,80', subtotal: 268, total: '261,65' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.totais.frete, r.body.totais.desconto, r.body.totais.subtotal, r.body.totais.total], [20.45, 26.8, 268, 261.65]);
    // Pedido lançado antes desta versão (sem totais): aparece com os totais vazios
    await api('POST', '/api/admin/produtos/lote', { produtos: [linhaProduto('T-2', { fornecedor: 'Clush', quantidade: 1, pedido_fornecedor: '68670' })] });
    let lista = (await api('GET', '/api/admin/pedidos-fornecedor')).body;
    const tassia = lista.find((p) => p.numero === '16511');
    assert.deepEqual([tassia.frete_descricao, tassia.frete, tassia.desconto, tassia.subtotal, tassia.total, tassia.valor], ['Nuvem Envio - Jadlog Econômico', 20.45, 26.8, 268, 261.65, 268]);
    const clush = lista.find((p) => p.numero === '68670');
    assert.deepEqual([clush.total, clush.frete_descricao], [null, '']);

    const corrigido = await api('PUT', '/api/admin/pedidos-fornecedor/totais', { fornecedor: 'clush', numero: '68670', totais: { frete: 18.27, desconto: 50, subtotal: 282, total: 250.27 } });
    assert.equal(corrigido.status, 200, JSON.stringify(corrigido.body));
    lista = (await api('GET', '/api/admin/pedidos-fornecedor')).body;
    assert.equal(lista.find((p) => p.numero === '68670').total, 250.27);
    // Corrigir de novo atualiza a mesma linha
    await api('PUT', '/api/admin/pedidos-fornecedor/totais', { fornecedor: 'Clush', numero: '68670', totais: { total: 250 } });
    assert.equal(Number((await h.pool.query('SELECT count(*) FROM pedidos_fornecedor')).rows[0].count), 2);
    assert.equal((await api('GET', '/api/admin/pedidos-fornecedor')).body.find((p) => p.numero === '68670').total, 250);

    assert.equal((await api('PUT', '/api/admin/pedidos-fornecedor/totais', { fornecedor: 'Clush', numero: '68670', totais: { frete: 'abc' } })).status, 400);
    assert.equal((await api('PUT', '/api/admin/pedidos-fornecedor/totais', { fornecedor: 'Clush', totais: {} })).status, 400);
    const ruim = await api('POST', '/api/admin/pedidos-fornecedor', { fornecedor: 'Tassia', numero: '9', produtos: [linhaProduto('T-9')], totais: { total: 'x' } });
    assert.equal(ruim.status, 400);
    assert.equal(Number((await h.pool.query(`SELECT count(*) FROM produtos WHERE codigo_sku = 'T-9'`)).rows[0].count), 0);
  });
});

describe('API: lançar o pedido', () => {
  it('cria os novos, repõe os que já existem e lança os acessórios, tudo com o nº do pedido', async () => {
    const existente = await api('POST', '/api/admin/produtos/lote', { produtos: [linhaProduto('NIX-VOG-BRO-BLK', { fornecedor: 'Tassia', codigo_fornecedor: 'XFG976', quantidade: 1, pedido_fornecedor: '14563', data_compra: '09/11/2025' })] });
    assert.equal(existente.status, 201);
    const estojo = (await h.pool.query(`INSERT INTO acessorios (nome, preco_venda, estoque) VALUES ('Estojo', 10, 3) RETURNING id`)).rows[0];

    const r = await api('POST', '/api/admin/pedidos-fornecedor', {
      fornecedor: 'Tassia', numero: '20001', data: '05/11/2026',
      produtos: [
        linhaProduto('NIX-VOG-BRO-BLK', { quantidade: 2, preco_custo: 29.9 }),
        linhaProduto('NIX-VOG-BRO-BRW', { codigo_fornecedor: 'XFG976-BRW', cor_armacao: 'Marrom', quantidade: 1, preco_custo: 29.9 }),
        linhaProduto('NIX-VOG-BRO-BRW', { codigo_fornecedor: 'XFG976-BRW', cor_armacao: 'Marrom', quantidade: 3, preco_custo: 29.9 }),
      ],
      acessorios: [
        { id: estojo.id, quantidade: 10, preco_custo: 3.9 },
        { nome: 'Flanela', quantidade: 5, preco_custo: 1, preco_venda: 5 },
      ],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.produtos.length, 1);
    assert.equal(r.body.produtos[0].fornecedor, 'Tassia');
    assert.deepEqual(r.body.repostos.map((x) => [x.codigo_sku, x.quantidade, x.estoque]), [['NIX-VOG-BRO-BLK', 2, 3], ['NIX-VOG-BRO-BRW', 3, 4]]);
    assert.deepEqual(r.body.acessorios.map((a) => [a.nome, a.estoque, a.novo]), [['Estojo', 13, false], ['Flanela', 5, true]]);

    const compras = (await h.pool.query(`SELECT p.codigo_sku, c.origem, c.quantidade, c.pedido_fornecedor, to_char(c.data_compra, 'DD/MM/YYYY') AS data
                                          FROM compras_fornecedor c JOIN produtos p ON p.id = c.produto_id WHERE c.pedido_fornecedor = '20001' ORDER BY c.id`)).rows;
    assert.deepEqual(compras.map((c) => [c.codigo_sku, c.origem, c.quantidade, c.data]), [
      ['NIX-VOG-BRO-BLK', 'REPOSICAO', 2, '05/11/2026'], ['NIX-VOG-BRO-BRW', 'CADASTRO', 1, '05/11/2026'], ['NIX-VOG-BRO-BRW', 'REPOSICAO', 3, '05/11/2026'],
    ]);
    const custoEstojo = (await h.pool.query('SELECT preco_custo FROM acessorios WHERE id = $1', [estojo.id])).rows[0];
    assert.equal(Number(custoEstojo.preco_custo), 3.9);

    // Relatório: pedidos lançados
    const pedidos = await api('GET', '/api/admin/pedidos-fornecedor');
    assert.deepEqual(pedidos.body.map((p) => [p.numero, p.pecas, p.novos, p.reposicoes, p.acessorios]), [['20001', 21, 1, 2, 2], ['14563', 1, 1, 0, 0]]);
    assert.equal(pedidos.body[0].valor, Math.round((6 * 29.9 + 10 * 3.9 + 5) * 100) / 100);

    // Itens do pedido, com quantas vezes cada um já foi comprado
    const itens = await api('GET', '/api/admin/pedidos-fornecedor/itens?numero=20001&fornecedor=tassia');
    const preto = itens.body.find((i) => i.codigo_sku === 'NIX-VOG-BRO-BLK');
    assert.equal(preto.origem, 'REPOSICAO');
    assert.equal(preto.pedidos, 2);
    assert.equal(preto.pecas_compradas, 3);
    assert.ok(itens.body.some((i) => i.tipo === 'acessorio' && i.nome === 'Flanela'));

    // Compras por produto
    const porProduto = await api('GET', '/api/admin/compras/produtos');
    const linhaPreto = porProduto.body.find((p) => p.codigo_sku === 'NIX-VOG-BRO-BLK');
    assert.deepEqual([linhaPreto.pecas, linhaPreto.reposicoes, linhaPreto.pedidos], [3, 1, 2]);
    assert.deepEqual([...linhaPreto.numeros_pedidos].sort(), ['14563', '20001']);
    assert.equal(linhaPreto.custo_ultimo, 29.9);
  });

  it('não lança o mesmo pedido duas vezes, a não ser que peça', async () => {
    const corpo = { fornecedor: 'Tassia', numero: '777', produtos: [linhaProduto('A-1', { quantidade: 1 })] };
    assert.equal((await api('POST', '/api/admin/pedidos-fornecedor', corpo)).status, 201);
    const de_novo = await api('POST', '/api/admin/pedidos-fornecedor', { ...corpo, fornecedor: 'TASSIA' });
    assert.equal(de_novo.status, 409);
    assert.equal(de_novo.body.ja_lancado, true);
    assert.equal(Number((await h.pool.query(`SELECT estoque FROM produtos WHERE codigo_sku = 'A-1'`)).rows[0].estoque), 1);
    const forcado = await api('POST', '/api/admin/pedidos-fornecedor', { ...corpo, forcar: true });
    assert.equal(forcado.status, 201);
    assert.equal(forcado.body.repostos[0].estoque, 2);
    // Outro fornecedor com o mesmo número é outro pedido
    assert.equal((await api('POST', '/api/admin/pedidos-fornecedor', { ...corpo, fornecedor: 'Outro' })).status, 201);
  });

  it('é tudo ou nada: linha com erro não lança nada e diz qual é', async () => {
    const r = await api('POST', '/api/admin/pedidos-fornecedor', {
      fornecedor: 'Tassia', numero: '888',
      produtos: [linhaProduto('B-1'), linhaProduto('B-2', { preco_venda: 'abc' })],
      acessorios: [{ nome: '', quantidade: 1 }],
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.erros.some((e) => e.linha === 1 && e.campo === 'preco_venda'));
    assert.ok(r.body.erros.some((e) => e.acessorio === 0 && e.campo === 'nome'));
    assert.equal(Number((await h.pool.query('SELECT count(*) FROM produtos')).rows[0].count), 0);
    assert.equal((await api('POST', '/api/admin/pedidos-fornecedor', { fornecedor: 'Tassia', produtos: [linhaProduto('B-1')] })).status, 400);
    // Acessório que não existe desfaz o resto
    const semAcessorio = await api('POST', '/api/admin/pedidos-fornecedor', { fornecedor: 'Tassia', numero: '889', produtos: [linhaProduto('B-3')], acessorios: [{ id: 999, quantidade: 1 }] });
    assert.equal(semAcessorio.status, 400);
    assert.equal(Number((await h.pool.query('SELECT count(*) FROM produtos')).rows[0].count), 0);
  });
});

// ---------- Painel: funções da tela Pedido do fornecedor ----------
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
const funcoes = ['lerTotaisDigitados', 'totalPagoPedidoForn', 'somarPedidosForn', 'lerPreco', 'lerDataCompra', 'precoVendaPadrao', 'proximoSku', 'nomeCurtoDino', 'nomeTematico', 'semAcentoPf', 'normalizarCodigoForn',
  'candidatosDoItem', 'itemPedidoForn', 'recalcularItensPedidoForn', 'montarLancamentoPedidoForn'];
const ctx = vm.createContext({ Number, String, Math, Map, Set, Object, Date });
const j = (v) => JSON.parse(JSON.stringify(v));
vm.runInContext(`const ACRESCIMO_VENDA = 100;\n${funcoes.map(extrairFuncao).join('\n')}\n${funcoes.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);

describe('painel: totais dos pedidos', () => {
  it('lê os totais digitados (com sinal de menos e R$) e aponta o inválido', () => {
    const t = j(ctx.lerTotaisDigitados({ frete_descricao: ' Jadlog ', frete: '20,45', desconto: '- R$ 26,80', subtotal: '268,00', total: '' }));
    assert.deepEqual(t.totais, { frete_descricao: 'Jadlog', frete: 20.45, desconto: 26.8, subtotal: 268, total: null });
    assert.equal(ctx.lerTotaisDigitados({ total: 'abc' }).erro, 'Total do pedido inválido');
  });

  it('soma o total geral e por fornecedor; pedido sem totais conta o valor dos itens', () => {
    const r = j(ctx.somarPedidosForn([
      { fornecedor: 'Tassia', pecas: 8, valor: 268, frete: 20.45, desconto: 26.8, subtotal: 268, total: 261.65 },
      { fornecedor: 'tassia', pecas: 2, valor: 50, frete: null, desconto: null, subtotal: null, total: null },
      { fornecedor: 'Clush', pecas: 9, valor: 282, frete: 18.27, desconto: 50, subtotal: 282, total: 250.27 },
    ]));
    assert.equal(r.geral.pedidos, 3);
    assert.equal(r.geral.semTotais, 1);
    assert.equal(Math.round(r.geral.total * 100) / 100, 561.92);
    assert.equal(Math.round(r.geral.frete * 100) / 100, 38.72);
    assert.deepEqual(r.porFornecedor.map((f) => [f.fornecedor, f.pedidos, Math.round(f.total * 100) / 100]), [['Tassia', 2, 311.65], ['Clush', 1, 250.27]]);
  });
});

describe('painel: pedido do fornecedor', () => {
  const produtos = [
    { id: 1, nome: 'Nix Bronto Vogue - Onyx Black / Brown', codigo_sku: 'NIX-VOG-BRO-BLK-BRW', fornecedor: 'Tassia', codigo_fornecedor: 'XFG976-BLK-BRW', preco_venda: '129.90', cor_armacao: 'Preto, lente marrom' },
    { id: 2, nome: 'Nix Bronto Vogue - Onyx Black / Purple', codigo_sku: 'NIX-VOG-BRO-BLK-PRP', fornecedor: 'Tassia', codigo_fornecedor: 'XFG976-BLK-PRP', preco_venda: '129.90' },
    { id: 3, nome: 'Nix Dilo Nero - Onyx Black', codigo_sku: 'NIX-NER-DIL-BLK', fornecedor: '', codigo_fornecedor: 'XFG 50610', preco_venda: '116.90' },
    { id: 4, nome: 'Outro', codigo_sku: 'X-1', fornecedor: 'Outra loja', codigo_fornecedor: 'XFG50610', preco_venda: '10' },
  ];
  const lido = (extra) => ({ descricao: 'Óculos de Sol Vogue • XFG976 • Metal • Oval', modelo: 'Vogue', codigo: 'XFG976', formato: 'Oval', material: 'Metal', quantidade: 1, preco_unitario: 29.9, oculos: true, ...extra });

  it('acha o produto que já existe pelo código, de qualquer cor e sem o fornecedor de outra loja', () => {
    assert.deepEqual(j(ctx.candidatosDoItem({ codigo: 'XFG976' }, produtos, 'tassia').map((p) => p.id)), [1, 2]);
    assert.deepEqual(j(ctx.candidatosDoItem({ codigo: 'XFG-50610' }, produtos, 'Tassia').map((p) => p.id)), [3]);
    assert.deepEqual(j(ctx.candidatosDoItem({ codigo: '' }, produtos, 'Tassia')), []);
  });

  it('sem código (Clush), acha pelo nome na loja do fornecedor e já traz a cor; taxa de gravação fica fora', () => {
    const clush = [{ id: 9, nome: 'Nix Ptero Gold - Mocha Brown Gradient / Gold', codigo_sku: 'NIX-GOL-PTE-BRW-GLD', fornecedor: 'Clush', codigo_fornecedor: 'DJY8Z', nome_fornecedor: 'Óculos de Sol Aviador Gold - Marrom Degradê/Dourado - Metal', preco_venda: '139.90' }];
    const d = { descricao: 'ÓCULOS DE SOL AVIADOR GOLD - MARROM DEGRADÊ/DOURADO - METAL', modelo: 'Aviador Gold', codigo: '', cor: 'Marrom Degradê/Dourado', formato: 'Aviador', quantidade: 2, preco_unitario: 39.9, oculos: true };
    assert.equal(ctx.itemPedidoForn(d, [d], clush, [], 'Clush').destino, 'repor:9');
    const outraCor = { ...d, descricao: 'ÓCULOS DE SOL AVIADOR GOLD - AZUL DEGRADÊ/DOURADO - METAL', cor: 'Azul Degradê/Dourado' };
    const item = ctx.itemPedidoForn(outraCor, [outraCor], clush, [], 'Clush');
    assert.equal(item.destino, 'novo');
    assert.equal(item.cor, 'Azul Degradê/Dourado');
    ctx.recalcularItensPedidoForn([item], clush, 'Clush');
    assert.equal(item.nome, 'Nix Ptero Gold - Ocean Blue Gradient / Gold');
    const taxa = ctx.itemPedidoForn({ descricao: 'TAXA DE GRAVAÇÃO - ENVIE O LOGO', quantidade: 1, preco_unitario: 50, oculos: false }, [], clush, [], 'Clush');
    assert.equal(taxa.destino, 'ignorar');
  });

  it('sugere o destino: novo, reposição (um só igual) ou escolher; acessório; brinde fora', () => {
    const nero = ctx.itemPedidoForn(lido({ codigo: 'XFG50610', modelo: 'Nero' }), [lido({ codigo: 'XFG50610' })], produtos, [], 'Tassia');
    assert.equal(nero.destino, 'repor:3');
    assert.equal(ctx.itemPedidoForn(lido(), [lido()], produtos, [], 'Tassia').destino, '');
    assert.equal(ctx.itemPedidoForn(lido({ codigo: 'NV 560' }), [], produtos, [], 'Tassia').destino, 'novo');
    const estojo = ctx.itemPedidoForn({ descricao: 'KIT COM 100 ESTOJOS • CORES', quantidade: 1, preco_unitario: 239, oculos: false }, [], produtos, [{ id: 7, nome: 'Estojo rígido' }], 'Tassia');
    assert.equal(estojo.destino, 'acessorio:7');
    const flanela = ctx.itemPedidoForn({ descricao: 'Flanela microfibra', quantidade: 3, preco_unitario: 2, oculos: false }, [], produtos, [], 'Tassia');
    assert.equal(flanela.destino, 'acessorio-novo');
    assert.equal(flanela.acessorioNome, 'Flanela microfibra');
    assert.equal(ctx.itemPedidoForn({ descricao: 'Brinde', quantidade: 1, preco_unitario: 0, oculos: false }, [], produtos, [], 'Tassia').destino, 'ignorar');
  });

  it('produto novo ganha nome Nix, SKU, venda e código com a cor; mesma cor repetida soma no mesmo SKU', () => {
    const itens = [lido({ quantidade: 2 }), lido(), lido({ codigo: 'NV 560', modelo: 'Zaya', formato: '' })].map((d) => ctx.itemPedidoForn(d, [], produtos, [], 'Tassia'));
    itens.forEach((i) => { i.destino = 'novo'; });
    itens[0].cor = 'Dourado, lente verde';
    itens[1].cor = 'Dourado, lente verde';
    ctx.recalcularItensPedidoForn(itens, produtos, 'Tassia');
    assert.equal(itens[0].nome, 'Nix Bronto Vogue - Royal Gold / Green');
    assert.equal(itens[0].sku, 'NIX-VOG-BRO-GLD-GRN');
    assert.equal(itens[0].venda, '129,90');
    assert.equal(itens[0].codigoNovo, 'XFG976-GLD-GRN');
    assert.equal(itens[1].sku, itens[0].sku);
    assert.equal(itens[2].codigoNovo, 'NV 560');
    assert.match(itens[2].nome, /^Nix Tricera Zaya/);

    const r = ctx.montarLancamentoPedidoForn(itens, { fornecedor: 'Tassia', numero: '20001', data: '05/11/2026', totais: { frete: '10,00', total: '100,00' } }, produtos, []);
    assert.equal(r.erros, undefined);
    assert.deepEqual(j(r.corpo.totais), { frete_descricao: '', frete: 10, desconto: null, subtotal: null, total: 100 });
    assert.deepEqual(j(r.corpo.produtos.map((p) => [p.codigo_sku, p.quantidade, p.preco_custo, p.codigo_fornecedor])), [
      ['NIX-VOG-BRO-GLD-GRN', 2, 29.9, 'XFG976-GLD-GRN'], ['NIX-VOG-BRO-GLD-GRN', 1, 29.9, 'XFG976-GLD-GRN'], [itens[2].sku, 1, 29.9, 'NV 560'],
    ]);
  });

  it('monta a reposição com o SKU do produto e os acessórios; aponta o que falta escolher', () => {
    const itens = [lido(), lido(), { descricao: 'Estojo', quantidade: '10', custo: '3,90', destino: 'acessorio:7' }, { descricao: 'Brinde', destino: 'ignorar' }]
      .map((d, k) => (k < 2 ? ctx.itemPedidoForn(d, [], produtos, [], 'Tassia') : { quantidade: '1', custo: '0', ...d }));
    itens[0].destino = 'repor:2';
    const falta = ctx.montarLancamentoPedidoForn(itens, { numero: '1' }, produtos, [{ id: 7, nome: 'Estojo' }]);
    assert.equal(falta.erros.get(1), 'Escolha como lançar este item');
    itens[1].destino = 'ignorar';
    const r = ctx.montarLancamentoPedidoForn(itens, { fornecedor: 'Tassia', numero: '1' }, produtos, [{ id: 7, nome: 'Estojo' }]);
    assert.deepEqual(j(r.corpo.produtos.map((p) => [p.codigo_sku, p.preco_venda, p.quantidade])), [['NIX-VOG-BRO-BLK-PRP', 129.9, 1]]);
    assert.deepEqual(j(r.corpo.acessorios), [{ id: 7, preco_custo: 3.9, quantidade: 10 }]);
    assert.deepEqual(j(r.origem), { produtos: [0], acessorios: [2] });
    assert.equal(ctx.montarLancamentoPedidoForn(itens, { numero: '' }, produtos, []).erros.get(-1), 'Informe o número do pedido');
  });
});

describe('banco: totais dos pedidos antigos (lidos dos PDFs)', () => {
  it('preenche só os pedidos que existem na loja, no fornecedor certo, sem sobrescrever', async () => {
    const { initTables } = require('../db');
    await api('POST', '/api/admin/produtos/lote', { produtos: [
      linhaProduto('S-1', { fornecedor: 'Tassia Nunes Atacado', quantidade: 1, pedido_fornecedor: '16511' }),
      linhaProduto('S-2', { fornecedor: '', quantidade: 1, pedido_fornecedor: '16511' }),
      linhaProduto('S-3', { fornecedor: 'Clush', quantidade: 1, pedido_fornecedor: '68670' }),
      linhaProduto('S-4', { fornecedor: 'Outra', quantidade: 1, pedido_fornecedor: '15074' }),
    ] });
    await h.pool.query(`INSERT INTO pedidos_fornecedor (fornecedor, numero, total) VALUES ('Clush', '68670', 999)`);
    await initTables(h.pool);
    const { rows } = await h.pool.query('SELECT fornecedor, numero, total::float, frete_descricao FROM pedidos_fornecedor ORDER BY numero');
    assert.deepEqual(rows.map((r) => [r.fornecedor, r.numero, r.total]), [['Tassia Nunes Atacado', '16511', 261.65], ['Clush', '68670', 999]]);
    assert.equal(rows[0].frete_descricao, 'Nuvem Envio - Jadlog Econômico');
  });
});
