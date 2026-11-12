// Dados da loja de cada empresa (nome, textos da vitrine, logo e tipo de loja), guardados
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
// Tipo de loja (loja_nicho): troca os campos do produto e os textos de cada nicho.
//   oculos: provador virtual, medidas da armação, formato da lente, 🕶️ nas mensagens.
//   roupas: tamanhos (cada tamanho com o seu estoque), cor, tecido e categoria.
//   geral: só os campos comuns.
// Bancos de antes do nicho seguem o loja_oculos ('1' = oculos, '0' = geral).
// loja.oculos continua existindo (= nicho oculos) para quem só lê ele.
// Provador Virtual (loja_provador): chave de Configurações > Dados da loja, ligada por
// padrão. Desligada, a vitrine esconde o card, o pop-up e o botão "Provar virtualmente";
// as fotos (inclusive a foto 4 do provador) continuam salvas para religar depois.
const NICHOS = ['oculos', 'roupas', 'geral'];
// Instagram da loja (loja_instagram), de Configurações > Dados da loja: guardado só o
// usuário, sem @ (aceita "@loja", "loja" ou o link do perfil). Vazio = sem botão.
// O botão de WhatsApp do topo usa o número de pedidos (whatsapp_number); sem número, some.
// Produtos por linha na vitrine (loja_colunas_celular / loja_colunas_computador), de
// Configurações > Dados da loja. Padrão 3 no celular e 4 no computador (como sempre foi).
// No tablet (de 640px até 1023px) a vitrine usa o do celular, com no mínimo 3 e no
// máximo o do computador, para os cards não ficarem enormes nem espremidos.
const COLUNAS = {
  celular: { min: 1, max: 4, padrao: 3 },
  computador: { min: 2, max: 6, padrao: 4 },
};

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
  nicho: 'oculos',
  oculos: true,
  provador: true,
  colunas_celular: COLUNAS.celular.padrao,
  colunas_computador: COLUNAS.computador.padrao,
  instagram: '',
  whatsapp: '',
};

// Textos de partida de uma loja de roupas (só onde a empresa não escreveu os seus).
const TEXTOS_ROUPAS = {
  chamada: 'Moda para provar em casa',
  descricao: 'Escolha as peças e os tamanhos, receba a maleta e prove em casa antes de decidir.',
  sobre: 'Trabalhamos com o sistema de maleta: você escolhe as peças e os tamanhos, recebe em casa, prova com calma e fica só com o que gostar. O pedido é finalizado pelo WhatsApp.',
};

function lojaPadrao(empresa) {
  if ((empresa.padrao || empresa.legado) && (!empresa.nome || empresa.nome === PADRAO_NIX.nome)) return { ...PADRAO_NIX };
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
    nicho: 'geral',
    oculos: false,
    provador: true,
    colunas_celular: COLUNAS.celular.padrao,
    colunas_computador: COLUNAS.computador.padrao,
    instagram: '',
    whatsapp: '',
  };
}

// Usuário do Instagram a partir do que a loja digitou: '' (vazio), o usuário sem @, ou
// null quando não dá para entender (caracteres que o Instagram não aceita).
function lerInstagram(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return null;
  let t = v.trim();
  if (!t) return '';
  const link = t.match(/^(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/([^/?#\s]+)\/?(?:[?#].*)?$/i);
  if (link) t = link[1];
  t = t.replace(/^@/, '');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(t) || /^\.|\.$|\.\./.test(t)) return null;
  return t.toLowerCase();
}

// Número de produtos por linha válido para o aparelho ('celular' ou 'computador'), ou null.
function lerColunas(aparelho, v) {
  const { min, max } = COLUNAS[aparelho];
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// Colunas da grade da vitrine em cada largura de tela.
function colunasVitrine(loja) {
  const celular = lerColunas('celular', loja.colunas_celular) || COLUNAS.celular.padrao;
  const computador = lerColunas('computador', loja.colunas_computador) || COLUNAS.computador.padrao;
  return { celular, tablet: Math.min(computador, Math.max(celular, 3)), computador };
}

function lerNicho(v) {
  return NICHOS.includes(v) ? v : null;
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
  const oculosAntigo = salvo.get('loja_oculos');
  if (oculosAntigo === '1' || oculosAntigo === '0') loja.nicho = oculosAntigo === '1' ? 'oculos' : 'geral';
  loja.nicho = lerNicho(salvo.get('loja_nicho')) || loja.nicho;
  if (loja.nicho === 'roupas') Object.assign(loja, TEXTOS_ROUPAS);
  for (const campo of Object.keys(CAMPOS_TEXTO)) {
    const v = salvo.get('loja_' + campo);
    if (v) loja[campo] = v;
  }
  loja.oculos = loja.nicho === 'oculos';
  loja.provador = salvo.get('loja_provador') !== '0';
  for (const aparelho of Object.keys(COLUNAS)) {
    loja['colunas_' + aparelho] = lerColunas(aparelho, salvo.get('loja_colunas_' + aparelho)) || COLUNAS[aparelho].padrao;
  }
  loja.instagram = lerInstagram(salvo.get('loja_instagram')) || '';
  loja.whatsapp = String(salvo.get('whatsapp_number') || '').replace(/\D/g, '');
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

// Com 4 por linha no celular o card fica estreito: o selo (Disponível/Encomenda) diminui para caber.
const SELO_APERTADO = ' @media (max-width: 639px) { #catalogoGrid .selo-card { font-size: 7px; letter-spacing: 0; padding: 0.0625rem 0.25rem; gap: 0.125rem; } }';

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
  const publico = { nome: loja.nome, marca: loja.marca, oculos: loja.oculos, nicho: loja.nicho,
    instagram: loja.instagram || '', whatsapp: loja.whatsapp || '', provador: loja.provador !== false };
  // A grade da vitrine já sai com as colunas da loja (sem pular de 3 para outro número)
  const c = colunasVitrine(loja);
  const estilo = out.includes('id="catalogoGrid"')
    ? `  <style>:root { --colunas-celular: ${c.celular}; --colunas-tablet: ${c.tablet}; --colunas-computador: ${c.computador}; }${c.celular >= 4 ? SELO_APERTADO : ''}</style>\n`
    : '';
  return out.replace('</head>', `${estilo}  <script>window.LOJA = ${jsonParaScript(publico)};</script>\n</head>`);
}

module.exports = { CAMPOS_TEXTO, NICHOS, lerInstagram, COLUNAS, lerColunas, colunasVitrine, PADRAO_NIX, lojaPadrao, lerNicho, limparTextoLoja, montarLoja, renderizarPagina, escapeHtml };
