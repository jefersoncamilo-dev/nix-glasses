require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const { pool, initTables } = require('./db');
const { importarProduto, ErroImportacao } = require('./importar-produto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
// Serve front-end estático (site público + admin) — necessário no Render.
// Só arquivos da lista abaixo saem da raiz: server.js, db.js, .env, package*.json,
// node_modules/ e scripts/ NUNCA podem ser servidos.
const PUBLIC_ROOT_FILES = new Set(['index.html', 'logo.png', 'favicon.ico', 'apple-touch-icon.png', 'robots.txt']);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:file', (req, res, next) => {
  if (!PUBLIC_ROOT_FILES.has(req.params.file)) return next();
  res.sendFile(path.join(__dirname, req.params.file), (err) => err && next());
});
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Só imagens comuns; SVG/HTML ficam de fora porque seriam servidos pelo mesmo domínio em /imagens.
// O tipo gravado vem da assinatura do arquivo (bytes iniciais), não do que o cliente declarou.
const TIPOS_IMAGEM = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TAMANHO_MAX_IMAGEM = 8 * 1024 * 1024; // 8 MB (fotos da câmera do celular cabem)
const MAX_FOTOS = 4;
// foto1..foto4 são as posições do formulário; `imagem` é o campo antigo (= foto1).
const CAMPOS_FOTO = Array.from({ length: MAX_FOTOS }, (_, i) => `foto${i + 1}`);

function detectarTipoImagem(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANHO_MAX_IMAGEM, files: MAX_FOTOS },
  fileFilter: (req, file, cb) => {
    if (TIPOS_IMAGEM.has(file.mimetype)) return cb(null, true);
    const err = new Error('Formato de imagem não suportado. Use JPG, PNG ou WEBP.');
    err.status = 400;
    cb(err);
  },
});

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
      for (const file of req.fotosEnviadas) {
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
          ? `No máximo ${MAX_FOTOS} fotos por produto`
          : 'Upload inválido';
      return res.status(400).json({ error: msg });
    }
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  });
}

// Fotos atuais de um produto; linhas gravadas antes da coluna `fotos` só têm imagem_url.
function fotosDoProduto(row) {
  if (Array.isArray(row.fotos) && row.fotos.length) return row.fotos.slice(0, MAX_FOTOS);
  return row.imagem_url ? [row.imagem_url] : [];
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
function getAuthConfig() {
  return {
    user: process.env.ADMIN_USER || '',
    passHash: process.env.ADMIN_PASS_HASH || '',
    secret: process.env.JWT_SECRET || process.env.ADMIN_TOKEN_SECRET || '',
  };
}

let _fallbackSecret = null;
function getTokenSecret() {
  const { secret } = getAuthConfig();
  if (secret) return secret;
  if (!_fallbackSecret) {
    _fallbackSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[auth] JWT_SECRET não definido: usando segredo aleatório (tokens invalidados a cada restart). Defina JWT_SECRET em produção.');
  }
  return _fallbackSecret;
}

function isAdminAuthEnabled() {
  const { user, passHash } = getAuthConfig();
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

function signToken(username, expiresInHours = 12) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { u: username, iat: now, exp: now + expiresInHours * 3600 };
  const body = b64urlEncode(payload);
  const sig = crypto.createHmac('sha256', getTokenSecret()).update(body).digest('hex');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) throw new Error('Token inválido');
  const expected = crypto.createHmac('sha256', getTokenSecret()).update(body).digest('hex');
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Token inválido');
  const payload = JSON.parse(b64urlDecode(body));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Sessão expirada');
  return payload;
}

function requireAdmin(req, res, next) {
  // Sem ADMIN_USER/ADMIN_PASS_HASH configurados, o admin fica FECHADO (nunca aberto por padrão).
  if (!isAdminAuthEnabled()) {
    return res.status(503).json({ error: 'Admin não configurado (defina ADMIN_USER e ADMIN_PASS_HASH)' });
  }
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autorizado' });
  try {
    req.admin = verifyToken(token);
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }
}

