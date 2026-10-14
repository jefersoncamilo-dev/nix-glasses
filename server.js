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

function detectarTipoImagem(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANHO_MAX_IMAGEM, files: 1 },
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

// Converte erros do upload em 400 com JSON (o admin mostra err.error no toast)
function uploadImagem(req, res, next) {
  upload.single('imagem')(req, res, (err) => {
    if (!err) {
      if (!req.file) return next();
      req.file.tipoDetectado = detectarTipoImagem(req.file.buffer);
      if (!req.file.tipoDetectado) {
        return res.status(400).json({ error: 'Arquivo não é uma imagem JPG, PNG ou WEBP válida.' });
      }
      return next();
    }
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `Imagem muito grande (máximo ${TAMANHO_MAX_IMAGEM / 1024 / 1024} MB)`
        : 'Upload inválido';
      return res.status(400).json({ error: msg });
    }
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  });
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

async function startServer() {
  if (!isAdminAuthEnabled()) {
    console.warn('[auth] ADMIN_USER/ADMIN_PASS_HASH não definidos: rotas admin ficarão bloqueadas (503).');
  }
  await initTables();

  // ---------- Handlers reutilizáveis ----------

  async function handleListPublicos(req, res) {
    try {
      const result = await pool.query(
        `SELECT id, nome, codigo_sku, preco_venda, imagem_url, status, formato, estilo, cor_armacao
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
        `SELECT id, nome, codigo_sku, preco_custo, preco_venda, imagem_url, status, formato, estilo, cor_armacao, vezes_em_maleta
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
        `SELECT id, nome, codigo_sku, preco_custo, preco_venda, imagem_url, status, formato, estilo, cor_armacao, vezes_em_maleta
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

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const imagem_url = req.file ? await salvarImagem(client, req.file) : null;
      const result = await client.query(
        `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, imagem_url, formato, estilo, cor_armacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [nome, codigoFinal, preco_custo, preco_venda, imagem_url, formato, estilo, cor_armacao]
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
    const { nome, codigo_sku, sku, preco_custo, preco_venda, status, formato, estilo, cor_armacao } = req.body;
    const codigoFinal = codigo_sku !== undefined ? codigo_sku : sku;

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const imagem_url = req.file ? await salvarImagem(client, req.file) : undefined;

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
      addField('formato', formato);
      addField('estilo', estilo);
      addField('cor_armacao', cor_armacao);
      if (imagem_url !== undefined) {
        addField('imagem_url', imagem_url);
      }

      if (fields.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Nenhum campo para atualizar' });
      }

      // Guarda a foto antiga para apagá-la quando for trocada (FOR UPDATE trava a linha até o COMMIT)
      const anterior = await client.query(`SELECT imagem_url FROM produtos WHERE id = $1 FOR UPDATE`, [id]);
      if (anterior.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Produto não encontrado' });
      }

      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const query = `UPDATE produtos SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
      const result = await client.query(query, values);

      const idAntigo = imagem_url !== undefined ? idDaImagem(anterior.rows[0].imagem_url) : null;
      if (idAntigo) await client.query(`DELETE FROM imagens WHERE id = $1`, [idAntigo]);

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

  async function handleMaletaCheckout(req, res) {
    const { produtoIds, productIds, ids } = req.body;
    const list = produtoIds || productIds || ids;

    if (!Array.isArray(list) || list.length === 0) {
      return res.status(400).json({ error: 'Array de IDs de produtos é obrigatório' });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE produtos
         SET vezes_em_maleta = vezes_em_maleta + 1
         WHERE id = ANY($1)
         RETURNING id, nome, vezes_em_maleta`,
        [list]
      );

      await client.query('COMMIT');
      res.json({ atualizados: result.rows });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao processar checkout da maleta' });
    } finally {
      if (client) client.release();
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
  // GET produtos e GET whatsapp precisam ficar abertos para o site público.
  app.get('/api/produtos', handleListPublicos);
  app.get('/imagens/:id', handleGetImagem);
  app.get('/api/config/whatsapp', handleGetWhatsapp);
  app.get('/api/admin/whatsapp', handleGetWhatsapp);
  app.post('/api/maleta/checkout', handleMaletaCheckout);
  app.post('/api/case/checkout', handleMaletaCheckout);

  // ---------- Rotas admin (sempre exigem token; sem ADMIN_USER/ADMIN_PASS_HASH respondem 503) ----------
  app.get('/api/admin/produtos', requireAdmin, handleListAdmin);
  app.post('/api/produtos', requireAdmin, uploadImagem, handleCreateProduto);
  app.put('/api/produtos/:id', requireAdmin, uploadImagem, handleUpdateProduto);
  app.post('/api/admin/acerto', requireAdmin, handleAcerto);
  app.get('/api/admin/acertos', requireAdmin, handleListAcertos);
  app.post('/api/config/whatsapp', requireAdmin, handlePostWhatsapp);
  app.post('/api/admin/whatsapp', requireAdmin, handlePostWhatsapp);
  app.get('/api/admin/metrics', requireAdmin, handleMetrics);

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
