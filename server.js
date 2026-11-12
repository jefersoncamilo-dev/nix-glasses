require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const { criarPool, initTables } = require('./db');
const { lerEmpresas, empresaDoHost, normalizarHost, identidadeBanco, hostInterno } = require('./empresas');
const { CAMPOS_TEXTO, COLUNAS, lerColunas, lerInstagram, lerNicho, limparTextoLoja, montarLoja, renderizarPagina } = require('./loja');
const master = require('./master');
const { importarProduto, baixarImagem, ErroImportacao } = require('./importar-produto');
const { lerPedidoPdf, ErroPedidoPdf } = require('./pedido-fornecedor');
const usuariosAdmin = require('./usuarios-admin');
const conferenciaEstoque = require('./conferencia-estoque');
const vendas = require('./vendas');
const anuncios = require('./anuncios');
const rastreamento = require('./rastreamento');
const origens = require('./origens');
const filaEncomendas = require('./fila-encomendas');

const app = express();
const PORT = process.env.PORT || 3000;

// Empresas atendidas por este serviço (ver empresas.js). Cada uma com o seu banco.
// As das variáveis de ambiente se juntam, no boot, às cadastradas no painel master
// (master.js); a lista muda quando o master cria, edita ou remove uma loja.
// Banco só da plataforma (cadastro das lojas do painel master). Sem ele, o cadastro fica
// no banco da empresa padrão, como antes. Ver master.js.
const PLATAFORMA_DATABASE_URL = process.env.PLATAFORMA_DATABASE_URL || '';
// Com o banco da plataforma, as variáveis de loja só servem para a importação da primeira
// subida: depois dela, sobra de variável apagada pela metade não derruba o serviço.
let erroVariaveis = null;
const EMPRESAS_ENV = (() => {
  try {
    return lerEmpresas(process.env);
  } catch (err) {
    if (!PLATAFORMA_DATABASE_URL) throw err;
    erroVariaveis = err;
    return [];
  }
})();
const EMPRESAS = [];
if (!PLATAFORMA_DATABASE_URL && !EMPRESAS_ENV.length) throw new Error('Defina DATABASE_URL (ou PLATAFORMA_DATABASE_URL)');
const HOST_RENDER = normalizarHost(process.env.RENDER_EXTERNAL_HOSTNAME);
let poolCadastro = null;

// Endereços do painel master (ex.: admin.temcatalogo.com.br). Ele também abre no
// endereço do serviço no Render e em localhost, antes de o DNS estar pronto.
const MASTER_DOMINIOS = (() => {
  const r = master.lerDominios(process.env.MASTER_DOMINIOS || '');
  if (r.erro) throw new Error(`MASTER_DOMINIOS: ${r.erro}`);
  return r.dominios;
})();

app.use(cors());
app.use(express.json());

// Empresa da requisição pelo endereço (Host). Todas as rotas usam req.db, o banco dela.
function escolherEmpresa(req, res, next) {
  // O endereço do painel master nunca abre uma loja (nem a padrão, com uma loja só).
  req.empresa = MASTER_DOMINIOS.includes(normalizarHost(req.hostname)) ? null : empresaDoHost(EMPRESAS, req.hostname);
  if (!req.empresa) {
    return res.status(404).type('text').send('Loja não encontrada neste endereço.');
  }
  if (req.empresa.ativo === false) {
    return res.status(503).type('text').send('Loja temporariamente indisponível.');
  }
  if (req.empresa.erro || !req.empresa.pool) {
    return res.status(503).type('text').send('Loja indisponível no momento.');
  }
  req.db = req.empresa.pool;
  next();
}
// Health check do Render: responde antes de escolher a empresa, então não depende do endereço.
app.get('/saude', (req, res) => res.type('text').send('ok'));

// Painel master: /master/ e /api/master/* só nos endereços do master. No endereço
// próprio do master (admin.temcatalogo.com.br), "/" leva ao painel.
const masterRouter = express.Router({ strict: true });
function hostDoMaster(host) {
  const h = normalizarHost(host);
  return MASTER_DOMINIOS.includes(h) || hostInterno(h) || (!!HOST_RENDER && h === HOST_RENDER);
}
app.use((req, res, next) => {
  if (!hostDoMaster(req.hostname)) return next();
  if (req.path === '/' && MASTER_DOMINIOS.includes(normalizarHost(req.hostname))) return res.redirect(302, '/master/');
  masterRouter(req, res, next);
});
app.use(escolherEmpresa);

// Dados da loja (nome, textos, logo, recursos) por empresa, guardados em memória
// até o admin salvar de novo. Só um processo no Render, então o cache não fica velho.
const cacheLoja = new Map();
async function lojaDaEmpresa(empresa) {
  if (!cacheLoja.has(empresa.slug)) {
    const { rows } = await empresa.pool.query(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'loja\\_%' OR chave IN ('whatsapp_number', 'meta_capi_token')`);
    cacheLoja.set(empresa.slug, montarLoja(empresa, rows));
  }
  return cacheLoja.get(empresa.slug);
}

// Serve front-end estático (site público + admin) — necessário no Render.
// Só arquivos da lista abaixo saem da raiz: server.js, db.js, .env, package*.json,
// node_modules/ e scripts/ NUNCA podem ser servidos.
// As páginas HTML saem com os textos da loja da empresa (loja.js).
const PAGINAS = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/admin/', 'admin/index.html'],
  ['/admin/index.html', 'admin/index.html'],
  ['/admin/login.html', 'admin/login.html'],
  ['/admin/acerto.html', 'admin/acerto.html'],
]);
const cachePaginas = new Map();
async function servirPagina(req, res, next) {
  const arquivo = PAGINAS.get(req.path);
  if (!arquivo) return next();
  try {
    if (!cachePaginas.has(arquivo)) cachePaginas.set(arquivo, fs.readFileSync(path.join(__dirname, arquivo), 'utf8'));
    const html = renderizarPagina(cachePaginas.get(arquivo), await lojaDaEmpresa(req.empresa));
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  } catch (err) {
    next(err);
  }
}
app.get([...PAGINAS.keys()], servirPagina);

// Logo: a enviada no painel (no banco da empresa) ou, na empresa padrão, o logo.png do repositório.
// Os ícones do navegador (favicon) são os da Nix: as outras empresas ficam sem.
async function servirLogo(req, res, next) {
  try {
    const { logo } = await lojaDaEmpresa(req.empresa);
    if (logo) return res.redirect(302, logo);
  } catch (err) {
    return next(err);
  }
  if (!req.empresa.legado) return res.status(404).end();
  next();
}
app.get('/logo.png', servirLogo);
const PUBLIC_ROOT_FILES = new Set(['logo.png', 'favicon.ico', 'apple-touch-icon.png', 'robots.txt', 'rastreamento-vitrine.js']);
const SO_DA_PADRAO = new Set(['favicon.ico', 'apple-touch-icon.png']);
app.get('/:file', (req, res, next) => {
  if (!PUBLIC_ROOT_FILES.has(req.params.file)) return next();
  if (SO_DA_PADRAO.has(req.params.file) && !req.empresa.legado) return res.status(404).end();
  res.sendFile(path.join(__dirname, req.params.file), (err) => err && next());
});
app.use('/admin', express.static(path.join(__dirname, 'admin'), { index: false }));

// Só imagens comuns; SVG/HTML ficam de fora porque seriam servidos pelo mesmo domínio em /imagens.
// O tipo gravado vem da assinatura do arquivo (bytes iniciais), não do que o cliente declarou.
const TIPOS_IMAGEM = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TAMANHO_MAX_IMAGEM = 8 * 1024 * 1024; // 8 MB (fotos da câmera do celular cabem)
const MAX_FOTOS = 4;
// foto1..foto4 são as posições do formulário; `imagem` é o campo antigo (= foto1).
const CAMPOS_FOTO = Array.from({ length: MAX_FOTOS }, (_, i) => `foto${i + 1}`);
// Cores do cadastro (um produto por cor): a foto de cada cor vem em foto_cor_1, foto_cor_2...
const MAX_CORES = 20;
const CAMPOS_FOTO_COR = Array.from({ length: MAX_CORES }, (_, i) => `foto_cor_${i + 1}`);

function detectarTipoImagem(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANHO_MAX_IMAGEM, files: MAX_FOTOS + MAX_CORES },
  fileFilter: (req, file, cb) => {
    if (TIPOS_IMAGEM.has(file.mimetype)) return cb(null, true);
    const err = new Error('Formato de imagem não suportado. Use JPG, PNG ou WEBP.');
    err.status = 400;
    cb(err);
  },
});

// PDF do pedido do fornecedor (só lido na memória, não é gravado)
const TAMANHO_MAX_PDF = 15 * 1024 * 1024;
const pdfPedido = multer({ storage: multer.memoryStorage(), limits: { fileSize: TAMANHO_MAX_PDF, files: 1 } }).single('pdf');
function uploadPdfPedido(req, res, next) {
  pdfPedido(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `PDF muito grande (máximo ${TAMANHO_MAX_PDF / 1024 / 1024} MB)` : 'Envie um PDF só, no campo "pdf"' });
    }
    next(err);
  });
}

// Grava a imagem enviada na tabela `imagens` e devolve a URL pública (/imagens/<id>).
async function salvarImagem(db, file) {
  const id = crypto.randomBytes(16).toString('hex');
  await db.query(
    `INSERT INTO imagens (id, mime_type, dados) VALUES ($1, $2, $3)`,
    [id, file.tipoDetectado, file.buffer]
  );
  return `/imagens/${id}`;
}

function idDaImagem(url) {
  const m = /^\/imagens\/([0-9a-f]{32})$/.exec(String(url || ''));
  return m ? m[1] : null;
}

const camposUpload = upload.fields([
  { name: 'imagem', maxCount: 1 },
  ...CAMPOS_FOTO.map((name) => ({ name, maxCount: 1 })),
  ...CAMPOS_FOTO_COR.map((name) => ({ name, maxCount: 1 })),
]);

// Converte erros do upload em 400 com JSON (o admin mostra err.error no toast).
// Deixa em req.fotosEnviadas um array de 4 posições: o arquivo novo de cada foto ou null.
function uploadImagem(req, res, next) {
  camposUpload(req, res, (err) => {
    if (!err) {
      const arquivos = req.files || {};
      if (arquivos.imagem && arquivos.foto1) {
        return res.status(400).json({ error: 'Envie a foto 1 em "foto1" ou "imagem", não nos dois.' });
      }
      req.fotosEnviadas = CAMPOS_FOTO.map((campo, i) =>
        (arquivos[campo] || (i === 0 && arquivos.imagem) || [])[0] || null
      );
      // Foto de cada cor do cadastro, pela posição da cor (null = cor sem foto própria)
      req.fotosCores = CAMPOS_FOTO_COR.map((campo) => (arquivos[campo] || [])[0] || null);
      for (const file of [...req.fotosEnviadas, ...req.fotosCores]) {
        if (!file) continue;
        file.tipoDetectado = detectarTipoImagem(file.buffer);
        if (!file.tipoDetectado) {
          return res.status(400).json({ error: 'Arquivo não é uma imagem JPG, PNG ou WEBP válida.' });
        }
      }
      return next();
    }
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `Imagem muito grande (máximo ${TAMANHO_MAX_IMAGEM / 1024 / 1024} MB)`
        : err.code === 'LIMIT_FILE_COUNT'
          ? `No máximo ${MAX_FOTOS} fotos por produto (e uma por cor)`
          : 'Upload inválido';
      return res.status(400).json({ error: msg });
    }
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  });
}

// Configurações > POP Anúncio: a imagem do selo (`selo`) e a do pop-up (`imagem`)
const camposAnuncio = upload.fields([{ name: 'selo', maxCount: 1 }, { name: 'imagem', maxCount: 1 }]);
function uploadAnuncio(req, res, next) {
  camposAnuncio(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Imagem muito grande (máximo ${TAMANHO_MAX_IMAGEM / 1024 / 1024} MB)` : 'Envie no máximo uma imagem de selo e uma de anúncio' });
    }
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  });
}

// Fotos atuais de um produto, por posição (null = posição vazia); linhas gravadas
// antes da coluna `fotos` só têm imagem_url.
function fotosDoProduto(row) {
  if (Array.isArray(row.fotos) && row.fotos.length) return row.fotos.slice(0, MAX_FOTOS);
  return row.imagem_url ? [row.imagem_url] : [];
}

// Fotos 1 a 3 são a galeria (a 1ª é a capa); a foto 4 tem posição fixa porque, na
// loja de óculos, é a foto exclusiva do Provador Virtual. A galeria fica sem buracos
// (tirar a foto 1 promove a seguinte a capa); só com foto 4 ela é completada com null.
function organizarFotos(posicoes) {
  const galeria = posicoes.slice(0, MAX_FOTOS - 1).filter(Boolean);
  const quarta = posicoes[MAX_FOTOS - 1] || null;
  if (!quarta) return galeria;
  while (galeria.length < MAX_FOTOS - 1) galeria.push(null);
  return [...galeria, quarta];
}

// O que a vitrine recebe: na loja de óculos, `fotos` só com as fotos 1 a 3 e a foto 4
// à parte em `foto_provador` (o visitante nunca vê a foto 4). Nas outras lojas, as 4.
function fotosPublicas(row, oculos) {
  const posicoes = fotosDoProduto(row);
  if (!oculos) return { fotos: posicoes.filter(Boolean), foto_provador: null };
  return {
    fotos: posicoes.slice(0, MAX_FOTOS - 1).filter(Boolean),
    foto_provador: posicoes[MAX_FOTOS - 1] || null,
  };
}

// fotos_manter (multipart, JSON): até 4 posições com a URL atual a manter ou null para remover.
// undefined = campo ausente; false = valor inválido.
function lerFotosManter(raw) {
  if (raw === undefined) return undefined;
  let lista = raw;
  if (typeof raw === 'string') {
    try { lista = JSON.parse(raw); } catch { return false; }
  }
  if (!Array.isArray(lista) || lista.length > MAX_FOTOS) return false;
  if (lista.some((url) => url !== null && typeof url !== 'string')) return false;
  return lista;
}

// Sanitiza número de WhatsApp: remove tudo que não for dígito
function sanitizeWhatsapp(num) {
  if (typeof num !== 'string') return '';
  return num.replace(/\D/g, '');
}

// ---------- Auth admin (login + token, sem dependências externas) ----------
// Env: ADMIN_USER, ADMIN_PASS_HASH (formato salt:hashHex via scrypt), JWT_SECRET.
// Senha NUNCA é commitada: gere com `node scripts/generate-admin-hash.js "sua-senha-forte"`.
// Cada empresa tem o seu login (empresas.js). O segredo dos tokens é derivado por
// empresa, então o token do admin de uma loja não abre o painel de outra. A empresa
// padrão usa o JWT_SECRET puro, como antes (sessões abertas continuam valendo).
function getAuthConfig(empresa) {
  return {
    user: empresa.adminUser,
    passHash: empresa.adminPassHash,
  };
}

let _fallbackSecret = null;
function segredoBase() {
  const secret = process.env.JWT_SECRET || process.env.ADMIN_TOKEN_SECRET || '';
  if (secret) return secret;
  if (!_fallbackSecret) {
    _fallbackSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[auth] JWT_SECRET não definido: usando segredo aleatório (tokens invalidados a cada restart). Defina JWT_SECRET em produção.');
  }
  return _fallbackSecret;
}

function getTokenSecret(empresa) {
  if (empresa.legado) return segredoBase();
  return crypto.createHmac('sha256', segredoBase()).update(`empresa:${empresa.slug}`).digest('hex');
}

// Trocar o login de uma loja no painel master (sessao + 1) derruba as sessões abertas
// do admin dela. As contas de clientes da vitrine não mudam (usam getTokenSecret).
function getAdminTokenSecret(empresa) {
  if (!empresa.sessao) return getTokenSecret(empresa);
  return crypto.createHmac('sha256', getTokenSecret(empresa)).update(`sessao:${empresa.sessao}`).digest('hex');
}

function isAdminAuthEnabled(empresa) {
  const { user, passHash } = getAuthConfig(empresa);
  return !!(user && passHash);
}

function b64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

// ADMIN_PASS_HASH = saltHex:hashHex (scrypt, 64 bytes)
function verifyPassword(pass, stored) {
  try {
    const [saltHex, hashHex] = String(stored || '').split(':');
    if (!saltHex || !hashHex) return false;
    const derived = crypto.scryptSync(String(pass || ''), Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function assinarToken(secret, username, expiresInHours, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...extra, u: username, iat: now, exp: now + expiresInHours * 3600 };
  const body = b64urlEncode(payload);
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

function conferirToken(secret, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) throw new Error('Token inválido');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Token inválido');
  const payload = JSON.parse(b64urlDecode(body));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Sessão expirada');
  return payload;
}

// extra: { uid, s } nos tokens dos usuários cadastrados (sem uid = dono da loja).
function signToken(empresa, username, expiresInHours = 12, extra = {}) {
  return assinarToken(getAdminTokenSecret(empresa), username, expiresInHours, extra);
}

function verifyToken(empresa, token) {
  return conferirToken(getAdminTokenSecret(empresa), token);
}

// Token sem uid é do dono (login da loja ou entrada pelo painel master): acesso total.
// Token com uid é de um usuário de Configurações > Usuários: a cada pedido o servidor
// relê o usuário (desativado, excluído ou com senha nova = sessão derrubada) e as áreas.
async function requireAdmin(req, res, next) {
  // Sem ADMIN_USER/ADMIN_PASS_HASH configurados, o admin fica FECHADO (nunca aberto por padrão).
  if (!isAdminAuthEnabled(req.empresa)) {
    return res.status(503).json({ error: 'Admin não configurado (defina ADMIN_USER e ADMIN_PASS_HASH)' });
  }
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autorizado' });
  let payload;
  try {
    payload = verifyToken(req.empresa, token);
  } catch (e) {
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }
  if (payload.uid === undefined) {
    req.admin = { ...payload, dono: true, nome: '', permissoes: usuariosAdmin.AREAS.map((a) => a.chave) };
    return next();
  }
  try {
    const { rows } = await req.db.query(
      'SELECT id, nome, login, permissoes, ativo, sessao FROM admin_usuarios WHERE id = $1',
      [Number(payload.uid)]
    );
    const u = rows[0];
    if (!u || !u.ativo || u.sessao !== payload.s) {
      return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }
    req.admin = { ...payload, u: u.login, dono: false, nome: u.nome, permissoes: usuariosAdmin.lerPermissoes(u.permissoes) };
    return next();
  } catch (err) {
    console.error('Erro ao conferir o usuário do admin:', err);
    return res.status(500).json({ error: 'Erro ao conferir o acesso' });
  }
}

// Rotas admin: login + pelo menos uma das áreas (sem áreas = só o dono).
function exigirArea(...areas) {
  return [
    requireAdmin,
    (req, res, next) => {
      if (req.admin.dono || areas.some((a) => req.admin.permissoes.includes(a))) return next();
      return res.status(403).json({ error: areas.length ? 'Seu usuário não tem acesso a esta área' : 'Só o dono da loja pode fazer isso' });
    },
  ];
}
const soDono = exigirArea();

function handleAdminAtual(req, res) {
  res.json({
    user: req.admin.u,
    nome: req.admin.nome || '',
    dono: req.admin.dono,
    permissoes: req.admin.permissoes,
    areas: usuariosAdmin.AREAS,
  });
}

async function handleLogin(req, res) {
  const { user, username, password, pass } = req.body || {};
  const loginUser = String(user || username || '');
  const loginPass = String(password || pass || '');

  if (!isAdminAuthEnabled(req.empresa)) {
    return res.status(500).json({ error: 'Login admin não configurado (defina ADMIN_USER e ADMIN_PASS_HASH)' });
  }
  const cfg = getAuthConfig(req.empresa);
  const userOk =
    loginUser.length === String(cfg.user).length &&
    crypto.timingSafeEqual(Buffer.from(loginUser), Buffer.from(String(cfg.user)));
  if (userOk) {
    if (!verifyPassword(loginPass, cfg.passHash)) {
      // Resposta genérica para não vazar qual campo errou
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }
    const token = signToken(req.empresa, cfg.user);
    return res.json({ token, expiresIn: '12h', user: cfg.user, dono: true });
  }

  // Usuários cadastrados em Configurações > Usuários (login sem diferença de maiúsculas)
  const login = usuariosAdmin.normalizarLogin(loginUser);
  const chaveTentativas = `admin:${req.empresa.slug}:${login}`;
  if (loginBloqueado(chaveTentativas)) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
  }
  try {
    const { rows } = login
      ? await req.db.query('SELECT id, nome, login, senha_hash, ativo, sessao FROM admin_usuarios WHERE login = $1', [login])
      : { rows: [] };
    const u = rows[0];
    const ok = await conferirSenhaCliente(loginPass.slice(0, SENHA_MAX), u ? u.senha_hash : HASH_FALSO);
    if (!u || !ok || !u.ativo) {
      registrarFalhaLogin(chaveTentativas);
      return res.status(401).json({ error: u && ok ? 'Usuário desativado. Fale com o dono da loja.' : 'Usuário ou senha inválidos' });
    }
    tentativasLogin.delete(chaveTentativas);
    await req.db.query('UPDATE admin_usuarios SET ultimo_acesso = CURRENT_TIMESTAMP WHERE id = $1', [u.id]);
    const token = signToken(req.empresa, u.login, 12, { uid: u.id, s: u.sessao });
    res.json({ token, expiresIn: '12h', user: u.login, nome: u.nome, dono: false });
  } catch (err) {
    console.error('Erro no login do admin:', err);
    res.status(500).json({ error: 'Erro ao entrar' });
  }
}

// ---------- Login do painel master ----------
// Env: MASTER_USER e MASTER_PASS_HASH (mesmo formato do ADMIN_PASS_HASH). Precisa do
// JWT_SECRET de verdade: a chave que cifra os bancos das lojas sai dele, e um segredo
// aleatório a cada restart perderia os bancos cadastrados.
function masterHabilitado() {
  return !!(process.env.MASTER_USER && process.env.MASTER_PASS_HASH && process.env.JWT_SECRET);
}

// Trocar a senha do master (MASTER_PASS_HASH) derruba as sessões abertas do master.
function segredoMaster() {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`master:${process.env.MASTER_PASS_HASH}`).digest('hex');
}

function decifrarBanco(cifrado) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET não definido');
  return master.decifrar(cifrado, process.env.JWT_SECRET);
}

function requireMaster(req, res, next) {
  if (!masterHabilitado()) return res.status(503).json({ error: 'Painel master não configurado (defina MASTER_USER e MASTER_PASS_HASH)' });
  const h = req.headers.authorization || '';
  try {
    req.master = conferirToken(segredoMaster(), h.startsWith('Bearer ') ? h.slice(7) : '');
    return next();
  } catch {
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }
}

async function handleLoginMaster(req, res) {
  if (!masterHabilitado()) return res.status(503).json({ error: 'Painel master não configurado (defina MASTER_USER e MASTER_PASS_HASH)' });
  // Um freio só para o master: 10 senhas erradas a cada 15 minutos
  if (loginBloqueado('master')) return res.status(429).json({ error: 'Muitas tentativas. Espere 15 minutos.' });
  const { user, password } = req.body || {};
  const esperado = String(process.env.MASTER_USER);
  const userOk = String(user || '').length === esperado.length && crypto.timingSafeEqual(Buffer.from(String(user || '')), Buffer.from(esperado));
  const passOk = verifyPassword(password, process.env.MASTER_PASS_HASH);
  if (!userOk || !passOk) {
    registrarFalhaLogin('master');
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }
  res.json({ token: assinarToken(segredoMaster(), esperado, 12), expiresIn: '12h', user: esperado });
}

// ---------- Contas de clientes (vitrine) ----------
// Senha com scrypt (salt:hash, como o admin). O token do cliente é assinado com
// uma chave derivada só para clientes, então nunca passa no requireAdmin.
const scryptAsync = (senha, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(senha, salt, 64, (err, key) => (err ? reject(err) : resolve(key))));