async function handleLogin(req, res) {
  const { user, username, password, pass } = req.body || {};
  const loginUser = user || username || '';
  const loginPass = password || pass || '';

  if (!isAdminAuthEnabled()) {
    return res.status(500).json({ error: 'Login admin não configurado (defina ADMIN_USER e ADMIN_PASS_HASH)' });
  }
  const cfg = getAuthConfig();
  const userOk =
    String(loginUser).length === String(cfg.user).length &&
    crypto.timingSafeEqual(Buffer.from(String(loginUser)), Buffer.from(String(cfg.user)));
  const passOk = verifyPassword(loginPass, cfg.passHash);

  if (!userOk || !passOk) {
    // Resposta genérica para não vazar qual campo errou
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }
  const token = signToken(cfg.user);
  res.json({ token, expiresIn: '12h', user: cfg.user });
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

function chaveTokenCliente() {
  return crypto.createHmac('sha256', getTokenSecret()).update('nix-glasses:clientes').digest();
}

function assinarTokenCliente(id, dias = 30) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64urlEncode({ c: id, t: 'cliente', iat: now, exp: now + dias * 86400 });
  return `${body}.${crypto.createHmac('sha256', chaveTokenCliente()).update(body).digest('hex')}`;
}

function verificarTokenCliente(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) throw new Error('Token inválido');
  const a = Buffer.from(sig);
  const b = Buffer.from(crypto.createHmac('sha256', chaveTokenCliente()).update(body).digest('hex'));
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
    const { rows } = await pool.query(
      `INSERT INTO clientes (email, nome, senha_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING RETURNING id, email, nome`,
      [emailOk, nomeOk, await hashSenhaCliente(senha)]
    );
    if (!rows.length) return res.status(409).json({ error: 'Já existe uma conta com este e-mail. Faça login.' });
    res.status(201).json({ token: assinarTokenCliente(rows[0].id), cliente: clientePublico(rows[0]) });
  } catch (err) {
    console.error('Erro ao cadastrar cliente:', err);
    res.status(500).json({ error: 'Erro ao criar conta' });
  }
}

async function handleLoginCliente(req, res) {
  const { email, senha } = req.body || {};
  const emailOk = validarEmailCliente(email);
  if (!emailOk || typeof senha !== 'string') return res.status(401).json({ error: 'E-mail ou senha inválidos' });
  if (loginBloqueado(emailOk)) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
  }
  try {
    const { rows } = await pool.query('SELECT id, email, nome, senha_hash FROM clientes WHERE email = $1', [emailOk]);
    const ok = await conferirSenhaCliente(senha.slice(0, SENHA_MAX), rows[0] ? rows[0].senha_hash : HASH_FALSO);
    if (!rows[0] || !ok) {
      registrarFalhaLogin(emailOk);
      return res.status(401).json({ error: 'E-mail ou senha inválidos' });
    }
    tentativasLogin.delete(emailOk);
    res.json({ token: assinarTokenCliente(rows[0].id), cliente: clientePublico(rows[0]) });
  } catch (err) {
    console.error('Erro no login do cliente:', err);
    res.status(500).json({ error: 'Erro ao entrar' });
  }
}

