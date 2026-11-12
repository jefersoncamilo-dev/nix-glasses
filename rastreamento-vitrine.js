// Rastreamento da vitrine (carregado no <head> do index.html, antes de tudo).
//
// 1. Origem da visita: lê utm_source, utm_medium, utm_campaign, utm_content, utm_term,
//    fbclid e gclid da URL e guarda no localStorage (nix_origem) por 30 dias. Uma visita
//    nova com UTM troca a origem (último clique); sem UTM, a origem salva continua.
// 2. dataLayer: cria window.dataLayer e dispara os eventos do GA4 / Meta Pixel / Google Ads
//    com um event_id em cada um (view_item, add_to_cart, remove_from_cart, begin_checkout,
//    generate_lead e purchase). O GTM (quando a loja configurou) lê daqui.
// 3. CAPI: com a API de Conversões ligada na loja, manda os mesmos eventos (mesmo event_id)
//    para o servidor, que repete na Meta. O Pixel e o servidor contam uma vez só.
// 4. "Lembrar meus dados": depois do pedido, guarda o contato e um token aleatório do
//    navegador (nix_meus_dados) para preencher a maleta na próxima visita.
//
// Nada de dado pessoal vai para URL. E-mail e telefone só entram no dataLayer em SHA-256.
(function (raiz) {
  'use strict';

  const CHAVE_ORIGEM = 'nix_origem';
  const CHAVE_DADOS = 'nix_meus_dados';
  const CHAVE_CHECKOUT = 'nix_checkout_visto';
  const DIAS_ORIGEM = 30;
  const CAMPOS_UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  const CAMPOS_CLIQUE = ['fbclid', 'gclid'];
  const CAMPOS_CONTATO = ['nome', 'telefone', 'email', 'cep', 'numero', 'rua', 'bairro', 'cidade', 'complemento'];

  function guardar(storage, chave, valor) {
    try { storage.setItem(chave, JSON.stringify(valor)); } catch {}
  }
  function ler(storage, chave) {
    try { return JSON.parse(storage.getItem(chave)); } catch { return null; }
  }

  // event_id único (o mesmo vai para o dataLayer e para a CAPI)
  function novoEventId(c = raiz.crypto) {
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return 'ev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  // ---------- 1. Origem (UTMs) ----------
  // Origem que a URL traz, ou null quando ela não tem nenhum dos parâmetros.
  function origemDaUrl(href, referrer, agora = new Date()) {
    let url;
    try { url = new URL(href); } catch { return null; }
    const o = {};
    for (const campo of [...CAMPOS_UTM, ...CAMPOS_CLIQUE]) {
      const v = (url.searchParams.get(campo) || '').trim().slice(0, campo.endsWith('clid') ? 500 : 150);
      if (v) o[campo] = v;
    }
    if (!Object.keys(o).length) return null;
    o.landing_page = url.origin + url.pathname;
    if (referrer) {
      try { const r = new URL(referrer); if (r.host !== url.host) o.referrer = r.origin + r.pathname; } catch {}
    }
    o.capturado_em = agora.toISOString();
    return o;
  }

  // Guarda a origem da URL (se tiver) e devolve a origem que vale agora.
  function capturarOrigem(storage, href, referrer, agora = new Date()) {
    const nova = origemDaUrl(href, referrer, agora);
    if (nova) {
      guardar(storage, CHAVE_ORIGEM, nova);
      return nova;
    }
    const salva = ler(storage, CHAVE_ORIGEM);
    if (!salva || typeof salva !== 'object') return {};
    const idade = agora - new Date(salva.capturado_em || 0);
    if (!(idade >= 0 && idade < DIAS_ORIGEM * 86400000)) {
      try { storage.removeItem(CHAVE_ORIGEM); } catch {}
      return {};
    }
    return salva;
  }

  // ---------- Cookies da Meta (_fbp do Pixel, _fbc do clique no anúncio) ----------
  function lerCookie(texto, nome) {
    const m = String(texto || '').match(new RegExp('(?:^|;\\s*)' + nome + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  // _fbc: o cookie do Pixel ou, sem ele, montado com o fbclid guardado
  function idsMeta(cookies, origem) {
    const fbp = lerCookie(cookies, '_fbp');
    let fbc = lerCookie(cookies, '_fbc');
    if (!fbc && origem && origem.fbclid) fbc = 'fb.1.' + new Date(origem.capturado_em || Date.now()).getTime() + '.' + origem.fbclid;
    return { fbp, fbc };
  }

  // ---------- 2. dataLayer ----------
  // Item no formato do GA4 (item_id = SKU, o mesmo que a CAPI usa em content_ids)
  function itemGa4(p, extra = {}) {
    if (!p) return null;
    const item = {
      item_id: String(p.codigo_sku || p.sku || p.id),
      item_name: String(p.nome || ''),
      price: Number(p.preco) || 0,
      quantity: 1,
    };
    if (p.marca) item.item_brand = String(p.marca);
    if (p.categoria || p.tipo) item.item_category = String(p.categoria || p.tipo);
    if (p.cor) item.item_variant = String(p.cor);
    return Object.assign(item, extra);
  }

  function valorDe(itens) {
    return Math.round(itens.reduce((t, i) => t + Math.round((Number(i.price) || 0) * 100), 0)) / 100;
  }

  // Evento pronto para o dataLayer. `ecommerce` segue o GA4; event_id e origem ficam no topo
  // para as tags do Meta Pixel (deduplicação) e para relatórios.
  function montarEventoDataLayer(nome, itens, { eventId, origem, extra } = {}) {
    const lista = (itens || []).filter(Boolean);
    const ev = {
      event: nome,
      event_id: eventId || novoEventId(),
      ecommerce: { currency: 'BRL', value: valorDe(lista), items: lista },
    };
    if (origem && Object.keys(origem).length) {
      ev.traffic = {};
      for (const c of [...CAMPOS_UTM, ...CAMPOS_CLIQUE]) if (origem[c]) ev.traffic[c] = origem[c];
    }
    if (extra) Object.assign(ev.ecommerce, extra.ecommerce || {}), Object.assign(ev, extra.topo || {});
    return ev;
  }

  // ---------- 4. Lembrar os dados da cliente ----------
  function dadosSalvos(storage) {
    const d = ler(storage, CHAVE_DADOS);
    if (!d || typeof d !== 'object') return { visitante: '', contato: {} };
    const visitante = typeof d.visitante === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(d.visitante) ? d.visitante : '';
    const contato = {};
    for (const c of CAMPOS_CONTATO) if (d.contato && typeof d.contato[c] === 'string') contato[c] = d.contato[c].slice(0, 200);
    return { visitante, contato };
  }

  // lembrar=false: só o token do navegador fica (os dados pessoais saem do aparelho)
  function salvarDados(storage, visitante, contato, lembrar = true) {
    const limpo = {};
    if (lembrar) for (const c of CAMPOS_CONTATO) if (contato && typeof contato[c] === 'string' && contato[c].trim()) limpo[c] = contato[c].trim().slice(0, 200);
    guardar(storage, CHAVE_DADOS, { visitante: visitante || '', contato: limpo, salvo_em: new Date().toISOString() });
  }

  // SHA-256 em hex (crypto.subtle só existe em https/localhost; sem ele, devolve '')
  async function sha256(texto, c = raiz.crypto) {
    if (!texto || !c || !c.subtle) return '';
    const buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(texto));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function telefoneE164(v) {
    let d = String(v || '').replace(/\D/g, '').replace(/^0+/, '');
    if (d.length === 10 || d.length === 11) d = '55' + d;
    return d.length >= 12 && d.length <= 15 ? d : '';
  }
  // user_data com hash para as conversões avançadas (Google Ads) e correspondência
  // avançada do Pixel. Nunca o e-mail ou o telefone em texto.
  async function userDataComHash(contato) {
    const out = {};
    const email = String((contato && contato.email) || '').trim().toLowerCase();
    const tel = telefoneE164(contato && contato.telefone);
    const em = email ? await sha256(email) : '';
    const ph = tel ? await sha256(tel) : '';
    if (em) out.sha256_email_address = em;
    if (ph) out.sha256_phone_number = ph;
    return out;
  }

  // ---------- Ligação com a página ----------
  const w = raiz;
  const navegador = typeof w.window !== 'undefined' && typeof w.document !== 'undefined';
  let origemAtual = {};
  if (navegador) {
    w.dataLayer = w.dataLayer || [];
    try { origemAtual = capturarOrigem(w.localStorage, w.location.href, w.document.referrer); } catch {}
  }

  function capiLigada() {
    return !!(w.LOJA && w.LOJA.capi);
  }

  function rastroAtual() {
    const ids = navegador ? idsMeta(w.document.cookie, origemAtual) : {};
    return { origem: origemAtual, fbp: ids.fbp || undefined, fbc: ids.fbc || undefined };
  }

  // Manda o evento para o servidor repetir na CAPI (só com a CAPI ligada na loja).
  function enviarCapi(nome, eventId, produtoIds) {
    if (!navegador || !capiLigada() || typeof w.fetch !== 'function') return;
    const r = rastroAtual();
    const corpo = { evento: nome, event_id: eventId, produto_ids: produtoIds, url: w.location.origin + w.location.pathname,
      origem: r.origem, fbp: r.fbp, fbc: r.fbc, visitante: dadosSalvos(w.localStorage).visitante || undefined };
    try {
      w.fetch('/api/rastreamento/evento', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), keepalive: true })
        .catch(() => {});
    } catch {}
  }

  // Dispara no dataLayer (e na CAPI, para os eventos de navegação). Devolve o event_id.
  function disparar(nome, produtos, opcoes = {}) {
    const lista = (produtos || []).filter(Boolean);
    const ev = montarEventoDataLayer(nome, lista.map((p) => itemGa4(p)), { eventId: opcoes.eventId, origem: origemAtual, extra: opcoes.extra });
    if (navegador) {
      // Limpa o ecommerce anterior (recomendação do GA4 para não misturar itens)
      w.dataLayer.push({ ecommerce: null });
      w.dataLayer.push(ev);
    }
    if (opcoes.capi !== false && ['view_item', 'add_to_cart', 'begin_checkout'].includes(nome)) {
      enviarCapi(nome, ev.event_id, lista.map((p) => Number(p.id)).filter(Boolean));
    }
    return ev.event_id;
  }

  // begin_checkout uma vez por conteúdo da maleta na sessão (abrir e fechar a gaveta
  // várias vezes não conta como vários checkouts)
  function iniciarCheckout(itens) {
    if (!itens || !itens.length) return null;
    const chave = itens.map((i) => i.id).sort((a, b) => a - b).join(',');
    try {
      if (w.sessionStorage.getItem(CHAVE_CHECKOUT) === chave) return null;
      w.sessionStorage.setItem(CHAVE_CHECKOUT, chave);
    } catch {}
    return disparar('begin_checkout', itens);
  }

  // Pedido gravado: generate_lead e purchase com o MESMO event_id do servidor (CAPI Lead e
  // Purchase). transaction_id = nº do pedido.
  async function pedidoEnviado({ itens, eventId, pedidoId, contato }) {
    const userData = await userDataComHash(contato).catch(() => ({}));
    const topo = Object.keys(userData).length ? { user_data: userData } : {};
    const extra = { ecommerce: { transaction_id: pedidoId ? String(pedidoId) : eventId }, topo };
    disparar('generate_lead', itens, { eventId, extra, capi: false });
    disparar('purchase', itens, { eventId, extra, capi: false });
    try { w.sessionStorage.removeItem(CHAVE_CHECKOUT); } catch {}
  }

  const api = {
    novoEventId, origemDaUrl, capturarOrigem, lerCookie, idsMeta, itemGa4, montarEventoDataLayer,
    dadosSalvos, salvarDados, telefoneE164, userDataComHash,
    disparar, iniciarCheckout, pedidoEnviado, rastroAtual,
    origem: () => origemAtual,
  };
  if (navegador) w.NixRastreamento = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