async function hashSenhaCliente(senha) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${(await scryptAsync(String(senha), salt)).toString('hex')}`;
}

async function conferirSenhaCliente(senha, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const derivada = await scryptAsync(String(senha || ''), Buffer.from(saltHex, 'hex'));
  const esperada = Buffer.from(hashHex, 'hex');
  return derivada.length === esperada.length && crypto.timingSafeEqual(derivada, esperada);
}

// Usado quando o e-mail não existe, para o login levar o mesmo tempo nos dois casos
const HASH_FALSO = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

function chaveTokenCliente(empresa) {
  return crypto.createHmac('sha256', getTokenSecret(empresa)).update('nix-glasses:clientes').digest();
}

function assinarTokenCliente(empresa, id, dias = 30) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64urlEncode({ c: id, t: 'cliente', iat: now, exp: now + dias * 86400 });
  return `${body}.${crypto.createHmac('sha256', chaveTokenCliente(empresa)).update(body).digest('hex')}`;
}

function verificarTokenCliente(empresa, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) throw new Error('Token inválido');
  const a = Buffer.from(sig);
  const b = Buffer.from(crypto.createHmac('sha256', chaveTokenCliente(empresa)).update(body).digest('hex'));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Token inválido');
  const payload = JSON.parse(b64urlDecode(body));
  if (payload.t !== 'cliente' || !Number.isInteger(payload.c)) throw new Error('Token inválido');
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Sessão expirada');
  return payload;
}

function validarEmailCliente(email) {
  const e = typeof email === 'string' ? email.trim() : '';
  return e.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e) ? e.toLowerCase() : null;
}

const SENHA_MIN = 8;
const SENHA_MAX = 200;

// Freio de força bruta: 10 senhas erradas por e-mail a cada 15 minutos
const TENTATIVAS_MAX = 10;
const JANELA_TENTATIVAS_MS = 15 * 60 * 1000;
const tentativasLogin = new Map();

function loginBloqueado(email) {
  const t = tentativasLogin.get(email);
  if (t && Date.now() - t.inicio > JANELA_TENTATIVAS_MS) tentativasLogin.delete(email);
  return (tentativasLogin.get(email)?.falhas || 0) >= TENTATIVAS_MAX;
}

function registrarFalhaLogin(email) {
  if (tentativasLogin.size > 10000) {
    for (const [k, v] of tentativasLogin) if (Date.now() - v.inicio > JANELA_TENTATIVAS_MS) tentativasLogin.delete(k);
  }
  const t = tentativasLogin.get(email) || { inicio: Date.now(), falhas: 0 };
  t.falhas++;
  tentativasLogin.set(email, t);
}

const clientePublico = (row) => ({ id: row.id, email: row.email, nome: row.nome });

async function handleCadastroCliente(req, res) {
  const { email, senha, nome } = req.body || {};
  const emailOk = validarEmailCliente(email);
  if (!emailOk) return res.status(400).json({ error: 'E-mail inválido' });
  if (typeof senha !== 'string' || senha.length < SENHA_MIN || senha.length > SENHA_MAX) {
    return res.status(400).json({ error: `A senha precisa ter pelo menos ${SENHA_MIN} caracteres` });
  }
  const nomeOk = typeof nome === 'string' ? nome.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
  try {
    const { rows } = await req.db.query(
      `INSERT INTO clientes (email, nome, senha_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING RETURNING id, email, nome`,
      [emailOk, nomeOk, await hashSenhaCliente(senha)]
    );
    if (!rows.length) return res.status(409).json({ error: 'Já existe uma conta com este e-mail. Faça login.' });
    res.status(201).json({ token: assinarTokenCliente(req.empresa, rows[0].id), cliente: clientePublico(rows[0]) });
  } catch (err) {
    console.error('Erro ao cadastrar cliente:', err);
    res.status(500).json({ error: 'Erro ao criar conta' });
  }
}

async function handleLoginCliente(req, res) {
  const { email, senha } = req.body || {};
  const emailOk = validarEmailCliente(email);
  if (!emailOk || typeof senha !== 'string') return res.status(401).json({ error: 'E-mail ou senha inválidos' });
  const chaveTentativas = `${req.empresa.slug}:${emailOk}`;
  if (loginBloqueado(chaveTentativas)) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
  }
  try {
    const { rows } = await req.db.query('SELECT id, email, nome, senha_hash FROM clientes WHERE email = $1', [emailOk]);
    const ok = await conferirSenhaCliente(senha.slice(0, SENHA_MAX), rows[0] ? rows[0].senha_hash : HASH_FALSO);
    if (!rows[0] || !ok) {
      registrarFalhaLogin(chaveTentativas);
      return res.status(401).json({ error: 'E-mail ou senha inválidos' });
    }
    tentativasLogin.delete(chaveTentativas);
    res.json({ token: assinarTokenCliente(req.empresa, rows[0].id), cliente: clientePublico(rows[0]) });
  } catch (err) {
    console.error('Erro no login do cliente:', err);
    res.status(500).json({ error: 'Erro ao entrar' });
  }
}

async function handleClienteAtual(req, res) {
  const h = req.headers.authorization || '';
  let payload;
  try {
    payload = verificarTokenCliente(req.empresa, h.startsWith('Bearer ') ? h.slice(7) : '');
  } catch {
    return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }
  try {
    const { rows } = await req.db.query('SELECT id, email, nome FROM clientes WHERE id = $1', [payload.c]);
    if (!rows.length) return res.status(401).json({ error: 'Conta não encontrada' });
    res.json({ cliente: clientePublico(rows[0]) });
  } catch (err) {
    console.error('Erro ao buscar cliente:', err);
    res.status(500).json({ error: 'Erro ao buscar conta' });
  }
}

// ---------- Pedidos da maleta ----------
const MAX_ITENS_PEDIDO = 100;

// Id do cliente logado (token de cliente no Authorization), ou null. Token
// inválido/expirado não impede o pedido: só não liga à conta.
function clienteDoToken(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    return verificarTokenCliente(req.empresa, h.slice(7)).c;
  } catch {
    return null;
  }
}

function textoCurto(v, max) {
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

// Link do produto na loja do fornecedor: '' (sem link), a URL normalizada, ou null se
// inválido. Só http/https: o painel abre esse link, então javascript:/data: nunca entram.
const MAX_LINK_FORNECEDOR = 1000;
function lerLinkFornecedor(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return '';
  if (t.length > MAX_LINK_FORNECEDOR) return null;
  try {
    const u = new URL(t);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null;
    const href = u.href;
    return href.length <= MAX_LINK_FORNECEDOR ? href : null;
  } catch {
    return null;
  }
}

// Especificações técnicas: medidas em cm ("5,0", "5.0", "5 cm" ou número).
// Devolve null (vazio), o número com uma casa decimal, ou NaN se inválido.
const MEDIDAS_CM = [
  ['diametro_cm', 'Diâmetro'],
  ['ponte_cm', 'Ponte'],
  ['largura_total_cm', 'Largura total'],
];
function lerMedidaCm(v) {
  if (v === undefined || v === null) return null;
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const t = v.trim().replace(/\s*cm$/i, '').replace(',', '.');
    if (!t) return null;
    if (!/^\d{1,2}(\.\d+)?$/.test(t)) return NaN;
    n = Number(t);
  } else return NaN;
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return NaN;
  return Math.round(n * 10) / 10;
}

// Gênero do produto: MASCULINO, FEMININO, UNISSEX ou '' (não informado).
// Aceita o texto da planilha ("Masculino", "unisex"...). Inválido -> null.
const GENEROS = ['MASCULINO', 'FEMININO', 'UNISSEX'];
function lerGenero(v) {
  const t = String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  if (!t) return '';
  if (/^masc/.test(t)) return 'MASCULINO';
  if (/^fem/.test(t)) return 'FEMININO';
  if (/^unis+e?x/.test(t)) return 'UNISSEX';
  return null;
}

// Tamanho da roupa: letras em maiúsculas (p -> P, gg -> GG); o resto como veio ("38", "Único").
function lerTamanho(v) {
  const t = textoCurto(v, 20);
  return /^[a-z]{1,4}$/i.test(t) ? t.toUpperCase() : t;
}

// Campos de especificação vindos do formulário/lote (e o nome curto do card, que
// segue o mesmo caminho). Só inclui os enviados (o PUT não mexe no que não veio).
// `erro` = a 1ª medida inválida.
function lerEspecificacoes(body) {
  const espec = {};
  let erro = null;
  for (const [campo, rotulo] of MEDIDAS_CM) {
    if (body[campo] === undefined) continue;
    const v = lerMedidaCm(body[campo]);
    if (Number.isNaN(v)) erro = erro || { campo, mensagem: `${rotulo} inválido (em cm, ex.: 5,0)` };
    else espec[campo] = v;
  }
  if (body.material !== undefined) espec.material = textoCurto(body.material, 60);
  if (body.tipo !== undefined) espec.tipo = textoCurto(body.tipo, 100);
  if (body.nome_curto !== undefined) espec.nome_curto = textoCurto(body.nome_curto, 80);
  if (body.tamanho !== undefined) espec.tamanho = lerTamanho(body.tamanho);
  if (body.grade !== undefined) espec.grade = textoCurto(body.grade, 100);
  if (body.genero !== undefined) {
    const g = lerGenero(body.genero);
    if (g === null) erro = erro || { campo: 'genero', mensagem: 'Gênero inválido (Masculino, Feminino ou Unissex)' };
    else espec.genero = g;
  }
  return { espec, erro };
}

// Cadastro em lote: confere uma linha e devolve o produto já normalizado.
// Mesmas regras do formulário do painel (nome, SKU e preços obrigatórios).
const STATUS_PRODUTO = ['DISPONIVEL', 'CONDICIONAL', 'ESGOTADO'];
const DISPONIBILIDADES_PRODUTO = ['PRONTA_ENTREGA', 'SOB_ENCOMENDA'];
const MAX_LOTE = 100;

function lerPrecoLote(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string' || !/^\s*\d+(\.\d{1,2})?\s*$/.test(v)) return NaN;
  return Number(v);
}

function validarProdutoLote(linha) {
  const l = linha && typeof linha === 'object' ? linha : {};
  const erros = [];
  const produto = {
    nome: textoCurto(l.nome, 255),
    codigo_sku: textoCurto(l.codigo_sku, 100),
    fornecedor: textoCurto(l.fornecedor, 120),
    codigo_fornecedor: textoCurto(l.codigo_fornecedor, 100),
    nome_fornecedor: textoCurto(l.nome_fornecedor, 255),
    link_fornecedor: lerLinkFornecedor(l.link_fornecedor),
    preco_custo: lerPrecoLote(l.preco_custo),
    preco_venda: lerPrecoLote(l.preco_venda),
    status: l.status || 'DISPONIVEL',
    disponibilidade: l.disponibilidade || 'PRONTA_ENTREGA',
    formato: textoCurto(l.formato, 100) || null,
    estilo: textoCurto(l.estilo, 100) || null,
    cor_armacao: textoCurto(l.cor_armacao, 100) || null,
    quantidade: lerQuantidade(l.quantidade),
    pedido_fornecedor: textoCurto(l.pedido_fornecedor, 60),
    data_compra: lerDataCompra(l.data_compra),
    // Conferido no painel como produto diferente: o mesmo cód. do fornecedor não junta
    cadastrar_novo: l.cadastrar_novo === true,
    // Importado pelo link: fica fora da vitrine até ser liberado no painel
    em_conferencia: l.em_conferencia === true,
    // Cor cadastrada esgotada ou sob encomenda, sem peça na loja: estoque inicial 0
    sem_estoque: l.sem_estoque === true,
  };
  const { espec, erro: erroEspec } = lerEspecificacoes(l);
  Object.assign(produto, { diametro_cm: null, ponte_cm: null, largura_total_cm: null, material: '', tipo: '', nome_curto: '', genero: '', tamanho: '', grade: '' }, espec);
  if (erroEspec) erros.push(erroEspec);
  if (!produto.nome) erros.push({ campo: 'nome', mensagem: 'Informe o nome' });
  if (!produto.codigo_sku) erros.push({ campo: 'codigo_sku', mensagem: 'Informe o SKU' });
  if (produto.link_fornecedor === null) erros.push({ campo: 'link_fornecedor', mensagem: 'Link inválido (use http:// ou https://)' });
  for (const campo of ['preco_custo', 'preco_venda']) {
    const v = produto[campo];
    if (!Number.isFinite(v) || v < 0 || v >= 1e8) erros.push({ campo, mensagem: 'Preço inválido' });
  }
  if (!STATUS_PRODUTO.includes(produto.status)) erros.push({ campo: 'status', mensagem: 'Status inválido' });
  if (!DISPONIBILIDADES_PRODUTO.includes(produto.disponibilidade)) erros.push({ campo: 'disponibilidade', mensagem: 'Disponibilidade inválida' });
  if (produto.quantidade === false || produto.quantidade === 0) erros.push({ campo: 'quantidade', mensagem: 'Quantidade inválida (número inteiro a partir de 1)' });
  if (produto.data_compra === false) erros.push({ campo: 'data_compra', mensagem: 'Data inválida (use DD/MM/AAAA)' });
  return { produto, erros };
}

// Quantidade de peças: vazio = null (não informada), inteiro de 0 a 100000, senão false.
function lerQuantidade(v) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = typeof v === 'number' ? v : /^\s*\d{1,6}\s*$/.test(String(v)) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : false;
}

// Grade de tamanhos do cadastro de roupas: [{ tamanho, estoque }] (ou o JSON dela, vindo
// do formulário). Vazio = null (produto único), inválida = false. Tamanhos repetidos
// não entram (cada um vira um produto com SKU próprio).
const MAX_TAMANHOS = 30;
function lerGradeTamanhos(v) {
  if (v === undefined || v === null || v === '') return null;
  let lista = v;
  if (typeof v === 'string') {
    try { lista = JSON.parse(v); } catch { return false; }
  }
  if (!Array.isArray(lista) || lista.length === 0 || lista.length > MAX_TAMANHOS) return false;
  const vistos = new Set();
  const grade = [];
  for (const item of lista) {
    const tamanho = lerTamanho(item && item.tamanho);
    const estoque = lerQuantidade(item && item.estoque);
    if (!tamanho || estoque === false || vistos.has(tamanho.toLowerCase())) return false;
    vistos.add(tamanho.toLowerCase());
    grade.push({ tamanho, estoque: estoque ?? 0 });
  }
  return grade;
}

// Cores do cadastro: [{ cor, estoque }] (ou o JSON dela). Cada cor vira um produto com o
// seu estoque, a sua foto e SKU próprio. Vazio = null (produto único), inválida = false.
function lerCores(v) {
  if (v === undefined || v === null || v === '') return null;
  let lista = v;
  if (typeof v === 'string') {
    try { lista = JSON.parse(v); } catch { return false; }
  }
  if (!Array.isArray(lista) || lista.length === 0 || lista.length > MAX_CORES) return false;
  const vistos = new Set();
  const cores = [];
  for (const item of lista) {
    const cor = textoCurto(item && item.cor, 100);
    const estoque = lerQuantidade(item && item.estoque);
    // Disponibilidade da cor: Disponível (pronta entrega), Sob Encomenda ou Esgotado (estoque 0).
    // Sem ela, a cor segue a disponibilidade do produto.
    const disp = item && item.disponibilidade ? String(item.disponibilidade) : '';
    if (!cor || estoque === false || vistos.has(cor.toLowerCase()) || (disp && !['PRONTA_ENTREGA', 'SOB_ENCOMENDA', 'ESGOTADO'].includes(disp))) return false;
    vistos.add(cor.toLowerCase());
    cores.push({ cor, estoque: disp === 'ESGOTADO' ? 0 : estoque ?? 0, disponibilidade: disp === 'ESGOTADO' ? 'PRONTA_ENTREGA' : disp });
  }
  return cores;
}

// Pedaço do SKU de uma cor: "Azul-claro" -> "AZUL-CLARO", "Café" -> "CAFE"
function skuDaCor(cor) {
  return String(cor).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'COR';
}

// Cadastro vindo da importação pelo link (em_conferencia = "true"): os produtos criados
// ficam fora da vitrine até serem liberados no painel. Atualiza a lista `criados`.
async function marcarEmConferencia(client, flag, criados) {
  if (!(flag === true || flag === 'true') || !criados.length) return;
  await client.query('UPDATE produtos SET em_conferencia = true WHERE id = ANY($1)', [criados.map((p) => p.id)]);
  criados.forEach((p) => { p.em_conferencia = true; });
}

// Data da compra em AAAA-MM-DD ou DD/MM/AAAA: vazio = null, inválida = false.
function lerDataCompra(v) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
  const t = String(v).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const [a, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : br ? [+br[3], +br[2], +br[1]] : [];
  if (!a) return false;
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || a < 2000) return false;
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Lote: Map índice -> { campo, motivo } das linhas a ignorar por duplicidade.
// SKU compara sem diferenciar maiúsculas; código do fornecedor só conta dentro do
// mesmo fornecedor (dois fornecedores podem usar o mesmo código) e quando preenchido.
// `existentes`: linhas do banco com sku, fornecedor e codigo já em minúsculas.
function encontrarDuplicadosLote(produtos, existentes) {
  const chaveForn = (fornecedor, codigo) => `${fornecedor}\u0000${codigo}`;
  const skusBanco = new Set(existentes.map((r) => r.sku));
  const codigosBanco = new Set(existentes.filter((r) => r.codigo).map((r) => chaveForn(r.fornecedor, r.codigo)));
  const skusLote = new Map();
  const codigosLote = new Map();
  const duplicados = new Map();
  produtos.forEach((p, i) => {
    const sku = p.codigo_sku.toLowerCase();
    const codigo = p.codigo_fornecedor && !p.cadastrar_novo ? chaveForn(p.fornecedor.toLowerCase(), p.codigo_fornecedor.toLowerCase()) : '';
    let dup = null;
    if (skusBanco.has(sku)) dup = { campo: 'codigo_sku', motivo: 'SKU já cadastrado' };
    else if (codigo && codigosBanco.has(codigo)) dup = { campo: 'codigo_fornecedor', motivo: 'Cód. fornecedor já cadastrado' };
    else if (skusLote.has(sku)) dup = { campo: 'codigo_sku', motivo: `SKU repetido na linha ${skusLote.get(sku) + 1}` };
    else if (codigo && codigosLote.has(codigo)) dup = { campo: 'codigo_fornecedor', motivo: `Cód. fornecedor repetido na linha ${codigosLote.get(codigo) + 1}` };
    if (dup) return duplicados.set(i, dup);
    skusLote.set(sku, i);
    if (codigo) codigosLote.set(codigo, i);
  });
  return duplicados;
}

// Ao cadastrar um produto, o custo informado vira a 1ª compra do histórico de reposição.
async function registrarCompraCadastro(db, produto, compra = {}) {
  await db.query(
    `INSERT INTO compras_fornecedor (produto_id, fornecedor, preco_custo, quantidade, origem, data_compra, pedido_fornecedor)
     VALUES ($1, $2, $3, $4, 'CADASTRO', COALESCE($5::date, CURRENT_DATE), $6)`,
    [produto.id, produto.fornecedor || '', produto.preco_custo, compra.quantidade || 1, compra.data || null, compra.pedido || '']
  );
}

// Reposição: registra a compra (custo unitário, quantidade, data e nº do pedido no
// fornecedor), soma as peças no estoque e o custo do produto passa a ser o da
// compra mais recente. O cadastro (nome, SKU, preço de venda) não muda.
async function reporEstoque(db, produtoId, { custo, quantidade, data, pedido }) {
  const compra = await db.query(
    `INSERT INTO compras_fornecedor (produto_id, fornecedor, preco_custo, quantidade, origem, data_compra, pedido_fornecedor)
     SELECT id, fornecedor, $2, $3, 'REPOSICAO', COALESCE($4::date, CURRENT_DATE), $5 FROM produtos WHERE id = $1
     RETURNING id, fornecedor, preco_custo, quantidade, origem, to_char(data_compra, 'YYYY-MM-DD') AS data_compra, pedido_fornecedor, created_at`,
    [produtoId, custo, quantidade, data || null, pedido || '']
  );
  // Comprou de novo um produto arquivado: ele volta para a lista (e para a vitrine)
  await db.query(
    `UPDATE produtos SET
       estoque = estoque + $2, arquivado = false, arquivado_em = NULL,
       preco_custo = (SELECT preco_custo FROM compras_fornecedor WHERE produto_id = $1 ORDER BY data_compra DESC, id DESC LIMIT 1)
     WHERE id = $1`,
    [produtoId, quantidade]
  );
  const [produto] = await recalcularStatus(db, [produtoId]);
  return { compra: compra.rows[0], produto };
}

// Grava as linhas já validadas do cadastro em lote (dentro da transação de quem
// chama): produto novo, reposição (duplicado com Quantidade) ou ignorado.
// Usado pelo Cadastro em Lote e pelo lançamento do pedido do fornecedor.
async function gravarLote(client, produtos) {
  const existentes = await client.query(
    `SELECT lower(codigo_sku) AS sku, lower(fornecedor) AS fornecedor, lower(codigo_fornecedor) AS codigo
     FROM produtos
     WHERE lower(codigo_sku) = ANY($1) OR (codigo_fornecedor <> '' AND lower(codigo_fornecedor) = ANY($2))`,
    [produtos.map((p) => p.codigo_sku.toLowerCase()), produtos.map((p) => p.codigo_fornecedor.toLowerCase()).filter(Boolean)]
  );
  const duplicados = encontrarDuplicadosLote(produtos, existentes.rows);
  const ignorados = [];
  const repostos = [];

  const criados = [];
  for (const [i, p] of produtos.entries()) {
    const dup = duplicados.get(i);
    const compra = { quantidade: p.quantidade || 1, data: p.data_compra, pedido: p.pedido_fornecedor };
    if (dup && p.quantidade) {
      // Mesmo SKU primeiro; senão o mesmo código do mesmo fornecedor (pode ser um produto criado linhas acima)
      const alvo = (await client.query(
        `SELECT id FROM produtos
         WHERE lower(codigo_sku) = lower($1) OR ($2 <> '' AND lower(codigo_fornecedor) = lower($2) AND lower(fornecedor) = lower($3))
         ORDER BY (lower(codigo_sku) = lower($1)) DESC, id LIMIT 1 FOR UPDATE`,
        [p.codigo_sku, p.codigo_fornecedor, p.fornecedor]
      )).rows[0];
      if (alvo) {
        const r = await reporEstoque(client, alvo.id, { custo: p.preco_custo, ...compra });
        repostos.push({ linha: i, id: r.produto.id, nome: r.produto.nome, codigo_sku: r.produto.codigo_sku, quantidade: p.quantidade, estoque: r.produto.estoque });
        continue;
      }
    }
    if (dup) {
      ignorados.push({ linha: i, codigo_sku: p.codigo_sku, codigo_fornecedor: p.codigo_fornecedor, ...dup });
      continue;
    }
    // ON CONFLICT cobre outro cadastro do mesmo SKU entre a checagem e o INSERT
    const r = await client.query(
      `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, status, disponibilidade, formato, estilo, cor_armacao, fornecedor, codigo_fornecedor, link_fornecedor,
                             diametro_cm, ponte_cm, largura_total_cm, material, tipo, nome_curto, genero, estoque, tamanho, grade, nome_fornecedor, em_conferencia)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
       ON CONFLICT (codigo_sku) DO NOTHING
       RETURNING *`,
      [p.nome, p.codigo_sku, p.preco_custo, p.preco_venda, p.status, p.disponibilidade, p.formato, p.estilo, p.cor_armacao, p.fornecedor, p.codigo_fornecedor, p.link_fornecedor,
        p.diametro_cm, p.ponte_cm, p.largura_total_cm, p.material, p.tipo, p.nome_curto, p.genero, p.sem_estoque ? 0 : compra.quantidade, p.tamanho, p.grade, p.nome_fornecedor, p.em_conferencia === true]
    );
    if (!r.rows.length) {
      ignorados.push({ linha: i, codigo_sku: p.codigo_sku, codigo_fornecedor: p.codigo_fornecedor, campo: 'codigo_sku', motivo: 'SKU já cadastrado' });
      continue;
    }
    // Cor sem peça (esgotada ou sob encomenda): nada foi comprado
    if (!p.sem_estoque) await registrarCompraCadastro(client, r.rows[0], compra);
    if (p.status !== 'DISPONIVEL') await aplicarStatusManual(client, r.rows[0].id, p.status);
    criados.push((await recalcularStatus(client, [r.rows[0].id]))[0]);
  }
  ignorados.sort((x, y) => x.linha - y.linha);
  return { criados, repostos, ignorados };
}

// Status sai das contas: peça na loja (estoque) = DISPONIVEL; só em maletas =
// CONDICIONAL; nenhuma = ESGOTADO. pedido_condicional_id fica com a maleta mais
// antiga da peça, para as telas que mostram uma só.
async function recalcularStatus(db, ids) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `UPDATE produtos p SET
       status = CASE WHEN p.estoque > 0 THEN 'DISPONIVEL' WHEN m.qtd > 0 THEN 'CONDICIONAL' ELSE 'ESGOTADO' END,
       pedido_condicional_id = m.pedido_id,
       updated_at = CURRENT_TIMESTAMP
     FROM (SELECT x.id,
                  (SELECT COUNT(*) FROM maleta_pecas mp WHERE mp.produto_id = x.id) AS qtd,
                  (SELECT mp.pedido_id FROM maleta_pecas mp WHERE mp.produto_id = x.id ORDER BY mp.id LIMIT 1) AS pedido_id
           FROM produtos x WHERE x.id = ANY($1)) m
     WHERE p.id = m.id
     RETURNING p.*`,
    [ids]
  );
  return rows;
}

// Status escolhido à mão (painel, lote): ESGOTADO zera tudo; DISPONIVEL traz de
// volta as peças das maletas (ao menos uma na loja); CONDICIONAL tira uma peça da
// loja para uma maleta sem pedido, se ainda não houver peça fora.
async function aplicarStatusManual(db, produtoId, status) {
  if (status === 'ESGOTADO') {
    await db.query('DELETE FROM maleta_pecas WHERE produto_id = $1', [produtoId]);
    await db.query('UPDATE produtos SET estoque = 0 WHERE id = $1', [produtoId]);
  } else if (status === 'DISPONIVEL') {
    const fora = (await db.query('DELETE FROM maleta_pecas WHERE produto_id = $1 RETURNING id', [produtoId])).rowCount;
    await db.query('UPDATE produtos SET estoque = GREATEST(estoque + $2, 1) WHERE id = $1', [produtoId, fora]);
  } else if (status === 'CONDICIONAL') {
    const fora = (await db.query('SELECT 1 FROM maleta_pecas WHERE produto_id = $1 LIMIT 1', [produtoId])).rowCount;
    if (!fora) {
      await db.query('INSERT INTO maleta_pecas (produto_id) VALUES ($1)', [produtoId]);
      await db.query('UPDATE produtos SET estoque = GREATEST(estoque - 1, 0) WHERE id = $1', [produtoId]);
    }
  }
}

// Tira uma peça do produto da maleta (acerto): de preferência a da maleta do
// pedido informado, senão a mais antiga. Devolve true se havia peça fora.
async function tirarDaMaleta(db, produtoId, pedidoId) {
  const r = await db.query(
    `DELETE FROM maleta_pecas WHERE id = (
       SELECT id FROM maleta_pecas WHERE produto_id = $1
       ORDER BY COALESCE(pedido_id = $2::int, false) DESC, id LIMIT 1 FOR UPDATE
     ) RETURNING id`,
    [produtoId, pedidoId]
  );
  return r.rowCount > 0;
}

// Monta o pedido a partir das linhas de produtos do banco (preço e encomenda
// nunca vêm do navegador). Sinal = 50% por item, arredondado como na vitrine.
// intencoes: Map produto_id -> 'COMPRA' | 'CONDICIONAL' escolhido no carrinho.
// Sob encomenda é sempre ENCOMENDA; pronta entrega sem escolha vai para a maleta.
function montarPedido(produtos, contato, intencoes = new Map()) {
  const c = contato && typeof contato === 'object' ? contato : {};
  const centavos = v => Math.round(Number(v) * 100);
  const itens = produtos.map(p => {
    const encomenda = p.disponibilidade === 'SOB_ENCOMENDA';
    // Em promoção com preço promocional, o pedido cobra o promocional e guarda o preço de
    // antes (preco_normal) para o painel mostrar o desconto
    const normal = centavos(p.preco_venda) / 100;
    const promo = p.preco_promocional === null || p.preco_promocional === undefined ? null : centavos(p.preco_promocional) / 100;
    const preco = promo !== null && promo > 0 && promo < normal ? promo : normal;
    const intencao = encomenda ? 'ENCOMENDA' : intencoes.get(p.id) === 'COMPRA' ? 'COMPRA' : 'CONDICIONAL';
    const item = { produto_id: p.id, nome: p.nome, codigo_sku: p.codigo_sku, preco, encomenda, sinal: encomenda ? Math.round(preco * 50) / 100 : 0, intencao };
    if (preco < normal) item.preco_normal = normal;
    return item;
  });
  const soma = (lista, campo) => lista.reduce((t, i) => t + centavos(i[campo]), 0) / 100;
  const prova = itens.filter(i => i.intencao === 'CONDICIONAL');
  const compras = itens.filter(i => i.intencao === 'COMPRA');
  const encomendas = itens.filter(i => i.encomenda);
  const rua = textoCurto(c.rua, 150);
  const numero = textoCurto(c.numero, 20);
  const bairro = textoCurto(c.bairro, 100);
  const cidade = textoCurto(c.cidade, 100);
  const complemento = textoCurto(c.complemento, 100);
  const cep = textoCurto(c.cep, 12);
  let endereco = [rua && numero ? `${rua}, ${numero}` : rua || numero, bairro, cidade].filter(Boolean).join(' - ');
  if (complemento) endereco += ` (${complemento})`;
  if (cep) endereco += ` CEP ${cep}`;
  return {
    nome: textoCurto(c.nome, 100),
    telefone: textoCurto(c.telefone, 30),
    endereco: endereco.trim(),
    itens,
    totalProva: soma(prova, 'preco'),
    totalCompra: soma(compras, 'preco'),
    totalEncomendas: soma(encomendas, 'preco'),
    sinal: soma(encomendas, 'sinal'),
    total: soma(itens, 'preco'),
  };
}

// Intenção de um item gravado no pedido. Pedidos antigos (sem o campo): encomenda
// ou peça para provar na maleta.
const INTENCOES = ['COMPRA', 'CONDICIONAL', 'ENCOMENDA'];
function intencaoDoItem(item) {
  if (item && item.encomenda === true) return 'ENCOMENDA';
  return item && INTENCOES.includes(item.intencao) ? item.intencao : 'CONDICIONAL';
}

const STATUS_PEDIDO = ['NOVO', 'EM_ANDAMENTO', 'ENTREGUE', 'CANCELADO'];
const STATUS_ENCOMENDA = ['AGUARDANDO_FABRICANTE', 'EM_TRANSITO', 'PRONTO_ENTREGA', 'ENTREGUE', 'CANCELADA'];

// Peças que foram provadas numa maleta e o que aconteceu com cada uma: VENDIDA ou
// DEVOLVIDA (pelos acertos do pedido) ou COM_CLIENTE (ainda em condicional ligada ao
// pedido). Peça que nunca saiu (já estava indisponível ao enviar) não conta.
function resultadoMaleta(itens, vendidos, devolvidos, naRua) {
  return (Array.isArray(itens) ? itens : []).map(i => {
    const id = Number(i.produto_id);
    const resultado = vendidos.includes(id) ? 'VENDIDA' : devolvidos.includes(id) ? 'DEVOLVIDA'
      : naRua.includes(id) && intencaoDoItem(i) === 'CONDICIONAL' ? 'COM_CLIENTE' : null;
    return { produto_id: id, nome: i.nome, codigo_sku: i.codigo_sku, preco: Number(i.preco) || 0, resultado };
  }).filter(p => p.resultado);
}

// Conversão de um conjunto de peças provadas. taxa = vendidas / peças já acertadas
// (as que ainda estão com a cliente não contam contra).
function resumoConversao(pecas) {
  const conta = r => pecas.filter(p => p.resultado === r).length;
  const vendidas = conta('VENDIDA');
  const devolvidas = conta('DEVOLVIDA');
  const acertadas = vendidas + devolvidas;
  return {
    enviadas: pecas.length,
    vendidas,
    devolvidas,
    com_cliente: conta('COM_CLIENTE'),
    valor_vendido: pecas.filter(p => p.resultado === 'VENDIDA').reduce((t, p) => t + Math.round(p.preco * 100), 0) / 100,
    taxa: acertadas ? Math.round((vendidas / acertadas) * 1000) / 10 : null,
  };
}

// Alertas do perfil da cliente: maleta com ela, pedido aguardando entrega, encomenda pendente
function pendenciasDoCliente(pedidos, maletas, encomendas, agora = Date.now()) {
  const dias = (d) => Math.max(0, Math.floor((agora - new Date(d).getTime()) / 86400000));
  const ha = (d) => (dias(d) === 0 ? 'desde hoje' : `há ${dias(d)} dia(s)`);
  const lista = [];
  for (const m of maletas) {
    if (m.com_cliente > 0) {
      lista.push({ tipo: 'MALETA', ref: m.pedido_id, dias: dias(m.enviada_em), desde: m.enviada_em,
        texto: `Maleta do pedido #${m.pedido_id} com a cliente ${ha(m.enviada_em)}: ${m.com_cliente} peça(s) sem acerto` });
    }
  }
  for (const p of pedidos) {
    if (p.status === 'NOVO' || p.status === 'EM_ANDAMENTO') {
      lista.push({ tipo: 'PEDIDO', ref: p.id, dias: dias(p.created_at), desde: p.created_at,
        texto: `Pedido #${p.id} ${p.status === 'NOVO' ? 'novo, ainda não atendido' : 'aguardando entrega'} ${ha(p.created_at)}` });
    }
  }
  const rotulos = { AGUARDANDO_FABRICANTE: 'aguardando fabricante', EM_TRANSITO: 'em trânsito', PRONTO_ENTREGA: 'pronta para entrega' };
  for (const e of encomendas) {
    if (rotulos[e.status]) {
      lista.push({ tipo: 'ENCOMENDA', ref: e.id, dias: dias(e.created_at), desde: e.created_at,
        texto: `Encomenda #${e.id} (${e.modelo}) ${rotulos[e.status]}` });
    }
  }
  return lista.sort((a, b) => b.dias - a.dias);
}

// Totais do pedido a partir dos itens gravados (depois de um item virar encomenda)
function totaisDoPedido(itens) {
  const c = v => Math.round(Number(v) * 100);
  const soma = (lista, campo) => lista.reduce((t, i) => t + c(i[campo]), 0) / 100;
  const por = (intencao) => itens.filter(i => intencaoDoItem(i) === intencao);
  return {
    total_prova: soma(por('CONDICIONAL'), 'preco'),
    total_compra: soma(por('COMPRA'), 'preco'),
    total_encomendas: soma(por('ENCOMENDA'), 'preco'),
    sinal: soma(por('ENCOMENDA'), 'sinal'),
    total: soma(itens, 'preco'),
  };
}
const TIPOS_DESCONTO = ['VALOR', 'PERCENTUAL'];
const MAX_EXTRAS = 30;
const MAX_QTD_EXTRA = 99;

// Desconto do fechamento: { tipo: 'VALOR'|'PERCENTUAL', valor } ou nada. null = inválido.
function lerDesconto(d) {
  if (d === undefined || d === null || d === '') return { tipo: '', valor: 0 };
  if (typeof d !== 'object' || Array.isArray(d)) return null;
  if (!d.tipo) return { tipo: '', valor: 0 };
  if (!TIPOS_DESCONTO.includes(d.tipo)) return null;
  const valor = typeof d.valor === 'number' ? d.valor : Number(String(d.valor ?? '').replace(',', '.'));
  if (!Number.isFinite(valor) || valor < 0) return null;
  if (d.tipo === 'PERCENTUAL' && valor > 100) return null;
  if (valor > 1e7) return null;
  return { tipo: valor ? d.tipo : '', valor: Math.round(valor * 100) / 100 };
}

// Acessórios do fechamento: [{ acessorio_id, quantidade }] somando ids repetidos. null = inválido.
function lerExtras(lista) {
  if (lista === undefined || lista === null) return new Map();
  if (!Array.isArray(lista) || lista.length > MAX_EXTRAS) return null;
  const qtd = new Map();
  for (const e of lista) {
    const id = Number(e && e.acessorio_id);
    const q = Number(e && e.quantidade);
    if (!Number.isInteger(id) || id <= 0 || id >= 2 ** 31 || !Number.isInteger(q) || q <= 0) return null;
    qtd.set(id, (qtd.get(id) || 0) + q);
    if (qtd.get(id) > MAX_QTD_EXTRA) return null;
  }
  return qtd;
}

// Valor final do pedido na entrega, em centavos para não perder arredondamento.
// itens: [{ preco }] cobrados; extras: [{ preco, quantidade }]; desconto sobre o subtotal.
function calcularFechamento(itens, extras, desconto) {
  const c = v => Math.round(Number(v) * 100);
  const subtotalItens = itens.reduce((t, i) => t + c(i.preco), 0);
  const totalExtras = extras.reduce((t, e) => t + c(e.preco) * Number(e.quantidade), 0);
  const subtotal = subtotalItens + totalExtras;
  let valorDesconto = 0;
  if (desconto && desconto.tipo === 'VALOR') valorDesconto = c(desconto.valor);
  if (desconto && desconto.tipo === 'PERCENTUAL') valorDesconto = Math.round(subtotal * Number(desconto.valor) / 100);
  valorDesconto = Math.min(Math.max(valorDesconto, 0), subtotal);
  return {
    subtotal_itens: subtotalItens / 100,
    total_extras: totalExtras / 100,
    subtotal: subtotal / 100,
    desconto: valorDesconto / 100,
    total: (subtotal - valorDesconto) / 100,
  };
}

