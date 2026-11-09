// Pedido do fornecedor em PDF (ex.: a página do pedido na loja Nuvemshop, impressa
// em PDF) -> número, data, itens (descrição, código, quantidade, custo) e a foto de
// cada item. O painel usa o resultado para lançar o pedido no estoque.
//
// O texto e as fotos saem do PDF com o pdf.js. A leitura do texto (lerPedidoTexto)
// é separada e não depende do PDF, para os testes.
const zlib = require('node:zlib');

const MAX_PAGINAS = 40;
const MAX_ITENS = 300;

class ErroPedidoPdf extends Error {}

// ---------- Texto do pedido ----------

const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// "R$1.234,56" / "R$ 29,00" -> 1234.56; senão NaN
function lerValor(t) {
  const m = /R\$\s*-?\s*([\d.]+,\d{2})/.exec(String(t || ''));
  return m ? Number(m[1].replace(/\./g, '').replace(',', '.')) : NaN;
}

const FORMATOS = [
  [/oval/, 'Oval'], [/quadrad/, 'Quadrado'], [/redond|arredondad/, 'Redondo'], [/aviador|piloto/, 'Aviador'],
  [/gatinh|cat ?eye/, 'Gatinho'], [/hexagon/, 'Hexagonal'], [/geometric/, 'Geométrico'], [/retangul/, 'Retangular'],
  [/esport|mascara/, 'Esportivo'], [/borboleta/, 'Borboleta'], [/octogon/, 'Octogonal'],
];
const MATERIAIS = [
  [/^metal/, 'Metal'], [/^acetato/, 'Acetato'], [/^tr ?-?90/, 'TR90'], [/^bambu/, 'Bambu'], [/^madeira|^wood/, 'Madeira'],
  [/^injetad/, 'Injetado'], [/^nylon/, 'Nylon'], [/^policarbonato/, 'Policarbonato'], [/^titanio/, 'Titânio'],
];

