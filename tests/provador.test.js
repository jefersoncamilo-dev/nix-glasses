// Provador Virtual da vitrine: a matemática que leva os pontos do rosto (Face Landmarker)
// à posição/tamanho/inclinação da armação, a suavização, o preparo da foto (fundo
// removido + recorte) e o desenho no canvas. Câmera e MediaPipe só existem no navegador,
// então aqui testamos as funções puras da própria index.html num contexto isolado.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

function carregar(funcoes, globais = {}) {
  const ctx = vm.createContext({ ...globais });
  vm.runInContext(`${funcoes.map((f) => extrairFuncao(HTML, f)).join('\n')}\n${funcoes.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

const { calcularPoseOculos, suavizarPose, prepararPixelsOculos, desenharOculos } =
  carregar(['calcularPoseOculos', 'suavizarPose', 'prepararPixelsOculos', 'desenharOculos']);

const perto = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

// Rosto de frente num vídeo 1000x500: olhos em y=0,4, têmporas a 0,3 de distância, nariz no meio
function rosto({ inclinar = 0 } = {}) {
  const p = [];
  const centro = { x: 0.5, y: 0.4 };
  const girar = (x, y) => {
    // gira em pixels (o vídeo não é quadrado) e volta para 0..1
    const dx = (x - centro.x) * 1000, dy = (y - centro.y) * 500;
    return {
      x: centro.x + (dx * Math.cos(inclinar) - dy * Math.sin(inclinar)) / 1000,
      y: centro.y + (dx * Math.sin(inclinar) + dy * Math.cos(inclinar)) / 500,
    };
  };
  p[33] = girar(0.42, 0.4);
  p[263] = girar(0.58, 0.4);
  p[127] = girar(0.35, 0.4);
  p[356] = girar(0.65, 0.4);
  p[168] = girar(0.5, 0.4);
  return p;
}

describe('Provador: calcularPoseOculos', () => {
  it('centraliza no dorso do nariz e usa a largura entre as têmporas', () => {
    const pose = calcularPoseOculos(rosto(), 1000, 500);
    perto(pose.x, 500, 'x');
    perto(pose.y, 200, 'y');
    perto(pose.largura, 300, 'largura');
    perto(pose.angulo, 0, 'ângulo');
  });

  it('acompanha a inclinação da cabeça e mantém a largura', () => {
    const pose = calcularPoseOculos(rosto({ inclinar: 0.3 }), 1000, 500);
    perto(pose.angulo, 0.3, 'ângulo');
    perto(pose.largura, 300, 'largura');
    perto(pose.x, 500, 'x');
    perto(pose.y, 200, 'y');
  });

  it('sem as têmporas, estima a largura pela distância entre os olhos', () => {
    const p = rosto();
    delete p[127];
    const pose = calcularPoseOculos(p, 1000, 500);
    perto(pose.largura, 160 * 1.45, 'largura');
  });

  it('aplica escala e desce a armação na direção do rosto inclinado', () => {
    const reto = calcularPoseOculos(rosto(), 1000, 500, { escala: 1.1, deslocamentoY: 0.1 });
    perto(reto.largura, 330, 'largura');
    perto(reto.x, 500, 'x');
    perto(reto.y, 200 + 33, 'y');

    const a = Math.PI / 2; // cabeça deitada de lado: "para baixo" do rosto vira -x na imagem
    const deitado = calcularPoseOculos(rosto({ inclinar: a }), 1000, 500, { deslocamentoY: 0.1 });
    perto(deitado.x, 500 - 30, 'x');
    perto(deitado.y, 200, 'y');
  });

  it('devolve null sem rosto ou sem os pontos essenciais', () => {
    assert.equal(calcularPoseOculos(undefined, 1000, 500), null);
    assert.equal(calcularPoseOculos([], 1000, 500), null);
    assert.equal(calcularPoseOculos(rosto(), 0, 500), null);
    const p = rosto();
    delete p[168];
    assert.equal(calcularPoseOculos(p, 1000, 500), null);
  });
});

describe('Provador: suavizarPose', () => {
  it('mistura com o quadro anterior pelo fator', () => {
    const s = suavizarPose({ x: 0, y: 0, largura: 100, angulo: 0 }, { x: 10, y: 20, largura: 200, angulo: 0.2 }, 0.5);
    perto(s.x, 5, 'x');
    perto(s.y, 10, 'y');
    perto(s.largura, 150, 'largura');
    perto(s.angulo, 0.1, 'ângulo');
  });

  it('usa a pose nova quando não há anterior (ou a nova é nula)', () => {
    const nova = { x: 1, y: 2, largura: 3, angulo: 0 };
    assert.equal(suavizarPose(null, nova, 0.5), nova);
    assert.equal(suavizarPose(nova, null, 0.5), null);
  });

  it('mistura o ângulo pelo menor caminho (sem girar a volta toda)', () => {
    const s = suavizarPose({ x: 0, y: 0, largura: 1, angulo: Math.PI - 0.1 }, { x: 0, y: 0, largura: 1, angulo: -Math.PI + 0.1 }, 0.5);
    perto(Math.cos(s.angulo), -1, 'cos do ângulo');
  });
});

// Imagem RGBA de teste: fundo de uma cor, retângulo de outra
function imagem(largura, altura, fundo, desenho = []) {
  const rgba = new Uint8ClampedArray(largura * altura * 4);
  for (let i = 0; i < largura * altura; i++) rgba.set(fundo, i * 4);
  for (const { x, y, w, h, cor } of desenho) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) rgba.set(cor, (yy * largura + xx) * 4);
  }
  return rgba;
}
const alfa = (rgba, largura, x, y) => rgba[(y * largura + x) * 4 + 3];

describe('Provador: prepararPixelsOculos', () => {
  it('apaga o fundo branco e recorta rente à armação', () => {
    const rgba = imagem(20, 10, [255, 255, 255, 255], [{ x: 4, y: 3, w: 12, h: 4, cor: [20, 20, 20, 255] }]);
    const caixa = prepararPixelsOculos(rgba, 20, 10);
    assert.deepEqual({ ...caixa }, { x: 4, y: 3, largura: 12, altura: 4 });
    assert.equal(alfa(rgba, 20, 0, 0), 0);
    assert.equal(alfa(rgba, 20, 19, 9), 0);
    assert.equal(alfa(rgba, 20, 5, 4), 255);
  });

  it('não fura branco cercado pela armação (ex.: lente clara)', () => {
    const rgba = imagem(12, 8, [250, 250, 250, 255], [
      { x: 2, y: 2, w: 8, h: 4, cor: [0, 0, 0, 255] },
      { x: 4, y: 3, w: 4, h: 2, cor: [255, 255, 255, 255] },
    ]);
    prepararPixelsOculos(rgba, 12, 8);
    assert.equal(alfa(rgba, 12, 5, 3), 255);
    assert.equal(alfa(rgba, 12, 0, 0), 0);
  });

  it('PNG que já é transparente: não mexe nos pixels, só mede a armação', () => {
    const rgba = imagem(10, 6, [255, 255, 255, 0], [{ x: 2, y: 1, w: 5, h: 3, cor: [255, 255, 255, 255] }]);
    const caixa = prepararPixelsOculos(rgba, 10, 6);
    assert.deepEqual({ ...caixa }, { x: 2, y: 1, largura: 5, altura: 3 });
    assert.equal(alfa(rgba, 10, 3, 2), 255); // armação branca continua lá
  });

  it('foto sem fundo claro fica inteira; foto toda branca devolve null', () => {
    const escura = imagem(6, 4, [40, 40, 40, 255]);
    assert.deepEqual({ ...prepararPixelsOculos(escura, 6, 4) }, { x: 0, y: 0, largura: 6, altura: 4 });
    assert.equal(prepararPixelsOculos(imagem(6, 4, [255, 255, 255, 255]), 6, 4), null);
  });
});

describe('Provador: desenharOculos', () => {
  function ctxFalso() {
    const chamadas = [];
    const ctx = { canvas: { width: 640, height: 480 } };
    for (const m of ['clearRect', 'save', 'translate', 'rotate', 'drawImage', 'restore']) ctx[m] = (...a) => chamadas.push([m, ...a]);
    return { ctx, chamadas };
  }

  it('posiciona, gira e escala mantendo a proporção da foto', () => {
    const { ctx, chamadas } = ctxFalso();
    const img = {};
    desenharOculos(ctx, { imagem: img, largura: 400, altura: 100 }, { x: 320, y: 200, largura: 200, angulo: 0.1 });
    assert.deepEqual(chamadas.map((c) => c[0]), ['clearRect', 'save', 'translate', 'rotate', 'drawImage', 'restore']);
    assert.deepEqual(chamadas[0], ['clearRect', 0, 0, 640, 480]);
    assert.deepEqual(chamadas[2], ['translate', 320, 200]);
    assert.deepEqual(chamadas[3], ['rotate', 0.1]);
    const [, imagem, x, y, w, h] = chamadas[4];
    assert.equal(imagem, img);
    assert.deepEqual([x, w, h], [-100, 200, 50]);
    perto(y, -22.5, 'linha dos olhos a 45% da altura');
  });

  it('sem rosto, só limpa o canvas', () => {
    const { ctx, chamadas } = ctxFalso();
    desenharOculos(ctx, { imagem: {}, largura: 1, altura: 1 }, null);
    assert.deepEqual(chamadas.map((c) => c[0]), ['clearRect']);
  });
});

describe('Provador: botão nos detalhes do produto', () => {
  const FUNCOES = ['escapeHtml', 'fotosDoProduto', 'indiceCircular', 'ehSobEncomenda', 'calcularSinal',
    'etiquetaProduto', 'especificacoesProduto', 'renderizarDetalhes'];

  function detalhesDe(produto) {
    const detalhesConteudo = { innerHTML: '' };
    const ctx = carregar(FUNCOES, {
      produtos: [produto],
      maleta: { itens: [] },
      detalhes: { id: produto.id, indice: 0 },
      detalhesConteudo,
      formatarMoeda: (v) => `R$ ${v}`,
      fecharDetalhes() {},
    });
    ctx.renderizarDetalhes();
    return detalhesConteudo.innerHTML;
  }

  const base = { id: 7, nome: 'Aviador', codigo_sku: 'AV-1', preco_venda: '199.90', status: 'disponivel' };

  it('aparece quando o produto tem foto e abre o provador daquele produto', () => {
    const html = detalhesDe({ ...base, fotos: ['/imagens/aaa'], imagem_url: '/imagens/aaa' });
    assert.match(html, /onclick="abrirProvador\(7\)"[^>]*>Provar virtualmente</);
  });

  it('não aparece em produto sem foto', () => {
    const html = detalhesDe({ ...base, fotos: [], imagem_url: null });
    assert.doesNotMatch(html, /Provar virtualmente/);
  });

  it('o título do provador entra por textContent (sem innerHTML com o nome do produto)', () => {
    const fonte = extrairFuncao(HTML, 'abrirProvador');
    assert.match(fonte, /provadorTitulo'\)\.textContent =/);
    assert.doesNotMatch(fonte, /innerHTML/);
  });
});