// Cada banco guarda de qual empresa ele é. Se duas empresas apontarem para o mesmo banco
// (mesmo com connection strings diferentes), a segunda encontra a marca da primeira e o
// boot para, em vez de misturar os dados.
async function conferirDonoDoBanco(empresa) {
  await empresa.pool.query(
    `INSERT INTO configuracoes (chave, valor) VALUES ('empresa_dona', $1) ON CONFLICT (chave) DO NOTHING`,
    [empresa.slug]
  );
  const { rows } = await empresa.pool.query(`SELECT valor FROM configuracoes WHERE chave = 'empresa_dona'`);
  if (rows[0].valor !== empresa.slug) {
    throw new Error(`O banco da empresa "${empresa.slug}" já é da empresa "${rows[0].valor}": cada empresa precisa do seu banco`);
  }
}

// Abre e prepara o banco de uma loja (tabelas e marca de dona). Usado no boot e quando
// o master cadastra uma loja ou troca o banco dela.
async function conectarBanco(slug, databaseUrl) {
  const pool = criarPool(databaseUrl);
  try {
    await initTables(pool);
    await conferirDonoDoBanco({ slug, pool });
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
}

// Primeira subida com o banco da plataforma: traz as lojas das variáveis e o que o painel
// tinha no banco da Nix. Roda uma vez só (marca importado_do_render); depois disso as
// lojas vêm só do cadastro e as variáveis EMPRESA_* podem sair do Render.
async function importarDoRender(pool) {
  const { rows: [feito] } = await pool.query(`SELECT 1 FROM plataforma_config WHERE chave = 'importado_do_render'`);
  if (feito) {
    if (erroVariaveis) console.warn(`[master] Variáveis de loja ignoradas (as lojas vêm do cadastro): ${erroVariaveis.message}`);
    return;
  }
  if (erroVariaveis) throw erroVariaveis;
  let antigas = [];
  if (EMPRESAS_ENV.length) {
    const antigo = criarPool(EMPRESAS_ENV[0].databaseUrl);
    try {
      const { rows: [t] } = await antigo.query(`SELECT to_regclass('master_lojas') AS tabela`);
      if (t.tabela) antigas = (await antigo.query('SELECT * FROM master_lojas ORDER BY created_at, slug')).rows;
    } finally {
      await antigo.end().catch(() => {});
    }
  }
  const linhas = master.importarLojas(EMPRESAS_ENV, antigas, (url) => master.cifrar(url, process.env.JWT_SECRET));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const l of linhas) {
      await client.query(
        `INSERT INTO master_lojas (slug, nome, dominios, banco_cifrado, admin_user, admin_pass_hash, ativo, sessao, legado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (slug) DO NOTHING`,
        [l.slug, l.nome, l.dominios, l.banco_cifrado, l.admin_user, l.admin_pass_hash, l.ativo, l.sessao, l.legado]
      );
    }
    await client.query(`INSERT INTO plataforma_config (chave, valor) VALUES ('importado_do_render', $1)`, [new Date().toISOString()]);
    await client.query('COMMIT');
    console.log(`[master] Lojas importadas das variáveis do Render: ${linhas.map((l) => l.slug).join(', ') || 'nenhuma'}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function startServer() {
  if (PLATAFORMA_DATABASE_URL) {
    // Todas as lojas vêm do cadastro da plataforma; nenhuma é a padrão.
    if (!process.env.JWT_SECRET) throw new Error('Com PLATAFORMA_DATABASE_URL, defina JWT_SECRET (ele cifra os bancos das lojas)');
    const idPlataforma = identidadeBanco(PLATAFORMA_DATABASE_URL);
    const igual = EMPRESAS_ENV.find((e) => identidadeBanco(e.databaseUrl) === idPlataforma);
    if (igual) throw new Error(`PLATAFORMA_DATABASE_URL é o banco da loja "${igual.slug}": a plataforma precisa de um banco só dela`);
    poolCadastro = criarPool(PLATAFORMA_DATABASE_URL);
    await master.criarTabelaMaster(poolCadastro);
    await importarDoRender(poolCadastro);
    const { rows: linhasMaster } = await poolCadastro.query('SELECT * FROM master_lojas ORDER BY created_at, slug');
    EMPRESAS.push(...master.mesclarEmpresas([], linhasMaster, decifrarBanco));
    for (const e of EMPRESAS) {
      if (identidadeBanco(e.databaseUrl || '') === idPlataforma) e.erro = 'Essa loja aponta para o banco da plataforma: cole o banco dela';
    }
  } else {
    // A empresa padrão vem primeiro: o cadastro do painel master fica no banco dela.
    const padrao = EMPRESAS_ENV[0];
    padrao.pool = await conectarBanco(padrao.slug, padrao.databaseUrl);
    await master.criarTabelaMaster(padrao.pool);
    poolCadastro = padrao.pool;
    const { rows: linhasMaster } = await padrao.pool.query('SELECT * FROM master_lojas ORDER BY created_at, slug');
    EMPRESAS.push(...master.mesclarEmpresas(EMPRESAS_ENV, linhasMaster, decifrarBanco));
  }

  const bancos = new Map();
  for (const empresa of EMPRESAS) {
    if (!isAdminAuthEnabled(empresa)) {
      console.warn(`[auth] Empresa "${empresa.slug}": login do admin não definido, rotas admin ficarão bloqueadas (503).`);
    }
    if (empresa.erro) {
      console.error(`[master] Loja "${empresa.slug}" fora do ar: ${empresa.erro}`);
      continue;
    }
    const id = identidadeBanco(empresa.databaseUrl);
    if (bancos.has(id)) {
      const msg = `A empresa "${empresa.slug}" usa o mesmo banco da empresa "${bancos.get(id)}": cada uma precisa do seu`;
      if (!empresa.bancoDoPainel) throw new Error(msg);
      empresa.erro = msg;
      console.error(`[master] ${msg}`);
      continue;
    }
    bancos.set(id, empresa.slug);
    if (empresa.pool) continue;
    try {
      empresa.pool = await conectarBanco(empresa.slug, empresa.databaseUrl);
    } catch (err) {
      // Erro nas variáveis do Render para o boot, como antes (o Render mantém a versão
      // anterior no ar). Loja do painel com problema fica fora do ar sozinha.
      if (!empresa.bancoDoPainel) throw err;
      empresa.erro = `Não consegui usar o banco: ${err.message}`;
      console.error(`[master] Loja "${empresa.slug}" fora do ar: ${err.message}`);
    }
  }
  console.log(`Empresas: ${EMPRESAS.map((e) => e.slug).join(', ')}`);
  if (!masterHabilitado()) console.warn('[master] Painel master desligado (defina MASTER_USER, MASTER_PASS_HASH e JWT_SECRET).');

  // ---------- Handlers reutilizáveis ----------

  const DISPONIBILIDADES = ['PRONTA_ENTREGA', 'SOB_ENCOMENDA'];

  async function handleListPublicos(req, res) {
    try {
      const result = await req.db.query(
        `SELECT p.id, p.nome, p.nome_curto, p.codigo_sku, p.preco_venda, p.imagem_url, p.fotos, p.status, p.disponibilidade, p.formato, p.estilo, p.cor_armacao,
                p.diametro_cm, p.ponte_cm, p.largura_total_cm, p.material, p.tipo, p.genero, p.tamanho, p.grade,
                CASE WHEN a.ativo THEN p.anuncio_id END AS anuncio_id,
                ${anuncios.sqlPrecoPromocional('p')} AS preco_promocional
         FROM produtos p
         LEFT JOIN anuncios a ON a.id = p.anuncio_id
         WHERE p.status IN ('DISPONIVEL', 'CONDICIONAL') AND NOT p.em_conferencia AND NOT p.arquivado
         ORDER BY p.created_at DESC`
      );
      const { oculos } = await lojaDaEmpresa(req.empresa);
      res.json(result.rows.map((row) => ({ ...row, ...fotosPublicas(row, oculos) })));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar produtos' });
    }
  }

  // Lista do painel, com a última compra do histórico de reposição e o custo da
  // compra anterior (para a variação de preço do fornecedor).
  async function handleListAdmin(req, res) {
    try {
      const result = await req.db.query(
        `SELECT p.id, p.nome, p.nome_curto, p.codigo_sku, p.preco_custo, p.preco_venda, p.imagem_url, p.fotos, p.status, p.disponibilidade,
                p.formato, p.estilo, p.cor_armacao, p.diametro_cm, p.ponte_cm, p.largura_total_cm, p.material, p.tipo, p.genero, p.tamanho, p.grade,
                p.fornecedor, p.codigo_fornecedor, p.nome_fornecedor, p.link_fornecedor, p.vezes_em_maleta, p.pedido_condicional_id,
                p.estoque, p.anuncio_id, p.preco_promocional, p.em_conferencia, p.arquivado,
                to_char(p.arquivado_em, 'YYYY-MM-DD') AS arquivado_em, COALESCE(mp.pedidos, '{}') AS maletas, COALESCE(cardinality(mp.pedidos), 0)::int AS em_maleta,
                to_char(uc.data_compra, 'YYYY-MM-DD') AS ultima_compra, uc.preco_custo AS custo_ultima_compra,
                ca.preco_custo AS custo_compra_anterior, COALESCE(nc.total, 0)::int AS total_compras
         FROM produtos p
         LEFT JOIN LATERAL (
           SELECT data_compra, preco_custo FROM compras_fornecedor c
           WHERE c.produto_id = p.id ORDER BY data_compra DESC, id DESC LIMIT 1
         ) uc ON true
         LEFT JOIN LATERAL (
           SELECT preco_custo FROM compras_fornecedor c
           WHERE c.produto_id = p.id ORDER BY data_compra DESC, id DESC OFFSET 1 LIMIT 1
         ) ca ON true
         LEFT JOIN LATERAL (SELECT COUNT(*) AS total FROM compras_fornecedor c WHERE c.produto_id = p.id) nc ON true
         LEFT JOIN LATERAL (SELECT array_agg(m.pedido_id ORDER BY m.id) AS pedidos FROM maleta_pecas m WHERE m.produto_id = p.id) mp ON true
         ORDER BY p.created_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar produtos' });
    }
  }

  async function handleListConditional(req, res) {
    try {
      const result = await req.db.query(
        `SELECT id, nome, nome_curto, codigo_sku, preco_custo, preco_venda, imagem_url, fotos, status, disponibilidade, formato, estilo, cor_armacao, diametro_cm, ponte_cm, largura_total_cm, material, tipo, genero, tamanho, grade, fornecedor, codigo_fornecedor, nome_fornecedor, link_fornecedor, vezes_em_maleta, estoque
         FROM produtos p
         WHERE EXISTS (SELECT 1 FROM maleta_pecas m WHERE m.produto_id = p.id)
         ORDER BY created_at DESC`
      );
      // Retorna snake_case (padrão PT) + camelCase (compat. admin/acerto.html em inglês)
      const rows = result.rows.map((p) => ({
        ...p,
        sku: p.codigo_sku,
        codigoSku: p.codigo_sku,
        vezesEmMaleta: p.vezes_em_maleta,
        precoCusto: p.preco_custo,
        precoVenda: p.preco_venda,
        imagemUrl: p.imagem_url,
      }));
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar produtos condicionais' });
    }
  }

  async function handleCreateProduto(req, res) {
    const { nome, codigo_sku, sku, preco_custo, preco_venda, formato, estilo, cor_armacao } = req.body;
    const codigoFinal = codigo_sku || sku;
    const fornecedor = textoCurto(req.body.fornecedor, 120);
    const codigoFornecedor = textoCurto(req.body.codigo_fornecedor, 100);
    const nomeFornecedor = textoCurto(req.body.nome_fornecedor, 255);
    const linkFornecedor = lerLinkFornecedor(req.body.link_fornecedor);
    if (linkFornecedor === null) {
      return res.status(400).json({ error: 'Link do fornecedor inválido (use http:// ou https://)' });
    }
    const disponibilidade = req.body.disponibilidade || 'PRONTA_ENTREGA';
    if (!DISPONIBILIDADES.includes(disponibilidade)) {
      return res.status(400).json({ error: 'Disponibilidade inválida' });
    }
    const { espec, erro: erroEspec } = lerEspecificacoes(req.body);
    if (erroEspec) return res.status(400).json({ error: erroEspec.mensagem });
    const estoque = lerQuantidade(req.body.estoque);
    if (estoque === false) return res.status(400).json({ error: 'Estoque inválido' });
    // Promoção (Configurações > POP Anúncio): vale para todos os tamanhos/cores do cadastro
    const anuncioId = anuncios.lerAnuncioId(req.body.anuncio_id);
    if (anuncioId === false) return res.status(400).json({ error: 'Promoção inválida' });
    // Preço promocional: só com a promoção marcada, e menor que o preço de venda
    let precoPromocional = anuncios.lerPrecoPromocional(req.body.preco_promocional);
    if (precoPromocional === false) return res.status(400).json({ error: 'Preço promocional inválido' });
    if (!anuncioId) precoPromocional = null;
    if (precoPromocional && !(precoPromocional < Number(preco_venda))) {
      return res.status(400).json({ error: 'O preço promocional precisa ser menor que o preço de venda' });
    }
    // Roupas: com a grade de tamanhos, cada tamanho vira um produto com o seu estoque,
    // SKU "<SKU>-<tamanho>", nome "<nome> - <tamanho>", as mesmas fotos e grade = SKU
    // (o código do modelo, que junta os tamanhos num card só na vitrine).
    const tamanhos = lerGradeTamanhos(req.body.tamanhos);
    if (tamanhos === false) return res.status(400).json({ error: 'Tamanhos inválidos (cada tamanho uma vez, com a quantidade em peças)' });
    // Cores: o mesmo, um produto por cor ("<nome> - <cor>", SKU "<SKU>-<COR>"), cada um com
    // a cor, o estoque e a foto 1 da sua cor; as fotos 2 a 4 do formulário valem para todas.
    const cores = lerCores(req.body.cores);
    if (cores === false) return res.status(400).json({ error: 'Cores inválidas (cada cor uma vez, com a quantidade em peças)' });
    if (cores && tamanhos) return res.status(400).json({ error: 'Cadastre por tamanhos ou por cores, não os dois de uma vez' });
    const skusCor = new Set();
    const pecas = tamanhos
      ? tamanhos.map((t) => ({
        nome: `${nome} - ${t.tamanho}`, sku: `${codigoFinal}-${t.tamanho}`, estoque: t.estoque,
        espec: { ...espec, tamanho: t.tamanho, grade: textoCurto(codigoFinal, 100) },
      }))
      : cores
        ? cores.map((c, i) => {
          let sku = `${codigoFinal}-${skuDaCor(c.cor)}`;
          for (let n = 2; skusCor.has(sku); n++) sku = `${codigoFinal}-${skuDaCor(c.cor)}-${n}`;
          skusCor.add(sku);
          return {
            nome: `${nome} - ${c.cor}`, sku, estoque: c.estoque, cor: c.cor, fotoCor: (req.fotosCores || [])[i] || null, disponibilidade: c.disponibilidade,
            espec: { ...espec, grade: textoCurto(codigoFinal, 100) },
          };
        })
        : [{ nome, sku: codigoFinal, estoque: estoque ?? 1, espec }];
    const variacoes = tamanhos || cores;

    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      // Com foto em todas as cores, a foto 1 do formulário não seria usada: nem é gravada
      const foto1Sobra = cores && pecas.every((peca) => peca.fotoCor);
      const posicoes = [];
      for (const [i, file] of (req.fotosEnviadas || []).entries()) {
        posicoes.push(file && !(i === 0 && foto1Sobra) ? await salvarImagem(client, file) : null);
      }
      const fotosComuns = organizarFotos(posicoes);
      const criados = [];
      for (const peca of pecas) {
        const e = peca.espec;
        // A foto da cor entra no lugar da foto 1 (sem ela, a cor usa a foto 1 do formulário)
        const fotos = peca.fotoCor
          ? organizarFotos([await salvarImagem(client, peca.fotoCor), ...posicoes.slice(1)])
          : fotosComuns;
        const result = await client.query(
          `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, imagem_url, fotos, disponibilidade, formato, estilo, cor_armacao, fornecedor, codigo_fornecedor, link_fornecedor,
                                 diametro_cm, ponte_cm, largura_total_cm, material, tipo, nome_curto, genero, estoque, tamanho, grade, nome_fornecedor, anuncio_id, preco_promocional)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
           RETURNING *`,
          [peca.nome, peca.sku, preco_custo, preco_venda, fotos[0] || null, fotos, peca.disponibilidade || disponibilidade, formato, estilo, peca.cor || cor_armacao, fornecedor, codigoFornecedor, linkFornecedor,
            e.diametro_cm ?? null, e.ponte_cm ?? null, e.largura_total_cm ?? null, e.material || '', e.tipo || '', e.nome_curto || '', e.genero || '',
            peca.estoque, e.tamanho || '', e.grade || '', nomeFornecedor, anuncioId ?? null, precoPromocional ?? null]
        );
        // A compra do cadastro conta ao menos 1 peça (o custo fica registrado mesmo sem estoque)
        await registrarCompraCadastro(client, result.rows[0], { quantidade: peca.estoque || 1 });
        criados.push(...(await recalcularStatus(client, [result.rows[0].id])));
      }
      await marcarEmConferencia(client, req.body.em_conferencia, criados);
      await client.query('COMMIT');
      // Um produto: a resposta de sempre. Grade: o 1º tamanho e a lista completa.
      res.status(201).json(variacoes ? { ...criados[0], produtos: criados } : criados[0]);
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      if (err.code === '23503' && anuncioId) return res.status(400).json({ error: 'Essa promoção não existe mais. Escolha outra.' });
      if (err.code === '23505') {
        return res.status(400).json({ error: tamanhos ? 'SKU já cadastrado (algum tamanho já existe com esse código)' : cores ? 'SKU já cadastrado (alguma cor já existe com esse código)' : 'SKU já cadastrado' });
      }
      res.status(500).json({ error: 'Erro ao cadastrar produto' });
    } finally {
      if (client) client.release();
    }
  }

  // Produtos importados "em conferência": liberar (aparecem na vitrine) ou voltar para conferência.
  // Body { ids: [..], em_conferencia: false|true } -> { atualizados }
  async function handleConferenciaProdutos(req, res) {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number) : [];
    if (!ids.length || ids.length > 500 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
      return res.status(400).json({ error: 'Informe os produtos' });
    }
    const flag = req.body.em_conferencia === true;
    try {
      const r = await req.db.query('UPDATE produtos SET em_conferencia = $2, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1) RETURNING id', [ids, flag]);
      res.json({ atualizados: r.rowCount });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao atualizar os produtos' });
    }
  }

  // Editar produto: inclui cores novas no modelo do produto. Cada cor nova vira um produto
  // com os dados do produto editado (preços, especificações, fornecedor, promoção), nome
  // "<nome do modelo> - <cor>", SKU "<código do modelo>-<COR>", a foto da cor como capa e as
  // fotos 2 a 4 do produto. Sem código do modelo, o SKU do produto passa a ser o código.
  async function handleAdicionarCores(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Produto não encontrado' });
    const cores = lerCores(req.body.cores);
    if (!cores) return res.status(400).json({ error: 'Cores inválidas (cada cor uma vez, com a quantidade em peças)' });
    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const atual = await client.query('SELECT * FROM produtos WHERE id = $1 FOR UPDATE', [id]);
      const p = atual.rows[0];
      if (!p) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Produto não encontrado' });
      }
      const corAtual = String(p.cor_armacao || '').trim();
      if (!corAtual) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Preencha a cor deste produto antes de incluir outras cores' });
      }
      if (String(p.tamanho || '').trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Produto com tamanho: inclua as cores pelo cadastro de cada tamanho' });
      }
      const grade = String(p.grade || '').trim() || textoCurto(p.codigo_sku, 100);
      if (!String(p.grade || '').trim()) await client.query('UPDATE produtos SET grade = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [grade, id]);
      // Cores que o modelo já tem não entram de novo
      const irmaos = await client.query(`SELECT lower(COALESCE(cor_armacao, '')) AS cor FROM produtos WHERE grade = $1 OR id = $2`, [grade, id]);
      const jaTem = new Set(irmaos.rows.map((r) => r.cor.trim()));
      const repetida = cores.find((c) => jaTem.has(c.cor.toLowerCase()));
      if (repetida) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `O modelo já tem a cor ${repetida.cor}` });
      }
      const sufixo = ` - ${corAtual}`;
      const nomeBase = textoCurto(req.body.nome_modelo, 255)
        || (p.nome.endsWith(sufixo) ? p.nome.slice(0, -sufixo.length) : p.nome);
      const fotosProduto = fotosDoProduto(p);
      const skusUsados = new Set((await client.query('SELECT codigo_sku FROM produtos WHERE codigo_sku LIKE $1', [`${grade}-%`])).rows.map((r) => r.codigo_sku));
      const criados = [];
      for (const [i, c] of cores.entries()) {
        let sku = `${grade}-${skuDaCor(c.cor)}`;
        for (let n = 2; skusUsados.has(sku); n++) sku = `${grade}-${skuDaCor(c.cor)}-${n}`;
        skusUsados.add(sku);
        const fotoCor = (req.fotosCores || [])[i];
        const fotos = organizarFotos([fotoCor ? await salvarImagem(client, fotoCor) : fotosProduto[0] || null, ...[1, 2, 3].map((j) => fotosProduto[j] || null)]);
        const result = await client.query(
          `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, imagem_url, fotos, disponibilidade, formato, estilo, cor_armacao, fornecedor, codigo_fornecedor, link_fornecedor,
                                 diametro_cm, ponte_cm, largura_total_cm, material, tipo, nome_curto, genero, estoque, tamanho, grade, nome_fornecedor, anuncio_id, preco_promocional)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, '', $22, $23, $24, $25)
           RETURNING *`,
          [`${nomeBase} - ${c.cor}`, sku, p.preco_custo, p.preco_venda, fotos[0] || null, fotos, c.disponibilidade || p.disponibilidade, p.formato, p.estilo, c.cor, p.fornecedor, p.codigo_fornecedor, p.link_fornecedor,
            p.diametro_cm, p.ponte_cm, p.largura_total_cm, p.material || '', p.tipo || '', p.nome_curto || '', p.genero || '', c.estoque, grade, p.nome_fornecedor || '', p.anuncio_id ?? null, p.preco_promocional ?? null]
        );
        await registrarCompraCadastro(client, result.rows[0], { quantidade: c.estoque || 1 });
        criados.push(...(await recalcularStatus(client, [result.rows[0].id])));
      }
      await marcarEmConferencia(client, req.body.em_conferencia, criados);
      await client.query('COMMIT');
      res.status(201).json({ grade, produtos: criados });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      if (err.code === '23505') return res.status(400).json({ error: 'SKU já cadastrado (alguma cor já existe com esse código)' });
      res.status(500).json({ error: 'Erro ao incluir as cores' });
    } finally {
      if (client) client.release();
    }
  }

  async function handleUpdateProduto(req, res) {
    const { id } = req.params;
    const { nome, codigo_sku, sku, preco_custo, preco_venda, status, disponibilidade, formato, estilo, cor_armacao } = req.body;
    const codigoFinal = codigo_sku !== undefined ? codigo_sku : sku;
    if (disponibilidade !== undefined && !DISPONIBILIDADES.includes(disponibilidade)) {
      return res.status(400).json({ error: 'Disponibilidade inválida' });
    }
    const enviadas = req.fotosEnviadas || [];
    const manter = lerFotosManter(req.body.fotos_manter);
    if (manter === false) {
      return res.status(400).json({ error: 'fotos_manter inválido' });
    }
    const mexeNasFotos = manter !== undefined || enviadas.some(Boolean);
    const linkFornecedor = lerLinkFornecedor(req.body.link_fornecedor);
    if (linkFornecedor === null) {
      return res.status(400).json({ error: 'Link do fornecedor inválido (use http:// ou https://)' });
    }
    const { espec, erro: erroEspec } = lerEspecificacoes(req.body);
    if (erroEspec) return res.status(400).json({ error: erroEspec.mensagem });
    if (status !== undefined && !STATUS_PRODUTO.includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }
    const estoque = lerQuantidade(req.body.estoque);
    if (estoque === false) return res.status(400).json({ error: 'Estoque inválido' });
    const mexeNoEstoque = status !== undefined || estoque !== null;
    const anuncioId = anuncios.lerAnuncioId(req.body.anuncio_id);
    if (anuncioId === false) return res.status(400).json({ error: 'Promoção inválida' });
    // Preço promocional: desmarcar a promoção também tira o preço promocional
    let precoPromocional = anuncios.lerPrecoPromocional(req.body.preco_promocional);
    if (precoPromocional === false) return res.status(400).json({ error: 'Preço promocional inválido' });
    if (anuncioId === null) precoPromocional = null;

    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');

      const fields = [];
      const values = [];
      let paramCount = 1;

      const addField = (field, value) => {
        if (value !== undefined) {
          fields.push(`${field} = $${paramCount}`);
          values.push(value);
          paramCount++;
        }
      };

      addField('nome', nome);
      addField('codigo_sku', codigoFinal);
      addField('preco_custo', preco_custo);
      addField('preco_venda', preco_venda);
      addField('disponibilidade', disponibilidade);
      addField('formato', formato);
      addField('estilo', estilo);
      addField('cor_armacao', cor_armacao);
      if (req.body.fornecedor !== undefined) addField('fornecedor', textoCurto(req.body.fornecedor, 120));
      if (req.body.codigo_fornecedor !== undefined) addField('codigo_fornecedor', textoCurto(req.body.codigo_fornecedor, 100));
      if (req.body.nome_fornecedor !== undefined) addField('nome_fornecedor', textoCurto(req.body.nome_fornecedor, 255));
      if (req.body.link_fornecedor !== undefined) addField('link_fornecedor', linkFornecedor);
      if (anuncioId !== undefined) {
        fields.push(`anuncio_id = $${paramCount++}`);
        values.push(anuncioId);
      }
      if (precoPromocional !== undefined) {
        fields.push(`preco_promocional = $${paramCount++}`);
        values.push(precoPromocional);
      }
      // addField pula undefined, mas null (medida apagada) precisa entrar
      for (const [campo, valor] of Object.entries(espec)) {
        fields.push(`${campo} = $${paramCount++}`);
        values.push(valor);
      }

      if (fields.length === 0 && !mexeNasFotos && !mexeNoEstoque) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Nenhum campo para atualizar' });
      }

      // Lê as fotos atuais para montar a nova lista e apagar as que saírem (FOR UPDATE trava a linha até o COMMIT)
      const anterior = await client.query(`SELECT imagem_url, fotos, status FROM produtos WHERE id = $1 FOR UPDATE`, [id]);
      if (anterior.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Produto não encontrado' });
      }

      let removidas = [];
      if (mexeNasFotos) {
        const atuais = fotosDoProduto(anterior.rows[0]);
        // Sem fotos_manter, cada posição sem arquivo novo continua com a foto que já tinha.
        // Só aceita manter URLs que já são deste produto.
        const base = manter !== undefined
          ? manter.map((url) => (url && atuais.includes(url) ? url : null))
          : atuais;
        const posicoes = [];
        for (let i = 0; i < MAX_FOTOS; i++) {
          if (enviadas[i]) posicoes.push(await salvarImagem(client, enviadas[i]));
          else posicoes.push(base[i] && !posicoes.includes(base[i]) ? base[i] : null);
        }
        const novas = organizarFotos(posicoes);
        removidas = atuais.filter((url) => url && !novas.includes(url));
        addField('fotos', novas);
        addField('imagem_url', novas[0] || null);
      }

      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const query = `UPDATE produtos SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
      let result = await client.query(query, values);
      const promo = result.rows[0].preco_promocional;
      if (promo !== null && promo !== undefined && !(Number(promo) < Number(result.rows[0].preco_venda))) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'O preço promocional precisa ser menor que o preço de venda' });
      }
      if (mexeNoEstoque) {
        // O formulário reenvia o status de sempre: só um status diferente mexe nas peças
        if (status !== undefined && status !== anterior.rows[0].status) await aplicarStatusManual(client, result.rows[0].id, status);
        if (estoque !== null) await client.query('UPDATE produtos SET estoque = $2 WHERE id = $1', [result.rows[0].id, estoque]);
        result = { rows: await recalcularStatus(client, [result.rows[0].id]) };
      }

      // Roupas: as fotos valem para todos os tamanhos do mesmo modelo (grade). Só entre os
      // da mesma cor: cada cor do modelo tem as suas fotos.
      const grade = result.rows[0].grade;
      if (mexeNasFotos && grade) {
        const irmaos = await client.query(
          `UPDATE produtos p SET fotos = $1, imagem_url = $2, updated_at = CURRENT_TIMESTAMP
           FROM (SELECT id, fotos FROM produtos WHERE grade = $3 AND id <> $4
                   AND lower(COALESCE(cor_armacao, '')) = lower(COALESCE($5, '')) FOR UPDATE) antes
           WHERE p.id = antes.id
           RETURNING antes.fotos`,
          [result.rows[0].fotos, result.rows[0].imagem_url, grade, result.rows[0].id, result.rows[0].cor_armacao]
        );
        for (const r of irmaos.rows) removidas.push(...(r.fotos || []).filter((url) => url && !result.rows[0].fotos.includes(url)));
      }

      // A promoção vale para o modelo inteiro (todos os tamanhos e cores do mesmo código)
      // (e o preço promocional junto)
      if (anuncioId !== undefined && grade) {
        await client.query(
          'UPDATE produtos SET anuncio_id = $1, updated_at = CURRENT_TIMESTAMP WHERE grade = $2 AND id <> $3 AND anuncio_id IS DISTINCT FROM $1',
          [anuncioId, grade, result.rows[0].id]
        );
      }
      if (precoPromocional !== undefined && grade) {
        await client.query(
          `UPDATE produtos SET preco_promocional = $1, updated_at = CURRENT_TIMESTAMP
           WHERE grade = $2 AND id <> $3 AND preco_promocional IS DISTINCT FROM $1`,
          [precoPromocional, grade, result.rows[0].id]
        );
      }

      // Apaga as fotos que saíram, menos as que outro produto ainda usa
      const idsRemovidos = [...new Set(removidas.map(idDaImagem).filter(Boolean))];
      if (idsRemovidos.length) {
        await client.query(
          `DELETE FROM imagens i WHERE i.id = ANY($1)
           AND NOT EXISTS (SELECT 1 FROM produtos p WHERE ('/imagens/' || i.id) = ANY(p.fotos) OR p.imagem_url = '/imagens/' || i.id)`,
          [idsRemovidos]
        );
      }

      await client.query('COMMIT');
      res.json(result.rows[0]);
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      if (err.code === '23503' && anuncioId) return res.status(400).json({ error: 'Essa promoção não existe mais. Escolha outra.' });
      if (err.code === '23505') {
        return res.status(400).json({ error: 'SKU já cadastrado' });
      }
      res.status(500).json({ error: 'Erro ao atualizar produto' });
    } finally {
      if (client) client.release();
    }
  }

  // Cadastro em lote (JSON, sem fotos: elas entram depois, editando cada produto).
  // Erros de preenchimento (nome, preço...) barram o lote inteiro e a resposta diz
  // qual linha (índice a partir de 0) e qual campo corrigir.
  // Duplicados não barram: a linha cujo SKU ou código do fornecedor (do mesmo
  // fornecedor) já existe no banco, ou repete uma linha anterior do lote, é
  // ignorada e volta em `ignorados`; as demais são gravadas.
  // Com Quantidade preenchida, o duplicado vira reposição: soma as peças no
  // estoque do produto que já existe e registra a compra com o custo da linha
  // (volta em `repostos`). Quantidade também é o estoque inicial do produto novo.
  async function handleCreateLote(req, res) {
    const linhas = req.body && req.body.produtos;
    if (!Array.isArray(linhas) || linhas.length === 0) {
      return res.status(400).json({ error: 'Envie ao menos um produto' });
    }
    if (linhas.length > MAX_LOTE) {
      return res.status(400).json({ error: `Máximo de ${MAX_LOTE} produtos por lote` });
    }

    const erros = [];
    const produtos = linhas.map((linha, i) => {
      const r = validarProdutoLote(linha);
      r.erros.forEach((e) => erros.push({ linha: i, ...e }));
      return r.produto;
    });
    if (erros.length) {
      erros.sort((a, b) => a.linha - b.linha);
      return res.status(400).json({ error: 'Corrija as linhas marcadas', erros });
    }

    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const { criados, repostos, ignorados } = await gravarLote(client, produtos);
      await client.query('COMMIT');
      res.status(criados.length || repostos.length ? 201 : 200).json({ produtos: criados, repostos, ignorados });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao cadastrar produtos' });
    } finally {
      if (client) client.release();
    }
  }

  // Editar em estoque (lote): grava de uma vez as linhas alteradas na aba
  // "Editar em estoque" do painel. Cada linha traz o id do produto e o cadastro
  // completo (mesmas regras do cadastro em lote) e, se veio, o estoque (peças na
  // loja). O status sai do estoque, como na edição de um produto. Tudo ou nada:
  // qualquer erro (preenchimento, SKU de outro produto, id que não existe) volta
  // com a linha (índice a partir de 0) e o campo, e nada é gravado.
  async function handleUpdateLote(req, res) {
    const linhas = req.body && req.body.produtos;
    if (!Array.isArray(linhas) || linhas.length === 0) {
      return res.status(400).json({ error: 'Envie ao menos um produto' });
    }
    if (linhas.length > MAX_LOTE) {
      return res.status(400).json({ error: `Máximo de ${MAX_LOTE} produtos por vez` });
    }

    const erros = [];
    const skusVistos = new Map();
    const idsVistos = new Set();
    const produtos = linhas.map((linha, i) => {
      const l = linha && typeof linha === 'object' ? linha : {};
      const r = validarProdutoLote({ ...l, quantidade: undefined, pedido_fornecedor: undefined, data_compra: undefined, status: undefined });
      r.erros.forEach((e) => erros.push({ linha: i, ...e }));
      const id = Number(l.id);
      if (!Number.isInteger(id) || id <= 0 || idsVistos.has(id)) erros.push({ linha: i, campo: 'codigo_sku', mensagem: 'Produto inválido ou repetido' });
      idsVistos.add(id);
      const estoque = lerQuantidade(l.estoque);
      if (estoque === false) erros.push({ linha: i, campo: 'estoque', mensagem: 'Estoque inválido (número inteiro a partir de 0)' });
      // Promoção e preço promocional: só mexe quando a linha manda (painel antigo não manda)
      const anuncioId = anuncios.lerAnuncioId(l.anuncio_id);
      if (anuncioId === false) erros.push({ linha: i, campo: 'anuncio_id', mensagem: 'Promoção inválida' });
      let precoPromocional = anuncios.lerPrecoPromocional(l.preco_promocional);
      if (precoPromocional === false) erros.push({ linha: i, campo: 'preco_promocional', mensagem: 'Preço promocional inválido' });
      if (anuncioId === null) precoPromocional = null;
      if (precoPromocional && anuncioId === undefined) precoPromocional = undefined;
      if (precoPromocional && !(precoPromocional < r.produto.preco_venda)) {
        erros.push({ linha: i, campo: 'preco_promocional', mensagem: 'O preço promocional precisa ser menor que o preço de venda' });
      }
      const sku = r.produto.codigo_sku.toLowerCase();
      if (sku && skusVistos.has(sku)) erros.push({ linha: i, campo: 'codigo_sku', mensagem: `SKU repetido na linha ${skusVistos.get(sku) + 1}` });
      else if (sku) skusVistos.set(sku, i);
      return { ...r.produto, id, estoque, anuncio_id: anuncioId === false ? undefined : anuncioId, preco_promocional: precoPromocional === false ? undefined : precoPromocional };
    });
    if (erros.length) {
      erros.sort((a, b) => a.linha - b.linha);
      return res.status(400).json({ error: 'Corrija as linhas marcadas', erros });
    }

    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const ids = produtos.map((p) => p.id);
      const antes = new Map((await client.query('SELECT id, anuncio_id, preco_promocional FROM produtos WHERE id = ANY($1) FOR UPDATE', [ids])).rows.map((r) => [Number(r.id), r]));
      const existentes = new Set(antes.keys());
      // SKU que já é de outro produto (fora das linhas enviadas)
      const outros = await client.query(
        'SELECT lower(codigo_sku) AS sku FROM produtos WHERE lower(codigo_sku) = ANY($1) AND NOT (id = ANY($2))',
        [produtos.map((p) => p.codigo_sku.toLowerCase()), ids]
      );
      const skusOutros = new Set(outros.rows.map((r) => r.sku));
      produtos.forEach((p, i) => {
        if (!existentes.has(p.id)) erros.push({ linha: i, campo: 'codigo_sku', mensagem: 'Produto não encontrado (pode ter sido apagado)' });
        else if (skusOutros.has(p.codigo_sku.toLowerCase())) erros.push({ linha: i, campo: 'codigo_sku', mensagem: 'SKU já é de outro produto' });
      });
      if (erros.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Corrija as linhas marcadas', erros });
      }

      for (const p of produtos) {
        await client.query(
          `UPDATE produtos SET nome = $2, codigo_sku = $3, preco_custo = $4, preco_venda = $5, disponibilidade = $6, formato = $7, estilo = $8, cor_armacao = $9,
                  fornecedor = $10, codigo_fornecedor = $11, link_fornecedor = $12, nome_fornecedor = $13, diametro_cm = $14, ponte_cm = $15, largura_total_cm = $16,
                  material = $17, tipo = $18, nome_curto = $19, genero = $20, tamanho = $21, grade = $22, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [p.id, p.nome, p.codigo_sku, p.preco_custo, p.preco_venda, p.disponibilidade, p.formato, p.estilo, p.cor_armacao,
            p.fornecedor, p.codigo_fornecedor, p.link_fornecedor, p.nome_fornecedor, p.diametro_cm, p.ponte_cm, p.largura_total_cm,
            p.material, p.tipo, p.nome_curto, p.genero, p.tamanho, p.grade]
        );
        if (p.estoque !== null) await client.query('UPDATE produtos SET estoque = $2 WHERE id = $1', [p.id, p.estoque]);
        if (p.anuncio_id !== undefined) {
          const a = antes.get(p.id);
          const promo = p.preco_promocional === undefined ? (p.anuncio_id ? a.preco_promocional : null) : p.preco_promocional;
          await client.query('UPDATE produtos SET anuncio_id = $2, preco_promocional = $3 WHERE id = $1', [p.id, p.anuncio_id, promo]);
          // Como na edição de um produto: a promoção vale para o modelo inteiro (mesmo
          // código do modelo). Só quando mudou, e sem mexer nas linhas que vieram juntas.
          const mudou = Number(a.anuncio_id || 0) !== Number(p.anuncio_id || 0) || Number(a.preco_promocional || 0) !== Number(promo || 0);
          if (mudou && p.grade) {
            await client.query(
              `UPDATE produtos SET anuncio_id = $1, preco_promocional = $2, updated_at = CURRENT_TIMESTAMP
               WHERE grade = $3 AND NOT (id = ANY($4))
                 AND (anuncio_id IS DISTINCT FROM $1 OR preco_promocional IS DISTINCT FROM $2)
                 AND ($2::numeric IS NULL OR $2::numeric < preco_venda)`,
              [p.anuncio_id, promo, p.grade, ids]
            );
          }
        }
      }
      const atualizados = await recalcularStatus(client, ids);
      await client.query('COMMIT');
      res.json({ produtos: atualizados });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      if (err.code === '23505') return res.status(400).json({ error: 'Dois produtos ficariam com o mesmo SKU' });
      if (err.code === '23503') return res.status(400).json({ error: 'Essa promoção não existe mais. Escolha outra.' });
      res.status(500).json({ error: 'Erro ao salvar as alterações' });
    } finally {
      if (client) client.release();
    }
  }

  // ---------- Pedido do fornecedor ----------
  // Totais do rodapé do pedido: valores em reais (vazio = não informado) e a
  // descrição do frete. -> { totais } ou { erro }
  function lerTotaisPedido(t) {
    const b = t && typeof t === 'object' ? t : {};
    const totais = { frete_descricao: textoCurto(b.frete_descricao, 120) };
    for (const [campo, rotulo] of [['frete', 'Frete'], ['desconto', 'Desconto'], ['subtotal', 'Subtotal'], ['total', 'Total']]) {
      const v = b[campo];
      if (v === undefined || v === null || v === '') { totais[campo] = null; continue; }
      // Aceita 20.45, "20,45", "- R$ 1.234,56"
      let texto = String(v).replace(/R\$|-|\s/gi, '');
      if (texto.includes(',')) texto = texto.replace(/\./g, '').replace(',', '.');
      const n = typeof v === 'number' ? Math.abs(v) : lerPrecoLote(texto);
      if (!Number.isFinite(n) || n >= 1e8) return { erro: `${rotulo} inválido` };
      totais[campo] = Math.round(n * 100) / 100;
    }
    return { totais };
  }

  async function salvarTotaisPedido(db, fornecedor, numero, data, totais) {
    const { rows } = await db.query(
      `INSERT INTO pedidos_fornecedor (fornecedor, numero, data_compra, frete, frete_descricao, desconto, subtotal, total)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
       ON CONFLICT ((lower(fornecedor)), (lower(numero))) DO UPDATE SET
         data_compra = COALESCE(EXCLUDED.data_compra, pedidos_fornecedor.data_compra),
         frete = EXCLUDED.frete, frete_descricao = EXCLUDED.frete_descricao, desconto = EXCLUDED.desconto,
         subtotal = EXCLUDED.subtotal, total = EXCLUDED.total, updated_at = CURRENT_TIMESTAMP
       RETURNING fornecedor, numero, frete::float, frete_descricao, desconto::float, subtotal::float, total::float`,
      [fornecedor, numero, data || null, totais.frete, totais.frete_descricao, totais.desconto, totais.subtotal, totais.total]
    );
    return rows[0];
  }

  // Grava (ou corrige) os totais de um pedido já lançado
  async function handleTotaisPedidoFornecedor(req, res) {
    const b = req.body || {};
    const numero = textoCurto(b.numero, 60);
    const fornecedor = textoCurto(b.fornecedor, 120);
    if (!numero) return res.status(400).json({ error: 'Informe o número do pedido' });
    const t = lerTotaisPedido(b.totais);
    if (t.erro) return res.status(400).json({ error: t.erro });
    try {
      res.json(await salvarTotaisPedido(req.db, fornecedor, numero, null, t.totais));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao salvar os totais do pedido' });
    }
  }

  // Lê o PDF do pedido (número, data, itens com código, quantidade, custo e foto).
  // Não grava nada: o painel mostra os itens para conferir e depois lança.
  async function handleLerPedidoFornecedor(req, res) {
    if (!req.file) return res.status(400).json({ error: 'Envie o PDF do pedido' });
    try {
      const pedido = await lerPedidoPdf(req.file.buffer);
      if (!pedido.itens.length) {
        return res.status(422).json({ error: 'Não achei itens neste PDF. Ele precisa ter uma linha por item com "x1" e o valor (como a página do pedido na loja do fornecedor).' });
      }
      res.json(pedido);
    } catch (err) {
      if (err instanceof ErroPedidoPdf) return res.status(400).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Erro ao ler o PDF do pedido' });
    }
  }

  // Lança o pedido do fornecedor de uma vez (tudo ou nada):
  // - produtos: linhas do cadastro em lote (produto novo ou reposição pelo SKU),
  //   todas com o fornecedor, o nº do pedido e a data do pedido;
  // - acessorios: estojos, flanelas... somam no estoque do acessório escolhido (id)
  //   ou criam um acessório novo; cada um registra a compra (custo e quantidade).
  // Pedido já lançado (mesmo nº e fornecedor) volta 409, a não ser com `forcar`.
  async function handleLancarPedidoFornecedor(req, res) {
    const b = req.body || {};
    const fornecedor = textoCurto(b.fornecedor, 120);
    const numero = textoCurto(b.numero, 60);
    const data = lerDataCompra(b.data);
    const erros = [];
    if (!numero) erros.push({ campo: 'numero', mensagem: 'Informe o número do pedido' });
    if (data === false) erros.push({ campo: 'data', mensagem: 'Data inválida (use DD/MM/AAAA)' });
    const linhas = Array.isArray(b.produtos) ? b.produtos : [];
    const listaAcessorios = Array.isArray(b.acessorios) ? b.acessorios : [];
    if (!linhas.length && !listaAcessorios.length) erros.push({ campo: 'itens', mensagem: 'O pedido não tem itens para lançar' });
    if (linhas.length > MAX_LOTE) erros.push({ campo: 'itens', mensagem: `Máximo de ${MAX_LOTE} produtos por pedido` });
    if (listaAcessorios.length > MAX_LOTE) erros.push({ campo: 'itens', mensagem: `Máximo de ${MAX_LOTE} acessórios por pedido` });
    if (listaAcessorios.length && !req.admin.dono && !req.admin.permissoes.includes('acessorios')) {
      return res.status(403).json({ error: 'Seu usuário não tem acesso a Acessórios: tire os acessórios do pedido ou peça acesso ao dono' });
    }
    const totaisPedido = b.totais === undefined ? null : lerTotaisPedido(b.totais);
    if (totaisPedido && totaisPedido.erro) erros.push({ campo: 'totais', mensagem: totaisPedido.erro });
    if (erros.length) return res.status(400).json({ error: erros[0].mensagem, erros });

    const produtos = linhas.map((linha, i) => {
      const r = validarProdutoLote({ ...linha, fornecedor, pedido_fornecedor: numero, data_compra: data || '', quantidade: linha && linha.quantidade !== undefined && linha.quantidade !== '' ? linha.quantidade : 1 });
      r.erros.forEach((e) => erros.push({ linha: i, ...e }));
      return r.produto;
    });
    const acessorios = listaAcessorios.map((a, i) => {
      const item = a && typeof a === 'object' ? a : {};
      const id = item.id === undefined || item.id === null || item.id === '' ? null : Number(item.id);
      const nome = textoCurto(item.nome, 100);
      const quantidade = lerQuantidade(item.quantidade ?? 1);
      const custo = lerPrecoLote(item.preco_custo ?? 0);
      const venda = lerPrecoLote(item.preco_venda ?? 0);
      if (id !== null && !(Number.isInteger(id) && id > 0)) erros.push({ acessorio: i, campo: 'id', mensagem: 'Acessório inválido' });
      if (id === null && !nome) erros.push({ acessorio: i, campo: 'nome', mensagem: 'Informe o nome do acessório' });
      if (!quantidade) erros.push({ acessorio: i, campo: 'quantidade', mensagem: 'Quantidade inválida (número inteiro a partir de 1)' });
      if (!Number.isFinite(custo) || custo < 0 || custo >= 1e6) erros.push({ acessorio: i, campo: 'preco_custo', mensagem: 'Custo inválido' });
      if (!Number.isFinite(venda) || venda < 0 || venda >= 1e6) erros.push({ acessorio: i, campo: 'preco_venda', mensagem: 'Preço de venda inválido' });
      return { id, nome, quantidade, custo, venda };
    });
    if (erros.length) return res.status(400).json({ error: 'Corrija os itens marcados', erros });

    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      // Trava por pedido: dois cliques em "Lançar" não lançam o mesmo pedido duas vezes
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pedido-fornecedor:${fornecedor.toLowerCase()}:${numero.toLowerCase()}`]);
      if (b.forcar !== true) {
        const ja = (await client.query(
          `SELECT min(created_at) AS lancado_em, sum(quantidade)::int AS pecas FROM (
             SELECT created_at, quantidade FROM compras_fornecedor WHERE lower(pedido_fornecedor) = lower($1) AND (lower(fornecedor) = lower($2) OR fornecedor = '')
             UNION ALL
             SELECT created_at, quantidade FROM compras_acessorio WHERE lower(pedido_fornecedor) = lower($1) AND (lower(fornecedor) = lower($2) OR fornecedor = '')
           ) c`,
          [numero, fornecedor]
        )).rows[0];
        if (ja && ja.lancado_em) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `O pedido ${numero}${fornecedor ? ` de ${fornecedor}` : ''} já foi lançado (${ja.pecas} peça(s))`, ja_lancado: true, lancado_em: ja.lancado_em, pecas: ja.pecas });
        }
      }
      const { criados, repostos, ignorados } = produtos.length ? await gravarLote(client, produtos) : { criados: [], repostos: [], ignorados: [] };
      const acessoriosGravados = [];
      for (const a of acessorios) {
        const custo = Math.round(a.custo * 100) / 100;
        const r = a.id !== null
          ? await client.query(
            `UPDATE acessorios SET estoque = estoque + $2, preco_custo = $3, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING id, nome, estoque, preco_venda, preco_custo`,
            [a.id, a.quantidade, custo])
          : await client.query(
            `INSERT INTO acessorios (nome, preco_venda, estoque, preco_custo) VALUES ($1, $2, $3, $4)
             RETURNING id, nome, estoque, preco_venda, preco_custo`,
            [a.nome, Math.round(a.venda * 100) / 100, a.quantidade, custo]);
        if (!r.rows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Acessório não encontrado (foi excluído?)', erros: [{ acessorio: acessorios.indexOf(a), campo: 'id', mensagem: 'Acessório não encontrado' }] });
        }
        await client.query(
          `INSERT INTO compras_acessorio (acessorio_id, fornecedor, preco_custo, quantidade, data_compra, pedido_fornecedor)
           VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6)`,
          [r.rows[0].id, fornecedor, custo, a.quantidade, data || null, numero]
        );
        acessoriosGravados.push({ ...r.rows[0], quantidade: a.quantidade, novo: a.id === null });
      }
      const totais = totaisPedido ? await salvarTotaisPedido(client, fornecedor, numero, data, totaisPedido.totais) : null;
      await client.query('COMMIT');
      res.status(201).json({ produtos: criados, repostos, ignorados, acessorios: acessoriosGravados, totais });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao lançar o pedido' });
    } finally {
      if (client) client.release();
    }
  }

  // Compras de produtos e acessórios com nº de pedido, uma linha por peça comprada
  const COMPRAS_COM_PEDIDO = `
    SELECT 'produto' AS tipo, c.produto_id AS item_id, c.fornecedor, c.pedido_fornecedor, c.data_compra, c.quantidade, c.preco_custo, c.origem, c.created_at
    FROM compras_fornecedor c WHERE c.pedido_fornecedor <> ''
    UNION ALL
    SELECT 'acessorio', c.acessorio_id, c.fornecedor, c.pedido_fornecedor, c.data_compra, c.quantidade, c.preco_custo, 'ACESSORIO', c.created_at
    FROM compras_acessorio c WHERE c.pedido_fornecedor <> ''`;

  // Relatório: pedidos do fornecedor lançados (cadastro em lote com nº do pedido ou
  // a tela Pedido do fornecedor), com peças, valor, produtos novos e reposições.
  async function handleListPedidosFornecedor(req, res) {
    try {
      const { rows } = await req.db.query(
        `SELECT g.*, t.frete::float AS frete, COALESCE(t.frete_descricao, '') AS frete_descricao,
                t.desconto::float AS desconto, t.subtotal::float AS subtotal, t.total::float AS total
         FROM (
           SELECT fornecedor, pedido_fornecedor AS numero, to_char(min(data_compra), 'YYYY-MM-DD') AS data_compra,
                  sum(quantidade)::int AS pecas, round(sum(quantidade * preco_custo), 2)::float AS valor,
                  count(*) FILTER (WHERE origem = 'CADASTRO')::int AS novos,
                  count(*) FILTER (WHERE origem = 'REPOSICAO')::int AS reposicoes,
                  count(*) FILTER (WHERE tipo = 'acessorio')::int AS acessorios,
                  min(created_at) AS lancado_em
           FROM (${COMPRAS_COM_PEDIDO}) c
           GROUP BY fornecedor, pedido_fornecedor
         ) g
         LEFT JOIN pedidos_fornecedor t ON lower(t.fornecedor) = lower(g.fornecedor) AND lower(t.numero) = lower(g.numero)
         ORDER BY g.data_compra DESC, g.lancado_em DESC
         LIMIT 500`
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar os pedidos do fornecedor' });
    }
  }

  // O que veio num pedido: cada produto/acessório, quantidade, custo, se foi novo ou
  // reposição, e quantas vezes o produto já foi comprado (em quantos pedidos).
  async function handleItensPedidoFornecedor(req, res) {
    const numero = textoCurto(req.query.numero, 60);
    const fornecedor = textoCurto(req.query.fornecedor, 120);
    if (!numero) return res.status(400).json({ error: 'Informe o número do pedido' });
    try {
      const { rows } = await req.db.query(
        `SELECT c.tipo, c.item_id AS id, c.quantidade, c.preco_custo::float AS preco_custo, c.origem, to_char(c.data_compra, 'YYYY-MM-DD') AS data_compra,
                COALESCE(p.nome, a.nome, '(excluído)') AS nome, p.codigo_sku, p.codigo_fornecedor, p.cor_armacao,
                COALESCE(p.fotos[1], p.imagem_url) AS foto, COALESCE(p.estoque, a.estoque) AS estoque,
                h.pedidos::int AS pedidos, h.pecas::int AS pecas_compradas
         FROM (${COMPRAS_COM_PEDIDO}) c
         LEFT JOIN produtos p ON c.tipo = 'produto' AND p.id = c.item_id
         LEFT JOIN acessorios a ON c.tipo = 'acessorio' AND a.id = c.item_id
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT x.pedido_fornecedor) AS pedidos, sum(x.quantidade) AS pecas
           FROM (${COMPRAS_COM_PEDIDO}) x WHERE x.tipo = c.tipo AND x.item_id = c.item_id
         ) h ON true
         WHERE lower(c.pedido_fornecedor) = lower($1) AND lower(c.fornecedor) = lower($2)
         ORDER BY c.tipo DESC, c.created_at, nome`,
        [numero, fornecedor]
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar os itens do pedido' });
    }
  }

  // Relatório por produto: em quantos pedidos veio, peças compradas, reposições,
  // custo (último, menor, maior) e os números dos pedidos.
  async function handleComprasPorProduto(req, res) {
    try {
      const { rows } = await req.db.query(
        `SELECT p.id, p.nome, p.codigo_sku, p.fornecedor, p.codigo_fornecedor, p.cor_armacao, p.estoque,
                COALESCE(p.fotos[1], p.imagem_url) AS foto,
                count(*)::int AS compras, sum(c.quantidade)::int AS pecas,
                count(*) FILTER (WHERE c.origem = 'REPOSICAO')::int AS reposicoes,
                count(DISTINCT NULLIF(c.pedido_fornecedor, ''))::int AS pedidos,
                array_remove(array_agg(DISTINCT NULLIF(c.pedido_fornecedor, '')), NULL) AS numeros_pedidos,
                to_char(max(c.data_compra), 'YYYY-MM-DD') AS ultima_compra,
                min(c.preco_custo)::float AS custo_min, max(c.preco_custo)::float AS custo_max,
                (SELECT x.preco_custo FROM compras_fornecedor x WHERE x.produto_id = p.id ORDER BY x.data_compra DESC, x.id DESC LIMIT 1)::float AS custo_ultimo
         FROM produtos p JOIN compras_fornecedor c ON c.produto_id = p.id
         GROUP BY p.id
         ORDER BY sum(c.quantidade) DESC, count(*) DESC, p.nome
         LIMIT 1000`
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar o histórico de compras' });
    }
  }

  // ---------- Histórico de reposição (compras do fornecedor) ----------

  function idProduto(v) {
    return typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null;
  }

  async function handleListCompras(req, res) {
    const id = idProduto(req.params.id);
    if (!id) return res.status(404).json({ error: 'Produto não encontrado' });
    try {
      const { rows } = await req.db.query(
        `SELECT id, fornecedor, preco_custo, quantidade, origem, to_char(data_compra, 'YYYY-MM-DD') AS data_compra, pedido_fornecedor, created_at
         FROM compras_fornecedor WHERE produto_id = $1
         ORDER BY data_compra DESC, id DESC LIMIT 100`,
        [id]
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar histórico de compras' });
    }
  }

  // Registra uma reposição: custo unitário pago, quantidade, data (padrão hoje) e
  // nº do pedido no fornecedor. As peças somam no estoque (produto ESGOTADO volta
  // a DISPONIVEL) e o custo do produto passa a ser o da compra mais recente.
  async function handleCreateCompra(req, res) {
    const id = idProduto(req.params.id);
    if (!id) return res.status(404).json({ error: 'Produto não encontrado' });
    const b = req.body || {};
    const custo = lerPrecoLote(b.preco_custo);
    if (!Number.isFinite(custo) || custo < 0 || custo >= 1e8) return res.status(400).json({ error: 'Custo inválido' });
    const quantidade = b.quantidade === undefined || b.quantidade === '' ? 1 : Number(b.quantidade);
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 100000) return res.status(400).json({ error: 'Quantidade inválida' });
    const data = lerDataCompra(b.data_compra);
    if (data === false) return res.status(400).json({ error: 'Data inválida' });

    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const prod = await client.query('SELECT id FROM produtos WHERE id = $1 FOR UPDATE', [id]);
      if (!prod.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Produto não encontrado' });
      }
      const r = await reporEstoque(client, id, { custo, quantidade, data, pedido: textoCurto(b.pedido_fornecedor, 60) });
      await client.query('COMMIT');
      res.status(201).json(r);
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao registrar compra' });
    } finally {
      if (client) client.release();
    }
  }

  // Resumo por fornecedor: produtos, última compra, quantos subiram/baixaram de
  // custo na última compra e a variação média (última vs. anterior).
  async function handleResumoFornecedores(req, res) {
    try {
      const { rows } = await req.db.query(
        `WITH ult AS (
           SELECT p.fornecedor, uc.data_compra, uc.preco_custo AS custo_ult, ca.preco_custo AS custo_ant
           FROM produtos p
           LEFT JOIN LATERAL (
             SELECT data_compra, preco_custo FROM compras_fornecedor c
             WHERE c.produto_id = p.id ORDER BY data_compra DESC, id DESC LIMIT 1
           ) uc ON true
           LEFT JOIN LATERAL (
             SELECT preco_custo FROM compras_fornecedor c
             WHERE c.produto_id = p.id ORDER BY data_compra DESC, id DESC OFFSET 1 LIMIT 1
           ) ca ON true
         )
         SELECT fornecedor,
                COUNT(*)::int AS produtos,
                to_char(MAX(data_compra), 'YYYY-MM-DD') AS ultima_compra,
                COUNT(*) FILTER (WHERE custo_ant IS NOT NULL AND custo_ult > custo_ant)::int AS subiram,
                COUNT(*) FILTER (WHERE custo_ant IS NOT NULL AND custo_ult < custo_ant)::int AS baixaram,
                ROUND(AVG((custo_ult - custo_ant) / custo_ant * 100) FILTER (WHERE custo_ant > 0), 1)::float AS variacao_media
         FROM ult
         GROUP BY fornecedor
         ORDER BY MAX(data_compra) DESC NULLS LAST, fornecedor`
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar resumo dos fornecedores' });
    }
  }

  // Importação pelo link do produto na loja do fornecedor (só preenche o formulário;
  // nada é gravado aqui).
  async function handleImportarUrl(req, res) {
    try {
      res.json(await importarProduto(req.body && req.body.url));
    } catch (err) {
      if (err instanceof ErroImportacao) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Erro ao importar o produto' });
    }
  }

  // Foto principal do fornecedor, pelo servidor (a loja não deixa o navegador baixar
  // direto de outro site): o painel salva no computador com o nome do SKU.
  async function handleImportarImagem(req, res) {
    try {
      const img = await baixarImagem(req.body && req.body.url);
      res.set('Cache-Control', 'no-store').type(img.tipo).send(img.buffer);
    } catch (err) {
      if (err instanceof ErroImportacao) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Erro ao baixar a imagem' });
    }
  }

  async function handleMaletaCheckout(req, res) {
    const { produtoIds, productIds, ids, itens, contato } = req.body || {};
    // itens: [{ id, intencao }] com a escolha de cada item no carrinho (Compra direta ou Maleta)
    const comIntencao = Array.isArray(itens) ? itens.filter(i => i && typeof i === 'object') : [];
    const list = produtoIds || productIds || ids || (Array.isArray(itens) ? itens.map(i => i && i.id) : undefined);

    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ITENS_PEDIDO) {
      return res.status(400).json({ error: 'Array de IDs de produtos é obrigatório' });
    }
    if (!list.every(id => (Number.isInteger(id) && id > 0 && id < 2 ** 31) || (typeof id === 'string' && /^\d{1,9}$/.test(id) && Number(id) > 0))) {
      return res.status(400).json({ error: 'IDs de produtos inválidos' });
    }
    const idsOk = [...new Set(list.map(Number))];
    const intencoes = new Map(comIntencao
      .filter(i => i.intencao === 'COMPRA' || i.intencao === 'CONDICIONAL')
      .map(i => [Number(i.id), i.intencao]));
    const clienteId = clienteDoToken(req);
    // Origem (UTMs, fbclid, gclid), ids da Meta e o event_id do dataLayer. O event_id
    // sempre existe: sem o da vitrine, o servidor cria um (a CAPI usa o mesmo).
    const rastro = rastreamento.lerRastreamento(req.body && req.body.rastreamento);
    if (!rastro.event_id) rastro.event_id = crypto.randomUUID();
    const urlPagina = typeof (req.body && req.body.rastreamento && req.body.rastreamento.url) === 'string' ? req.body.rastreamento.url : '';
    // Token do navegador ("lembrar meus dados"): o mesmo das compras anteriores ou um novo
    const visitante = rastreamento.lerTokenVisitante(req.body && req.body.visitante) || rastreamento.novoTokenVisitante();
    const emailContato = contato && typeof contato.email === 'string' && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(contato.email.trim()) && contato.email.trim().length <= 254
      ? contato.email.trim().toLowerCase() : '';

    let client;
    let paraMeta = null;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE produtos p
         SET vezes_em_maleta = vezes_em_maleta + 1
         WHERE id = ANY($1)
         RETURNING id, nome, codigo_sku, preco_venda, ${anuncios.sqlPrecoPromocional('p')} AS preco_promocional, disponibilidade, vezes_em_maleta`,
        [idsOk]
      );

      let pedido = null;
      if (result.rows.length) {
        // Conta apagada no meio do caminho: o pedido fica sem cliente
        const dono = clienteId === null ? [] :
          (await client.query('SELECT id, email FROM clientes WHERE id = $1', [clienteId])).rows;
        const ordem = new Map(idsOk.map((id, i) => [id, i]));
        const linhas = [...result.rows].sort((a, b) => ordem.get(a.id) - ordem.get(b.id));
        const p = montarPedido(linhas, contato, intencoes);
        const { rows } = await client.query(
          `INSERT INTO pedidos (cliente_id, nome, telefone, email, endereco, itens, total_prova, total_compra, total_encomendas, sinal, total, rastreamento, visitante_token)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id, status, email`,
          [dono[0] ? dono[0].id : null, p.nome, p.telefone, dono[0] ? dono[0].email : emailContato, p.endereco,
            JSON.stringify(p.itens), p.totalProva, p.totalCompra, p.totalEncomendas, p.sinal, p.total,
            JSON.stringify(rastro), visitante]
        );
        pedido = { id: rows[0].id, status: rows[0].status };
        paraMeta = { pedido: { id: rows[0].id, email: rows[0].email }, p };
        // Itens sob encomenda já entram no painel de Encomendas
        for (const i of p.itens.filter(x => x.intencao === 'ENCOMENDA')) {
          await client.query(
            `INSERT INTO encomendas (pedido_id, cliente_id, produto_id, origem, nome_cliente, telefone, modelo, codigo_sku, valor)
             VALUES ($1, $2, $3, 'SITE', $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
            [pedido.id, dono[0] ? dono[0].id : null, i.produto_id, p.nome, p.telefone, i.nome, i.codigo_sku, i.preco]
          );
        }
      }

      await client.query('COMMIT');
      res.json({
        atualizados: result.rows.map(r => ({ id: r.id, nome: r.nome, vezes_em_maleta: r.vezes_em_maleta })),
        pedido,
        // A vitrine usa o event_id no generate_lead/purchase e guarda o visitante
        event_id: rastro.event_id,
        visitante,
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      return res.status(500).json({ error: 'Erro ao processar checkout da maleta' });
    } finally {
      if (client) client.release();
    }
    // Depois da resposta: a cliente já vai para o WhatsApp sem esperar a Meta
    if (paraMeta) enviarPedidoParaMeta(req, paraMeta.pedido, paraMeta.p, contato, { ...rastro, url: urlPagina }, visitante);
  }

  // Admin: clientes com resumo dos pedidos (nunca devolve senha_hash)
  async function handleListClientes(req, res) {
    try {
      const { rows } = await req.db.query(
        `SELECT c.id, c.email, c.nome, c.created_at,
                COUNT(p.id)::int AS pedidos,
                COALESCE(SUM(p.total), 0) AS total_pedidos,
                MAX(p.created_at) AS ultimo_pedido,
                COUNT(p.id) FILTER (WHERE p.status IN ('NOVO', 'EM_ANDAMENTO'))::int AS pedidos_abertos,
                (SELECT COUNT(*)::int FROM encomendas e WHERE e.cliente_id = c.id
                   AND e.status IN ('AGUARDANDO_FABRICANTE', 'EM_TRANSITO', 'PRONTO_ENTREGA')) AS encomendas_abertas,
                (SELECT COUNT(DISTINCT mp.pedido_id)::int FROM maleta_pecas mp JOIN pedidos p3 ON p3.id = mp.pedido_id
                   WHERE p3.cliente_id = c.id) AS maletas_na_rua
         FROM clientes c
         LEFT JOIN pedidos p ON p.cliente_id = c.id
         GROUP BY c.id
         ORDER BY MAX(p.created_at) DESC NULLS LAST, c.created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar clientes' });
    }
  }

  // Admin: pedidos (todos, de um cliente com ?cliente=<id> ou sem conta com ?cliente=sem-conta)
  // ?status=NOVO|EM_ANDAMENTO|ENTREGUE|CANCELADO filtra pelo status do pedido.
  // vendidos_acerto/devolvidos_acerto: peças da maleta deste pedido já acertadas.
  async function handleListPedidos(req, res) {
    const filtro = req.query.cliente;
    const status = req.query.status;
    const condicoes = [];
    const params = [];
    if (filtro === 'sem-conta') {
      condicoes.push('p.cliente_id IS NULL');
    } else if (filtro !== undefined) {
      if (typeof filtro !== 'string' || !/^\d{1,9}$/.test(filtro)) return res.status(400).json({ error: 'Cliente inválido' });
      params.push(Number(filtro));
      condicoes.push(`p.cliente_id = $${params.length}`);
    }
    if (status !== undefined) {
      if (!STATUS_PEDIDO.includes(status)) return res.status(400).json({ error: 'Status inválido' });
      params.push(status);
      condicoes.push(`p.status = $${params.length}`);
    }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    try {
      res.json(await listarPedidos(req.db, where, params));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar pedidos' });
    }
  }

  // Pedidos com o que o painel precisa (acertos, encomendas e o que a mesma cliente já
  // devolveu em maletas anteriores: ja_devolvidos, para não reenviar modelo recusado)
  async function listarPedidos(db, where, params) {
    const { rows } = await db.query(
        `SELECT p.id, p.cliente_id, p.nome, p.telefone, p.email, p.endereco, p.itens, p.status,
                p.total_prova, p.total_compra, p.total_encomendas, p.sinal, p.total, p.maleta_enviada_em, p.created_at,
                p.itens_removidos, p.extras, p.desconto_tipo, p.desconto_valor, p.total_final, p.entregue_em, p.updated_at, p.rastreamento,
                COALESCE(ac.vendidos, '{}') AS vendidos_acerto, COALESCE(ac.devolvidos, '{}') AS devolvidos_acerto,
                COALESCE((SELECT json_agg(json_build_object('id', e.id, 'produto_id', e.produto_id, 'status', e.status) ORDER BY e.id)
                          FROM encomendas e WHERE e.pedido_id = p.id), '[]') AS encomendas,
                COALESCE((SELECT array_agg(DISTINCT x) FROM pedidos p2
                          JOIN acertos a4 ON a4.pedido_id = p2.id
                          CROSS JOIN LATERAL unnest(a4.devolvidos) x
                          WHERE p2.id <> p.id AND (
                            (p.cliente_id IS NOT NULL AND p2.cliente_id = p.cliente_id) OR
                            (length(regexp_replace(p.telefone, '\\D', '', 'g')) >= 8 AND
                             regexp_replace(p2.telefone, '\\D', '', 'g') = regexp_replace(p.telefone, '\\D', '', 'g')))), '{}') AS ja_devolvidos
         FROM pedidos p
         LEFT JOIN LATERAL (
           SELECT (SELECT array_agg(DISTINCT x) FROM acertos a2, unnest(a2.comprados) x WHERE a2.pedido_id = p.id) AS vendidos,
                  (SELECT array_agg(DISTINCT x) FROM acertos a3, unnest(a3.devolvidos) x WHERE a3.pedido_id = p.id) AS devolvidos
         ) ac ON true
         ${where}
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT 200`,
        params
      );
    return rows;
  }

  // Maletas enviadas (pedidos com maleta_enviada_em) e o resultado de cada peça
  async function carregarMaletas(db, where, params) {
    const pedidos = (await db.query(
      `SELECT p.id, p.cliente_id, p.nome, p.telefone, p.itens, p.status, p.maleta_enviada_em
       FROM pedidos p WHERE p.maleta_enviada_em IS NOT NULL ${where ? 'AND ' + where : ''}
       ORDER BY p.maleta_enviada_em DESC, p.id DESC LIMIT 500`, params)).rows;
    const ids = pedidos.map(p => p.id);
    const acertos = (await db.query('SELECT pedido_id, comprados, devolvidos FROM acertos WHERE pedido_id = ANY($1)', [ids])).rows;
    const naRua = (await db.query(
      `SELECT produto_id AS id, pedido_id AS pedido_condicional_id FROM maleta_pecas WHERE pedido_id = ANY($1)`, [ids])).rows;
    return pedidos.map(p => {
      const doPedido = acertos.filter(a => a.pedido_id === p.id);
      const pecas = resultadoMaleta(p.itens,
        doPedido.flatMap(a => a.comprados.map(Number)),
        doPedido.flatMap(a => a.devolvidos.map(Number)),
        naRua.filter(r => r.pedido_condicional_id === p.id).map(r => r.id));
      return { pedido_id: p.id, cliente_id: p.cliente_id, nome: p.nome, status: p.status, enviada_em: p.maleta_enviada_em, pecas, ...resumoConversao(pecas) };
    });
  }

  // Admin: perfil 360 da cliente (pedidos, encomendas, maletas, acertos, histórico de
  // provas e pendências)
  async function handlePerfilCliente(req, res) {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'Cliente inválido' });
    const id = Number(req.params.id);
    try {
      const cli = (await req.db.query('SELECT id, email, nome, created_at FROM clientes WHERE id = $1', [id])).rows[0];
      if (!cli) return res.status(404).json({ error: 'Cliente não encontrada' });
      const pedidos = await listarPedidos(req.db, 'WHERE p.cliente_id = $1', [id]);
      const encomendas = (await req.db.query(
        `SELECT ${CAMPOS_ENCOMENDA} FROM encomendas
         WHERE cliente_id = $1 OR pedido_id IN (SELECT id FROM pedidos WHERE cliente_id = $1)
         ORDER BY created_at DESC, id DESC`, [id])).rows;
      const maletas = await carregarMaletas(req.db, 'p.cliente_id = $1', [id]);
      const acertos = (await req.db.query(
        `SELECT a.id, a.pedido_id, a.observacoes, a.created_at,
                COALESCE((SELECT json_agg(json_build_object('id', pr.id, 'nome', pr.nome, 'codigo_sku', pr.codigo_sku, 'preco', pr.preco_venda) ORDER BY pr.id)
                          FROM produtos pr WHERE pr.id = ANY(a.comprados)), '[]') AS comprados,
                COALESCE((SELECT json_agg(json_build_object('id', pr.id, 'nome', pr.nome, 'codigo_sku', pr.codigo_sku) ORDER BY pr.id)
                          FROM produtos pr WHERE pr.id = ANY(a.devolvidos)), '[]') AS devolvidos
         FROM acertos a JOIN pedidos p ON p.id = a.pedido_id
         WHERE p.cliente_id = $1 ORDER BY a.created_at DESC, a.id DESC`, [id])).rows;
      // Histórico de provas: cada peça que ela recebeu numa maleta, com o resultado e a foto atual
      const provas = maletas.flatMap(m => m.pecas.map(pc => ({ ...pc, pedido_id: m.pedido_id, data: m.enviada_em })));
      const fotos = new Map((await req.db.query('SELECT id, imagem_url FROM produtos WHERE id = ANY($1)', [provas.map(p => p.produto_id)])).rows
        .map(r => [r.id, r.imagem_url]));
      for (const p of provas) p.imagem_url = fotos.get(p.produto_id) || null;
      const entregues = pedidos.filter(p => p.status === 'ENTREGUE');
      res.json({
        cliente: cli,
        resumo: {
          pedidos: pedidos.length,
          entregues: entregues.length,
          total_comprado: entregues.reduce((t, p) => t + Math.round(Number(p.total_final ?? 0) * 100), 0) / 100,
          ...resumoConversao(provas),
        },
        pendencias: pendenciasDoCliente(pedidos, maletas, encomendas),
        pedidos,
        encomendas,
        maletas,
        acertos,
        provas,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao montar o perfil da cliente' });
    }
  }

  // Admin: relatório de conversão das maletas (?dias=30|90|365; sem = tudo)
  async function handleRelatorioMaletas(req, res) {
    const { dias } = req.query;
    if (dias !== undefined && !['30', '90', '365'].includes(dias)) return res.status(400).json({ error: 'Período inválido' });
    const params = dias ? [Number(dias)] : [];
    const periodo = (col) => (dias ? `${col} >= CURRENT_TIMESTAMP - make_interval(days => $1)` : '');
    try {
      const maletas = await carregarMaletas(req.db, periodo('p.maleta_enviada_em'), params);
      const avulsos = (await req.db.query(
        `SELECT COALESCE(SUM(cardinality(comprados)), 0)::int AS vendidas, COALESCE(SUM(cardinality(devolvidos)), 0)::int AS devolvidas,
                COUNT(*)::int AS acertos
         FROM acertos WHERE pedido_id IS NULL ${dias ? 'AND ' + periodo('created_at') : ''}`, params)).rows[0];
      // Modelos que mais voltam e que mais vendem nas maletas
      const porProduto = new Map();
      for (const pc of maletas.flatMap(m => m.pecas)) {
        const atual = porProduto.get(pc.produto_id) || { produto_id: pc.produto_id, nome: pc.nome, codigo_sku: pc.codigo_sku, enviadas: 0, vendidas: 0, devolvidas: 0 };
        atual.enviadas++;
        if (pc.resultado === 'VENDIDA') atual.vendidas++;
        if (pc.resultado === 'DEVOLVIDA') atual.devolvidas++;
        porProduto.set(pc.produto_id, atual);
      }
      res.json({
        total: resumoConversao(maletas.flatMap(m => m.pecas)),
        maletas: maletas.map(({ pecas, ...m }) => m),
        sem_pedido: avulsos,
        produtos: [...porProduto.values()].sort((a, b) => b.enviadas - a.enviadas || b.vendidas - a.vendidas).slice(0, 20),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao montar o relatório' });
    }
  }

  // Admin: "Enviar maleta" de um pedido. As peças de pronta entrega que ainda estão
  // DISPONIVEL vão para CONDICIONAL ligadas ao pedido; as que já saíram (vendidas ou
  // na maleta de outra cliente) voltam em `indisponiveis`. Pode repetir sem efeito colateral.
  async function handleEnviarMaleta(req, res) {
    const { id } = req.params;
    if (!/^\d{1,9}$/.test(id) || Number(id) === 0) return res.status(400).json({ error: 'Pedido inválido' });
    const pedidoId = Number(id);

    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT id, itens, status FROM pedidos WHERE id = $1 FOR UPDATE', [pedidoId]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Pedido não encontrado' });
      }
      if (rows[0].status === 'CANCELADO' || rows[0].status === 'ENTREGUE') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Pedido ${rows[0].status === 'CANCELADO' ? 'cancelado' : 'já entregue'}` });
      }
      const prova = (Array.isArray(rows[0].itens) ? rows[0].itens : [])
        .filter((i) => i && intencaoDoItem(i) === 'CONDICIONAL' && Number.isInteger(Number(i.produto_id)));
      const ids = [...new Set(prova.map((i) => Number(i.produto_id)))];
      if (!ids.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Este pedido não tem peças para provar na maleta' });
      }

      // Uma peça de cada produto sai do estoque para a maleta (a que já está nela fica)
      const enviados = [];
      for (const pid of ids) {
        const ja = await client.query('SELECT 1 FROM maleta_pecas WHERE produto_id = $1 AND pedido_id = $2', [pid, pedidoId]);
        if (ja.rows.length) continue;
        const saiu = await client.query('UPDATE produtos SET estoque = estoque - 1 WHERE id = $1 AND estoque > 0 RETURNING id', [pid]);
        if (!saiu.rows.length) continue;
        await client.query('INSERT INTO maleta_pecas (produto_id, pedido_id) VALUES ($1, $2)', [pid, pedidoId]);
        enviados.push(pid);
      }
      await recalcularStatus(client, enviados);
      const naMaleta = (await client.query(
        `SELECT DISTINCT produto_id AS id FROM maleta_pecas WHERE produto_id = ANY($1) AND pedido_id = $2`,
        [ids, pedidoId]
      )).rows.map((r) => r.id);
      const indisponiveis = prova
        .filter((i) => !naMaleta.includes(Number(i.produto_id)))
        .map((i) => ({ produto_id: Number(i.produto_id), nome: i.nome, codigo_sku: i.codigo_sku }));

      if (!naMaleta.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Nenhuma peça deste pedido está disponível', indisponiveis });
      }

      const atualizado = await client.query(
        `UPDATE pedidos SET maleta_enviada_em = COALESCE(maleta_enviada_em, CURRENT_TIMESTAMP),
                status = CASE WHEN status = 'NOVO' THEN 'EM_ANDAMENTO' ELSE status END, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING maleta_enviada_em, status`,
        [pedidoId]
      );
      await client.query('COMMIT');
      res.json({ enviados, na_maleta: naMaleta, indisponiveis, maleta_enviada_em: atualizado.rows[0].maleta_enviada_em, status: atualizado.rows[0].status });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao enviar a maleta' });
    } finally {
      if (client) client.release();
    }
  }

  function lerIdPedido(req, res) {
    const { id } = req.params;
    if (!/^\d{1,9}$/.test(id) || Number(id) === 0) {
      res.status(400).json({ error: 'Pedido inválido' });
      return null;
    }
    return Number(id);
  }

  // Peças da maleta deste pedido que ainda estão com a cliente
  async function pecasNaRua(db, pedidoId) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM maleta_pecas WHERE pedido_id = $1`, [pedidoId]);
    return rows[0].n;
  }

  // Devolve ao estoque os acessórios lançados no fechamento do pedido
  async function devolverExtras(db, extras) {
    for (const e of Array.isArray(extras) ? extras : []) {
      const q = Number(e && e.quantidade);
      if (Number.isInteger(q) && q > 0) {
        await db.query('UPDATE acessorios SET estoque = estoque + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [Number(e.acessorio_id), q]);
      }
    }
  }

  // Admin: muda o status do pedido. ENTREGUE só pelo fechamento (que dá baixa no estoque).
  // Cancelar devolve os acessórios ao estoque; com peças da maleta na rua, faça o acerto antes.
  async function handleStatusPedido(req, res) {
    const pedidoId = lerIdPedido(req, res);
    if (pedidoId === null) return;
    const novo = req.body && req.body.status;
    if (!['NOVO', 'EM_ANDAMENTO', 'CANCELADO'].includes(novo)) {
      return res.status(400).json({ error: 'Status inválido (para entregar, use o fechamento do pedido)' });
    }
    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT id, status, extras FROM pedidos WHERE id = $1 FOR UPDATE', [pedidoId]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Pedido não encontrado' });
      }
      const atual = rows[0];
      if (atual.status === 'ENTREGUE') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Pedido já entregue não muda de status' });
      }
      if (novo === 'CANCELADO' && atual.status !== 'CANCELADO') {
        if (await pecasNaRua(client, pedidoId)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'A maleta deste pedido ainda está com a cliente: faça o acerto antes de cancelar' });
        }
        await devolverExtras(client, atual.extras);
        await client.query(`UPDATE pedidos SET extras = '[]', total_final = NULL WHERE id = $1`, [pedidoId]);
      }
      const r = await client.query(
        'UPDATE pedidos SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, status',
        [pedidoId, novo]
      );
      await client.query('COMMIT');
      res.json(r.rows[0]);
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao mudar o status do pedido' });
    } finally {
      if (client) client.release();
    }
  }

  // Admin: fechamento do pedido na entrega. Cobra os itens de compra direta que a
  // cliente levou e as peças da maleta vendidas no acerto, mais os acessórios extras
  // (que dão baixa no estoque deles), com desconto em R$ ou %. Pode salvar quantas
  // vezes quiser; concluir=true marca ENTREGUE e dá baixa (ESGOTADO) nas peças de compra direta.
  async function handleFechamentoPedido(req, res) {
    const pedidoId = lerIdPedido(req, res);
    if (pedidoId === null) return;
    const body = req.body || {};
    const removidosRaw = body.removidos === undefined || body.removidos === null ? [] : body.removidos;
    if (!Array.isArray(removidosRaw) || removidosRaw.length > MAX_ITENS_PEDIDO ||
        !removidosRaw.every(id => Number.isInteger(Number(id)) && Number(id) > 0 && Number(id) < 2 ** 31)) {
      return res.status(400).json({ error: 'Itens removidos inválidos' });
    }
    const desconto = lerDesconto(body.desconto);
    if (desconto === null) return res.status(400).json({ error: 'Desconto inválido (valor em R$ ou percentual de 0 a 100)' });
    const novosExtras = lerExtras(body.extras);
    if (novosExtras === null) return res.status(400).json({ error: 'Acessórios inválidos' });
    const concluir = body.concluir === true;

    let client;
    const falhar = async (status, payload) => {
      await client.query('ROLLBACK');
      res.status(status).json(payload);
    };
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [pedidoId]);
      if (!rows.length) return falhar(404, { error: 'Pedido não encontrado' });
      const pedido = rows[0];
      if (pedido.status === 'CANCELADO') return falhar(409, { error: 'Pedido cancelado: reabra antes de fechar' });
      const jaEntregue = pedido.status === 'ENTREGUE';

      const itens = Array.isArray(pedido.itens) ? pedido.itens : [];
      const compras = itens.filter(i => intencaoDoItem(i) === 'COMPRA');
      const idsCompra = compras.map(i => Number(i.produto_id));
      const removidosPedidos = [...new Set(removidosRaw.map(Number))];
      if (!jaEntregue && removidosPedidos.some(id => !idsCompra.includes(id))) {
        return falhar(400, { error: 'Só itens de compra direta podem ser tirados do pedido' });
      }
      // Depois de entregue a baixa já foi feita: os itens levados não mudam mais
      const removidos = jaEntregue ? (pedido.itens_removidos || []).map(Number) : removidosPedidos;

      const vendidosAcerto = (await client.query(
        `SELECT DISTINCT x AS id FROM acertos a, unnest(a.comprados) x WHERE a.pedido_id = $1`, [pedidoId]
      )).rows.map(r => Number(r.id));
      const cobrados = itens.filter(i => {
        const intencao = intencaoDoItem(i);
        const id = Number(i.produto_id);
        if (intencao === 'COMPRA') return !removidos.includes(id);
        return intencao === 'CONDICIONAL' && vendidosAcerto.includes(id);
      });

      // Acessórios: aplica no estoque só a diferença para o que já estava lançado
      const anteriores = new Map();
      for (const e of Array.isArray(pedido.extras) ? pedido.extras : []) {
        anteriores.set(Number(e.acessorio_id), e);
      }
      const todosIds = [...new Set([...anteriores.keys(), ...novosExtras.keys()])];
      const estoque = new Map((await client.query(
        'SELECT id, nome, preco_venda, estoque, ativo FROM acessorios WHERE id = ANY($1) ORDER BY id FOR UPDATE', [todosIds]
      )).rows.map(a => [a.id, a]));
      const extras = [];
      for (const id of todosIds) {
        const antes = anteriores.has(id) ? Number(anteriores.get(id).quantidade) || 0 : 0;
        const depois = novosExtras.get(id) || 0;
        const a = estoque.get(id);
        if (!a) {
          if (depois > antes) return falhar(400, { error: 'Acessório não encontrado' });
          // Acessório excluído do cadastro: o que já estava no pedido fica como foi
          // lançado (nome e preço copiados), sem mexer em estoque; zerado, sai do pedido.
          if (depois > 0) {
            const ant = anteriores.get(id);
            extras.push({ acessorio_id: id, nome: ant.nome, preco: Number(ant.preco), quantidade: depois });
          }
          continue;
        }
        const delta = depois - antes;
        if (delta > 0 && !a.ativo && antes === 0) return falhar(400, { error: `Acessório inativo: ${a.nome}` });
        if (delta > 0 && a.estoque < delta) {
          return falhar(409, { error: `Estoque insuficiente de ${a.nome} (restam ${a.estoque})` });
        }
        if (delta !== 0) {
          await client.query('UPDATE acessorios SET estoque = estoque - $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id, delta]);
        }
        if (depois > 0) {
          // Preço de quando entrou no pedido; acessório novo no pedido usa o preço atual
          const preco = anteriores.has(id) ? Number(anteriores.get(id).preco) : Number(a.preco_venda);
          extras.push({ acessorio_id: id, nome: a.nome, preco, quantidade: depois });
        }
      }

      const fechamento = calcularFechamento(cobrados, extras, desconto);

      if (concluir && !jaEntregue) {
        if (await pecasNaRua(client, pedidoId)) {
          return falhar(409, { error: 'A maleta deste pedido ainda está com a cliente: faça o acerto antes de concluir a entrega' });
        }
        const levar = idsCompra.filter(id => !removidos.includes(id));
        if (levar.length) {
          // Compra direta: uma peça de cada sai do estoque
          const baixados = (await client.query(
            `UPDATE produtos SET estoque = estoque - 1 WHERE id = ANY($1) AND estoque > 0 RETURNING id`,
            [levar]
          )).rows.map(r => r.id);
          await recalcularStatus(client, baixados);
          const indisponiveis = compras
            .filter(i => levar.includes(Number(i.produto_id)) && !baixados.includes(Number(i.produto_id)))
            .map(i => ({ produto_id: Number(i.produto_id), nome: i.nome, codigo_sku: i.codigo_sku }));
          if (indisponiveis.length) {
            return falhar(409, { error: 'Peças que já não estão disponíveis (tire do pedido ou encomende)', indisponiveis });
          }
        }
      }

      const r = await client.query(
        `UPDATE pedidos SET itens_removidos = $2, extras = $3, desconto_tipo = $4, desconto_valor = $5, total_final = $6,
                status = CASE WHEN $7 THEN 'ENTREGUE' ELSE status END,
                entregue_em = CASE WHEN $7 THEN COALESCE(entregue_em, CURRENT_TIMESTAMP) ELSE entregue_em END,
                updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, status, itens_removidos, extras, desconto_tipo, desconto_valor, total_final, entregue_em`,
        [pedidoId, removidos, JSON.stringify(extras), desconto.tipo, desconto.valor, fechamento.total, concluir]
      );
      await client.query('COMMIT');
      res.json({ ...r.rows[0], fechamento });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao salvar o fechamento do pedido' });
    } finally {
      if (client) client.release();
    }
  }

  // ---------- Encomendas ----------
  const CAMPOS_ENCOMENDA = 'id, pedido_id, cliente_id, produto_id, origem, nome_cliente, telefone, modelo, codigo_sku, especificacoes, valor, sinal_pago, status, observacoes, entregue_em, pedido_fornecedor_em, pedido_fornecedor_ref, created_at, updated_at';

  function lerValorEncomenda(v) {
    if (v === undefined || v === null || v === '') return 0;
    const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
    return Number.isFinite(n) && n >= 0 && n <= 1e6 ? Math.round(n * 100) / 100 : null;
  }

  // Campos editáveis; parcial=true só lê o que veio no corpo
  function lerEncomenda(body, parcial) {
    const b = body || {};
    const tem = (k) => !parcial || b[k] !== undefined;
    const e = {};
    if (tem('nome_cliente')) e.nome_cliente = textoCurto(b.nome_cliente, 100);
    if (tem('telefone')) e.telefone = textoCurto(b.telefone, 30);
    if (tem('modelo')) e.modelo = textoCurto(b.modelo, 255);
    if (tem('codigo_sku')) e.codigo_sku = textoCurto(b.codigo_sku, 100);
    if (tem('especificacoes')) e.especificacoes = typeof b.especificacoes === 'string' ? b.especificacoes.trim().slice(0, 2000) : '';
    if (tem('observacoes')) e.observacoes = typeof b.observacoes === 'string' ? b.observacoes.trim().slice(0, 2000) : '';
    for (const k of ['valor', 'sinal_pago']) {
      if (tem(k)) {
        e[k] = lerValorEncomenda(b[k]);
        if (e[k] === null) return { erro: `${k === 'valor' ? 'Valor' : 'Sinal'} inválido` };
      }
    }
    if (tem('status')) {
      e.status = b.status === undefined ? 'AGUARDANDO_FABRICANTE' : b.status;
      if (!STATUS_ENCOMENDA.includes(e.status)) return { erro: 'Status da encomenda inválido' };
    }
    if (e.valor !== undefined && e.sinal_pago !== undefined && e.sinal_pago > e.valor && e.valor > 0) return { erro: 'Sinal maior que o valor' };
    return { dados: e };
  }

  async function handleListEncomendas(req, res) {
    const { status, cliente } = req.query;
    const condicoes = [];
    const params = [];
    if (status !== undefined) {
      if (!STATUS_ENCOMENDA.includes(status)) return res.status(400).json({ error: 'Status inválido' });
      params.push(status);
      condicoes.push(`status = $${params.length}`);
    }
    if (cliente !== undefined) {
      if (typeof cliente !== 'string' || !/^\d{1,9}$/.test(cliente)) return res.status(400).json({ error: 'Cliente inválido' });
      params.push(Number(cliente));
      condicoes.push(`cliente_id = $${params.length}`);
    }
    try {
      const { rows } = await req.db.query(
        `SELECT ${CAMPOS_ENCOMENDA} FROM encomendas ${condicoes.length ? 'WHERE ' + condicoes.join(' AND ') : ''}
         ORDER BY created_at DESC, id DESC LIMIT 300`, params);
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar encomendas' });
    }
  }

  // Encomenda lançada à mão (cliente pediu no balcão, por telefone etc.)
  async function handleCreateEncomenda(req, res) {
    const { erro, dados: e } = lerEncomenda(req.body, false);
    if (erro) return res.status(400).json({ error: erro });
    if (!e.modelo) return res.status(400).json({ error: 'Informe o modelo encomendado' });
    if (!e.nome_cliente && !e.telefone) return res.status(400).json({ error: 'Informe o nome ou o telefone da cliente' });
    const clienteId = req.body.cliente_id === undefined || req.body.cliente_id === null || req.body.cliente_id === '' ? null : Number(req.body.cliente_id);
    if (clienteId !== null && !(Number.isInteger(clienteId) && clienteId > 0 && clienteId < 2 ** 31)) return res.status(400).json({ error: 'Cliente inválido' });
    try {
      const { rows } = await req.db.query(
        `INSERT INTO encomendas (cliente_id, origem, nome_cliente, telefone, modelo, codigo_sku, especificacoes, valor, sinal_pago, status, observacoes)
         VALUES ((SELECT id FROM clientes WHERE id = $1), 'MANUAL', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${CAMPOS_ENCOMENDA}`,
        [clienteId, e.nome_cliente, e.telefone, e.modelo, e.codigo_sku, e.especificacoes, e.valor, e.sinal_pago, e.status, e.observacoes]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao criar encomenda' });
    }
  }

  async function handleUpdateEncomenda(req, res) {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'Encomenda inválida' });
    const { erro, dados: e } = lerEncomenda(req.body, true);
    if (erro) return res.status(400).json({ error: erro });
    const campos = Object.keys(e);
    if (!campos.length) return res.status(400).json({ error: 'Nada para alterar' });
    if (e.modelo === '') return res.status(400).json({ error: 'Informe o modelo encomendado' });
    try {
      const atual = await req.db.query('SELECT valor, sinal_pago FROM encomendas WHERE id = $1', [Number(req.params.id)]);
      if (!atual.rows.length) return res.status(404).json({ error: 'Encomenda não encontrada' });
      const valor = e.valor !== undefined ? e.valor : Number(atual.rows[0].valor);
      const sinal = e.sinal_pago !== undefined ? e.sinal_pago : Number(atual.rows[0].sinal_pago);
      if (valor > 0 && sinal > valor) return res.status(400).json({ error: 'Sinal maior que o valor' });
      const sets = campos.map((k, i) => `${k} = $${i + 2}`);
      const params = [Number(req.params.id), ...campos.map(k => e[k])];
      if (e.status) {
        params.push(e.status === 'ENTREGUE');
        sets.push(`entregue_em = CASE WHEN $${params.length}::boolean THEN COALESCE(entregue_em, CURRENT_TIMESTAMP) ELSE NULL END`);
      }
      const { rows } = await req.db.query(
        `UPDATE encomendas SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING ${CAMPOS_ENCOMENDA}`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: 'Encomenda não encontrada' });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao salvar encomenda' });
    }
  }

  // Admin: botão "Encomendar" num item do pedido (esgotado, sob medida...). O item
  // passa a ser encomenda no pedido (sai da maleta e do fechamento, com sinal de 50%)
  // e entra no painel de Encomendas.
  async function handleEncomendarItem(req, res) {
    const pedidoId = lerIdPedido(req, res);
    if (pedidoId === null) return;
    const produtoId = Number(req.body && req.body.produto_id);
    if (!Number.isInteger(produtoId) || produtoId <= 0 || produtoId >= 2 ** 31) return res.status(400).json({ error: 'Produto inválido' });
    const especificacoes = typeof (req.body && req.body.especificacoes) === 'string' ? req.body.especificacoes.trim().slice(0, 2000) : '';

    let client;
    const falhar = async (status, payload) => {
      await client.query('ROLLBACK');
      res.status(status).json(payload);
    };
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [pedidoId]);
      if (!rows.length) return falhar(404, { error: 'Pedido não encontrado' });
      const pedido = rows[0];
      if (pedido.status !== 'NOVO' && pedido.status !== 'EM_ANDAMENTO') return falhar(409, { error: 'Só pedidos abertos podem ganhar encomendas' });
      const itens = Array.isArray(pedido.itens) ? pedido.itens : [];
      const item = itens.find(i => Number(i.produto_id) === produtoId);
      if (!item) return falhar(400, { error: 'Este produto não está no pedido' });
      if (intencaoDoItem(item) !== 'ENCOMENDA') {
        const naMaleta = await client.query(
          `SELECT 1 FROM maleta_pecas WHERE produto_id = $1 AND pedido_id = $2`, [produtoId, pedidoId]);
        if (naMaleta.rows.length) return falhar(409, { error: 'Esta peça está na maleta com a cliente: faça o acerto antes de encomendar' });
        if ((await client.query('SELECT 1 FROM acertos a WHERE a.pedido_id = $1 AND $2 = ANY(a.comprados)', [pedidoId, produtoId])).rows.length) {
          return falhar(409, { error: 'Esta peça já foi vendida no acerto' });
        }
        item.intencao = 'ENCOMENDA';
        item.encomenda = true;
        item.sinal = Math.round(Number(item.preco) * 50) / 100;
        const t = totaisDoPedido(itens);
        await client.query(
          `UPDATE pedidos SET itens = $2, total_prova = $3, total_compra = $4, total_encomendas = $5, sinal = $6, total = $7,
                  itens_removidos = array_remove(itens_removidos, $8), updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [pedidoId, JSON.stringify(itens), t.total_prova, t.total_compra, t.total_encomendas, t.sinal, t.total, produtoId]
        );
      }
      await client.query(
        `INSERT INTO encomendas (pedido_id, cliente_id, produto_id, origem, nome_cliente, telefone, modelo, codigo_sku, valor, especificacoes)
         VALUES ($1, $2, (SELECT id FROM produtos WHERE id = $3), 'PEDIDO', $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
        [pedidoId, pedido.cliente_id, produtoId, pedido.nome, pedido.telefone, item.nome || '', item.codigo_sku || '', Number(item.preco) || 0, especificacoes]
      );
      const enc = await client.query(`SELECT ${CAMPOS_ENCOMENDA} FROM encomendas WHERE pedido_id = $1 AND produto_id = $2`, [pedidoId, produtoId]);
      await client.query('COMMIT');
      res.json({ encomenda: enc.rows[0] || null, itens });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao encomendar o item' });
    } finally {
      if (client) client.release();
    }
  }

  // ---------- Acessórios (estoque próprio, em unidades) ----------
  function lerAcessorio(body) {
    const b = body || {};
    const nome = textoCurto(b.nome, 100);
    if (!nome) return { erro: 'Nome do acessório é obrigatório' };
    const preco = typeof b.preco_venda === 'number' ? b.preco_venda : Number(String(b.preco_venda ?? '').trim().replace(',', '.'));
    if (b.preco_venda === '' || !Number.isFinite(preco) || preco < 0 || preco > 1e6) return { erro: 'Preço inválido' };
    const estoque = Number(b.estoque ?? 0);
    if (!Number.isInteger(estoque) || estoque < 0 || estoque > 100000) return { erro: 'Estoque inválido (unidades inteiras, 0 ou mais)' };
    const ativo = b.ativo === undefined ? true : b.ativo === true || b.ativo === 'true';
    return { nome, preco, estoque, ativo };
  }

  async function handleListAcessorios(req, res) {
    try {
      const { rows } = await req.db.query(
        'SELECT id, nome, preco_venda, estoque, ativo, updated_at FROM acessorios ORDER BY ativo DESC, nome, id');
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar acessórios' });
    }
  }

  async function handleCreateAcessorio(req, res) {
    const a = lerAcessorio(req.body);
    if (a.erro) return res.status(400).json({ error: a.erro });
    try {
      const { rows } = await req.db.query(
        `INSERT INTO acessorios (nome, preco_venda, estoque, ativo) VALUES ($1, $2, $3, $4)
         RETURNING id, nome, preco_venda, estoque, ativo, updated_at`,
        [a.nome, Math.round(a.preco * 100) / 100, a.estoque, a.ativo]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao cadastrar acessório' });
    }
  }

  async function handleUpdateAcessorio(req, res) {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'Acessório inválido' });
    const a = lerAcessorio(req.body);
    if (a.erro) return res.status(400).json({ error: a.erro });
    try {
      const { rows } = await req.db.query(
        `UPDATE acessorios SET nome = $2, preco_venda = $3, estoque = $4, ativo = $5, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING id, nome, preco_venda, estoque, ativo, updated_at`,
        [Number(req.params.id), a.nome, Math.round(a.preco * 100) / 100, a.estoque, a.ativo]
      );
      if (!rows.length) return res.status(404).json({ error: 'Acessório não encontrado' });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao salvar acessório' });
    }
  }

  async function handleAcerto(req, res) {
    let { comprados, devolvidos, itens, observacoes, pedido_id } = req.body;

    // Compatibilidade com admin/acerto.html (inglês): { itens: [{sku|id, bought, returned}] }
    if ((!Array.isArray(comprados) && !Array.isArray(devolvidos)) && Array.isArray(itens)) {
      comprados = [];
      devolvidos = [];
      for (const item of itens) {
        const sku = item.sku || item.codigo_sku;
        const id = item.id || item.productId || item.produtoId;
        // Resolve SKU -> ID quando necessário
        let resolvedId = id;
        if (!resolvedId && sku) {
          try {
            const found = await req.db.query(`SELECT id FROM produtos WHERE codigo_sku = $1`, [sku]);
            if (found.rows[0]) resolvedId = found.rows[0].id;
          } catch (e) {
            console.error('Erro ao resolver SKU:', e);
          }
        }
        if (!resolvedId) continue;
        if (item.bought === true || item.comprado === true) comprados.push(resolvedId);
        if (item.returned === true || item.devolvido === true) devolvidos.push(resolvedId);
      }
    }

    if (!Array.isArray(comprados) && !Array.isArray(devolvidos)) {
      return res.status(400).json({ error: 'Arrays "comprados" e/ou "devolvidos" são obrigatórios' });
    }

    const toIds = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number))];
    comprados = toIds(comprados);
    devolvidos = toIds(devolvidos);

    if ([...comprados, ...devolvidos].some((id) => !Number.isInteger(id) || id <= 0)) {
      return res.status(400).json({ error: 'IDs de produto inválidos' });
    }
    if (comprados.some((id) => devolvidos.includes(id))) {
      return res.status(400).json({ error: 'Um produto não pode ser marcado como comprado e devolvido ao mesmo tempo' });
    }
    if (comprados.length === 0 && devolvidos.length === 0) {
      return res.status(400).json({ error: 'Selecione pelo menos um produto' });
    }

    const obs = typeof observacoes === 'string' ? observacoes.trim().slice(0, 2000) : '';
    // Pedido da maleta (opcional): só para o histórico do acerto
    const pedidoId = pedido_id === undefined || pedido_id === null || pedido_id === '' ? null : Number(pedido_id);
    if (pedidoId !== null && !(Number.isInteger(pedidoId) && pedidoId > 0 && pedidoId < 2 ** 31)) {
      return res.status(400).json({ error: 'Pedido inválido' });
    }

    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');

      // Só peças que estão numa maleta participam do acerto: evita que um produto
      // já vendido volte ao estoque por engano. Vendida sai da maleta; devolvida
      // volta para o estoque.
      const vendidos = [];
      for (const pid of comprados) {
        if (await tirarDaMaleta(client, pid, pedidoId)) vendidos.push(pid);
      }
      const retornados = [];
      for (const pid of devolvidos) {
        if (await tirarDaMaleta(client, pid, pedidoId)) retornados.push(pid);
      }
      if (retornados.length) await client.query('UPDATE produtos SET estoque = estoque + 1 WHERE id = ANY($1)', [retornados]);
      const atualizados = await recalcularStatus(client, [...vendidos, ...retornados]);
      const totalCentavos = atualizados.filter((row) => vendidos.includes(row.id))
        .reduce((t, row) => t + Math.round(Number(row.preco_venda) * 100), 0);

      const ignorados = [...comprados, ...devolvidos].filter(
        (id) => !vendidos.includes(id) && !retornados.includes(id)
      );

      if (vendidos.length === 0 && retornados.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Nenhum dos produtos selecionados está em condicional',
          ignorados,
        });
      }

      await client.query(
        `INSERT INTO acertos (comprados, devolvidos, observacoes, pedido_id)
         VALUES ($1, $2, $3, (SELECT id FROM pedidos WHERE id = $4))`,
        [vendidos, retornados, obs || null, pedidoId]
      );

      await client.query('COMMIT');
      // total_vendido: soma do preço de venda do que realmente foi vendido (para o resumo do acerto)
      res.json({ sucesso: true, success: true, comprados: vendidos, devolvidos: retornados, ignorados, total_vendido: totalCentavos / 100 });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao processar acerto' });
    } finally {
      if (client) client.release();
    }
  }

  async function handleListAcertos(req, res) {
    try {
      const result = await req.db.query(
        `SELECT id, comprados, devolvidos, observacoes, pedido_id, created_at
         FROM acertos
         ORDER BY created_at DESC
         LIMIT 100`
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar histórico de acertos' });
    }
  }

  async function handleGetWhatsapp(req, res) {
    try {
      const result = await req.db.query(
        `SELECT valor FROM configuracoes WHERE chave = 'whatsapp_number'`
      );
      const raw = result.rows[0]?.valor || '';
      const clean = sanitizeWhatsapp(raw);
      // Retorna ambas as chaves para compatibilidade PT/EN dos front-ends
      res.json({ whatsapp: clean, valor: clean, number: clean });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar configuração' });
    }
  }

  async function handlePostWhatsapp(req, res) {
    const raw = req.body.whatsapp ?? req.body.valor ?? req.body.number ?? '';
    const whatsapp = sanitizeWhatsapp(String(raw));

    if (!whatsapp) {
      return res.status(400).json({ error: 'Número de WhatsApp é obrigatório' });
    }

    try {
      await req.db.query(
        `INSERT INTO configuracoes (chave, valor) VALUES ('whatsapp_number', $1)
         ON CONFLICT (chave) DO UPDATE SET valor = $1`,
        [whatsapp]
      );
      // O botão de WhatsApp do topo da vitrine sai do cache dos dados da loja
      if (req.empresa) cacheLoja.delete(req.empresa.slug);
      res.json({ sucesso: true, success: true, whatsapp, valor: whatsapp });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao salvar configuração' });
    }
  }

  // ---------- Dados da loja (nome, textos da vitrine, logo, recursos) ----------
  async function handleGetLoja(req, res) {
    try {
      res.json(await lojaDaEmpresa(req.empresa));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar dados da loja' });
    }
  }

  async function salvarConfiguracoes(db, pares) {
    for (const [chave, valor] of pares) {
      await db.query(
        `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)
         ON CONFLICT (chave) DO UPDATE SET valor = $2`,
        [chave, valor]
      );
    }
  }

  // Só os campos enviados mudam. Texto vazio volta ao padrão da empresa.
  async function handleUpdateLoja(req, res) {
    const corpo = req.body || {};
    const pares = [];
    for (const campo of Object.keys(CAMPOS_TEXTO)) {
      if (corpo[campo] === undefined) continue;
      const v = limparTextoLoja(campo, corpo[campo]);
      if (v === null) return res.status(400).json({ error: `Campo "${campo}" inválido` });
      pares.push(['loja_' + campo, v]);
    }
    // Tipo de loja: `nicho` (oculos, roupas, geral) ou o `oculos` de antes (true/false)
    let nicho = null;
    if (corpo.oculos !== undefined) {
      if (typeof corpo.oculos !== 'boolean') return res.status(400).json({ error: 'Campo "oculos" inválido' });
      nicho = corpo.oculos ? 'oculos' : 'geral';
    }
    if (corpo.nicho !== undefined) {
      nicho = lerNicho(corpo.nicho);
      if (!nicho) return res.status(400).json({ error: 'Tipo de loja inválido' });
    }
    if (nicho) pares.push(['loja_nicho', nicho], ['loja_oculos', nicho === 'oculos' ? '1' : '0']);
    // Provador Virtual ligado/desligado (só esconde da vitrine; as fotos ficam)
    if (corpo.provador !== undefined) {
      if (typeof corpo.provador !== 'boolean') return res.status(400).json({ error: 'Campo "provador" inválido' });
      pares.push(['loja_provador', corpo.provador ? '1' : '0']);
    }
    // Instagram da loja (botão no topo da vitrine). Vazio tira o botão.
    if (corpo.instagram !== undefined) {
      const ig = lerInstagram(corpo.instagram);
      if (ig === null) return res.status(400).json({ error: 'Instagram inválido: use o @ da loja (ex.: @nixglasses) ou o link do perfil' });
      pares.push(['loja_instagram', ig]);
    }
    // Produtos por linha na vitrine (celular 1 a 4, computador 2 a 6)
    for (const aparelho of Object.keys(COLUNAS)) {
      const campo = 'colunas_' + aparelho;
      if (corpo[campo] === undefined) continue;
      const n = lerColunas(aparelho, corpo[campo]);
      if (n === null) {
        const { min, max } = COLUNAS[aparelho];
        return res.status(400).json({ error: `Produtos por linha no ${aparelho}: escolha de ${min} a ${max}` });
      }
      pares.push(['loja_' + campo, String(n)]);
    }
    try {
      await salvarConfiguracoes(req.db, pares);
      cacheLoja.delete(req.empresa.slug);
      res.json(await lojaDaEmpresa(req.empresa));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao salvar dados da loja' });
    }
  }

  // ---------- Rastreamento (GTM, Meta Pixel e Conversions API) ----------
  // Configurações > Rastreamento. O token da CAPI fica cifrado (AES-GCM com chave tirada
  // do JWT_SECRET) e nunca volta para o painel nem para a vitrine: só "configurado".
  const SEGREDO_CAPI = () => `${process.env.JWT_SECRET}:meta-capi`;

  async function respostaRastreamento(empresa) {
    const loja = await lojaDaEmpresa(empresa);
    const { rows } = await empresa.pool.query(`SELECT valor FROM configuracoes WHERE chave = 'meta_capi_teste'`);
    return {
      gtm_id: loja.gtm_id || '',
      meta_pixel_id: loja.meta_pixel || '',
      capi_token_configurado: loja.capi_ativo || (await tokenCapiSalvo(empresa)) !== '',
      capi_ativo: !!loja.capi_ativo,
      meta_test_code: rows[0] ? rows[0].valor : '',
      graph_version: rastreamento.GRAPH_VERSION,
    };
  }

  // Token decifrado ('' sem token; token que não abre, ex. JWT_SECRET trocado, conta como sem).
  async function tokenCapiSalvo(empresa) {
    const { rows } = await empresa.pool.query(`SELECT valor FROM configuracoes WHERE chave = 'meta_capi_token'`);
    if (!rows[0] || !rows[0].valor || !process.env.JWT_SECRET) return '';
    try {
      return master.decifrar(rows[0].valor, SEGREDO_CAPI());
    } catch {
      console.warn(`[capi] token da loja "${empresa.slug}" não abre (JWT_SECRET mudou?): salve o token de novo`);
      return '';
    }
  }

  // Pixel + token + código de teste da loja, ou null (CAPI desligada).
  async function configMeta(empresa) {
    const loja = await lojaDaEmpresa(empresa);
    if (!loja.capi_ativo) return null;
    const token = await tokenCapiSalvo(empresa);
    if (!token) return null;
    const { rows } = await empresa.pool.query(`SELECT valor FROM configuracoes WHERE chave = 'meta_capi_teste'`);
    return { pixel_id: loja.meta_pixel, token, test_code: rows[0] ? rows[0].valor : '' };
  }

  async function handleGetRastreamento(req, res) {
    try {
      res.json(await respostaRastreamento(req.empresa));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar o rastreamento' });
    }
  }

  // Só os campos enviados mudam. capi_token vazio não mexe; remover_capi_token apaga.
  async function handleUpdateRastreamento(req, res) {
    const b = req.body || {};
    const pares = [];
    const apagar = [];
    if (b.gtm_id !== undefined) {
      const v = rastreamento.lerIdGtm(b.gtm_id);
      if (v === null) return res.status(400).json({ error: 'ID do Google Tag Manager inválido: use o formato GTM-XXXXXXX' });
      pares.push(['loja_gtm_id', v]);
    }
    if (b.meta_pixel_id !== undefined) {
      const v = rastreamento.lerPixelId(b.meta_pixel_id);
      if (v === null) return res.status(400).json({ error: 'Pixel ID inválido: só os números do Gerenciador de Eventos' });
      pares.push(['loja_meta_pixel', v]);
    }
    if (b.meta_test_code !== undefined) {
      const v = rastreamento.lerCodigoTeste(b.meta_test_code);
      if (v === null) return res.status(400).json({ error: 'Código de teste inválido (ex.: TEST12345)' });
      pares.push(['meta_capi_teste', v]);
    }
    if (b.remover_capi_token === true) apagar.push('meta_capi_token');
    else if (b.capi_token !== undefined && b.capi_token !== '') {
      const v = rastreamento.lerTokenCapi(b.capi_token);
      if (!v) return res.status(400).json({ error: 'Token da API de Conversões inválido: cole o token inteiro gerado no Gerenciador de Eventos' });
      if (!process.env.JWT_SECRET) return res.status(503).json({ error: 'Defina JWT_SECRET no servidor antes de salvar o token' });
      pares.push(['meta_capi_token', master.cifrar(v, SEGREDO_CAPI())]);
    }
    try {
      await salvarConfiguracoes(req.db, pares);
      if (apagar.length) await req.db.query('DELETE FROM configuracoes WHERE chave = ANY($1)', [apagar]);
      cacheLoja.delete(req.empresa.slug);
      res.json(await respostaRastreamento(req.empresa));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao salvar o rastreamento' });
    }
  }

  // Freio simples para o endpoint público de eventos: 120 por minuto por IP.
  const eventosPorIp = new Map();
  function muitosEventos(ip) {
    const agora = Date.now();
    const r = eventosPorIp.get(ip);
    if (!r || agora - r.inicio > 60000) {
      if (eventosPorIp.size > 5000) eventosPorIp.clear();
      eventosPorIp.set(ip, { inicio: agora, n: 1 });
      return false;
    }
    r.n += 1;
    return r.n > 120;
  }

  // Vitrine -> servidor -> Meta: view_item, add_to_cart e begin_checkout com o mesmo
  // event_id do dataLayer. Preço e SKU saem do banco (o navegador só manda os ids).
  // Responde na hora (202); a ida para a Meta não segura a vitrine.
  async function handleEventoRastreamento(req, res) {
    const b = req.body || {};
    const nome = rastreamento.EVENTOS_VITRINE[b.evento];
    const eventId = rastreamento.lerEventId(b.event_id);
    if (!nome || !eventId) return res.status(400).json({ error: 'Evento inválido' });
    const ids = (Array.isArray(b.produto_ids) ? b.produto_ids : [])
      .map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 2 ** 31).slice(0, MAX_ITENS_PEDIDO);
    const ip = rastreamento.ipDoCliente(req);
    if (muitosEventos(ip || 'sem-ip')) return res.status(429).json({ error: 'Muitos eventos' });
    let config;
    try {
      config = await configMeta(req.empresa);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Erro ao registrar evento' });
    }
    if (!config) return res.status(204).end();
    res.status(202).json({ ok: true });
    try {
      const { rows } = ids.length ? await req.db.query(
        `SELECT p.id, p.codigo_sku, p.preco_venda, ${anuncios.sqlPrecoPromocional('p')} AS preco_promocional, p.disponibilidade
         FROM produtos p WHERE p.id = ANY($1)`, [ids]) : { rows: [] };
      const itens = montarPedido(rows, {}).itens;
      const r = rastreamento.lerRastreamento(b);
      const evento = rastreamento.montarEvento({
        nome,
        eventId,
        url: b.url,
        userData: rastreamento.montarUserData({
          externalId: rastreamento.lerTokenVisitante(b.visitante),
          ip, userAgent: req.headers['user-agent'], fbp: r.fbp, fbc: r.fbc,
        }),
        customData: rastreamento.montarCustomData(itens),
      });
      await rastreamento.enviarEventosMeta(config, [evento]);
    } catch (err) {
      console.warn('[capi] evento da vitrine não enviado:', err.message);
    }
  }

  // Pedido gravado -> Lead e Purchase na CAPI, com o event_id que a vitrine usou no
  // generate_lead/purchase do dataLayer. Roda depois da resposta; nunca lança.
  async function enviarPedidoParaMeta(req, pedido, p, contato, r, visitante) {
    try {
      const config = await configMeta(req.empresa);
      if (!config) return;
      const c = contato && typeof contato === 'object' ? contato : {};
      const userData = rastreamento.montarUserData({
        email: pedido.email, telefone: p.telefone, nome: p.nome,
        cidade: typeof c.cidade === 'string' ? c.cidade : '', cep: typeof c.cep === 'string' ? c.cep : '',
        externalId: visitante, ip: rastreamento.ipDoCliente(req), userAgent: req.headers['user-agent'],
        fbp: r.fbp, fbc: r.fbc,
      });
      const customData = { ...rastreamento.montarCustomData(p.itens, p.total), order_id: String(pedido.id) };
      const base = { eventId: r.event_id, url: r.url || r.landing_page, userData, customData };
      const out = await rastreamento.enviarEventosMeta(config, [
        rastreamento.montarEvento({ ...base, nome: 'Lead' }),
        rastreamento.montarEvento({ ...base, nome: 'Purchase' }),
      ]);
      if (out.enviado) {
        await req.db.query(
          `UPDATE pedidos SET rastreamento = rastreamento || jsonb_build_object('capi_enviado_em', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) WHERE id = $1`,
          [pedido.id]);
      }
    } catch (err) {
      console.warn('[capi] pedido não enviado para a Meta:', err.message);
    }
  }

  // Logo enviada no painel: vai para a tabela `imagens` (campo foto1 do upload).
  async function handleUpdateLogo(req, res) {
    const file = req.fotosEnviadas[0];
    if (!file) return res.status(400).json({ error: 'Envie a imagem da logo' });
    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const anterior = idDaImagem((await lojaDaEmpresa(req.empresa)).logo);
      const url = await salvarImagem(client, file);
      await salvarConfiguracoes(client, [['loja_logo', url]]);
      if (anterior) await client.query('DELETE FROM imagens WHERE id = $1', [anterior]);
      await client.query('COMMIT');
      cacheLoja.delete(req.empresa.slug);
      res.json(await lojaDaEmpresa(req.empresa));
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao salvar a logo' });
    } finally {
      if (client) client.release();
    }
  }

  async function handleDeleteLogo(req, res) {
    try {
      const anterior = idDaImagem((await lojaDaEmpresa(req.empresa)).logo);
      await req.db.query(`DELETE FROM configuracoes WHERE chave = 'loja_logo'`);
      if (anterior) await req.db.query('DELETE FROM imagens WHERE id = $1', [anterior]);
      cacheLoja.delete(req.empresa.slug);
      res.json(await lojaDaEmpresa(req.empresa));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao remover a logo' });
    }
  }

  // ---------- Zerar dados de teste ----------
  // Apaga dados só do banco da empresa logada (req.db). Configurações da loja,
  // logo, WhatsApp e login do admin ficam. Não tem volta: o painel pede para
  // digitar ZERAR e o servidor confere de novo.
  // escopo 'tudo': produtos, fotos, compras, clientes, pedidos/maletas, acertos e
  //   encomendas, com a numeração (ids) voltando a 1.
  // escopo 'produtos': só produtos, fotos e compras; o histórico de pedidos fica.
  // escopo 'movimento' (Métricas > Limpar testes de venda): pedidos, maletas,
  //   acertos, encomendas e (se marcado) clientes; o Top 10 volta a zero e as
  //   Métricas passam a contar a partir de agora. Produtos, fotos, compras do
  //   fornecedor, acessórios e usuários ficam. Peça que estava numa maleta de
  //   teste volta para o estoque da loja.
  const CONFIRMACAO_ZERAR = 'ZERAR';

  async function contarDadosDeTeste(db) {
    const r = await db.query(`
      SELECT (SELECT COUNT(*) FROM produtos)::int AS produtos,
             (SELECT COUNT(*) FROM clientes)::int AS clientes,
             (SELECT COUNT(*) FROM pedidos)::int AS pedidos,
             (SELECT COUNT(*) FROM acertos)::int AS acertos,
             (SELECT COUNT(*) FROM encomendas)::int AS encomendas,
             (SELECT COUNT(*) FROM acessorios)::int AS acessorios
    `);
    return r.rows[0];
  }

  async function lerMetricasDesde(db) {
    const { rows } = await db.query(`SELECT valor FROM configuracoes WHERE chave = 'metricas_desde'`);
    return rows.length ? rows[0].valor : null;
  }

  // O que a limpeza dos testes de venda mexe, para mostrar antes de confirmar
  async function previaMovimento(db) {
    const { rows: [r] } = await db.query(`
      SELECT (SELECT COUNT(*) FROM maleta_pecas)::int AS pecas_em_maleta,
             (SELECT COUNT(DISTINCT produto_id) FROM maleta_pecas)::int AS produtos_em_maleta,
             (SELECT COUNT(*) FROM produtos WHERE vezes_em_maleta > 0)::int AS produtos_no_top,
             (SELECT COALESCE(SUM(vezes_em_maleta), 0) FROM produtos)::int AS vezes_em_maleta,
             (SELECT COALESCE(SUM(cardinality(comprados)), 0) FROM acertos)::int AS pecas_vendidas_em_acertos,
             (SELECT COUNT(*) FROM pedidos WHERE status = 'ENTREGUE')::int AS pedidos_entregues
    `);
    return { ...r, metricas_desde: await lerMetricasDesde(db) };
  }

  async function handleContagemZerar(req, res) {
    try {
      res.json({ ...(await contarDadosDeTeste(req.db)), movimento: await previaMovimento(req.db) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao contar os dados' });
    }
  }

  async function limparMovimento(client, { clientes }) {
    // Peças com clientes de teste voltam para a loja antes de a maleta sumir
    const fora = await client.query(
      `UPDATE produtos p SET estoque = p.estoque + m.n
       FROM (SELECT produto_id, COUNT(*)::int AS n FROM maleta_pecas GROUP BY produto_id) m
       WHERE p.id = m.produto_id RETURNING p.id`
    );
    await client.query('DELETE FROM maleta_pecas');
    await client.query('UPDATE produtos SET vezes_em_maleta = 0, pedido_condicional_id = NULL WHERE vezes_em_maleta <> 0 OR pedido_condicional_id IS NOT NULL');
    await recalcularStatus(client, fora.rows.map((r) => r.id));
    const tabelas = ['acertos', 'encomendas', 'pedidos', 'maleta_pecas'];
    if (clientes) tabelas.push('clientes');
    for (const t of tabelas.slice(0, 3)) await client.query(`DELETE FROM ${t}`);
    if (clientes) await client.query('DELETE FROM clientes');
    // A numeração dos pedidos (e o resto do movimento) volta a 1
    for (const t of tabelas) await client.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), 1, false)`, [t]);
    await salvarConfiguracoes(client, [['metricas_desde', new Date().toISOString()]]);
  }

  async function handleZerarDados(req, res) {
    const { confirmacao, escopo, acessorios } = req.body || {};
    if (confirmacao !== CONFIRMACAO_ZERAR) {
      return res.status(400).json({ error: `Digite ${CONFIRMACAO_ZERAR} para confirmar` });
    }
    if (escopo !== 'tudo' && escopo !== 'produtos' && escopo !== 'movimento') {
      return res.status(400).json({ error: 'Escolha o que zerar' });
    }
    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const antes = await contarDadosDeTeste(client);
      const logo = idDaImagem((await lojaDaEmpresa(req.empresa)).logo);
      if (escopo === 'movimento') {
        await limparMovimento(client, { clientes: req.body.clientes === true });
      } else if (escopo === 'tudo') {
        const tabelas = ['produtos', 'compras_fornecedor', 'maleta_pecas', 'acertos', 'pedidos', 'clientes', 'encomendas'];
        if (acessorios === true) tabelas.push('acessorios', 'compras_acessorio');
        tabelas.push('pedidos_fornecedor', 'movimentos_estoque');
        await client.query(`TRUNCATE ${tabelas.join(', ')} RESTART IDENTITY`);
        // Sem produtos, as únicas imagens que ainda servem são a logo e as dos anúncios
        await client.query(
          `DELETE FROM imagens i WHERE i.id IS DISTINCT FROM $1
             AND NOT EXISTS (SELECT 1 FROM anuncios a WHERE '/imagens/' || i.id IN (a.selo_url, a.imagem_url))`,
          [logo]
        );
      } else {
        const fotos = await client.query(
          `SELECT DISTINCT unnest(fotos || ARRAY[imagem_url]) AS url FROM produtos`
        );
        const ids = fotos.rows.map((r) => idDaImagem(r.url)).filter((id) => id && id !== logo);
        await client.query('DELETE FROM produtos');
        if (ids.length) await client.query('DELETE FROM imagens WHERE id = ANY($1)', [ids]);
        if (acessorios === true) await client.query('DELETE FROM acessorios');
      }
      await client.query('COMMIT');
      console.log(`[${req.empresa.slug}] dados zerados (escopo ${escopo}) por ${req.admin && req.admin.u}`);
      res.json({
        apagados: antes,
        agora: { ...(await contarDadosDeTeste(req.db)), movimento: await previaMovimento(req.db) },
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao zerar os dados. Nada foi apagado.' });
    } finally {
      if (client) client.release();
    }
  }

  // Acerto de estoque: excluir produtos de verdade (um ou vários), sem zerar a loja.
  // Só da empresa logada (req.db). Antes de apagar, o servidor confere de novo cada
  // produto: com peça em maleta ou num pedido aberto ele não sai, e aí nada é
  // apagado. Encomendas abertas só avisam (o modelo e o SKU ficam copiados nelas).
  // Leva junto as fotos e o histórico de compras do produto; pedidos e acertos antigos
  // ficam como estão (os itens deles guardam nome e preço).
  const CONFIRMACAO_EXCLUIR = 'EXCLUIR';
  const MAX_EXCLUIR = 500;
  const MAX_ARQUIVAR = 3000;

  function idsParaExcluir(body, um = 'produto', varios = 'produtos', max = MAX_EXCLUIR) {
    const lista = body && body.ids;
    if (!Array.isArray(lista) || !lista.length) return { erro: `Escolha ao menos um ${um === 'produto' ? 'produto' : 'item'} para excluir` };
    if (lista.length > max) return { erro: `No máximo ${max} ${varios} por vez` };
    const ids = [...new Set(lista.map(Number))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0 || id >= 2 ** 31)) return { erro: `Lista de ${varios} inválida` };
    return { ids };
  }

  async function conferirExclusao(db, ids, bloquear = false, acao = 'excluir') {
    const produtos = (await db.query(
      `SELECT id, nome, codigo_sku, tamanho, estoque, status, disponibilidade, arquivado FROM produtos WHERE id = ANY($1) ORDER BY nome, id
       ${bloquear ? 'FOR UPDATE' : ''}`, [ids]
    )).rows;
    const emMaleta = (await db.query(
      `SELECT produto_id, COUNT(*)::int AS pecas, array_agg(DISTINCT pedido_id) FILTER (WHERE pedido_id IS NOT NULL) AS pedidos
       FROM maleta_pecas WHERE produto_id = ANY($1) GROUP BY produto_id`, [ids]
    )).rows;
    const emPedido = (await db.query(
      `SELECT (i->>'produto_id')::int AS produto_id, array_agg(DISTINCT pe.id ORDER BY pe.id) AS pedidos
       FROM pedidos pe CROSS JOIN LATERAL jsonb_array_elements(pe.itens) i
       WHERE pe.status IN ('NOVO', 'EM_ANDAMENTO') AND i->>'produto_id' = ANY($1::text[])
       GROUP BY 1`, [ids.map(String)]
    )).rows;
    const emEncomenda = (await db.query(
      `SELECT produto_id, array_agg(id ORDER BY id) AS encomendas FROM encomendas
       WHERE produto_id = ANY($1) AND status NOT IN ('ENTREGUE', 'CANCELADA') GROUP BY produto_id`, [ids]
    )).rows;
    const porId = (rows) => new Map(rows.map((r) => [Number(r.produto_id), r]));
    const maletas = porId(emMaleta);
    const pedidos = porId(emPedido);
    const encomendas = porId(emEncomenda);
    const encontrados = new Set(produtos.map((p) => Number(p.id)));
    return {
      produtos: produtos.map((p) => {
        const bloqueios = [];
        const m = maletas.get(p.id);
        if (m) {
          const num = (m.pedidos || []).map((x) => `#${x}`).join(', ');
          bloqueios.push(`${m.pecas} peça(s) em maleta com cliente${num ? ` (pedido ${num})` : ''}. Faça o acerto da maleta antes.`);
        }
        const pe = pedidos.get(p.id);
        if (pe) bloqueios.push(`Está no pedido aberto ${pe.pedidos.map((x) => `#${x}`).join(', ')}. Entregue ou cancele o pedido antes.`);
        const en = encomendas.get(p.id);
        const avisos = [];
        if (en) {
          const num = en.encomendas.map((x) => `#${x}`).join(', ');
          avisos.push(acao === 'arquivar'
            ? `Tem encomenda aberta (${num}). Ela continua normalmente.`
            : `Tem encomenda aberta (${num}). Ela continua, com o modelo e o SKU copiados.`);
        }
        const loja = p.disponibilidade === 'SOB_ENCOMENDA' ? 0 : Number(p.estoque) || 0;
        if (acao === 'arquivar' && loja > 0) avisos.push(`Ainda tem ${loja} peça(s) em estoque: elas saem da vitrine e das Métricas junto com o produto.`);
        return { id: p.id, nome: p.nome, codigo_sku: p.codigo_sku, tamanho: p.tamanho, estoque: p.estoque, status: p.status, arquivado: p.arquivado, bloqueios, avisos };
      }),
      nao_encontrados: ids.filter((id) => !encontrados.has(id)),
    };
  }

  async function handleConferirExclusao(req, res) {
    const { ids, erro } = idsParaExcluir(req.body);
    if (erro) return res.status(400).json({ error: erro });
    try {
      res.json(await conferirExclusao(req.db, ids));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao conferir os produtos' });
    }
  }

  async function handleExcluirProdutos(req, res) {
    const { ids, erro } = idsParaExcluir(req.body);
    if (erro) return res.status(400).json({ error: erro });
    if ((req.body || {}).confirmacao !== CONFIRMACAO_EXCLUIR) {
      return res.status(400).json({ error: `Digite ${CONFIRMACAO_EXCLUIR} para confirmar` });
    }
    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const conferencia = await conferirExclusao(client, ids, true);
      const bloqueados = conferencia.produtos.filter((p) => p.bloqueios.length);
      if (bloqueados.length || conferencia.nao_encontrados.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: bloqueados.length
            ? `${bloqueados.length} produto(s) não podem ser excluídos agora. Nada foi apagado.`
            : 'Algum produto já não existe (a lista mudou). Nada foi apagado.',
          ...conferencia,
        });
      }
      const logo = idDaImagem((await lojaDaEmpresa(req.empresa)).logo);
      const apagados = (await client.query(
        `DELETE FROM produtos WHERE id = ANY($1)
         RETURNING id, nome, codigo_sku, (fotos || ARRAY[imagem_url]) AS urls`, [ids]
      )).rows;
      // Fotos que nenhum outro produto usa (a logo nunca sai)
      const fotos = [...new Set(apagados.flatMap((p) => (p.urls || []).map(idDaImagem)).filter((id) => id && id !== logo))];
      if (fotos.length) {
        await client.query(
          `DELETE FROM imagens i WHERE i.id = ANY($1)
             AND NOT EXISTS (SELECT 1 FROM produtos p WHERE ('/imagens/' || i.id) = ANY(p.fotos || ARRAY[p.imagem_url]))`,
          [fotos]
        );
      }
      await client.query('COMMIT');
      console.log(`[${req.empresa.slug}] acerto de estoque: ${apagados.length} produto(s) excluído(s) por ${req.admin && req.admin.user}: ${apagados.map((p) => p.codigo_sku).join(', ')}`);
      res.json({ excluidos: apagados.map(({ id, nome, codigo_sku }) => ({ id, nome, codigo_sku })) });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao excluir. Nada foi apagado.' });
    } finally {
      if (client) client.release();
    }
  }

  // Arquivar produtos (Produtos > Arquivar): o produto sai da lista, da vitrine, das
  // Métricas, do Editar em estoque e da Conferência de estoque, mas fica no banco com
  // fotos, compras e vendas, e pode ser desarquivado. Peça em maleta ou pedido aberto
  // barra o arquivamento (tudo ou nada), como no Acerto de estoque.
  async function handleConferirArquivamento(req, res) {
    const { ids, erro } = idsParaExcluir(req.body, 'produto', 'produtos', MAX_ARQUIVAR);
    if (erro) return res.status(400).json({ error: erro.replace('para excluir', 'para arquivar') });
    try {
      res.json(await conferirExclusao(req.db, ids, false, 'arquivar'));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao conferir os produtos' });
    }
  }

  // Body { ids: [..], arquivado: true|false } -> { arquivados: [{id, nome, codigo_sku}] }
  async function handleArquivarProdutos(req, res) {
    const { ids, erro } = idsParaExcluir(req.body, 'produto', 'produtos', MAX_ARQUIVAR);
    if (erro) return res.status(400).json({ error: erro.replace('para excluir', 'para arquivar') });
    const arquivar = (req.body || {}).arquivado !== false;
    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      if (arquivar) {
        const conferencia = await conferirExclusao(client, ids, true, 'arquivar');
        const bloqueados = conferencia.produtos.filter((p) => p.bloqueios.length);
        if (bloqueados.length || conferencia.nao_encontrados.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: bloqueados.length
              ? `${bloqueados.length} produto(s) não podem ser arquivados agora. Nada foi arquivado.`
              : 'Algum produto já não existe (a lista mudou). Nada foi arquivado.',
            ...conferencia,
          });
        }
      }
      const { rows } = await client.query(
        `UPDATE produtos SET arquivado = $2, arquivado_em = CASE WHEN $2 THEN COALESCE(arquivado_em, CURRENT_TIMESTAMP) END,
                updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) RETURNING id, nome, codigo_sku`, [ids, arquivar]
      );
      await client.query('COMMIT');
      console.log(`[${req.empresa.slug}] ${arquivar ? 'arquivados' : 'desarquivados'} ${rows.length} produto(s) por ${req.admin && req.admin.user}`);
      res.json({ [arquivar ? 'arquivados' : 'desarquivados']: rows });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao arquivar. Nada foi alterado.' });
    } finally {
      if (client) client.release();
    }
  }

  // Excluir de vez nas abas Encomendas, Acessórios e Clientes, no mesmo jeito do
  // Acerto de estoque: o servidor confere de novo dentro da transação e, se algum
  // item quebraria um pedido ou maleta em aberto, nada é apagado (409).
  // Cada tipo devolve itens { id, titulo, detalhe, bloqueios, avisos }.
  const PEDIDO_ABERTO = `('NOVO', 'EM_ANDAMENTO')`;
  const ENCOMENDA_FECHADA = `('ENTREGUE', 'CANCELADA')`;
  const listaIds = (ids) => (ids || []).map((x) => `#${x}`).join(', ');
  const ROTULO_STATUS_ENCOMENDA = {
    AGUARDANDO_FABRICANTE: 'aguardando fabricante', EM_TRANSITO: 'em trânsito', PRONTO_ENTREGA: 'pronta para entrega',
  };

  const EXCLUSOES = {
    encomendas: {
      area: 'encomendas', um: 'encomenda', varios: 'encomendas',
      async conferir(db, ids, bloquear) {
        const { rows } = await db.query(
          `SELECT e.id, e.modelo, e.codigo_sku, e.nome_cliente, e.status, e.sinal_pago, e.pedido_id, pe.status AS pedido_status
           FROM encomendas e LEFT JOIN pedidos pe ON pe.id = e.pedido_id
           WHERE e.id = ANY($1) ORDER BY e.id ${bloquear ? 'FOR UPDATE OF e' : ''}`, [ids]
        );
        return rows.map((e) => {
          const bloqueios = [];
          const avisos = [];
          if (e.pedido_id && ['NOVO', 'EM_ANDAMENTO'].includes(e.pedido_status)) {
            bloqueios.push(`É do pedido aberto #${e.pedido_id}. Entregue ou cancele o pedido antes (ou só cancele a encomenda).`);
          }
          if (ROTULO_STATUS_ENCOMENDA[e.status]) avisos.push(`Ainda está em aberto (${ROTULO_STATUS_ENCOMENDA[e.status]}).`);
          if (Number(e.sinal_pago) > 0) avisos.push(`Tem ${formatarReais(e.sinal_pago)} de sinal registrado, que some junto.`);
          return {
            id: e.id,
            titulo: `#${e.id} ${e.modelo || 'Sem modelo'}`,
            detalhe: [e.nome_cliente || 'Sem nome', e.codigo_sku].filter(Boolean).join(' • '),
            bloqueios, avisos,
          };
        });
      },
      apagar: (db, ids) => db.query('DELETE FROM encomendas WHERE id = ANY($1) RETURNING id, modelo AS nome', [ids]),
    },
    acessorios: {
      area: 'acessorios', um: 'acessório', varios: 'acessórios',
      async conferir(db, ids, bloquear) {
        const { rows } = await db.query(
          `SELECT id, nome, estoque, ativo FROM acessorios WHERE id = ANY($1) ORDER BY nome, id ${bloquear ? 'FOR UPDATE' : ''}`, [ids]
        );
        const emPedido = new Map((await db.query(
          `SELECT (x->>'acessorio_id')::int AS id, array_agg(DISTINCT pe.id ORDER BY pe.id) AS pedidos
           FROM pedidos pe CROSS JOIN LATERAL jsonb_array_elements(pe.extras) x
           WHERE pe.status IN ${PEDIDO_ABERTO} AND x->>'acessorio_id' = ANY($1::text[]) GROUP BY 1`, [ids.map(String)]
        )).rows.map((r) => [Number(r.id), r.pedidos]));
        return rows.map((a) => {
          const pedidos = emPedido.get(a.id);
          const avisos = [];
          if (Number(a.estoque) > 0) avisos.push(`Ainda tem ${a.estoque} un. em estoque.`);
          if (a.ativo) avisos.push('Se for só para não aparecer no fechamento, dá para marcar como Inativo.');
          return {
            id: a.id,
            titulo: a.nome,
            detalhe: `${Number(a.estoque) || 0} un. • ${a.ativo ? 'Ativo' : 'Inativo'}`,
            bloqueios: pedidos ? [`Está no fechamento do pedido aberto ${listaIds(pedidos)}. Entregue ou cancele o pedido antes.`] : [],
            avisos,
          };
        });
      },
      apagar: (db, ids) => db.query('DELETE FROM acessorios WHERE id = ANY($1) RETURNING id, nome', [ids]),
    },
    clientes: {
      area: 'clientes', um: 'cliente', varios: 'clientes',
      async conferir(db, ids, bloquear) {
        const { rows } = await db.query(
          `SELECT c.id, c.nome, c.email,
                  (SELECT array_agg(p.id ORDER BY p.id) FROM pedidos p WHERE p.cliente_id = c.id AND p.status IN ${PEDIDO_ABERTO}) AS pedidos_abertos,
                  (SELECT array_agg(DISTINCT mp.pedido_id) FROM maleta_pecas mp JOIN pedidos p ON p.id = mp.pedido_id
                    WHERE p.cliente_id = c.id) AS maletas,
                  (SELECT array_agg(e.id ORDER BY e.id) FROM encomendas e WHERE e.cliente_id = c.id AND e.status NOT IN ${ENCOMENDA_FECHADA}) AS encomendas_abertas,
                  (SELECT COUNT(*)::int FROM pedidos p WHERE p.cliente_id = c.id) AS pedidos,
                  (SELECT COUNT(*)::int FROM encomendas e WHERE e.cliente_id = c.id) AS encomendas
           FROM clientes c WHERE c.id = ANY($1) ORDER BY c.nome, c.id ${bloquear ? 'FOR UPDATE' : ''}`, [ids]
        );
        return rows.map((c) => {
          const bloqueios = [];
          if (c.maletas) bloqueios.push(`Está com a maleta do pedido ${listaIds(c.maletas)}. Faça o acerto da maleta antes.`);
          if (c.pedidos_abertos) bloqueios.push(`Tem pedido aberto (${listaIds(c.pedidos_abertos)}). Entregue ou cancele antes.`);
          if (c.encomendas_abertas) bloqueios.push(`Tem encomenda em aberto (${listaIds(c.encomendas_abertas)}). Entregue ou cancele antes.`);
          const avisos = ['A conta de acesso dela some: para comprar logada de novo, ela cria outra.'];
          const historico = [c.pedidos && `${c.pedidos} pedido(s)`, c.encomendas && `${c.encomendas} encomenda(s)`].filter(Boolean);
          if (historico.length) avisos.push(`${historico.join(' e ')} antigos continuam, como "sem conta" (com nome e telefone).`);
          return { id: c.id, titulo: c.nome || 'Sem nome', detalhe: c.email, bloqueios, avisos };
        });
      },
      apagar: (db, ids) => db.query('DELETE FROM clientes WHERE id = ANY($1) RETURNING id, nome', [ids]),
    },
  };

  function formatarReais(v) {
    return `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
  }

  async function conferirExclusaoDe(tipo, db, ids, bloquear = false) {
    const itens = await tipo.conferir(db, ids, bloquear);
    const encontrados = new Set(itens.map((i) => Number(i.id)));
    return { itens, nao_encontrados: ids.filter((id) => !encontrados.has(id)) };
  }

  const lerIdsExclusao = (tipo, body) => idsParaExcluir(body, tipo.um, tipo.varios);

  function handlersDeExclusao(tipo) {
    return {
      async conferir(req, res) {
        const { ids, erro } = lerIdsExclusao(tipo, req.body);
        if (erro) return res.status(400).json({ error: erro });
        try {
          res.json(await conferirExclusaoDe(tipo, req.db, ids));
        } catch (err) {
          console.error(err);
          res.status(500).json({ error: `Erro ao conferir ${tipo.varios}` });
        }
      },
      async excluir(req, res) {
        const { ids, erro } = lerIdsExclusao(tipo, req.body);
        if (erro) return res.status(400).json({ error: erro });
        if ((req.body || {}).confirmacao !== CONFIRMACAO_EXCLUIR) {
          return res.status(400).json({ error: `Digite ${CONFIRMACAO_EXCLUIR} para confirmar` });
        }
        let client;
        try {
          client = await req.db.connect();
          await client.query('BEGIN');
          const conferencia = await conferirExclusaoDe(tipo, client, ids, true);
          const bloqueados = conferencia.itens.filter((i) => i.bloqueios.length);
          if (bloqueados.length || conferencia.nao_encontrados.length) {
            await client.query('ROLLBACK');
            const n = bloqueados.length;
            return res.status(409).json({
              error: n
                ? `${n} ${n === 1 ? `${tipo.um} não pode` : `${tipo.varios} não podem`} sair agora. Nada foi apagado.`
                : 'A lista mudou (algum item já não existe). Nada foi apagado.',
              ...conferencia,
            });
          }
          const { rows } = await tipo.apagar(client, ids);
          await client.query('COMMIT');
          console.log(`[${req.empresa.slug}] excluir ${tipo.varios}: ${rows.length} por ${req.admin && req.admin.user}: ${rows.map((r) => `#${r.id}`).join(', ')}`);
          res.json({ excluidos: rows });
        } catch (err) {
          if (client) await client.query('ROLLBACK').catch(() => {});
          console.error(err);
          res.status(500).json({ error: 'Erro ao excluir. Nada foi apagado.' });
        } finally {
          if (client) client.release();
        }
      },
    };
  }

  // ---------- Zerar um cadastro (Configurações > Zerar um cadastro) ----------
  // Cada botão apaga uma tabela inteira desta loja (req.db): produtos, clientes,
  // pedidos, acertos, encomendas ou acessórios. Só o dono, com a palavra ZERAR.
  // Antes de apagar o servidor confere de novo, dentro da transação, as mesmas
  // proteções do Acerto de estoque e do Excluir de vez: se algum item está numa
  // maleta com cliente ou num pedido aberto, nada é apagado e a resposta diz o
  // que fazer antes. GET mostra a contagem, o que sai, o que fica e os avisos.
  const MAX_BLOQUEADOS_MOSTRADOS = 20;

  async function todosOsIds(db, tabela, bloquear) {
    const { rows } = await db.query(`SELECT id FROM ${tabela} ORDER BY id ${bloquear ? 'FOR UPDATE' : ''}`);
    return rows.map((r) => Number(r.id));
  }

  // Junta os avisos repetidos (um por item) em uma linha só, com a contagem
  function resumirAvisos(itens, regras) {
    const avisos = [];
    for (const [teste, texto] of regras) {
      const n = itens.filter((i) => i.avisos.some((a) => teste.test(a))).length;
      if (n) avisos.push(texto(n));
    }
    return avisos;
  }

  const bloqueadosDe = (itens) => itens.filter((i) => i.bloqueios.length)
    .map((i) => ({ id: i.id, titulo: i.titulo, bloqueios: i.bloqueios }));

  // Totais do pedido do fornecedor que ficaram sem nenhuma compra (produto ou acessório)
  const APAGAR_TOTAIS_SEM_COMPRA = `
    DELETE FROM pedidos_fornecedor t
    WHERE NOT EXISTS (SELECT 1 FROM compras_fornecedor c WHERE lower(c.pedido_fornecedor) = lower(t.numero))
      AND NOT EXISTS (SELECT 1 FROM compras_acessorio c WHERE lower(c.pedido_fornecedor) = lower(t.numero))`;

  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  const CADASTROS_ZERAR = {
    produtos: {
      rotulo: 'produtos',
      async conferir(db, bloquear) {
        const ids = await todosOsIds(db, 'produtos', bloquear);
        const conf = ids.length ? await conferirExclusao(db, ids, bloquear) : { produtos: [] };
        const itens = conf.produtos.map((p) => ({ ...p, titulo: [p.codigo_sku, p.nome].filter(Boolean).join(' ') }));
        const { rows: [x] } = await db.query(`
          SELECT (SELECT COUNT(*) FROM compras_fornecedor)::int AS compras,
                 (SELECT COALESCE(SUM(estoque), 0) FROM produtos)::int AS pecas,
                 (SELECT COUNT(*) FROM encomendas WHERE produto_id IS NOT NULL)::int AS encomendas`);
        const sai = [
          plural(ids.length, 'produto', 'produtos') + ` (${plural(x.pecas, 'peça', 'peças')} no estoque da loja)`,
          'as fotos deles',
          plural(x.compras, 'compra do fornecedor', 'compras do fornecedor') + ' (histórico de reposição e os pedidos do fornecedor que ficarem vazios)',
          'o Top 10 das Métricas',
        ];
        const fica = ['Pedidos, acertos e encomendas antigos (guardam nome, SKU e preço)', 'Clientes, acessórios, logo e configurações da loja'];
        const avisos = [];
        if (x.encomendas) avisos.push(`${plural(x.encomendas, 'encomenda está ligada', 'encomendas estão ligadas')} a produto. Elas continuam, com o modelo e o SKU copiados.`);
        avisos.push('Os números (ids) dos produtos não voltam a 1, para não se misturar com pedidos antigos.');
        return { total: ids.length, itens, sai, fica, avisos };
      },
      async apagar(db, req) {
        const logo = idDaImagem((await lojaDaEmpresa(req.empresa)).logo);
        const fotos = await db.query('SELECT DISTINCT unnest(fotos || ARRAY[imagem_url]) AS url FROM produtos');
        const ids = fotos.rows.map((r) => idDaImagem(r.url)).filter((id) => id && id !== logo);
        // compras_fornecedor e maleta_pecas saem junto (ON DELETE CASCADE)
        const r = await db.query('DELETE FROM produtos');
        if (ids.length) await db.query('DELETE FROM imagens WHERE id = ANY($1)', [ids]);
        await db.query(APAGAR_TOTAIS_SEM_COMPRA);
        return r.rowCount;
      },
    },
    clientes: {
      rotulo: 'clientes',
      async conferir(db, bloquear) {
        const ids = await todosOsIds(db, 'clientes', bloquear);
        const itens = ids.length ? await EXCLUSOES.clientes.conferir(db, ids, bloquear) : [];
        const avisos = resumirAvisos(itens, [
          [/antigos continuam/, (n) => `${plural(n, 'cliente tem', 'clientes têm')} pedidos ou encomendas antigos: eles continuam, como "sem conta" (com nome e telefone).`],
        ]);
        return {
          total: ids.length, itens,
          sai: [plural(ids.length, 'conta de cliente', 'contas de clientes') + ' (e-mail e senha da vitrine)'],
          fica: ['Pedidos, encomendas e acertos (com nome e telefone copiados)', 'Produtos, estoque e acessórios'],
          avisos: [...avisos, 'Quem quiser comprar logada de novo cria outra conta.'],
        };
      },
      apagar: async (db) => (await db.query('DELETE FROM clientes')).rowCount,
    },
    pedidos: {
      rotulo: 'pedidos',
      async conferir(db, bloquear) {
        const { rows } = await db.query(
          `SELECT pe.id, pe.nome, pe.status,
                  (SELECT COUNT(*)::int FROM maleta_pecas mp WHERE mp.pedido_id = pe.id) AS pecas_em_maleta
           FROM pedidos pe ORDER BY pe.id ${bloquear ? 'FOR UPDATE' : ''}`
        );
        const itens = rows.map((p) => ({
          id: p.id,
          titulo: `Pedido #${p.id} ${p.nome || ''}`.trim(),
          bloqueios: p.pecas_em_maleta
            ? [`${plural(p.pecas_em_maleta, 'peça está', 'peças estão')} na maleta com a cliente. Faça o acerto da maleta antes (ou use Métricas > Limpar testes, que devolve as peças ao estoque).`]
            : [],
          avisos: [],
        }));
        const { rows: [x] } = await db.query(`
          SELECT (SELECT COUNT(*) FROM pedidos WHERE status IN ${PEDIDO_ABERTO})::int AS abertos,
                 (SELECT COUNT(*) FROM pedidos WHERE status = 'ENTREGUE')::int AS entregues,
                 (SELECT COUNT(*) FROM encomendas WHERE pedido_id IS NOT NULL)::int AS encomendas,
                 (SELECT COUNT(*) FROM acertos WHERE pedido_id IS NOT NULL)::int AS acertos`);
        const avisos = [];
        if (x.abertos) avisos.push(`${plural(x.abertos, 'pedido está', 'pedidos estão')} em aberto (novo ou em andamento) e some${x.abertos === 1 ? '' : 'm'} também.`);
        if (x.entregues) avisos.push(`Peças e acessórios que saíram do estoque em ${plural(x.entregues, 'pedido entregue', 'pedidos entregues')} não voltam sozinhos.`);
        if (x.encomendas) avisos.push(`${plural(x.encomendas, 'encomenda veio', 'encomendas vieram')} de pedido: continua${x.encomendas === 1 ? '' : 'm'}, só sem o número do pedido.`);
        if (x.acertos) avisos.push(`${plural(x.acertos, 'acerto é', 'acertos são')} de pedido: continua${x.acertos === 1 ? '' : 'm'}, só sem o número do pedido.`);
        avisos.push('A numeração dos pedidos volta a 1.');
        return {
          total: rows.length, itens,
          sai: [plural(rows.length, 'pedido', 'pedidos') + ' da vitrine (itens, fechamento, descontos e acessórios lançados neles)'],
          fica: ['Produtos e estoque, clientes, encomendas e acertos', 'O Top 10 das Métricas (para zerar, use Métricas > Limpar testes)'],
          avisos,
        };
      },
      async apagar(db) {
        await db.query('UPDATE produtos SET pedido_condicional_id = NULL WHERE pedido_condicional_id IS NOT NULL');
        const r = await db.query('DELETE FROM pedidos');
        await db.query(`SELECT setval(pg_get_serial_sequence('pedidos', 'id'), 1, false)`);
        return r.rowCount;
      },
    },
    acertos: {
      rotulo: 'acertos',
      async conferir(db, bloquear) {
        const ids = await todosOsIds(db, 'acertos', bloquear);
        const { rows: [x] } = await db.query(
          `SELECT COALESCE(SUM(cardinality(comprados)), 0)::int AS vendidas FROM acertos`);
        const avisos = [];
        if (x.vendidas) avisos.push(`${plural(x.vendidas, 'peça vendida', 'peças vendidas')} nesses acertos não volta${x.vendidas === 1 ? '' : 'm'} para o estoque. Se eram testes, confira o estoque em Produtos > Editar em estoque.`);
        avisos.push('A numeração dos acertos volta a 1.');
        return {
          total: ids.length, itens: [],
          sai: [plural(ids.length, 'acerto de maleta', 'acertos de maleta') + ' (histórico do que foi comprado e devolvido)'],
          fica: ['Produtos e estoque como estão agora', 'Pedidos, clientes, encomendas e maletas abertas'],
          avisos,
        };
      },
      async apagar(db) {
        const r = await db.query('DELETE FROM acertos');
        await db.query(`SELECT setval(pg_get_serial_sequence('acertos', 'id'), 1, false)`);
        return r.rowCount;
      },
    },
    encomendas: {
      rotulo: 'encomendas',
      async conferir(db, bloquear) {
        const ids = await todosOsIds(db, 'encomendas', bloquear);
        const itens = ids.length ? await EXCLUSOES.encomendas.conferir(db, ids, bloquear) : [];
        const { rows: [x] } = await db.query(`SELECT COALESCE(SUM(sinal_pago), 0) AS sinais FROM encomendas`);
        const avisos = resumirAvisos(itens, [
          [/Ainda está em aberto/, (n) => `${plural(n, 'encomenda ainda está', 'encomendas ainda estão')} em aberto (aguardando, em trânsito ou pronta).`],
        ]);
        if (Number(x.sinais) > 0) avisos.push(`${formatarReais(x.sinais)} de sinal registrado some junto.`);
        avisos.push('A numeração das encomendas volta a 1.');
        return {
          total: ids.length, itens,
          sai: [plural(ids.length, 'encomenda', 'encomendas') + ' (com status, sinal e observações)'],
          fica: ['Produtos, pedidos e clientes'],
          avisos,
        };
      },
      async apagar(db) {
        const r = await db.query('DELETE FROM encomendas');
        await db.query(`SELECT setval(pg_get_serial_sequence('encomendas', 'id'), 1, false)`);
        return r.rowCount;
      },
    },
    acessorios: {
      rotulo: 'acessórios',
      async conferir(db, bloquear) {
        const ids = await todosOsIds(db, 'acessorios', bloquear);
        const itens = ids.length ? await EXCLUSOES.acessorios.conferir(db, ids, bloquear) : [];
        const { rows: [x] } = await db.query(`
          SELECT (SELECT COALESCE(SUM(estoque), 0) FROM acessorios)::int AS unidades,
                 (SELECT COUNT(*) FROM compras_acessorio)::int AS compras`);
        const avisos = [];
        if (x.unidades) avisos.push(`Ainda tem ${x.unidades} un. em estoque, que somem junto.`);
        avisos.push('Pedidos já entregues continuam com o acessório lançado (nome e preço ficam neles).');
        return {
          total: ids.length, itens,
          sai: [plural(ids.length, 'acessório', 'acessórios') + ` e ${plural(x.compras, 'compra', 'compras')} de acessório do fornecedor`],
          fica: ['Produtos, pedidos e clientes'],
          avisos,
        };
      },
      async apagar(db) {
        // compras_acessorio sai junto (ON DELETE CASCADE)
        const r = await db.query('DELETE FROM acessorios');
        await db.query(APAGAR_TOTAIS_SEM_COMPRA);
        return r.rowCount;
      },
    },
  };

  function previaCadastro(c) {
    const bloqueados = bloqueadosDe(c.itens);
    return {
      total: c.total,
      sai: c.sai, fica: c.fica, avisos: c.avisos,
      bloqueados: bloqueados.slice(0, MAX_BLOQUEADOS_MOSTRADOS),
      total_bloqueados: bloqueados.length,
      pode_zerar: c.total > 0 && bloqueados.length === 0,
    };
  }

  function cadastroDaRota(req, res) {
    const tipo = Object.prototype.hasOwnProperty.call(CADASTROS_ZERAR, req.params.cadastro) && CADASTROS_ZERAR[req.params.cadastro];
    if (!tipo) res.status(404).json({ error: 'Cadastro desconhecido' });
    return tipo;
  }

  async function handlePreviaZerarCadastro(req, res) {
    const tipo = cadastroDaRota(req, res);
    if (!tipo) return;
    try {
      res.json({ cadastro: req.params.cadastro, ...previaCadastro(await tipo.conferir(req.db, false)) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `Erro ao conferir ${tipo.rotulo}` });
    }
  }

  async function handleZerarCadastro(req, res) {
    const tipo = cadastroDaRota(req, res);
    if (!tipo) return;
    if ((req.body || {}).confirmacao !== CONFIRMACAO_ZERAR) {
      return res.status(400).json({ error: `Digite ${CONFIRMACAO_ZERAR} para confirmar` });
    }
    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const previa = previaCadastro(await tipo.conferir(client, true));
      if (previa.total_bloqueados) {
        await client.query('ROLLBACK');
        const n = previa.total_bloqueados;
        return res.status(409).json({
          error: `${n} ${n === 1 ? 'item impede' : 'itens impedem'} zerar ${tipo.rotulo} agora. Nada foi apagado.`,
          cadastro: req.params.cadastro, ...previa,
        });
      }
      const apagados = await tipo.apagar(client, req);
      await client.query('COMMIT');
      console.log(`[${req.empresa.slug}] zerar ${req.params.cadastro}: ${apagados} apagado(s) por ${req.admin && req.admin.u}`);
      res.json({ cadastro: req.params.cadastro, apagados, agora: await contarDadosDeTeste(req.db) });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao zerar. Nada foi apagado.' });
    } finally {
      if (client) client.release();
    }
  }

  async function handleMetrics(req, res) {
    try {
      // Peças = estoque na loja + peças em maletas. Produto Sob Encomenda ainda não
      // foi comprado: o "estoque" dele no cadastro não é peça de verdade, então fica
      // fora de peças, valor investido e lucro potencial (só entra no resumo à parte).
      // Peça dele que estiver numa maleta é real e conta.
      const { rows: [m] } = await req.db.query(
        `WITH u AS (
           SELECT p.preco_custo, p.preco_venda,
                  (p.disponibilidade = 'SOB_ENCOMENDA') AS encomenda,
                  CASE WHEN p.disponibilidade = 'SOB_ENCOMENDA' THEN 0 ELSE p.estoque END AS loja,
                  (SELECT COUNT(*) FROM maleta_pecas mp WHERE mp.produto_id = p.id) AS rua
           FROM produtos p
           WHERE NOT p.arquivado
         )
         SELECT COALESCE(SUM(loja + rua), 0) AS total,
                COALESCE(SUM(preco_custo * (loja + rua)), 0) AS investido,
                COALESCE(SUM((preco_venda - preco_custo) * (loja + rua)), 0) AS lucro,
                COALESCE(SUM(preco_venda * rua), 0) AS em_rua,
                COUNT(*) FILTER (WHERE encomenda) AS encomenda_modelos
         FROM u`
      );
      const totalEstoque = { rows: [{ total: m.total }] };
      const valorInvestido = { rows: [{ total: m.investido }] };
      const lucroPotencial = { rows: [{ total: m.lucro }] };
      const valorEmRua = { rows: [{ total: m.em_rua }] };

      const topMaleta = await req.db.query(
        `SELECT id, nome, codigo_sku, vezes_em_maleta, imagem_url
         FROM produtos
         WHERE vezes_em_maleta > 0 AND NOT arquivado
         ORDER BY vezes_em_maleta DESC
         LIMIT 10`
      );

      res.json({
        totalEstoque: parseInt(totalEstoque.rows[0].total),
        valorInvestido: parseFloat(valorInvestido.rows[0].total),
        lucroPotencial: parseFloat(lucroPotencial.rows[0].total),
        valorEmRua: parseFloat(valorEmRua.rows[0].total),
        topAdicionadosMaleta: topMaleta.rows,
        modelosSobEncomenda: parseInt(m.encomenda_modelos),
        // Quando os testes de venda foram limpos (null = nunca): o Top 10 e a
        // conversão das maletas contam a partir daí
        metricasDesde: await lerMetricasDesde(req.db),
        // aliases em inglês
        totalStock: parseInt(totalEstoque.rows[0].total),
        investedValue: parseFloat(valorInvestido.rows[0].total),
        potentialProfit: parseFloat(lucroPotencial.rows[0].total),
        onStreetValue: parseFloat(valorEmRua.rows[0].total),
        topAddedToCase: topMaleta.rows,
        popularity: topMaleta.rows,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao calcular métricas' });
    }
  }

  async function handleGetImagem(req, res) {
    if (!/^[0-9a-f]{32}$/.test(req.params.id)) return res.status(404).end();
    try {
      const result = await req.db.query(`SELECT mime_type, dados FROM imagens WHERE id = $1`, [req.params.id]);
      if (result.rows.length === 0) return res.status(404).end();
      const { mime_type, dados } = result.rows[0];
      // O id muda sempre que a foto é trocada, então o conteúdo de uma URL nunca muda: cache longo.
      res.set({
        'Content-Type': mime_type,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(dados);
    } catch (err) {
      console.error(err);
      res.status(500).end();
    }
  }

  // ---------- Painel master (dono do serviço: lojas, endereços, logins e bancos) ----------
  // As alterações passam uma de cada vez, para a lista de lojas em memória e a tabela
  // master_lojas não se desencontrarem.
  let filaMaster = Promise.resolve();
  function emFilaMaster(fn) {
    const p = filaMaster.then(fn);
    filaMaster = p.catch(() => {});
    return p;
  }

  class ErroMaster extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  function lojaPorSlug(slug) {
    const empresa = EMPRESAS.find((e) => e.slug === slug);
    if (!empresa) throw new ErroMaster(404, 'Loja não encontrada');
    return empresa;
  }

  // Um endereço só abre uma loja (nem o do painel master, nem o de outra loja).
  function conferirDominios(dominios, slug) {
    for (const d of dominios) {
      if (MASTER_DOMINIOS.includes(d)) throw new ErroMaster(400, `"${d}" é o endereço do painel master`);
      const padrao = EMPRESAS.find((e) => e.padrao);
      if (padrao && d === padrao.hostRender && slug !== padrao.slug) throw new ErroMaster(400, `"${d}" é o endereço do serviço no Render, que abre a loja principal`);
      const dona = empresaDoHost(EMPRESAS.filter((e) => e.slug !== slug), d);
      if (dona && (dona.dominios.includes(d) || d.startsWith(dona.slug + '.'))) {
        throw new ErroMaster(400, `"${d}" já abre a loja "${dona.slug}"`);
      }
    }
  }

  function conferirBancoLivre(databaseUrl, slug) {
    const id = identidadeBanco(databaseUrl);
    const outra = EMPRESAS.find((e) => e.slug !== slug && e.databaseUrl && identidadeBanco(e.databaseUrl) === id);
    if (outra) throw new ErroMaster(400, `Esse banco já é da loja "${outra.slug}": cada loja precisa do seu`);
    if (PLATAFORMA_DATABASE_URL && identidadeBanco(PLATAFORMA_DATABASE_URL) === id) throw new ErroMaster(400, 'Esse é o banco da plataforma: cada loja precisa do seu');
  }

  async function abrirBancoDaLoja(slug, databaseUrl) {
    try {
      return await conectarBanco(slug, databaseUrl);
    } catch (err) {
      throw new ErroMaster(400, `Não consegui usar esse banco: ${err.message}`);
    }
  }

  function nichoDoCorpo(campos) {
    if (campos.nicho === undefined) return null;
    const nicho = lerNicho(campos.nicho);
    if (!nicho) throw new ErroMaster(400, 'Tipo de loja inválido');
    return nicho;
  }

  function paresDaLoja({ nome, nicho }) {
    const pares = [];
    if (nome !== undefined) pares.push(['loja_nome', limparTextoLoja('nome', nome)]);
    if (nicho) pares.push(['loja_nicho', nicho], ['loja_oculos', nicho === 'oculos' ? '1' : '0']);
    return pares;
  }

  async function salvarLinhaMaster(linha) {
    const { rows } = await poolCadastro.query(
      `INSERT INTO master_lojas (slug, nome, dominios, banco_cifrado, admin_user, admin_pass_hash, ativo, sessao, legado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (slug) DO UPDATE SET nome = $2, dominios = $3, banco_cifrado = $4, admin_user = $5,
         admin_pass_hash = $6, ativo = $7, sessao = $8, legado = $9, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [linha.slug, linha.nome, linha.dominios, linha.banco_cifrado, linha.admin_user, linha.admin_pass_hash, linha.ativo, linha.sessao, !!linha.legado]
    );
    return rows[0];
  }

  // O que o painel mostra de cada loja. A connection string nunca sai: só servidor/banco.
  async function resumoDaLoja(empresa, hostDoPainel) {
    let loja = null;
    let produtos = null;
    let pedidos = null;
    if (!empresa.erro && empresa.pool) {
      try {
        loja = await lojaDaEmpresa(empresa);
        const { rows: [c] } = await empresa.pool.query(
          'SELECT (SELECT COUNT(*) FROM produtos)::int AS produtos, (SELECT COUNT(*) FROM pedidos)::int AS pedidos'
        );
        ({ produtos, pedidos } = c);
      } catch (err) {
        console.error(`[master] resumo de "${empresa.slug}":`, err.message);
      }
    }
    return {
      slug: empresa.slug,
      nome: (loja && loja.nome) || empresa.nome || empresa.slug,
      nicho: loja ? loja.nicho : null,
      padrao: empresa.padrao,
      origem: empresa.origem,
      dominios: empresa.dominios,
      endereco: master.enderecoDaLoja(empresa, hostDoPainel),
      banco: empresa.databaseUrl ? identidadeBanco(empresa.databaseUrl) : '',
      bancoDoPainel: !!empresa.bancoDoPainel,
      adminUser: empresa.adminUser,
      temSenha: !!empresa.adminPassHash,
      ativo: empresa.ativo !== false,
      erro: empresa.erro || '',
      produtos,
      pedidos,
    };
  }

  function responderMaster(res, status = 200) {
    return (resultado) => res.status(status).json(resultado);
  }

  function falhaMaster(res, contexto) {
    return (err) => {
      if (err instanceof ErroMaster) return res.status(err.status).json({ error: err.message });
      console.error(`[master] ${contexto}:`, err);
      res.status(500).json({ error: `Erro ao ${contexto}` });
    };
  }

  async function handleListLojasMaster(req, res) {
    try {
      res.json(await Promise.all(EMPRESAS.map((e) => resumoDaLoja(e, req.hostname))));
    } catch (err) {
      falhaMaster(res, 'listar as lojas')(err);
    }
  }

  function handleCreateLojaMaster(req, res) {
    emFilaMaster(async () => {
      const { erro, campos } = master.lerLojaMaster(req.body, { nova: true });
      if (erro) throw new ErroMaster(400, erro);
      const nicho = nichoDoCorpo(campos) || 'geral';
      if (EMPRESAS.some((e) => e.slug === campos.slug)) throw new ErroMaster(409, `Já existe uma loja "${campos.slug}"`);
      const dominios = campos.dominios || [];
      conferirDominios(dominios, campos.slug);
      // Sem domínio, a loja abre em "<slug>.": esse começo não pode ser de outra loja.
      const ocupado = !dominios.length && EMPRESAS.find((e) => e.dominios.some((d) => d.startsWith(campos.slug + '.')));
      if (ocupado) throw new ErroMaster(400, `Endereços "${campos.slug}." já são da loja "${ocupado.slug}": informe um domínio`);
      conferirBancoLivre(campos.banco, campos.slug);
      const pool = await abrirBancoDaLoja(campos.slug, campos.banco);
      try {
        const linha = await salvarLinhaMaster({
          slug: campos.slug,
          nome: campos.nome,
          dominios: dominios.join(','),
          banco_cifrado: master.cifrar(campos.banco, process.env.JWT_SECRET),
          admin_user: campos.adminUser,
          admin_pass_hash: await hashSenhaCliente(campos.senha),
          ativo: campos.ativo !== false,
          sessao: 0,
        });
        await salvarConfiguracoes(pool, paresDaLoja({ nicho }));
        const empresa = master.mesclarEmpresas([], [linha], decifrarBanco)[0];
        empresa.pool = pool;
        EMPRESAS.push(empresa);
        cacheLoja.delete(empresa.slug);
        console.log(`[master] loja "${empresa.slug}" criada por ${req.master.u}`);
        return resumoDaLoja(empresa, req.hostname);
      } catch (err) {
        await pool.end().catch(() => {});
        throw err;
      }
    }).then(responderMaster(res, 201), falhaMaster(res, 'criar a loja'));
  }

  function handleUpdateLojaMaster(req, res) {
    emFilaMaster(async () => {
      const empresa = lojaPorSlug(req.params.slug);
      const { erro, campos } = master.lerLojaMaster(req.body);
      if (erro) throw new ErroMaster(400, erro);
      const nicho = nichoDoCorpo(campos);
      if (empresa.padrao && campos.banco) throw new ErroMaster(400, 'O banco da loja principal fica no Render (DATABASE_URL)');
      if (empresa.padrao && campos.ativo === false) throw new ErroMaster(400, 'A loja principal não pode ser suspensa');
      if (campos.dominios) conferirDominios(campos.dominios, empresa.slug);
      if (campos.banco) conferirBancoLivre(campos.banco, empresa.slug);

      // Banco novo, ou nova tentativa no mesmo banco de uma loja que ficou fora do ar
      let novoPool = null;
      if (campos.banco) novoPool = await abrirBancoDaLoja(empresa.slug, campos.banco);
      else if (empresa.erro && empresa.databaseUrl) novoPool = await abrirBancoDaLoja(empresa.slug, empresa.databaseUrl);

      try {
        const { rows: [atual] } = await poolCadastro.query('SELECT * FROM master_lojas WHERE slug = $1', [empresa.slug]);
        const linha = atual || {
          slug: empresa.slug, nome: empresa.nome || '', dominios: null, banco_cifrado: null,
          admin_user: null, admin_pass_hash: null, ativo: true, sessao: 0,
        };
        if (campos.nome !== undefined) linha.nome = campos.nome;
        if (campos.dominios) linha.dominios = campos.dominios.join(',');
        if (campos.banco) linha.banco_cifrado = master.cifrar(campos.banco, process.env.JWT_SECRET);
        if (campos.ativo !== undefined) linha.ativo = campos.ativo;
        const trocouLogin = (campos.adminUser && campos.adminUser !== empresa.adminUser) || campos.senha;
        if (campos.adminUser) linha.admin_user = campos.adminUser;
        if (campos.senha) linha.admin_pass_hash = await hashSenhaCliente(campos.senha);
        if (trocouLogin) linha.sessao = (linha.sessao || 0) + 1;
        const salva = await salvarLinhaMaster(linha);

        if (novoPool) {
          const antigo = empresa.pool;
          empresa.pool = novoPool;
          empresa.databaseUrl = campos.banco || empresa.databaseUrl;
          delete empresa.erro;
          if (antigo && antigo !== novoPool) antigo.end().catch(() => {});
          novoPool = null;
        }
        master.aplicarRegistro(empresa, salva, decifrarBanco);
        if (empresa.origem === 'render') empresa.origem = 'render+painel';
        const pares = paresDaLoja({ nome: campos.nome, nicho });
        if (pares.length && empresa.pool && !empresa.erro) await salvarConfiguracoes(empresa.pool, pares);
        cacheLoja.delete(empresa.slug);
        console.log(`[master] loja "${empresa.slug}" alterada por ${req.master.u}`);
        return resumoDaLoja(empresa, req.hostname);
      } finally {
        if (novoPool) await novoPool.end().catch(() => {});
      }
    }).then(responderMaster(res), falhaMaster(res, 'salvar a loja'));
  }

  // Tira a loja do painel. O banco dela no Neon fica intacto: cadastrar de novo com o
  // mesmo identificador e a mesma connection string traz tudo de volta.
  function handleDeleteLojaMaster(req, res) {
    emFilaMaster(async () => {
      const empresa = lojaPorSlug(req.params.slug);
      if (empresa.origem !== 'painel') throw new ErroMaster(400, 'Essa loja vem das variáveis do Render: tire de lá (EMPRESAS e EMPRESA_*)');
      if ((req.body || {}).confirmacao !== empresa.slug) throw new ErroMaster(400, `Digite ${empresa.slug} para confirmar`);
      await poolCadastro.query('DELETE FROM master_lojas WHERE slug = $1', [empresa.slug]);
      EMPRESAS.splice(EMPRESAS.indexOf(empresa), 1);
      cacheLoja.delete(empresa.slug);
      if (empresa.pool) empresa.pool.end().catch(() => {});
      console.log(`[master] loja "${empresa.slug}" removida do painel por ${req.master.u}`);
      return { removida: empresa.slug };
    }).then(responderMaster(res), falhaMaster(res, 'remover a loja'));
  }

  // Entrar no painel de uma loja sem a senha dela (suporte ao cliente): token de 1 hora
  // do admin daquela loja, levado no #acesso= da página de login (não vai para o servidor).
  function handleAcessoLojaMaster(req, res) {
    try {
      const empresa = lojaPorSlug(req.params.slug);
      if (empresa.erro || empresa.ativo === false) throw new ErroMaster(400, 'A loja está fora do ar');
      if (!isAdminAuthEnabled(empresa)) throw new ErroMaster(400, 'A loja ainda não tem login do admin');
      console.log(`[master] ${req.master.u} entrou no painel da loja "${empresa.slug}"`);
      res.json({ token: signToken(empresa, `master:${req.master.u}`, 1), endereco: master.enderecoDaLoja(empresa, req.hostname) });
    } catch (err) {
      falhaMaster(res, 'abrir o painel da loja')(err);
    }
  }

  masterRouter.get('/master', (req, res) => res.redirect(301, '/master/'));
  masterRouter.get('/master/', (req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' });
    res.sendFile(path.join(__dirname, 'master', 'index.html'));
  });
  masterRouter.get('/api/master/status', (req, res) => res.json({ habilitado: masterHabilitado() }));
  masterRouter.post('/api/master/login', handleLoginMaster);
  masterRouter.get('/api/master/lojas', requireMaster, handleListLojasMaster);
  masterRouter.post('/api/master/lojas', requireMaster, handleCreateLojaMaster);
  masterRouter.put('/api/master/lojas/:slug', requireMaster, handleUpdateLojaMaster);
  masterRouter.delete('/api/master/lojas/:slug', requireMaster, handleDeleteLojaMaster);
  masterRouter.post('/api/master/lojas/:slug/acesso', requireMaster, handleAcessoLojaMaster);

  // ---------- Login admin (público; demais /api/admin exigem Bearer) ----------
  app.post('/api/admin/login', handleLogin);
  app.get('/api/admin/me', requireAdmin, handleAdminAtual);
  app.get('/api/admin/status', (req, res) => {
    res.json({ authEnabled: isAdminAuthEnabled(req.empresa) });
  });

  // ---------- Rotas públicas (vitrine) ----------
  app.post('/api/clientes/cadastro', handleCadastroCliente);
  app.post('/api/clientes/login', handleLoginCliente);
  app.get('/api/clientes/me', handleClienteAtual);
  // GET produtos e GET whatsapp precisam ficar abertos para o site público.
  app.get('/api/produtos', handleListPublicos);
  app.get('/imagens/:id', handleGetImagem);
  app.get('/api/config/whatsapp', handleGetWhatsapp);
  app.get('/api/admin/whatsapp', handleGetWhatsapp);
  app.post('/api/maleta/checkout', handleMaletaCheckout);
  app.post('/api/case/checkout', handleMaletaCheckout);

  // ---------- Rotas admin (sempre exigem token; sem ADMIN_USER/ADMIN_PASS_HASH respondem 503) ----------
  app.get('/api/admin/produtos', exigirArea('produtos', 'acerto', 'pedidos'), handleListAdmin);
  app.post('/api/admin/produtos/lote', exigirArea('produtos'), handleCreateLote);
  app.put('/api/admin/produtos/lote', exigirArea('produtos'), handleUpdateLote);
  app.post('/api/admin/produtos/excluir/conferir', exigirArea('produtos'), handleConferirExclusao);
  app.post('/api/admin/produtos/excluir', exigirArea('produtos'), handleExcluirProdutos);
  app.post('/api/admin/produtos/arquivar/conferir', exigirArea('produtos'), handleConferirArquivamento);
  app.post('/api/admin/produtos/arquivar', exigirArea('produtos'), handleArquivarProdutos);
  app.post('/api/admin/produtos/conferencia', exigirArea('produtos'), handleConferenciaProdutos);
  // Conferência de estoque: vendido, baixa, Sob Encomenda ou esgotado (com conferência antes)
  const conferencia = conferenciaEstoque.criarHandlers({ recalcularStatus, textoCurto });
  app.post('/api/admin/estoque/conferencia/conferir', exigirArea('produtos'), conferencia.handleConferir);
  app.post('/api/admin/estoque/conferencia', exigirArea('produtos'), conferencia.handleAplicar);
  app.get('/api/admin/estoque/movimentos', exigirArea('produtos'), conferencia.handleListar);
  app.post('/api/admin/importar-url', exigirArea('produtos'), handleImportarUrl);
  app.post('/api/admin/importar-imagem', exigirArea('produtos'), handleImportarImagem);
  app.post('/api/admin/pedidos-fornecedor/ler', exigirArea('produtos'), uploadPdfPedido, handleLerPedidoFornecedor);
  app.post('/api/admin/pedidos-fornecedor', exigirArea('produtos'), handleLancarPedidoFornecedor);
  app.get('/api/admin/pedidos-fornecedor', exigirArea('produtos', 'metricas'), handleListPedidosFornecedor);
  app.put('/api/admin/pedidos-fornecedor/totais', exigirArea('produtos'), handleTotaisPedidoFornecedor);
  app.get('/api/admin/pedidos-fornecedor/itens', exigirArea('produtos', 'metricas'), handleItensPedidoFornecedor);
  app.get('/api/admin/compras/produtos', exigirArea('produtos', 'metricas'), handleComprasPorProduto);
  app.get('/api/admin/produtos/:id/compras', exigirArea('produtos'), handleListCompras);
  app.post('/api/admin/produtos/:id/compras', exigirArea('produtos'), handleCreateCompra);
  app.get('/api/admin/fornecedores/reposicao', exigirArea('metricas', 'produtos'), handleResumoFornecedores);
  app.post('/api/produtos', exigirArea('produtos'), uploadImagem, handleCreateProduto);
  app.put('/api/produtos/:id', exigirArea('produtos'), uploadImagem, handleUpdateProduto);
  app.post('/api/produtos/:id/cores', exigirArea('produtos'), uploadImagem, handleAdicionarCores);
  app.post('/api/admin/acerto', exigirArea('acerto'), handleAcerto);
  app.get('/api/admin/acertos', exigirArea('acerto', 'metricas'), handleListAcertos);
  app.post('/api/config/whatsapp', exigirArea('config'), handlePostWhatsapp);
  app.post('/api/admin/whatsapp', exigirArea('config'), handlePostWhatsapp);
  app.get('/api/admin/metrics', exigirArea('metricas'), handleMetrics);
  // Vendas do período (pedidos entregues, maletas acertadas, encomendas e Conferência de estoque)
  app.get('/api/admin/vendas', exigirArea('metricas'), vendas.criarHandler({ lerMetricasDesde }).handleVendas);
  app.get('/api/admin/rastreamento', exigirArea('config'), handleGetRastreamento);
  app.put('/api/admin/rastreamento', exigirArea('config'), handleUpdateRastreamento);
  app.post('/api/rastreamento/evento', handleEventoRastreamento);
  app.get('/api/admin/origens', exigirArea('metricas'), origens.criarHandler({ lerMetricasDesde }));
  app.get('/api/admin/loja', exigirArea('config'), handleGetLoja);
  app.put('/api/admin/loja', exigirArea('config'), handleUpdateLoja);
  app.post('/api/admin/loja/logo', exigirArea('config'), uploadImagem, handleUpdateLogo);
  app.delete('/api/admin/loja/logo', exigirArea('config'), handleDeleteLogo);
  app.get('/api/admin/zerar', soDono, handleContagemZerar);
  app.post('/api/admin/zerar', soDono, handleZerarDados);
  app.get('/api/admin/zerar/:cadastro', soDono, handlePreviaZerarCadastro);
  app.post('/api/admin/zerar/:cadastro', soDono, handleZerarCadastro);
  app.get('/api/admin/clientes', exigirArea('clientes'), handleListClientes);
  app.get('/api/admin/pedidos', exigirArea('pedidos', 'acerto', 'clientes'), handleListPedidos);
  app.get('/api/admin/clientes/:id/perfil', exigirArea('clientes'), handlePerfilCliente);
  app.get('/api/admin/relatorios/maletas', exigirArea('metricas'), handleRelatorioMaletas);
  app.post('/api/admin/pedidos/:id/enviar-maleta', exigirArea('pedidos'), handleEnviarMaleta);
  app.patch('/api/admin/pedidos/:id/status', exigirArea('pedidos'), handleStatusPedido);
  app.put('/api/admin/pedidos/:id/fechamento', exigirArea('pedidos'), handleFechamentoPedido);
  app.post('/api/admin/pedidos/:id/encomendar', exigirArea('pedidos'), handleEncomendarItem);
  const fila = filaEncomendas.criarHandlers();
  app.get('/api/admin/encomendas/fila', exigirArea('encomendas'), fila.handleFila);
  app.put('/api/admin/encomendas/regras-fornecedor', exigirArea('encomendas'), fila.handleSalvarRegra);
  app.post('/api/admin/encomendas/pedido-fornecedor', exigirArea('encomendas'), fila.handlePedirFornecedor);
  app.get('/api/admin/encomendas', exigirArea('encomendas', 'pedidos'), handleListEncomendas);
  app.post('/api/admin/encomendas', exigirArea('encomendas'), handleCreateEncomenda);
  app.put('/api/admin/encomendas/:id', exigirArea('encomendas'), handleUpdateEncomenda);
  app.get('/api/admin/acessorios', exigirArea('acessorios', 'pedidos'), handleListAcessorios);
  app.post('/api/admin/acessorios', exigirArea('acessorios'), handleCreateAcessorio);
  app.put('/api/admin/acessorios/:id', exigirArea('acessorios'), handleUpdateAcessorio);
  // Excluir de vez (com conferência): encomendas, acessórios e clientes
  for (const [rota, tipo] of Object.entries(EXCLUSOES)) {
    const h = handlersDeExclusao(tipo);
    app.post(`/api/admin/${rota}/excluir/conferir`, exigirArea(tipo.area), h.conferir);
    app.post(`/api/admin/${rota}/excluir`, exigirArea(tipo.area), h.excluir);
  }

  // Usuários do painel e as áreas de cada um: só o dono da loja cadastra
  const usuariosHandlers = usuariosAdmin.criarHandlers({
    hashSenha: hashSenhaCliente,
    loginDono: (req) => getAuthConfig(req.empresa).user,
  });
  // Promoções: Configurações > POP Anúncio (o cadastro de produtos lê a lista para escolher)
  const anunciosHandlers = anuncios.criarHandlers({ salvarImagem, idDaImagem, detectarTipoImagem });
  app.get('/api/anuncios', anunciosHandlers.publico);
  app.get('/api/admin/anuncios', exigirArea('config', 'produtos'), anunciosHandlers.listar);
  app.post('/api/admin/anuncios', exigirArea('config'), uploadAnuncio, anunciosHandlers.criar);
  app.put('/api/admin/anuncios/popup', exigirArea('config'), anunciosHandlers.escolherPopup);
  app.put('/api/admin/anuncios/:id', exigirArea('config'), uploadAnuncio, anunciosHandlers.atualizar);
  app.delete('/api/admin/anuncios/:id', exigirArea('config'), anunciosHandlers.excluir);

  app.get('/api/admin/usuarios', soDono, usuariosHandlers.listar);
  app.post('/api/admin/usuarios', soDono, usuariosHandlers.criar);
  app.put('/api/admin/usuarios/:id', soDono, usuariosHandlers.atualizar);
  app.delete('/api/admin/usuarios/:id', soDono, usuariosHandlers.excluir);

  // ---------- Aliases EN (compatibilidade front-end em inglês) ----------
  app.get('/api/products', handleListPublicos);
  app.get('/api/admin/products', exigirArea('produtos', 'acerto', 'pedidos'), handleListAdmin);
  app.post('/api/products', exigirArea('produtos'), uploadImagem, handleCreateProduto);
  app.post('/api/admin/products', exigirArea('produtos'), uploadImagem, handleCreateProduto);
  app.put('/api/products/:id', exigirArea('produtos'), uploadImagem, handleUpdateProduto);
  app.put('/api/admin/products/:id', exigirArea('produtos'), uploadImagem, handleUpdateProduto);

  // admin/acerto.html usa /api/admin/products/conditional
  app.get('/api/admin/products/conditional', exigirArea('acerto'), handleListConditional);
  app.get('/api/admin/produtos/condicional', exigirArea('acerto'), handleListConditional);
  app.get('/api/produtos/condicional', exigirArea('acerto'), handleListConditional);

  // Métricas / popularidade
  app.get('/api/admin/popularity', exigirArea('metricas'), handleMetrics);
  app.get('/api/admin/popularidade', exigirArea('metricas'), handleMetrics);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});

module.exports = app;
