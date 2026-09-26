require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const { pool, initTables } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// Serve front-end estático (site público + admin) — necessário no Render
app.use(express.static(__dirname));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

// Sanitiza número de WhatsApp: remove tudo que não for dígito
function sanitizeWhatsapp(num) {
  if (typeof num !== 'string') return '';
  return num.replace(/\D/g, '');
}

async function startServer() {
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
    const imagem_url = req.file ? `/uploads/${req.file.filename}` : null;

    try {
      const result = await pool.query(
        `INSERT INTO produtos (nome, codigo_sku, preco_custo, preco_venda, imagem_url, formato, estilo, cor_armacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [nome, codigoFinal, preco_custo, preco_venda, imagem_url, formato, estilo, cor_armacao]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error(err);
      if (err.code === '23505') {
        return res.status(400).json({ error: 'SKU já cadastrado' });
      }
      res.status(500).json({ error: 'Erro ao cadastrar produto' });
    }
  }

  async function handleUpdateProduto(req, res) {
    const { id } = req.params;
    const { nome, codigo_sku, sku, preco_custo, preco_venda, status, formato, estilo, cor_armacao } = req.body;
    const codigoFinal = codigo_sku !== undefined ? codigo_sku : sku;
    const imagem_url = req.file ? `/uploads/${req.file.filename}` : undefined;

    try {
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
        return res.status(400).json({ error: 'Nenhum campo para atualizar' });
      }

      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const query = `UPDATE produtos SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Produto não encontrado' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      if (err.code === '23505') {
        return res.status(400).json({ error: 'SKU já cadastrado' });
      }
      res.status(500).json({ error: 'Erro ao atualizar produto' });
    }
  }

  async function handleMaletaCheckout(req, res) {
    const { produtoIds, productIds, ids } = req.body;
    const list = produtoIds || productIds || ids;

    if (!Array.isArray(list) || list.length === 0) {
      return res.status(400).json({ error: 'Array de IDs de produtos é obrigatório' });
    }

    try {
      await pool.query('BEGIN');

      const result = await pool.query(
        `UPDATE produtos
         SET vezes_em_maleta = vezes_em_maleta + 1
         WHERE id = ANY($1)
         RETURNING id, nome, vezes_em_maleta`,
        [list]
      );

      await pool.query('COMMIT');
      res.json({ atualizados: result.rows });
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Erro ao processar checkout da maleta' });
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

    try {
      await pool.query('BEGIN');

      if (Array.isArray(comprados) && comprados.length > 0) {
        await pool.query(
          `UPDATE produtos SET status = 'ESGOTADO', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1)`,
          [comprados]
        );
      }

      if (Array.isArray(devolvidos) && devolvidos.length > 0) {
        await pool.query(
          `UPDATE produtos SET status = 'DISPONIVEL', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1)`,
          [devolvidos]
        );
      }

      await pool.query('COMMIT');
      res.json({ sucesso: true, success: true });
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Erro ao processar acerto' });
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

  // ---------- Rotas PT (originais) ----------
  app.get('/api/produtos', handleListPublicos);
  app.get('/api/admin/produtos', handleListAdmin);
  app.post('/api/produtos', upload.single('imagem'), handleCreateProduto);
  app.put('/api/produtos/:id', upload.single('imagem'), handleUpdateProduto);
  app.post('/api/maleta/checkout', handleMaletaCheckout);
  app.post('/api/admin/acerto', handleAcerto);
  app.get('/api/config/whatsapp', handleGetWhatsapp);
  app.post('/api/config/whatsapp', handlePostWhatsapp);
  app.get('/api/admin/metrics', handleMetrics);

  // ---------- Aliases EN (compatibilidade front-end em inglês) ----------
  app.get('/api/products', handleListPublicos);
  app.get('/api/admin/products', handleListAdmin);
  app.post('/api/products', upload.single('imagem'), handleCreateProduto);
  app.post('/api/admin/products', upload.single('imagem'), handleCreateProduto);
  app.put('/api/products/:id', upload.single('imagem'), handleUpdateProduto);
  app.put('/api/admin/products/:id', upload.single('imagem'), handleUpdateProduto);

  // admin/acerto.html usa /api/admin/products/conditional
  app.get('/api/admin/products/conditional', handleListConditional);
  app.get('/api/admin/produtos/condicional', handleListConditional);
  app.get('/api/produtos/condicional', handleListConditional);

  // Métricas / popularidade
  app.get('/api/admin/popularity', handleMetrics);
  app.get('/api/admin/popularidade', handleMetrics);

  // WhatsApp aliases
  app.get('/api/admin/whatsapp', handleGetWhatsapp);
  app.post('/api/admin/whatsapp', handlePostWhatsapp);

  // Checkout alias EN
  app.post('/api/case/checkout', handleMaletaCheckout);

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}

startServer().catch(console.error);

module.exports = app;
