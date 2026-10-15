// Importação de produto a partir do link na loja do fornecedor.
// baixarPagina busca o HTML (só http/https, nunca endereços internos);
// extrairDadosProduto lê título, preço e referências de JSON-LD (schema.org
// Product), meta tags (Open Graph / product:*, itemprop) e <title>.
// Funciona com a maioria das lojas (Nuvemshop, Shopify, VTEX, Loja Integrada,
// WooCommerce), porque todas publicam esses dados para Google e redes sociais.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');

const TIMEOUT_MS = 10000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Endereços que o servidor nunca acessa: rede interna, loopback, link-local
// (metadados de nuvem), multicast e reservados.
const BLOQUEADOS = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
].forEach(([ip, bits]) => BLOQUEADOS.addSubnet(ip, bits, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32],
].forEach(([ip, bits]) => BLOQUEADOS.addSubnet(ip, bits, 'ipv6'));

function enderecoBloqueado(ip) {
  const tipo = net.isIP(ip);
  if (tipo === 4) return BLOQUEADOS.check(ip, 'ipv4');
  if (tipo === 6) {
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (v4) return BLOQUEADOS.check(v4[1], 'ipv4');
    return BLOQUEADOS.check(ip, 'ipv6');
  }
  return true;
}

class ErroImportacao extends Error {
  constructor(mensagem, status = 502) {
    super(mensagem);
    this.status = status;
  }
}

// URL colada no painel -> URL normalizada (só http/https, sem usuário/senha), ou null.
function lerUrlProduto(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 2000) return null;
  try {
    const u = new URL(v.trim());
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

// DNS resolvido aqui (e não pelo http) para conferir o IP que será de fato usado:
// um domínio que aponta para a rede interna é recusado mesmo que mude entre consultas.
function lookupSeguro(permitirRedeLocal) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, enderecos) => {
      if (err) return callback(err);
      if (!permitirRedeLocal && enderecos.some((a) => enderecoBloqueado(a.address))) {
        return callback(new ErroImportacao('Endereço não permitido', 400));
      }
      if (options && options.all) return callback(null, enderecos);
      callback(null, enderecos[0].address, enderecos[0].family);
    });
  };
}

function charsetDe(contentType, inicio) {
  const doCabecalho = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (doCabecalho) return doCabecalho[1];
  const doHtml = /<meta[^>]+charset=["']?([\w-]+)/i.exec(inicio);
  return doHtml ? doHtml[1] : 'utf-8';
}

function decodificar(buf, contentType) {
  const charset = charsetDe(contentType, buf.subarray(0, 4096).toString('latin1'));
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function descompactar(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

function requisitar(url, opcoes) {
  return new Promise((resolve, reject) => {
    if (!opcoes.permitirRedeLocal && net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && enderecoBloqueado(url.hostname.replace(/^\[|\]$/g, ''))) {
      return reject(new ErroImportacao('Endereço não permitido', 400));
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      lookup: lookupSeguro(opcoes.permitirRedeLocal),
      timeout: opcoes.timeoutMs,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new ErroImportacao(`A loja respondeu com erro ${res.statusCode}`));
      }
      const partes = [];
      let total = 0;
      const corpo = descompactar(res);
      corpo.on('data', (chunk) => {
        total += chunk.length;
        if (total > opcoes.maxBytes) {
          req.destroy();
          corpo.destroy();
          return reject(new ErroImportacao('Página grande demais'));
        }
        partes.push(chunk);
      });
      corpo.on('end', () => resolve({ html: decodificar(Buffer.concat(partes), res.headers['content-type']) }));
      corpo.on('error', () => reject(new ErroImportacao('Não foi possível ler a página da loja')));
    });
    // timeout do http só mede tempo parado; este limita o download inteiro
    const limite = setTimeout(() => req.destroy(new ErroImportacao('A loja demorou demais para responder', 504)), opcoes.timeoutMs * 2);
    req.on('close', () => clearTimeout(limite));
    req.on('timeout', () => req.destroy(new ErroImportacao('A loja demorou demais para responder', 504)));
    req.on('error', (err) => reject(err instanceof ErroImportacao ? err : new ErroImportacao('Não foi possível acessar a loja')));
  });
}