// "Óculos de Sol Vogue • XFG976 •Metal • Oval • Acetato" -> modelo, código e o que der
// para tirar das especificações (formato, material, polarizado, gênero).
// Texto todo em maiúsculas (padrão da Clush) -> "Primeira Letra Maiúscula"
function titulo(t) {
  const texto = String(t || '').trim();
  if (!texto || texto !== texto.toUpperCase()) return texto;
  return texto.toLowerCase().replace(/(^|[\s/(-])(\p{L})/gu, (_, antes, letra) => antes + letra.toUpperCase())
    .replace(/\b(De|Da|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());
}

// "ÓCULOS DE SOL AVIADOR GOLD - MARROM DEGRADÊ/DOURADO - METAL" (Clush): sem código,
// a cor e o material vêm depois de " - ".
function lerDescricaoComHifen(descricao) {
  const partes = String(descricao || '').split(/\s+[-–]\s+/).map((p) => p.trim()).filter(Boolean);
  const nome = partes.shift() || '';
  const resultado = lerDescricao(nome);
  resultado.modelo = titulo(resultado.modelo);
  resultado.cor = titulo(partes[0] || '');
  const material = partes.slice(1).join(' ');
  const materiais = [];
  for (const palavra of semAcento(material).split(/[\s/]+/)) {
    const mat = MATERIAIS.find(([re]) => re.test(palavra));
    if (mat && !materiais.includes(mat[1])) materiais.push(mat[1]);
  }
  resultado.material = materiais.join(' / ') || titulo(material);
  for (const palavra of semAcento(nome).split(/\s+/)) {
    if (palavra.startsWith('polariz')) resultado.tipo = 'Polarizado';
  }
  return resultado;
}

function lerDescricao(descricao) {
  if (!String(descricao || '').includes('•') && /\s[-–]\s/.test(String(descricao || ''))) return lerDescricaoComHifen(descricao);
  const partes = String(descricao || '').split('•').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const primeira = partes.shift() || '';
  const modelo = primeira.replace(/^(o|ó)culos(\s+de\s+(sol|grau))?\s*/i, '').replace(/^arma(c|ç)(a|ã)o\s*/i, '').trim();
  // Código: a 1ª parte depois do nome que tenha número (XFG976, NV 560, 722)
  // Código quebrado em pedaços ("XFG • D • 805", "S • 70") é juntado: XFG-D-805, S-70;
  // letras + número sem nada no meio ficam grudados (XFG • 50610 -> XFG50610).
  let codigo = '';
  if (partes.length && /\d/.test(partes[0]) && partes[0].length <= 30) codigo = partes.shift().toUpperCase();
  else {
    let n = 0;
    while (n < partes.length - 1 && n < 3 && /^[a-z]{1,4}$/i.test(partes[n])) n++;
    if (n && /^\d[\w-]{0,20}$/.test(partes[n])) {
      codigo = partes.splice(0, n + 1).join('-').toUpperCase().replace(/^([A-Z]{2,})-(\d+)$/, '$1$2');
    }
  }
  const especificacoes = partes.map((p) => p.replace(/\s*[-–]\s*$/, '').replace(/\s+ok$/i, '').trim()).filter(Boolean);
  const resultado = { modelo, codigo, especificacoes, formato: '', material: '', tipo: '', genero: '', cor: '' };
  const materiais = [];
  for (const e of especificacoes) {
    for (const palavra of semAcento(e).split(/\s+/)) {
      if (palavra.startsWith('polariz')) resultado.tipo = 'Polarizado';
      else if (/^unis+e?x/.test(palavra)) resultado.genero = 'UNISSEX';
      else if (/^feminin/.test(palavra)) resultado.genero = resultado.genero || 'FEMININO';
      else if (/^masculin/.test(palavra)) resultado.genero = resultado.genero || 'MASCULINO';
      const mat = MATERIAIS.find(([re]) => re.test(palavra));
      if (mat && !materiais.includes(mat[1])) materiais.push(mat[1]);
      const fmt = !resultado.formato && FORMATOS.find(([re]) => re.test(palavra));
      if (fmt) resultado.formato = fmt[1];
    }
  }
  if (!resultado.formato) {
    const fmt = FORMATOS.find(([re]) => re.test(semAcento(modelo)));
    if (fmt) resultado.formato = fmt[1];
  }
  resultado.material = materiais.join(' / ');
  return resultado;
}

// Linhas de texto do pedido ({ texto, pagina, y } na ordem de leitura) -> pedido.
// Item = descrição (uma ou mais linhas) que termina em "xN", seguida do valor da
// linha ("R$33,80" = total das N peças).
function lerPedidoTexto(linhas) {
  const pedido = { numero: '', data: '', itens: [], subtotal: null, desconto: null, frete: null, total: null };
  let buffer = [];
  let noEndereco = false;
  for (const linha of linhas) {
    const texto = String(linha.texto || '').replace(/\s+/g, ' ').trim();
    if (!texto) continue;
    const t = semAcento(texto);
    const numero = /^pedido\s*(n[ºo°.]*)?\s*#?\s*(\d[\w-]*)/i.exec(texto);
    if (numero && !pedido.numero) { pedido.numero = numero[2]; buffer = []; continue; }
    const data = /^data( do pedido| da compra)?:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(texto);
    if (data) { if (!pedido.data) pedido.data = data[2]; buffer = []; continue; }
    if (/^endereco( de (envio|entrega))?:?/.test(t)) { noEndereco = true; buffer = []; continue; }
    if (/^(subtotal|total|desconto|frete)\b/.test(t)) {
      const valor = lerValor(texto);
      const campo = t.startsWith('subtotal') ? 'subtotal' : t.startsWith('total') ? 'total' : t.startsWith('desconto') ? 'desconto' : 'frete';
      if (Number.isFinite(valor) && pedido[campo] === null) pedido[campo] = valor;
      else if (campo === 'frete' && pedido.frete === null && /gr[aá]tis/i.test(texto)) pedido.frete = 0;
      buffer = [];
      noEndereco = false;
      continue;
    }
    if (/^(estado|pagamento|meio de pagamento|forma de pagamento|envio|cliente|e-?mail|telefone|cpf|cnpj):/.test(t)) { buffer = []; continue; }
    // Títulos de seção ("PRODUTOS", "Detalhes do pedido") não fazem parte do item
    if (/^(produtos|itens|detalhes do pedido)$/.test(t)) { buffer = []; noEndereco = false; continue; }
    if (noEndereco) {
      // Endereço: nome, rua, cidade... até o telefone (não entram nos itens)
      if (/^\+?[\d\s().-]{10,}$/.test(texto)) noEndereco = false;
      if (!texto.includes('•') && !/\bx\d+$/.test(texto)) continue;
      noEndereco = false;
    }
    const valorSozinho = /^-?\s*R\$\s*[\d.]+,\d{2}$/.test(texto);
    const junto = buffer.join(' ').replace(/\s+/g, ' ').trim();
    const fimItem = /^(.*?)\s*\bx\s?(\d{1,4})$/i.exec(junto);
    if (valorSozinho && fimItem && fimItem[1]) {
      const quantidade = Number(fimItem[2]);
      const total = lerValor(texto);
      if (quantidade > 0 && Number.isFinite(total) && pedido.itens.length < MAX_ITENS) {
        const descricao = fimItem[1].replace(/\s*•\s*$/, '').replace(/\s*•\s*/g, ' • ').trim();
        pedido.itens.push({
          descricao,
          ...lerDescricao(descricao),
          quantidade,
          preco_total: total,
          preco_unitario: Math.round((total / quantidade) * 100) / 100,
          oculos: /^(o|ó)culos|^arma(c|ç)/i.test(descricao),
          pagina: buffer.inicio ? buffer.inicio.pagina : linha.pagina,
          y: buffer.inicio ? buffer.inicio.y : linha.y,
        });
      }
      buffer = [];
      continue;
    }
    // Valor que não fecha um item (sem "xN" antes): descarta o que veio junto
    if (valorSozinho) { buffer = []; continue; }
    if (!buffer.length) buffer.inicio = linha;
    buffer.push(texto);
    // Descrição de item não passa de 4 linhas: o que vier antes é lixo
    if (buffer.length > 4) {
      const inicio = buffer.inicio;
      buffer = buffer.slice(-4);
      buffer.inicio = inicio;
    }
  }
  return pedido;
}

// ---------- PDF ----------

let pdfjsPromise = null;
function carregarPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

const CRC_TABELA = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABELA[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Imagem decodificada do pdf.js ({ width, height, kind, data }) -> PNG (Buffer) ou null
function imagemParaPng(img) {
  if (!img || !img.data || !img.width || !img.height) return null;
  const { width, height, kind, data } = img;
  const canais = kind === 3 ? 4 : 3; // 3 = RGBA, 2 = RGB, 1 = cinza 1 bit por pixel
  const bruto = Buffer.alloc((width * canais + 1) * height);
  for (let y = 0; y < height; y++) {
    const linha = y * (width * canais + 1);
    bruto[linha] = 0;
    for (let x = 0; x < width; x++) {
      const destino = linha + 1 + x * canais;
      if (kind === 1) {
        const bytesLinha = (width + 7) >> 3;
        const bit = (data[y * bytesLinha + (x >> 3)] >> (7 - (x & 7))) & 1;
        bruto[destino] = bruto[destino + 1] = bruto[destino + 2] = bit ? 255 : 0;
      } else {
        const origem = (y * width + x) * canais;
        for (let c = 0; c < canais; c++) bruto[destino + c] = data[origem + c];
      }
    }
  }
  const bloco = (tipo, conteudo) => {
    const tam = Buffer.alloc(4);
    tam.writeUInt32BE(conteudo.length);
    const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), conteudo]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(corpo));
    return Buffer.concat([tam, corpo, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = canais === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', ihdr),
    bloco('IDAT', zlib.deflateSync(bruto)),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

const multiplicar = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

// PDF (Buffer) -> { linhas: [{ texto, pagina, y }], imagens: [{ pagina, y, altura, alturaPagina, png }] }
async function extrairPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new ErroPedidoPdf('O arquivo não é um PDF');
  }
  const pdfjs = await carregarPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
    }).promise;
  } catch {
    throw new ErroPedidoPdf('Não foi possível abrir o PDF');
  }
  try {
    if (doc.numPages > MAX_PAGINAS) throw new ErroPedidoPdf(`PDF com mais de ${MAX_PAGINAS} páginas`);
    const linhas = [];
    const imagens = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const alturaPagina = page.view[3] - page.view[1];
      // Texto: os pedaços na mesma altura viram uma linha, da esquerda para a direita
      const conteudo = await page.getTextContent();
      const pedacos = conteudo.items
        .filter((it) => typeof it.str === 'string' && it.str.trim())
        .map((it, ordem) => ({ texto: it.str, x: it.transform[4], y: it.transform[5], ordem }));
      const grupos = [];
      for (const pd of pedacos) {
        const g = grupos.find((gr) => Math.abs(gr.y - pd.y) <= 2);
        if (g) g.pedacos.push(pd);
        else grupos.push({ y: pd.y, ordem: pd.ordem, pedacos: [pd] });
      }
      grupos.sort((a, b) => b.y - a.y || a.ordem - b.ordem);
      for (const g of grupos) {
        g.pedacos.sort((a, b) => a.x - b.x);
        linhas.push({ texto: g.pedacos.map((pd) => pd.texto).join(' '), pagina: p, y: g.y });
      }
      // Fotos: onde cada imagem é desenhada (para achar o item do lado)
      const ops = await page.getOperatorList();
      let ctm = [1, 0, 0, 1, 0, 0];
      const pilha = [];
      const desenhos = [];
      ops.fnArray.forEach((fn, i) => {
        if (fn === pdfjs.OPS.save) pilha.push(ctm);
        else if (fn === pdfjs.OPS.restore) ctm = pilha.pop() || ctm;
        else if (fn === pdfjs.OPS.transform) ctm = multiplicar(ctm, ops.argsArray[i]);
        else if (fn === pdfjs.OPS.paintImageXObject) desenhos.push({ nome: ops.argsArray[i][0], ctm: ctm.slice() });
      });
      for (const d of desenhos) {
        const img = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 5000);
          try {
            page.objs.get(d.nome, (obj) => { clearTimeout(timer); resolve(obj); });
          } catch { clearTimeout(timer); resolve(null); }
        });
        const altura = Math.abs(d.ctm[3]);
        // Ícones e enfeites pequenos não são foto de produto
        if (!img || altura < 30 || Math.abs(d.ctm[0]) < 30) continue;
        const png = imagemParaPng(img);
        if (png) imagens.push({ pagina: p, y: d.ctm[5], altura, alturaPagina, png });
      }
      page.cleanup();
    }
    return { linhas, imagens };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

