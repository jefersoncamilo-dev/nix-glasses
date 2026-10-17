// Dados da loja de cada empresa (nome, textos da vitrine, logo e recursos), guardados
// na tabela `configuracoes` do banco da própria empresa e editados no painel.
// As páginas (index.html e admin) saem do servidor já com os textos da loja: os
// elementos marcados com data-loja="campo" recebem o valor, e window.LOJA leva os
// mesmos dados para os scripts.

const CAMPOS_TEXTO = {
  nome: 100,
  marca: 30,
  complemento: 40,
  titulo: 120,
  chamada: 120,
  descricao: 300,
  sobre_titulo: 80,
  sobre: 2000,
};
// oculos: loja de óculos (provador virtual na vitrine, 🕶️ e "óculos" nas mensagens).
const RECURSOS = ['oculos'];

// Textos de hoje da Nix Glasses: a empresa padrão continua igual sem mexer em nada.
const PADRAO_NIX = {
  nome: 'Nix Glasses',
  marca: 'NIX',
  complemento: 'Glasses',
  titulo: 'Nix Glasses - Óculos de Sol Premium',
  chamada: 'Óculos que definem seu estilo',
  descricao: 'Design exclusivo, qualidade premium e proteção UV400. Escolha os modelos e prove em casa.',
  sobre_titulo: 'A Nix Glasses',
  sobre: [
    'Fundada com a paixão por design e proteção ocular, a Nix Glasses nasceu para oferecer óculos de sol que unem estilo, qualidade e tecnologia.',
    'Todos nossos modelos possuem lentes com proteção UV400, armações em acetato italiano ou metal premium, e passam por rigoroso controle de qualidade.',
    'Trabalhamos com o sistema de maleta: você experimenta em casa, escolhe seus favoritos e finaliza o pedido pelo WhatsApp.',
  ].join('\n\n'),
  oculos: true,
};

function lojaPadrao(empresa) {
  if (empresa.padrao && (!empresa.nome || empresa.nome === PADRAO_NIX.nome)) return { ...PADRAO_NIX };
  const nome = empresa.nome || empresa.slug;
  const [primeira, ...resto] = nome.split(/\s+/);
  return {
    nome,
    marca: primeira.toUpperCase().slice(0, CAMPOS_TEXTO.marca),
    complemento: resto.join(' ').slice(0, CAMPOS_TEXTO.complemento),
    titulo: nome,
    chamada: 'Escolha seus favoritos',
    descricao: 'Monte sua maleta com os produtos que quiser e finalize o pedido pelo WhatsApp.',
    sobre_titulo: 'Sobre nós',
    sobre: 'Trabalhamos com o sistema de maleta: você escolhe os produtos, recebe em casa e finaliza o pedido pelo WhatsApp.',
    oculos: false,
  };
}

// Texto de uma linha (ou com parágrafos, no "sobre"), sem espaços sobrando.
function limparTextoLoja(campo, v) {
  if (typeof v !== 'string') return null;
  const max = CAMPOS_TEXTO[campo];
  const t = campo === 'sobre'
    ? v.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n\n')
    : v.trim().replace(/\s+/g, ' ');
  return t.slice(0, max);
}

// Junta o que está salvo no banco (chaves loja_*) com os padrões da empresa.
function montarLoja(empresa, linhas) {
  const loja = lojaPadrao(empresa);
  const salvo = new Map(linhas.map((r) => [r.chave, r.valor]));
  for (const campo of Object.keys(CAMPOS_TEXTO)) {
    const v = salvo.get('loja_' + campo);
    if (v) loja[campo] = v;
  }
  for (const r of RECURSOS) {
    const v = salvo.get('loja_' + r);
    if (v === '1' || v === '0') loja[r] = v === '1';
  }
  loja.logo = salvo.get('loja_logo') || '';
  return loja;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// JSON seguro dentro de <script>: nada de "</script>" nem "<!--" vindo dos textos.
function jsonParaScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function renderizarPagina(html, loja) {
  let out = html.replace(
    /(<(\w+)\b[^>]*?\sdata-loja="(\w+)"(?:\s+data-loja-sufixo="([^"]*)")?[^>]*>)[^<]*(<\/\2>)/g,
    (m, abre, tag, campo, sufixo, fecha) =>
      (campo in CAMPOS_TEXTO ? abre + escapeHtml(loja[campo]) + (sufixo || '') + fecha : m)
  );
  out = out.replace(
    /(<div\b[^>]*\sdata-loja-paragrafos="sobre"[^>]*>)[\s\S]*?(<\/div>)/,
    (m, abre, fecha) => abre + loja.sobre.split('\n\n')
      .map((p, i, todos) => `<p${i < todos.length - 1 ? ' class="mb-4"' : ''} style="color:var(--nix-muted)">${escapeHtml(p)}</p>`)
      .join('') + fecha
  );
  out = out.replace(/\salt="NIX"/g, ` alt="${escapeHtml(loja.marca)}"`);
  const publico = { nome: loja.nome, marca: loja.marca, oculos: loja.oculos };
  return out.replace('</head>', `  <script>window.LOJA = ${jsonParaScript(publico)};</script>\n</head>`);
}

module.exports = { CAMPOS_TEXTO, RECURSOS, PADRAO_NIX, lojaPadrao, limparTextoLoja, montarLoja, renderizarPagina, escapeHtml };
