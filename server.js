require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const { pool, initTables } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
// Serve front-end estático (site público + admin) — necessário no Render.
// Só arquivos da lista abaixo saem da raiz: server.js, db.js, .env, package*.json,
// node_modules/ e scripts/ NUNCA podem ser servidos.
const PUBLIC_ROOT_FILES = new Set(['index.html', 'logo.png', 'favicon.ico', 'robots.txt']);
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
    preco_custo: lerPrecoLote(l.preco_custo),
    preco_venda: lerPrecoLote(l.preco_venda),
    status: l.status || 'DISPONIVEL',
    disponibilidade: l.disponibilidade || 'PRONTA_ENTREGA',
    formato: textoCurto(l.formato, 100) || null,
    estilo: textoCurto(l.estilo, 100) || null,
    cor_armacao: textoCurto(l.cor_armacao, 100) || null,
  };
  if (!produto.nome) erros.push({ campo: 'nome', mensagem: 'Informe o nome' });
  if (!produto.codigo_sku) erros.push({ campo: 'codigo_sku', mensagem: 'Informe o SKU' });
  for (const campo of ['preco_custo', 'preco_venda']) {
    const v = produto[campo];
    if (!Number.isFinite(v) || v < 0 || v >= 1e8) erros.push({ campo, mensagem: 'Preço inválido' });
  }
  if (!STATUS_PRODUTO.includes(produto.status)) erros.push({ campo: 'status', mensagem: 'Status inválido' });
  if (!DISPONIBILIDADES_PRODUTO.includes(produto.disponibilidade)) erros.push({ campo: 'disponibilidade', mensagem: 'Disponibilidade inválida' });
  return { produto, erros };
}

