// Rastreamento de conversões da vitrine: Google Tag Manager, origem do pedido (UTMs)
// e Meta Conversions API (CAPI), configurados por loja em Configurações > Rastreamento.
//
// - GTM: com o ID do contêiner (GTM-XXXX) salvo, a vitrine sai do servidor com o script
//   do GTM no <head> e o <noscript> logo depois do <body>. Sem ID, nada é injetado.
// - Origem: a vitrine guarda utm_*, fbclid e gclid da primeira visita da sessão e manda
//   junto com o pedido; o pedido grava em pedidos.rastreamento (nunca vai para URL).
// - CAPI: com Pixel ID e token salvos, o servidor manda os eventos direto para a Graph API
//   da Meta, com o MESMO event_id que a vitrine pôs no dataLayer (o Pixel do GTM usa ele),
//   então a Meta conta uma vez só. E-mail, telefone, nome, cidade, CEP e o id do cliente
//   vão em SHA-256; IP e navegador vão como vieram (a Meta pede assim, sem hash).
//   O token fica cifrado no banco da loja e nunca sai do servidor.

const crypto = require('crypto');

// Versão da Graph API (dá para trocar sem mexer no código, com META_GRAPH_VERSION).
const GRAPH_VERSION = /^v\d{2,3}\.\d$/.test(process.env.META_GRAPH_VERSION || '') ? process.env.META_GRAPH_VERSION : 'v26.0';
// Só os testes trocam o endereço (servidor falso local).
const GRAPH_URL = process.env.META_GRAPH_URL || 'https://graph.facebook.com';
const TEMPO_MAX_META = 5000;

// Eventos que a vitrine pode pedir para o servidor repetir na CAPI (o pedido em si,
// Lead e Purchase, só sai do checkout, com os valores do banco).
const EVENTOS_VITRINE = {
  view_item: 'ViewContent',
  add_to_cart: 'AddToCart',
  begin_checkout: 'InitiateCheckout',
};

const CAMPOS_ORIGEM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];

// ---------- Configuração ----------
// '' (vazio = desligado), o ID em maiúsculas, ou null quando não é um ID do GTM.
function lerIdGtm(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return null;
  const t = v.trim().toUpperCase();
  if (!t) return '';
  return /^GTM-[A-Z0-9]{4,12}$/.test(t) ? t : null;
}

// Pixel ID da Meta: só números (o do Gerenciador de Eventos tem 15 ou 16 dígitos).
function lerPixelId(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = String(v).trim();
  if (!t) return '';
  return /^\d{8,20}$/.test(t) ? t : null;
}

// Token de acesso da CAPI (gerado no Gerenciador de Eventos). Só confere o formato.
function lerTokenCapi(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return '';
  return /^[A-Za-z0-9_\-|.]{20,600}$/.test(t) ? t : null;
}

// Código de teste do Gerenciador de Eventos (TEST12345): os eventos aparecem na aba
// "Testar eventos" e não entram nos relatórios. Vazio em produção.
function lerCodigoTeste(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return null;
  const t = v.trim().toUpperCase();
  if (!t) return '';
  return /^[A-Z0-9]{4,20}$/.test(t) ? t : null;
}

// Scripts do GTM para a vitrine (o ID já passou por lerIdGtm, só letras/números/hífen).
function snippetGtm(id) {
  const gtm = lerIdGtm(id);
  if (!gtm) return null;
  return {
    head: `  <!-- Google Tag Manager -->\n  <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtm}');</script>\n  <!-- End Google Tag Manager -->\n`,
    body: `\n  <!-- Google Tag Manager (noscript) -->\n  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${gtm}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>\n  <!-- End Google Tag Manager (noscript) -->`,
  };
}

// ---------- Dados que vêm da vitrine ----------
function textoLimpo(v, max) {
  return typeof v === 'string' ? v.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
}

// event_id gerado na vitrine (UUID ou parecido). Inválido = o servidor cria um.
function lerEventId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_.:-]{8,64}$/.test(v) ? v : '';
}