async function handleClienteAtual(req, res) {
  const h = req.headers.authorization || '';
  let payload;
  try {
    payload = verificarTokenCliente(h.startsWith('Bearer ') ? h.slice(7) : '');
  } catch {
    return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }
  try {
    const { rows } = await pool.query('SELECT id, email, nome FROM clientes WHERE id = $1', [payload.c]);
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
    return verificarTokenCliente(h.slice(7)).c;
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
    link_fornecedor: lerLinkFornecedor(l.link_fornecedor),
    preco_custo: lerPrecoLote(l.preco_custo),
    preco_venda: lerPrecoLote(l.preco_venda),
    status: l.status || 'DISPONIVEL',
    disponibilidade: l.disponibilidade || 'PRONTA_ENTREGA',
    formato: textoCurto(l.formato, 100) || null,
    estilo: textoCurto(l.estilo, 100) || null,
    cor_armacao: textoCurto(l.cor_armacao, 100) || null,
  };
  const { espec, erro: erroEspec } = lerEspecificacoes(l);
  Object.assign(produto, { diametro_cm: null, ponte_cm: null, largura_total_cm: null, material: '', tipo: '', nome_curto: '' }, espec);
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
  return { produto, erros };
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
    const codigo = p.codigo_fornecedor ? chaveForn(p.fornecedor.toLowerCase(), p.codigo_fornecedor.toLowerCase()) : '';
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
async function registrarCompraCadastro(db, produto) {
  await db.query(
    `INSERT INTO compras_fornecedor (produto_id, fornecedor, preco_custo, quantidade, origem)
     VALUES ($1, $2, $3, 1, 'CADASTRO')`,
    [produto.id, produto.fornecedor || '', produto.preco_custo]
  );
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
    const preco = centavos(p.preco_venda) / 100;
    const intencao = encomenda ? 'ENCOMENDA' : intencoes.get(p.id) === 'COMPRA' ? 'COMPRA' : 'CONDICIONAL';
    return { produto_id: p.id, nome: p.nome, codigo_sku: p.codigo_sku, preco, encomenda, sinal: encomenda ? Math.round(preco * 50) / 100 : 0, intencao };
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

async function startServer() {
  if (!isAdminAuthEnabled()) {
    console.warn('[auth] ADMIN_USER/ADMIN_PASS_HASH não definidos: rotas admin ficarão bloqueadas (503).');
  }
  await initTables();

  // ---------- Handlers reutilizáveis ----------

  const DISPONIBILIDADES = ['PRONTA_ENTREGA', 'SOB_ENCOMENDA'];

  async function handleListPublicos(req, res) {
    try {
      const result = await pool.query(
        `SELECT id, nome, nome_curto, codigo_sku, preco_venda, imagem_url, fotos, status, disponibilidade, formato, estilo, cor_armacao,
                diametro_cm, ponte_cm, largura_total_cm, material, tipo
         FROM produtos
         WHERE status IN ('DISPONIVEL', 'CONDICIONAL')
         ORDER BY created_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar produtos' });
    }
  }

  // Lista do painel, com a última compra do histórico de reposição e o custo da
  // compra anterior (para a variação de preço do fornecedor).
  async function handleListAdmin(req, res) {
    try {
      const result = await pool.query(
        `SELECT p.id, p.nome, p.nome_curto, p.codigo_sku, p.preco_custo, p.preco_venda, p.imagem_url, p.fotos, p.status, p.disponibilidade,
                p.formato, p.estilo, p.cor_armacao, p.diametro_cm, p.ponte_cm, p.largura_total_cm, p.material, p.tipo,
                p.fornecedor, p.codigo_fornecedor, p.link_fornecedor, p.vezes_em_maleta, p.pedido_condicional_id,
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
      const result = await pool.query(
        `SELECT id, nome, nome_curto, codigo_sku, preco_custo, preco_venda, imagem_url, fotos, status, disponibilidade, formato, estilo, cor_armacao, diametro_cm, ponte_cm, largura_total_cm, material, tipo, fornecedor, codigo_fornecedor, link_fornecedor, vezes_em_maleta
         FROM produtos
         WHERE status = 'CONDICIONAL'
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

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const fotos = [];
      for (const file of req.fotosEnviadas || []) {
        if (file) fotos.push(await salvarImagem(client, file));
      }
      const result = await client.query(
        `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, imagem_url, fotos, disponibilidade, formato, estilo, cor_armacao, fornecedor, codigo_fornecedor, link_fornecedor,
                               diametro_cm, ponte_cm, largura_total_cm, material, tipo, nome_curto)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING *`,
        [nome, codigoFinal, preco_custo, preco_venda, fotos[0] || null, fotos, disponibilidade, formato, estilo, cor_armacao, fornecedor, codigoFornecedor, linkFornecedor,
          espec.diametro_cm ?? null, espec.ponte_cm ?? null, espec.largura_total_cm ?? null, espec.material || '', espec.tipo || '', espec.nome_curto || '']
      );
      await registrarCompraCadastro(client, result.rows[0]);
      await client.query('COMMIT');
      res.status(201).json(result.rows[0]);
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      if (err.code === '23505') {
        return res.status(400).json({ error: 'SKU já cadastrado' });
      }
      res.status(500).json({ error: 'Erro ao cadastrar produto' });
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

    let client;
    try {
      client = await pool.connect();
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
      addField('status', status);
      // Fora de condicional a peça deixa de pertencer à maleta de um pedido
      if (status !== undefined && status !== 'CONDICIONAL') fields.push('pedido_condicional_id = NULL');
      addField('disponibilidade', disponibilidade);
      addField('formato', formato);
      addField('estilo', estilo);
      addField('cor_armacao', cor_armacao);
      if (req.body.fornecedor !== undefined) addField('fornecedor', textoCurto(req.body.fornecedor, 120));
      if (req.body.codigo_fornecedor !== undefined) addField('codigo_fornecedor', textoCurto(req.body.codigo_fornecedor, 100));
      if (req.body.link_fornecedor !== undefined) addField('link_fornecedor', linkFornecedor);
      // addField pula undefined, mas null (medida apagada) precisa entrar
      for (const [campo, valor] of Object.entries(espec)) {
        fields.push(`${campo} = $${paramCount++}`);
        values.push(valor);
      }

      if (fields.length === 0 && !mexeNasFotos) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Nenhum campo para atualizar' });
      }

      // Lê as fotos atuais para montar a nova lista e apagar as que saírem (FOR UPDATE trava a linha até o COMMIT)
      const anterior = await client.query(`SELECT imagem_url, fotos FROM produtos WHERE id = $1 FOR UPDATE`, [id]);
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
        const novas = [];
        for (let i = 0; i < MAX_FOTOS; i++) {
          if (enviadas[i]) novas.push(await salvarImagem(client, enviadas[i]));
          else if (base[i] && !novas.includes(base[i])) novas.push(base[i]);
        }
        removidas = atuais.filter((url) => !novas.includes(url));
        addField('fotos', novas);
        addField('imagem_url', novas[0] || null);
      }

      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const query = `UPDATE produtos SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
      const result = await client.query(query, values);

      const idsRemovidos = removidas.map(idDaImagem).filter(Boolean);
      if (idsRemovidos.length) await client.query(`DELETE FROM imagens WHERE id = ANY($1)`, [idsRemovidos]);

      await client.query('COMMIT');
      res.json(result.rows[0]);
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
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
      client = await pool.connect();
      const existentes = await client.query(
        `SELECT lower(codigo_sku) AS sku, lower(fornecedor) AS fornecedor, lower(codigo_fornecedor) AS codigo
         FROM produtos
         WHERE lower(codigo_sku) = ANY($1) OR (codigo_fornecedor <> '' AND lower(codigo_fornecedor) = ANY($2))`,
        [produtos.map((p) => p.codigo_sku.toLowerCase()), produtos.map((p) => p.codigo_fornecedor.toLowerCase()).filter(Boolean)]
      );
      const duplicados = encontrarDuplicadosLote(produtos, existentes.rows);
      const ignorados = [];
      const novos = [];
      produtos.forEach((p, i) => {
        const dup = duplicados.get(i);
        if (dup) ignorados.push({ linha: i, codigo_sku: p.codigo_sku, codigo_fornecedor: p.codigo_fornecedor, ...dup });
        else novos.push([i, p]);
      });

      await client.query('BEGIN');
      const criados = [];
      for (const [i, p] of novos) {
        // ON CONFLICT cobre outro cadastro do mesmo SKU entre a checagem e o INSERT
        const r = await client.query(
          `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, status, disponibilidade, formato, estilo, cor_armacao, fornecedor, codigo_fornecedor, link_fornecedor,
                                 diametro_cm, ponte_cm, largura_total_cm, material, tipo, nome_curto)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           ON CONFLICT (codigo_sku) DO NOTHING
           RETURNING *`,
          [p.nome, p.codigo_sku, p.preco_custo, p.preco_venda, p.status, p.disponibilidade, p.formato, p.estilo, p.cor_armacao, p.fornecedor, p.codigo_fornecedor, p.link_fornecedor,
            p.diametro_cm, p.ponte_cm, p.largura_total_cm, p.material, p.tipo, p.nome_curto]
        );
        if (!r.rows.length) {
          ignorados.push({ linha: i, codigo_sku: p.codigo_sku, codigo_fornecedor: p.codigo_fornecedor, campo: 'codigo_sku', motivo: 'SKU já cadastrado' });
          continue;
        }
        await registrarCompraCadastro(client, r.rows[0]);
        criados.push(r.rows[0]);
      }
      await client.query('COMMIT');
      ignorados.sort((a, b) => a.linha - b.linha);
      res.status(criados.length ? 201 : 200).json({ produtos: criados, ignorados });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao cadastrar produtos' });
    } finally {
      if (client) client.release();
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
      const { rows } = await pool.query(
        `SELECT id, fornecedor, preco_custo, quantidade, origem, to_char(data_compra, 'YYYY-MM-DD') AS data_compra, created_at
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

  // Registra uma reposição: custo unitário pago, quantidade e data (padrão hoje).
  // O custo do produto passa a ser o da compra mais recente; com reativar=true
  // um produto ESGOTADO volta a DISPONIVEL.
  async function handleCreateCompra(req, res) {
    const id = idProduto(req.params.id);
    if (!id) return res.status(404).json({ error: 'Produto não encontrado' });
    const b = req.body || {};
    const custo = lerPrecoLote(b.preco_custo);
    if (!Number.isFinite(custo) || custo < 0 || custo >= 1e8) return res.status(400).json({ error: 'Custo inválido' });
    const quantidade = b.quantidade === undefined || b.quantidade === '' ? 1 : Number(b.quantidade);
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 100000) return res.status(400).json({ error: 'Quantidade inválida' });
    let data = null;
    if (b.data_compra !== undefined && b.data_compra !== '') {
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b.data_compra));
      const dt = d && new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
      if (!d || dt.getUTCMonth() !== +d[2] - 1 || dt.getUTCDate() !== +d[3] || +d[1] < 2000) {
        return res.status(400).json({ error: 'Data inválida' });
      }
      data = b.data_compra;
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const prod = await client.query('SELECT id, fornecedor, status FROM produtos WHERE id = $1 FOR UPDATE', [id]);
      if (!prod.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Produto não encontrado' });
      }
      const compra = await client.query(
        `INSERT INTO compras_fornecedor (produto_id, fornecedor, preco_custo, quantidade, origem, data_compra)
         VALUES ($1, $2, $3, $4, 'REPOSICAO', COALESCE($5::date, CURRENT_DATE))
         RETURNING id, fornecedor, preco_custo, quantidade, origem, to_char(data_compra, 'YYYY-MM-DD') AS data_compra, created_at`,
        [id, prod.rows[0].fornecedor, custo, quantidade, data]
      );
      const produto = await client.query(
        `UPDATE produtos SET
           preco_custo = (SELECT preco_custo FROM compras_fornecedor WHERE produto_id = $1 ORDER BY data_compra DESC, id DESC LIMIT 1),
           status = CASE WHEN $2 AND status = 'ESGOTADO' THEN 'DISPONIVEL' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [id, b.reativar === true]
      );
      await client.query('COMMIT');
      res.status(201).json({ compra: compra.rows[0], produto: produto.rows[0] });
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
      const { rows } = await pool.query(
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

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE produtos
         SET vezes_em_maleta = vezes_em_maleta + 1
         WHERE id = ANY($1)
         RETURNING id, nome, codigo_sku, preco_venda, disponibilidade, vezes_em_maleta`,
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
          `INSERT INTO pedidos (cliente_id, nome, telefone, email, endereco, itens, total_prova, total_compra, total_encomendas, sinal, total)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, status`,
          [dono[0] ? dono[0].id : null, p.nome, p.telefone, dono[0] ? dono[0].email : '', p.endereco,
            JSON.stringify(p.itens), p.totalProva, p.totalCompra, p.totalEncomendas, p.sinal, p.total]
        );
        pedido = { id: rows[0].id, status: rows[0].status };
      }

      await client.query('COMMIT');
      res.json({
        atualizados: result.rows.map(r => ({ id: r.id, nome: r.nome, vezes_em_maleta: r.vezes_em_maleta })),
        pedido,
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao processar checkout da maleta' });
    } finally {
      if (client) client.release();
    }
  }

  // Admin: clientes com resumo dos pedidos (nunca devolve senha_hash)
  async function handleListClientes(req, res) {
    try {
      const { rows } = await pool.query(
        `SELECT c.id, c.email, c.nome, c.created_at,
                COUNT(p.id)::int AS pedidos,
                COALESCE(SUM(p.total), 0) AS total_pedidos,
                MAX(p.created_at) AS ultimo_pedido
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
      const { rows } = await pool.query(
        `SELECT p.id, p.cliente_id, p.nome, p.telefone, p.email, p.endereco, p.itens, p.status,
                p.total_prova, p.total_compra, p.total_encomendas, p.sinal, p.total, p.maleta_enviada_em, p.created_at,
                p.itens_removidos, p.extras, p.desconto_tipo, p.desconto_valor, p.total_final, p.entregue_em, p.updated_at,
                COALESCE(ac.vendidos, '{}') AS vendidos_acerto, COALESCE(ac.devolvidos, '{}') AS devolvidos_acerto
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
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar pedidos' });
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
      client = await pool.connect();
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

      const enviados = (await client.query(
        `UPDATE produtos SET status = 'CONDICIONAL', pedido_condicional_id = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) AND status = 'DISPONIVEL'
         RETURNING id`,
        [ids, pedidoId]
      )).rows.map((r) => r.id);
      const naMaleta = (await client.query(
        `SELECT id FROM produtos WHERE id = ANY($1) AND status = 'CONDICIONAL' AND pedido_condicional_id = $2`,
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
      `SELECT id FROM produtos WHERE status = 'CONDICIONAL' AND pedido_condicional_id = $1`, [pedidoId]);
    return rows.length;
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
      client = await pool.connect();
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
      client = await pool.connect();
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
          continue; // acessório apagado do banco: só sai do pedido
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
          const baixados = (await client.query(
            `UPDATE produtos SET status = 'ESGOTADO', pedido_condicional_id = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ANY($1) AND (status = 'DISPONIVEL' OR (status = 'CONDICIONAL' AND pedido_condicional_id = $2))
             RETURNING id`,
            [levar, pedidoId]
          )).rows.map(r => r.id);
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
      const { rows } = await pool.query(
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
      const { rows } = await pool.query(
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
      const { rows } = await pool.query(
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
            const found = await pool.query(`SELECT id FROM produtos WHERE codigo_sku = $1`, [sku]);
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
      client = await pool.connect();
      await client.query('BEGIN');

      // Só produtos em CONDICIONAL participam do acerto: evita que um produto
      // já vendido (ESGOTADO) volte para DISPONIVEL por engano.
      let vendidos = [];
      let totalCentavos = 0;
      if (comprados.length > 0) {
        const r = await client.query(
          `UPDATE produtos SET status = 'ESGOTADO', pedido_condicional_id = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ANY($1) AND status = 'CONDICIONAL'
           RETURNING id, preco_venda`,
          [comprados]
        );
        vendidos = r.rows.map((row) => row.id);
        totalCentavos = r.rows.reduce((t, row) => t + Math.round(Number(row.preco_venda) * 100), 0);
      }

      let retornados = [];
      if (devolvidos.length > 0) {
        const r = await client.query(
          `UPDATE produtos SET status = 'DISPONIVEL', pedido_condicional_id = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ANY($1) AND status = 'CONDICIONAL'
           RETURNING id`,
          [devolvidos]
        );
        retornados = r.rows.map((row) => row.id);
      }

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
      const result = await pool.query(
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
      const result = await pool.query(
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
      await pool.query(
        `INSERT INTO configuracoes (chave, valor) VALUES ('whatsapp_number', $1)
         ON CONFLICT (chave) DO UPDATE SET valor = $1`,
        [whatsapp]
      );
      res.json({ sucesso: true, success: true, whatsapp, valor: whatsapp });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao salvar configuração' });
    }
  }

  async function handleMetrics(req, res) {
    try {
      const totalEstoque = await pool.query(
        `SELECT COUNT(*) as total FROM produtos WHERE status IN ('DISPONIVEL', 'CONDICIONAL')`
      );

      const valorInvestido = await pool.query(
        `SELECT COALESCE(SUM(preco_custo), 0) as total FROM produtos WHERE status IN ('DISPONIVEL', 'CONDICIONAL')`
      );

      const lucroPotencial = await pool.query(
        `SELECT COALESCE(SUM(preco_venda - preco_custo), 0) as total FROM produtos WHERE status IN ('DISPONIVEL', 'CONDICIONAL')`
      );

      const valorEmRua = await pool.query(
        `SELECT COALESCE(SUM(preco_venda), 0) as total FROM produtos WHERE status = 'CONDICIONAL'`
      );

      const topMaleta = await pool.query(
        `SELECT id, nome, codigo_sku, vezes_em_maleta, imagem_url
         FROM produtos
         WHERE vezes_em_maleta > 0
         ORDER BY vezes_em_maleta DESC
         LIMIT 10`
      );

      res.json({
        totalEstoque: parseInt(totalEstoque.rows[0].total),
        valorInvestido: parseFloat(valorInvestido.rows[0].total),
        lucroPotencial: parseFloat(lucroPotencial.rows[0].total),
        valorEmRua: parseFloat(valorEmRua.rows[0].total),
        topAdicionadosMaleta: topMaleta.rows,
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
      const result = await pool.query(`SELECT mime_type, dados FROM imagens WHERE id = $1`, [req.params.id]);
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

  // ---------- Login admin (público; demais /api/admin exigem Bearer) ----------
  app.post('/api/admin/login', handleLogin);
  app.get('/api/admin/status', (req, res) => {
    res.json({ authEnabled: isAdminAuthEnabled() });
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
  app.get('/api/admin/produtos', requireAdmin, handleListAdmin);
  app.post('/api/admin/produtos/lote', requireAdmin, handleCreateLote);
  app.post('/api/admin/importar-url', requireAdmin, handleImportarUrl);
  app.get('/api/admin/produtos/:id/compras', requireAdmin, handleListCompras);
  app.post('/api/admin/produtos/:id/compras', requireAdmin, handleCreateCompra);
  app.get('/api/admin/fornecedores/reposicao', requireAdmin, handleResumoFornecedores);
  app.post('/api/produtos', requireAdmin, uploadImagem, handleCreateProduto);
  app.put('/api/produtos/:id', requireAdmin, uploadImagem, handleUpdateProduto);
  app.post('/api/admin/acerto', requireAdmin, handleAcerto);
  app.get('/api/admin/acertos', requireAdmin, handleListAcertos);
  app.post('/api/config/whatsapp', requireAdmin, handlePostWhatsapp);
  app.post('/api/admin/whatsapp', requireAdmin, handlePostWhatsapp);
  app.get('/api/admin/metrics', requireAdmin, handleMetrics);
  app.get('/api/admin/clientes', requireAdmin, handleListClientes);
  app.get('/api/admin/pedidos', requireAdmin, handleListPedidos);
  app.post('/api/admin/pedidos/:id/enviar-maleta', requireAdmin, handleEnviarMaleta);
  app.patch('/api/admin/pedidos/:id/status', requireAdmin, handleStatusPedido);
  app.put('/api/admin/pedidos/:id/fechamento', requireAdmin, handleFechamentoPedido);
  app.get('/api/admin/acessorios', requireAdmin, handleListAcessorios);
  app.post('/api/admin/acessorios', requireAdmin, handleCreateAcessorio);
  app.put('/api/admin/acessorios/:id', requireAdmin, handleUpdateAcessorio);

  // ---------- Aliases EN (compatibilidade front-end em inglês) ----------
  app.get('/api/products', handleListPublicos);
  app.get('/api/admin/products', requireAdmin, handleListAdmin);
  app.post('/api/products', requireAdmin, uploadImagem, handleCreateProduto);
  app.post('/api/admin/products', requireAdmin, uploadImagem, handleCreateProduto);
  app.put('/api/products/:id', requireAdmin, uploadImagem, handleUpdateProduto);
  app.put('/api/admin/products/:id', requireAdmin, uploadImagem, handleUpdateProduto);

  // admin/acerto.html usa /api/admin/products/conditional
  app.get('/api/admin/products/conditional', requireAdmin, handleListConditional);
  app.get('/api/admin/produtos/condicional', requireAdmin, handleListConditional);
  app.get('/api/produtos/condicional', requireAdmin, handleListConditional);

  // Métricas / popularidade
  app.get('/api/admin/popularity', requireAdmin, handleMetrics);
  app.get('/api/admin/popularidade', requireAdmin, handleMetrics);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}

startServer().catch(console.error);

module.exports = app;