// Monta o pedido a partir das linhas de produtos do banco (preço e encomenda
// nunca vêm do navegador). Sinal = 50% por item, arredondado como na vitrine.
function montarPedido(produtos, contato) {
  const c = contato && typeof contato === 'object' ? contato : {};
  const centavos = v => Math.round(Number(v) * 100);
  const itens = produtos.map(p => {
    const encomenda = p.disponibilidade === 'SOB_ENCOMENDA';
    const preco = centavos(p.preco_venda) / 100;
    return { produto_id: p.id, nome: p.nome, codigo_sku: p.codigo_sku, preco, encomenda, sinal: encomenda ? Math.round(preco * 50) / 100 : 0 };
  });
  const soma = (lista, campo) => lista.reduce((t, i) => t + centavos(i[campo]), 0) / 100;
  const prova = itens.filter(i => !i.encomenda);
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
    totalEncomendas: soma(encomendas, 'preco'),
    sinal: soma(encomendas, 'sinal'),
    total: soma(itens, 'preco'),
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
        `SELECT id, nome, codigo_sku, preco_venda, imagem_url, fotos, status, disponibilidade, formato, estilo, cor_armacao
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

  async function handleListAdmin(req, res) {
    try {
      const result = await pool.query(
        `SELECT id, nome, codigo_sku, preco_custo, preco_venda, imagem_url, fotos, status, disponibilidade, formato, estilo, cor_armacao, fornecedor, codigo_fornecedor, vezes_em_maleta
         FROM produtos
         ORDER BY created_at DESC`
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
        `SELECT id, nome, codigo_sku, preco_custo, preco_venda, imagem_url, fotos, status, disponibilidade, formato, estilo, cor_armacao, fornecedor, codigo_fornecedor, vezes_em_maleta
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
    const disponibilidade = req.body.disponibilidade || 'PRONTA_ENTREGA';
    if (!DISPONIBILIDADES.includes(disponibilidade)) {
      return res.status(400).json({ error: 'Disponibilidade inválida' });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const fotos = [];
      for (const file of req.fotosEnviadas || []) {
        if (file) fotos.push(await salvarImagem(client, file));
      }
      const result = await client.query(
        `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, imagem_url, fotos, disponibilidade, formato, estilo, cor_armacao, fornecedor, codigo_fornecedor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [nome, codigoFinal, preco_custo, preco_venda, fotos[0] || null, fotos, disponibilidade, formato, estilo, cor_armacao, fornecedor, codigoFornecedor]
      );
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
      addField('disponibilidade', disponibilidade);
      addField('formato', formato);
      addField('estilo', estilo);
      addField('cor_armacao', cor_armacao);
      if (req.body.fornecedor !== undefined) addField('fornecedor', textoCurto(req.body.fornecedor, 120));
      if (req.body.codigo_fornecedor !== undefined) addField('codigo_fornecedor', textoCurto(req.body.codigo_fornecedor, 100));

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
  // Tudo ou nada: se alguma linha tiver erro, nada é gravado e a resposta diz
  // qual linha (índice a partir de 0) e qual campo corrigir.
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

    const vistos = new Map();
    produtos.forEach((p, i) => {
      if (!p.codigo_sku) return;
      const chave = p.codigo_sku.toLowerCase();
      if (vistos.has(chave)) erros.push({ linha: i, campo: 'codigo_sku', mensagem: `SKU repetido na linha ${vistos.get(chave) + 1}` });
      else vistos.set(chave, i);
    });

    let client;
    try {
      client = await pool.connect();
      const skus = produtos.map((p) => p.codigo_sku).filter(Boolean);
      const existentes = await client.query('SELECT codigo_sku FROM produtos WHERE codigo_sku = ANY($1)', [skus]);
      const jaCadastrados = new Set(existentes.rows.map((r) => r.codigo_sku));
      produtos.forEach((p, i) => {
        if (jaCadastrados.has(p.codigo_sku)) erros.push({ linha: i, campo: 'codigo_sku', mensagem: 'SKU já cadastrado' });
      });

      if (erros.length) {
        erros.sort((a, b) => a.linha - b.linha);
        return res.status(400).json({ error: 'Corrija as linhas marcadas', erros });
      }

      await client.query('BEGIN');
      const criados = [];
      for (const p of produtos) {
        const r = await client.query(
          `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, status, disponibilidade, formato, estilo, cor_armacao, fornecedor, codigo_fornecedor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [p.nome, p.codigo_sku, p.preco_custo, p.preco_venda, p.status, p.disponibilidade, p.formato, p.estilo, p.cor_armacao, p.fornecedor, p.codigo_fornecedor]
        );
        criados.push(r.rows[0]);
      }
      await client.query('COMMIT');
      res.status(201).json({ produtos: criados });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      if (err.code === '23505') {
        return res.status(400).json({ error: 'SKU já cadastrado' });
      }
      res.status(500).json({ error: 'Erro ao cadastrar produtos' });
    } finally {
      if (client) client.release();
    }
  }

  async function handleMaletaCheckout(req, res) {
    const { produtoIds, productIds, ids, contato } = req.body || {};
    const list = produtoIds || productIds || ids;

    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ITENS_PEDIDO) {
      return res.status(400).json({ error: 'Array de IDs de produtos é obrigatório' });
    }
    if (!list.every(id => (Number.isInteger(id) && id > 0 && id < 2 ** 31) || (typeof id === 'string' && /^\d{1,9}$/.test(id) && Number(id) > 0))) {
      return res.status(400).json({ error: 'IDs de produtos inválidos' });
    }
    const idsOk = [...new Set(list.map(Number))];
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
        const p = montarPedido(linhas, contato);
        const { rows } = await client.query(
          `INSERT INTO pedidos (cliente_id, nome, telefone, email, endereco, itens, total_prova, total_encomendas, sinal, total)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [dono[0] ? dono[0].id : null, p.nome, p.telefone, dono[0] ? dono[0].email : '', p.endereco,
            JSON.stringify(p.itens), p.totalProva, p.totalEncomendas, p.sinal, p.total]
        );
        pedido = { id: rows[0].id };
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
  async function handleListPedidos(req, res) {
    const filtro = req.query.cliente;
    let where = '';
    const params = [];
    if (filtro === 'sem-conta') {
      where = 'WHERE p.cliente_id IS NULL';
    } else if (filtro !== undefined) {
      if (typeof filtro !== 'string' || !/^\d{1,9}$/.test(filtro)) return res.status(400).json({ error: 'Cliente inválido' });
      where = 'WHERE p.cliente_id = $1';
      params.push(Number(filtro));
    }
    try {
      const { rows } = await pool.query(
        `SELECT p.id, p.cliente_id, p.nome, p.telefone, p.email, p.endereco, p.itens,
                p.total_prova, p.total_encomendas, p.sinal, p.total, p.created_at
         FROM pedidos p ${where}
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

  async function handleAcerto(req, res) {
    let { comprados, devolvidos, itens, observacoes } = req.body;

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

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      // Só produtos em CONDICIONAL participam do acerto: evita que um produto
      // já vendido (ESGOTADO) volte para DISPONIVEL por engano.
      let vendidos = [];
      if (comprados.length > 0) {
        const r = await client.query(
          `UPDATE produtos SET status = 'ESGOTADO', updated_at = CURRENT_TIMESTAMP
           WHERE id = ANY($1) AND status = 'CONDICIONAL'
           RETURNING id`,
          [comprados]
        );
        vendidos = r.rows.map((row) => row.id);
      }

      let retornados = [];
      if (devolvidos.length > 0) {
        const r = await client.query(
          `UPDATE produtos SET status = 'DISPONIVEL', updated_at = CURRENT_TIMESTAMP
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
        `INSERT INTO acertos (comprados, devolvidos, observacoes) VALUES ($1, $2, $3)`,
        [vendidos, retornados, obs || null]
      );

      await client.query('COMMIT');
      res.json({ sucesso: true, success: true, comprados: vendidos, devolvidos: retornados, ignorados });
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
        `SELECT id, comprados, devolvidos, observacoes, created_at
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
  app.post('/api/produtos', requireAdmin, uploadImagem, handleCreateProduto);
  app.put('/api/produtos/:id', requireAdmin, uploadImagem, handleUpdateProduto);
  app.post('/api/admin/acerto', requireAdmin, handleAcerto);
  app.get('/api/admin/acertos', requireAdmin, handleListAcertos);
  app.post('/api/config/whatsapp', requireAdmin, handlePostWhatsapp);
  app.post('/api/admin/whatsapp', requireAdmin, handlePostWhatsapp);
  app.get('/api/admin/metrics', requireAdmin, handleMetrics);
  app.get('/api/admin/clientes', requireAdmin, handleListClientes);
  app.get('/api/admin/pedidos', requireAdmin, handleListPedidos);

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
