const { Pool } = require('pg');
require('dotenv').config();

// Neon DB exige SSL. O driver `pg` não suporta `channel_binding=require` na
// connection string (gera aviso no console), então removemos esse parâmetro
// aqui e ativamos SSL via opção `ssl`, mantendo `sslmode=require` no .env.
function buildConnectionString() {
  let cs = process.env.DATABASE_URL || '';
  // Remove channel_binding=require / prefer / disable para evitar warning do pg
  cs = cs.replace(/[?&]channel_binding=[^&]*/g, (m) => (m.startsWith('?') ? '?' : ''));
  cs = cs.replace(/\?&/, '?').replace(/\?$/, '').replace(/&&+/g, '&');
  return cs;
}

function shouldUseSSL() {
  const cs = process.env.DATABASE_URL || '';
  if (process.env.NODE_ENV === 'production') return true;
  if (cs.includes('neon.tech')) return true;
  if (cs.includes('sslmode=require')) return true;
  return false;
}

const pool = new Pool({
  connectionString: buildConnectionString(),
  ssl: shouldUseSSL() ? { rejectUnauthorized: false } : false,
});

async function initTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS produtos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        codigo_sku VARCHAR(100) UNIQUE NOT NULL,
        preco_custo DECIMAL(10,2) NOT NULL DEFAULT 0,
        preco_venda DECIMAL(10,2) NOT NULL DEFAULT 0,
        imagem_url TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'DISPONIVEL',
        formato VARCHAR(100),
        estilo VARCHAR(100),
        cor_armacao VARCHAR(100),
        vezes_em_maleta INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Disponibilidade: PRONTA_ENTREGA (estoque) ou SOB_ENCOMENDA (50% de sinal).
    // Produtos já cadastrados ficam como pronta entrega.
    await client.query(`
      ALTER TABLE produtos
      ADD COLUMN IF NOT EXISTS disponibilidade VARCHAR(20) NOT NULL DEFAULT 'PRONTA_ENTREGA'
    `);

    // Controle de estoque: de qual fornecedor o produto veio e o código dele lá.
    await client.query(`
      ALTER TABLE produtos
      ADD COLUMN IF NOT EXISTS fornecedor VARCHAR(120) NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS codigo_fornecedor VARCHAR(100) NOT NULL DEFAULT ''
    `);

    // Link do produto na loja do fornecedor (só http/https, conferido no servidor).
    await client.query(`
      ALTER TABLE produtos
      ADD COLUMN IF NOT EXISTS link_fornecedor VARCHAR(1000) NOT NULL DEFAULT ''
    `);

    // Histórico de compras/reposições de cada produto (custo unitário pago ao fornecedor).
    // origem: CADASTRO (custo informado ao cadastrar) ou REPOSICAO (registrada no painel).
    await client.query(`
      CREATE TABLE IF NOT EXISTS compras_fornecedor (
        id SERIAL PRIMARY KEY,
        produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
        fornecedor VARCHAR(120) NOT NULL DEFAULT '',
        preco_custo DECIMAL(10,2) NOT NULL,
        quantidade INTEGER NOT NULL DEFAULT 1,
        origem VARCHAR(20) NOT NULL DEFAULT 'REPOSICAO',
        data_compra DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS compras_produto_idx ON compras_fornecedor (produto_id, data_compra DESC, id DESC)');
    // Produtos cadastrados antes do histórico: o custo atual vira a compra do cadastro.
    await client.query(`
      INSERT INTO compras_fornecedor (produto_id, fornecedor, preco_custo, quantidade, origem, data_compra)
      SELECT p.id, p.fornecedor, p.preco_custo, 1, 'CADASTRO', COALESCE(p.created_at::date, CURRENT_DATE)
      FROM produtos p
      WHERE NOT EXISTS (SELECT 1 FROM compras_fornecedor c WHERE c.produto_id = p.id)
    `);

    // Até 4 fotos por produto (URLs /imagens/<id>, na ordem de exibição).
    // imagem_url continua sendo a 1ª foto, para quem só lê uma (métricas, acerto, maleta).
    // Produtos antigos: a foto única vira a foto 1.
    await client.query(`
      ALTER TABLE produtos
      ADD COLUMN IF NOT EXISTS fotos TEXT[] NOT NULL DEFAULT '{}'
    `);
    await client.query(`
      UPDATE produtos SET fotos = ARRAY[imagem_url]
      WHERE cardinality(fotos) = 0 AND imagem_url IS NOT NULL AND imagem_url <> ''
    `);

    // Fotos dos produtos ficam no próprio Postgres: o disco do Render Free é
    // apagado a cada deploy/restart, então /uploads não serve para guardar nada.
    await client.query(`
      CREATE TABLE IF NOT EXISTS imagens (
        id VARCHAR(32) PRIMARY KEY,
        mime_type VARCHAR(50) NOT NULL,
        dados BYTEA NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Histórico de acertos de condicional (produtos vendidos/devolvidos e observações)
    await client.query(`
      CREATE TABLE IF NOT EXISTS acertos (
        id SERIAL PRIMARY KEY,
        comprados INTEGER[] NOT NULL DEFAULT '{}',
        devolvidos INTEGER[] NOT NULL DEFAULT '{}',
        observacoes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Contas de clientes da vitrine (e-mail + senha com scrypt). E-mail sempre minúsculo.
    await client.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        id SERIAL PRIMARY KEY,
        email VARCHAR(254) UNIQUE NOT NULL,
        nome VARCHAR(100) NOT NULL DEFAULT '',
        senha_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Pedidos finalizados na vitrine (o pedido em si segue pelo WhatsApp).
    // Preços e encomenda/pronta entrega vêm do banco na hora do checkout e ficam
    // congelados em `itens`. cliente_id só quando o cliente estava logado.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
        nome VARCHAR(100) NOT NULL DEFAULT '',
        telefone VARCHAR(30) NOT NULL DEFAULT '',
        email VARCHAR(254) NOT NULL DEFAULT '',
        endereco TEXT NOT NULL DEFAULT '',
        itens JSONB NOT NULL DEFAULT '[]',
        total_prova DECIMAL(10,2) NOT NULL DEFAULT 0,
        total_encomendas DECIMAL(10,2) NOT NULL DEFAULT 0,
        sinal DECIMAL(10,2) NOT NULL DEFAULT 0,
        total DECIMAL(10,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS pedidos_cliente_idx ON pedidos (cliente_id, created_at DESC)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS configuracoes (
        chave VARCHAR(100) PRIMARY KEY,
        valor TEXT NOT NULL
      )
    `);

    await client.query(`
      INSERT INTO configuracoes (chave, valor)
      VALUES ('whatsapp_number', '')
      ON CONFLICT (chave) DO NOTHING
    `);

    console.log('Tabelas inicializadas com sucesso');
  } catch (err) {
    console.error('Erro ao inicializar tabelas:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initTables };