// Baixa o HTML da página, seguindo redirecionamentos (cada um conferido de novo).
async function baixarPagina(urlTexto, { permitirRedeLocal = false, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  let url = lerUrlProduto(String(urlTexto || ''));
  if (!url) throw new ErroImportacao('Link inválido (use http:// ou https://)', 400);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await requisitar(url, { permitirRedeLocal, timeoutMs, maxBytes });
    if (r.html !== undefined) return { html: r.html, url: url.href };
    url = lerUrlProduto(new URL(r.redirect, url).href);
    if (!url) throw new ErroImportacao('A loja redirecionou para um endereço inválido');
  }
  throw new ErroImportacao('Redirecionamentos demais');
}

// ---------- Leitura do HTML ----------

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodificarEntidades(t) {
  return String(t || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cod = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cod) && cod > 0 && cod <= 0x10ffff ? String.fromCodePoint(cod) : m;
    }
    return ENTIDADES[e.toLowerCase()] ?? m;
  });
}

const limpar = (t) => decodificarEntidades(t).replace(/\s+/g, ' ').trim();

// Atributos de uma tag: <meta property="og:title" content="..."> -> { property, content }
function atributos(tag) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

// Todas as meta tags, por property/name/itemprop (minúsculo). Primeira ocorrência vence.
function metaTags(html) {
  const metas = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = atributos(m[0]);
    const chave = (a.property || a.name || a.itemprop || '').toLowerCase();
    const valor = a.content ?? a.value;
    if (chave && valor !== undefined && !(chave in metas)) metas[chave] = limpar(valor);
  }
  // itemprop em outras tags (ex.: <span itemprop="price" content="199.90">)
  for (const m of html.matchAll(/<(?!meta\b)[a-z]+\b[^>]*\bitemprop\s*=\s*["']?(price|sku|mpn|name)["']?[^>]*>/gi)) {
    const a = atributos(m[0]);
    if (a.content && !(`itemprop:${a.itemprop}` in metas)) metas[`itemprop:${a.itemprop.toLowerCase()}`] = limpar(a.content);
  }
  return metas;
}

function blocosJsonLd(html) {
  const blocos = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      blocos.push(JSON.parse(m[1].trim()));
    } catch {
      // JSON-LD quebrado em algumas lojas: ignora o bloco
    }
  }
  return blocos;
}

function temTipo(obj, tipo) {
  const t = obj && obj['@type'];
  return Array.isArray(t) ? t.includes(tipo) : t === tipo;
}

// Primeiro objeto schema.org Product (ou ProductGroup) dentro dos blocos JSON-LD
function produtoJsonLd(blocos) {
  const fila = [...blocos];
  let visitados = 0;
  while (fila.length && visitados++ < 500) {
    const item = fila.shift();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { fila.push(...item); continue; }
    if (temTipo(item, 'Product') || temTipo(item, 'ProductGroup')) return item;
    for (const v of Object.values(item)) if (v && typeof v === 'object') fila.push(v);
  }
  return null;
}

