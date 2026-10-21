const { Pool } = require('pg');
require('dotenv').config();

// Neon DB exige SSL. O driver `pg` não suporta `channel_binding=require` na
// connection string (gera aviso no console), então removemos esse parâmetro
// aqui e ativamos SSL via opção `ssl`, mantendo `sslmode=require` no .env.
function buildConnectionString(cs) {
  cs = cs || '';
  // Remove channel_binding=require / prefer / disable para evitar warning do pg
  cs = cs.replace(/[?&]channel_binding=[^&]*/g, (m) => (m.startsWith('?') ? '?' : ''));
  cs = cs.replace(/\?&/, '?').replace(/\?$/, '').replace(/&&+/g, '&');
  return cs;
}

function shouldUseSSL(cs) {
  cs = cs || '';
  if (process.env.NODE_ENV === 'production') return true;
  if (cs.includes('neon.tech')) return true;
  if (cs.includes('sslmode=require')) return true;
  return false;
}

// Um pool por banco: cada empresa tem o seu (ver empresas.js).
function criarPool(databaseUrl) {
  return new Pool({
    connectionString: buildConnectionString(databaseUrl),
    ssl: shouldUseSSL(databaseUrl) ? { rejectUnauthorized: false } : false,
  });
}

async function initTables(pool) {
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

    // Especificações técnicas mostradas ao cliente. Medidas em cm, com uma casa
    // decimal (ex.: diâmetro 5,0); vazio = não informado.
    await client.query(`
      ALTER TABLE produtos
      ADD COLUMN IF NOT EXISTS diametro_cm DECIMAL(4,1),
      ADD COLUMN IF NOT EXISTS ponte_cm DECIMAL(4,1),
      ADD COLUMN IF NOT EXISTS largura_total_cm DECIMAL(4,1),
      ADD COLUMN IF NOT EXISTS material VARCHAR(60) NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS tipo VARCHAR(100) NOT NULL DEFAULT ''
    `);

    // Nome curto mostrado no card da vitrine (ex.: "Hexagonal Dubai"); vazio = usa o nome.
    await client.query(`
      ALTER TABLE produtos
      ADD COLUMN IF NOT EXISTS nome_curto VARCHAR(80) NOT NULL DEFAULT ''
    `);

    // Gênero do produto (MASCULINO, FEMININO, UNISSEX); vazio = não informado.
    await client.query(`
      ALTER TABLE produtos
      ADD COLUMN IF NOT EXISTS genero VARCHAR(10) NOT NULL DEFAULT ''
    `);

    // Loja de roupas: tamanho da peça (P, M, 38...) e o código do modelo (grade) que
    // junta os tamanhos num card só na vitrine. Cada tamanho é um produto com o seu
    // estoque, então maleta, acerto e pedidos seguem iguais. Vazio = sem tamanho.
    await client.query(`
      ALTER TABLE produtos
      ADD COLUMN IF NOT EXISTS tamanho VARCHAR(20) NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS grade VARCHAR(100) NOT NULL DEFAULT ''
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

    // Maleta de um pedido: "Enviar maleta" põe as peças de pronta entrega em
    // CONDICIONAL ligadas ao pedido, e o acerto registra de qual pedido foi.
    await client.query(`
      ALTER TABLE pedidos
      ADD COLUMN IF NOT EXISTS maleta_enviada_em TIMESTAMP
    `);
    await client.query(`
      ALTER TABLE produtos
      ADD COLUMN IF NOT EXISTS pedido_condicional_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL
    `);
    await client.query(`
      ALTER TABLE acertos
      ADD COLUMN IF NOT EXISTS pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL
    `);

    // Pedidos no painel: status (NOVO ao chegar da vitrine) e fechamento na entrega
    // (itens que a cliente desistiu, desconto em R$ ou %, acessórios extras).
    // total_compra: itens marcados como "Compra direta" no carrinho.
    const temEncomendas = (await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'encomendas'`
    )).rows.length > 0;
    const temStatus = (await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'pedidos' AND column_name = 'status'`
    )).rows.length > 0;
    await client.query(`
      ALTER TABLE pedidos
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'NOVO',
      ADD COLUMN IF NOT EXISTS total_compra DECIMAL(10,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS itens_removidos INTEGER[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS extras JSONB NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS desconto_tipo VARCHAR(12) NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS desconto_valor DECIMAL(10,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_final DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS entregue_em TIMESTAMP,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);
    // Só na primeira vez: pedidos que já tiveram maleta enviada estão em andamento
    if (!temStatus) {
      await client.query(`UPDATE pedidos SET status = 'EM_ANDAMENTO' WHERE maleta_enviada_em IS NOT NULL`);
    }
    await client.query('CREATE INDEX IF NOT EXISTS pedidos_status_idx ON pedidos (status, created_at DESC)');

    // Estoque de acessórios (flanelas, estojos, líquidos), contado em unidades.
    // Entram no fechamento do pedido e dão baixa aqui.
    await client.query(`
      CREATE TABLE IF NOT EXISTS acessorios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        preco_venda DECIMAL(10,2) NOT NULL DEFAULT 0,
        estoque INTEGER NOT NULL DEFAULT 0 CHECK (estoque >= 0),
        ativo BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Encomendas de clientes: vêm do checkout (itens sob encomenda), do botão
    // "Encomendar" num pedido ou são lançadas à mão no painel. Os dados do cliente e
    // do produto ficam copiados aqui (o produto pode nem estar cadastrado).
    await client.query(`
      CREATE TABLE IF NOT EXISTS encomendas (
        id SERIAL PRIMARY KEY,
        pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
        produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
        origem VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
        nome_cliente VARCHAR(100) NOT NULL DEFAULT '',
        telefone VARCHAR(30) NOT NULL DEFAULT '',
        modelo VARCHAR(255) NOT NULL DEFAULT '',
        codigo_sku VARCHAR(100) NOT NULL DEFAULT '',
        especificacoes TEXT NOT NULL DEFAULT '',
        valor DECIMAL(10,2) NOT NULL DEFAULT 0,
        sinal_pago DECIMAL(10,2) NOT NULL DEFAULT 0,
        status VARCHAR(30) NOT NULL DEFAULT 'AGUARDANDO_FABRICANTE',
        observacoes TEXT NOT NULL DEFAULT '',
        entregue_em TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS encomendas_status_idx ON encomendas (status, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS encomendas_cliente_idx ON encomendas (cliente_id, created_at DESC)');
    // Um item de pedido vira no máximo uma encomenda
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS encomendas_pedido_produto_idx ON encomendas (pedido_id, produto_id)
      WHERE pedido_id IS NOT NULL AND produto_id IS NOT NULL
    `);
    // Pedidos de antes desta tabela: as encomendas deles entram uma vez, na criação
    if (!temEncomendas) {
      await client.query(`
        INSERT INTO encomendas (pedido_id, cliente_id, produto_id, origem, nome_cliente, telefone, modelo, codigo_sku, valor, created_at)
        SELECT p.id, p.cliente_id, pr.id, 'SITE', p.nome, p.telefone, i->>'nome', COALESCE(i->>'codigo_sku', ''),
               COALESCE((i->>'preco')::numeric, 0), p.created_at
        FROM pedidos p
        CROSS JOIN LATERAL jsonb_array_elements(p.itens) i
        LEFT JOIN produtos pr ON pr.id = (i->>'produto_id')::int
        WHERE (i->>'encomenda')::boolean IS TRUE
        ON CONFLICT DO NOTHING
      `);
    }

    // Estoque em unidades: produtos.estoque conta as peças na loja e maleta_pecas
    // as que estão com clientes (uma linha por peça, ligada ao pedido da maleta).
    // O status do produto sai dessas contas. Na criação, cada produto de antes
    // (uma peça por cadastro) vira 1 em estoque se DISPONIVEL e a peça em
    // CONDICIONAL vira uma linha da maleta.
    const temMaletaPecas = (await client.query(`SELECT to_regclass('maleta_pecas') AS t`)).rows[0].t !== null;
    await client.query(`
      CREATE TABLE IF NOT EXISTS maleta_pecas (
        id SERIAL PRIMARY KEY,
        produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
        pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS maleta_pecas_produto_idx ON maleta_pecas (produto_id)');
    await client.query('CREATE INDEX IF NOT EXISTS maleta_pecas_pedido_idx ON maleta_pecas (pedido_id)');
    await client.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS estoque INTEGER`);
    await client.query(`UPDATE produtos SET estoque = CASE WHEN status = 'DISPONIVEL' THEN 1 ELSE 0 END WHERE estoque IS NULL`);
    await client.query(`ALTER TABLE produtos ALTER COLUMN estoque SET DEFAULT 1, ALTER COLUMN estoque SET NOT NULL`);
    if (!temMaletaPecas) {
      await client.query(`
        INSERT INTO maleta_pecas (produto_id, pedido_id)
        SELECT id, pedido_condicional_id FROM produtos WHERE status = 'CONDICIONAL'
      `);
    }
    // Nº do pedido no fornecedor (ex.: 14563), para achar a compra depois
    await client.query(`
      ALTER TABLE compras_fornecedor
      ADD COLUMN IF NOT EXISTS pedido_fornecedor VARCHAR(60) NOT NULL DEFAULT ''
    `);

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

module.exports = { criarPool, initTables };