// Liga cada item à foto do lado: mesma página, na altura da 1ª linha da descrição.
// Foto que ficou no pé de uma página com o item no topo da seguinte também vale.
function ligarFotos(itens, imagens) {
  const livres = new Set(imagens.map((_, i) => i));
  const semFoto = [];
  itens.forEach((item) => {
    let melhor = -1;
    let distancia = Infinity;
    for (const i of livres) {
      const img = imagens[i];
      if (img.pagina !== item.pagina) continue;
      const d = Math.abs(img.y - item.y);
      if (d <= 20 && d < distancia) { melhor = i; distancia = d; }
    }
    if (melhor >= 0) { item.foto = imagens[melhor]; livres.delete(melhor); } else semFoto.push(item);
  });
  for (const item of semFoto) {
    for (const i of livres) {
      const img = imagens[i];
      if (img.pagina === item.pagina - 1 && img.y < 150 && item.y > img.alturaPagina - 150) {
        item.foto = img;
        livres.delete(i);
        break;
      }
    }
  }
}

// PDF -> pedido com a foto de cada item em data URL (PNG)
async function lerPedidoPdf(buffer) {
  const { linhas, imagens } = await extrairPdf(buffer);
  const pedido = lerPedidoTexto(linhas);
  ligarFotos(pedido.itens, imagens);
  pedido.itens = pedido.itens.map(({ pagina, y, foto, ...item }) => ({
    ...item,
    foto: foto ? `data:image/png;base64,${foto.png.toString('base64')}` : null,
  }));
  return pedido;
}

module.exports = { lerPedidoPdf, lerPedidoTexto, lerDescricao, extrairPdf, ligarFotos, imagemParaPng, ErroPedidoPdf };