// "R$ 1.234,56", "199,90", "199.90", 199.9 -> 1234.56 / 199.9 / 199.9. Inválido -> null.
function lerPrecoTexto(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  let t = String(v ?? '').replace(/R\$|BRL/gi, '').replace(/\s/g, '');
  if (!t) return null;
  if (t.includes(',') && t.includes('.')) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (t.includes(',')) {
    t = t.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    t = t.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Math.round(Number(t) * 100) / 100;
  return n < 1e8 ? n : null;
}

function precoDasOfertas(offers) {
  const lista = Array.isArray(offers) ? offers : offers ? [offers] : [];
  const precos = [];
  for (const o of lista) {
    if (!o || typeof o !== 'object') continue;
    const candidatos = [o.price, o.lowPrice, o.priceSpecification && (Array.isArray(o.priceSpecification) ? o.priceSpecification[0]?.price : o.priceSpecification.price)];
    if (o.offers) candidatos.push(precoDasOfertas(o.offers));
    const p = candidatos.map(lerPrecoTexto).find((x) => x !== null && x > 0);
    if (p !== undefined) precos.push(p);
  }
  return precos.length ? Math.min(...precos) : null;
}

function texto(v) {
  if (typeof v === 'string' || typeof v === 'number') return limpar(String(v));
  if (v && typeof v === 'object' && !Array.isArray(v)) return texto(v.name || v['@id'] || '');
  return '';
}

function urlsImagens(v, base) {
  const lista = Array.isArray(v) ? v : v ? [v] : [];
  const urls = [];
  for (const item of lista) {
    const bruto = typeof item === 'string' ? item : item && (item.url || item.contentUrl);
    if (!bruto) continue;
    try {
      const u = new URL(decodificarEntidades(bruto), base);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !urls.includes(u.href)) urls.push(u.href);
    } catch {
      // URL de imagem inválida: ignora
    }
  }
  return urls;
}

// Título da página sem o nome da loja no fim ("Óculos X | Loja" -> "Óculos X")
function semNomeDaLoja(titulo, loja) {
  if (!loja) return titulo;
  const partes = titulo.split(/\s+[|–—-]\s+/);
  if (partes.length > 1 && partes[partes.length - 1].toLowerCase() === loja.toLowerCase()) partes.pop();
  return partes.join(' - ');
}

function extrairDadosProduto(html, urlPagina) {
  const pagina = String(html || '');
  const metas = metaTags(pagina);
  const ld = produtoJsonLd(blocosJsonLd(pagina)) || {};
  const tituloTag = limpar((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(pagina) || [])[1] || '');
  const host = (() => { try { return new URL(urlPagina).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const loja = metas['og:site_name'] || '';

  const nome = (texto(ld.name) || metas['og:title'] || metas['twitter:title'] || metas['itemprop:name'] || semNomeDaLoja(tituloTag, loja)).slice(0, 255);

  let preco = precoDasOfertas(ld.offers);
  if (preco === null) {
    const chaves = ['product:price:amount', 'og:price:amount', 'product:sale_price:amount', 'itemprop:price', 'price', 'twitter:data1'];
    const extras = Object.keys(metas).filter((k) => /(^|:)price$/.test(k) && !chaves.includes(k));
    for (const k of [...chaves, ...extras]) {
      const p = lerPrecoTexto(metas[k]);
      if (p !== null && p > 0) { preco = p; break; }
    }
  }

  const sku = texto(ld.sku) || metas['product:retailer_item_id'] || metas['itemprop:sku'] || '';
  const mpn = texto(ld.mpn) || metas['itemprop:mpn'] || '';
  const gtin = texto(ld.gtin13 || ld.gtin || ld.gtin12 || ld.gtin14 || ld.gtin8) || '';
  const marca = texto(ld.brand) || metas['product:brand'] || '';
  const referencia = (sku || mpn || texto(ld.productID) || gtin).slice(0, 100);

  return {
    nome,
    preco_custo: preco,
    codigo_fornecedor: referencia,
    referencias: { sku, mpn, gtin, marca },
    fornecedor: (loja || host).slice(0, 120),
    imagens: [...urlsImagens(ld.image, urlPagina), ...urlsImagens(metas['og:image'], urlPagina)]
      .filter((u, i, todas) => todas.indexOf(u) === i).slice(0, 4),
  };
}

async function importarProduto(url, opcoes) {
  const pagina = await baixarPagina(url, opcoes);
  const dados = extrairDadosProduto(pagina.html, pagina.url);
  if (!dados.nome && dados.preco_custo === null) {
    throw new ErroImportacao('Não encontrei nome nem preço nessa página. Confira se é o link de um produto.', 422);
  }
  return { ...dados, link_fornecedor: lerUrlProduto(url).href };
}

module.exports = { importarProduto, baixarPagina, extrairDadosProduto, lerPrecoTexto, enderecoBloqueado, ErroImportacao };