// Cookies _fbp / _fbc da Meta: fb.<n>.<timestamp>.<valor>
function lerCookieMeta(v) {
  return typeof v === 'string' && /^fb\.\d\.\d{10,13}\.[A-Za-z0-9_.\-]{1,500}$/.test(v) ? v : '';
}

// Origem do pedido (UTMs, fbclid, gclid, página de entrada) só com campos conhecidos.
function lerOrigem(corpo) {
  const o = corpo && typeof corpo === 'object' ? corpo : {};
  const origem = {};
  for (const campo of CAMPOS_ORIGEM) {
    const v = textoLimpo(o[campo], campo.endsWith('clid') ? 500 : 150);
    if (v) origem[campo] = v;
  }
  // Página de entrada sem a query (a query pode ter dados que não queremos guardar)
  const entrada = textoLimpo(o.landing_page, 300).split(/[?#]/)[0];
  if (/^https?:\/\//i.test(entrada)) origem.landing_page = entrada;
  const ref = textoLimpo(o.referrer, 300).split(/[?#]/)[0];
  if (/^https?:\/\//i.test(ref)) origem.referrer = ref;
  if (typeof o.capturado_em === 'string' && !Number.isNaN(Date.parse(o.capturado_em))) origem.capturado_em = new Date(o.capturado_em).toISOString();
  return origem;
}

// Tudo o que o pedido guarda de rastreamento: origem + ids da Meta + event_id.
function lerRastreamento(corpo) {
  const r = corpo && typeof corpo === 'object' ? corpo : {};
  const out = { ...lerOrigem(r.origem || r.utms || r) };
  const eventId = lerEventId(r.event_id);
  if (eventId) out.event_id = eventId;
  const fbp = lerCookieMeta(r.fbp);
  if (fbp) out.fbp = fbp;
  const fbc = lerCookieMeta(r.fbc);
  if (fbc) out.fbc = fbc;
  return out;
}

// Token do navegador da cliente ("lembrar meus dados"): aleatório, sem dado pessoal.
function lerTokenVisitante(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(v) ? v : '';
}
function novoTokenVisitante() {
  return crypto.randomBytes(18).toString('base64url');
}

// IP da cliente: o primeiro do X-Forwarded-For (o Render põe ali) ou o da conexão.
function ipDoCliente(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || (req.socket && req.socket.remoteAddress) || '';
  const limpo = ip.replace(/^::ffff:/, '');
  return /^[0-9a-fA-F:.]{3,45}$/.test(limpo) ? limpo : '';
}

// ---------- Hash (SHA-256 do texto normalizado, como a Meta pede) ----------
function sha256(t) {
  return crypto.createHash('sha256').update(t, 'utf8').digest('hex');
}
function semAcento(t) {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function hashEmail(v) {
  const t = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? sha256(t) : '';
}
// Telefone com DDI: no Brasil, 10 ou 11 dígitos ganham o 55 na frente.
function normalizarTelefone(v) {
  let d = String(v || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 && d.length <= 15 ? d : '';
}
function hashTelefone(v) {
  const d = normalizarTelefone(v);
  return d ? sha256(d) : '';
}
function hashNome(v) {
  const t = semAcento(String(v || '').trim().toLowerCase()).replace(/[^a-z]/g, '');
  return t ? sha256(t) : '';
}
function hashCidade(v) {
  // "São Paulo/SP" ou "São Paulo - SP": a cidade é o que vem antes da UF
  const cidade = String(v || '').split(/[/-]/)[0];
  const t = semAcento(cidade.trim().toLowerCase()).replace(/[^a-z]/g, '');
  return t ? sha256(t) : '';
}
function hashUf(v) {
  const m = String(v || '').match(/[/-]\s*([A-Za-z]{2})\s*$/);
  return m ? sha256(m[1].toLowerCase()) : '';
}
function hashCep(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 8 ? sha256(d) : '';
}

// user_data da CAPI. Campos vazios ficam de fora (a Meta rejeita hash de texto vazio).
function montarUserData({ email, telefone, nome, cidade, cep, externalId, ip, userAgent, fbp, fbc } = {}) {
  const u = {};
  const em = hashEmail(email);
  if (em) u.em = [em];
  const ph = hashTelefone(telefone);
  if (ph) u.ph = [ph];
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length) {
    const fn = hashNome(partes[0]);
    if (fn) u.fn = [fn];
    const ln = partes.length > 1 ? hashNome(partes[partes.length - 1]) : '';
    if (ln) u.ln = [ln];
  }
  const ct = hashCidade(cidade);
  if (ct) u.ct = [ct];
  const st = hashUf(cidade);
  if (st) u.st = [st];
  const zp = hashCep(cep);
  if (zp) u.zp = [zp];
  if (em || ph || zp) u.country = [sha256('br')];
  if (externalId) u.external_id = [sha256(String(externalId))];
  if (ip) u.client_ip_address = ip;
  if (userAgent) u.client_user_agent = String(userAgent).slice(0, 500);
  if (fbp) u.fbp = fbp;
  if (fbc) u.fbc = fbc;
  return u;
}

// custom_data a partir dos itens (preços sempre do banco, nunca do navegador).
function montarCustomData(itens, valor) {
  const lista = (itens || []).filter(Boolean);
  const soma = valor !== undefined ? Number(valor) : lista.reduce((t, i) => t + Number(i.preco || 0), 0);
  return {
    currency: 'BRL',
    value: Math.round(soma * 100) / 100,
    content_type: 'product',
    content_ids: lista.map((i) => String(i.codigo_sku || i.produto_id || i.id)),
    contents: lista.map((i) => ({ id: String(i.codigo_sku || i.produto_id || i.id), quantity: 1, item_price: Number(i.preco || 0) })),
    num_items: lista.length,
  };
}

// ---------- Envio para a Graph API ----------
// config: { pixel_id, token, test_code }. Devolve { enviado, status, erro? } e nunca lança:
// um problema na Meta não pode atrapalhar o pedido da cliente.
async function enviarEventosMeta(config, eventos, { fetchImpl = globalThis.fetch } = {}) {
  if (!config || !config.pixel_id || !config.token || !eventos.length) return { enviado: false, motivo: 'sem_configuracao' };
  // Token no corpo do POST, não na URL (não aparece em log de proxy nem de servidor)
  const corpo = { data: eventos, access_token: config.token };
  if (config.test_code) corpo.test_event_code = config.test_code;
  const url = `${GRAPH_URL}/${GRAPH_VERSION}/${encodeURIComponent(config.pixel_id)}/events`;
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), TEMPO_MAX_META);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: controle.signal,
    });
    if (res.ok) return { enviado: true, status: res.status };
    const txt = await res.text().catch(() => '');
    let msg = '';
    try { msg = JSON.parse(txt).error.message; } catch { msg = txt.slice(0, 200); }
    console.warn(`[capi] Meta respondeu ${res.status}: ${msg}`);
    return { enviado: false, status: res.status, erro: msg };
  } catch (err) {
    console.warn(`[capi] falha ao enviar evento: ${err.name === 'AbortError' ? 'tempo esgotado' : err.message}`);
    return { enviado: false, erro: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Um evento no formato da CAPI.
function montarEvento({ nome, eventId, url, userData, customData, quando = Date.now() }) {
  const e = {
    event_name: nome,
    event_time: Math.floor(quando / 1000),
    event_id: eventId,
    action_source: 'website',
    user_data: userData,
  };
  const pagina = textoLimpo(url, 500).split(/[?#]/)[0];
  if (/^https?:\/\//i.test(pagina)) e.event_source_url = pagina;
  if (customData) e.custom_data = customData;
  return e;
}

module.exports = {
  GRAPH_VERSION,
  EVENTOS_VITRINE,
  CAMPOS_ORIGEM,
  lerIdGtm,
  lerPixelId,
  lerTokenCapi,
  lerCodigoTeste,
  snippetGtm,
  lerEventId,
  lerCookieMeta,
  lerOrigem,
  lerRastreamento,
  lerTokenVisitante,
  novoTokenVisitante,
  ipDoCliente,
  sha256,
  normalizarTelefone,
  montarUserData,
  montarCustomData,
  montarEvento,
  enviarEventosMeta,
};
