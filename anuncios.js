// Promoções da vitrine (Configurações > POP Anúncio).
//
// Cada anúncio tem um nome, a imagem do selo (vai no canto da foto dos produtos da
// promoção e vira um botão na tela inicial), a imagem do anúncio (o pop-up da tela
// inicial), o texto do botão do pop-up (leva à lista de produtos da promoção) e a chave
// Ativo. Inativo some da vitrine inteira (selo, botão e pop-up), mas continua ligado
// aos produtos, para voltar igual quando for reativado.
//
// O produto escolhe a promoção em produtos.anuncio_id (Cadastro do produto > Promoção).
// O pop-up da tela inicial é escolhido em configuracoes.popup_inicial: 'nenhum',
// 'provador' (o pop-up do Provador Virtual de antes) ou o id de um anúncio.

const NOME_MAX = 80;
const BOTAO_MAX = 40;
const BOTAO_PADRAO = 'Ver produtos da promoção';
const CHAVE_POPUP = 'popup_inicial';

class ErroAnuncio extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

async function criarTabela(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS anuncios (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(${NOME_MAX}) NOT NULL,
      selo_url TEXT,
      imagem_url TEXT,
      botao_texto VARCHAR(${BOTAO_MAX}) NOT NULL DEFAULT '${BOTAO_PADRAO}',
      ativo BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Promoção do produto (vazio = sem promoção). Excluir o anúncio tira a promoção dos produtos.
  await client.query(`
    ALTER TABLE produtos
    ADD COLUMN IF NOT EXISTS anuncio_id INTEGER REFERENCES anuncios(id) ON DELETE SET NULL
  `);
  await client.query('CREATE INDEX IF NOT EXISTS produtos_anuncio_idx ON produtos (anuncio_id) WHERE anuncio_id IS NOT NULL');
  // Preço promocional (vazio = a promoção só põe o selo). Só vale com a promoção ativa e
  // abaixo do preço de venda: a vitrine mostra o preço riscado e o promocional, e o pedido,
  // a venda da conferência e as métricas de vendas usam o promocional.
  await client.query('ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_promocional DECIMAL(10,2)');
}

function texto(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// 'true'/'false' do formulário (multipart) ou boolean do JSON; undefined = não enviado
function lerAtivo(v) {
  if (v === undefined) return undefined;
  if (v === true || v === 'true' || v === '1' || v === 'on') return true;
  if (v === false || v === 'false' || v === '0' || v === '') return false;
  return null;
}

// Valor do campo anuncio_id do produto: undefined (não mexe), null (sem promoção) ou o id.
// false = inválido.
function lerAnuncioId(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === 'null' || v === '0' || v === 0) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : false;
}

// Valor do campo preco_promocional do produto: undefined (não mexe), null (sem preço
// promocional) ou o valor em reais (até 2 casas). false = inválido.
function lerPrecoPromocional(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === 'null') return null;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+([.,]\d{1,2})?\s*$/.test(v) ? Number(v.trim().replace(',', '.')) : NaN);
  if (!Number.isFinite(n) || n < 0 || n >= 1e6) return false;
  return n > 0 ? Math.round(n * 100) / 100 : null;
}

// SQL do preço promocional que vale agora (NULL quando não vale): promoção ativa e preço
// promocional abaixo do preço de venda. p = alias da tabela produtos.
function sqlPrecoPromocional(p = 'p') {
  return `CASE WHEN ${p}.preco_promocional > 0 AND ${p}.preco_promocional < ${p}.preco_venda
            AND EXISTS (SELECT 1 FROM anuncios a_pp WHERE a_pp.id = ${p}.anuncio_id AND a_pp.ativo)
          THEN ${p}.preco_promocional END`;
}

// Valor de popup_inicial: 'nenhum', 'provador' ou o id do anúncio (número)
function lerPopup(valor) {
  if (valor === 'provador') return 'provador';
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : 'nenhum';
}

function anuncioPublico(row) {
  return {
    id: row.id,
    nome: row.nome,
    selo_url: row.selo_url || null,
    imagem_url: row.imagem_url || null,
    botao_texto: row.botao_texto || BOTAO_PADRAO,
  };
}

function criarHandlers({ salvarImagem, idDaImagem, detectarTipoImagem }) {
  async function lerPopupSalvo(db) {
    const { rows } = await db.query('SELECT valor FROM configuracoes WHERE chave = $1', [CHAVE_POPUP]);
    return lerPopup(rows[0] && rows[0].valor);
  }

  async function salvarPopup(db, valor) {
    await db.query(
      `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)
       ON CONFLICT (chave) DO UPDATE SET valor = $2`,
      [CHAVE_POPUP, String(valor)]
    );
  }

  // Arquivos do formulário: `selo` e `imagem` (já conferidos pela assinatura)
  function arquivos(req) {
    const f = req.files || {};
    const selo = (f.selo || [])[0] || null;
    const imagem = (f.imagem || [])[0] || null;
    for (const file of [selo, imagem]) {
      if (!file) continue;
      file.tipoDetectado = detectarTipoImagem(file.buffer);
      if (!file.tipoDetectado) throw new ErroAnuncio(400, 'Arquivo não é uma imagem JPG, PNG ou WEBP válida.');
    }
    return { selo, imagem };
  }

  async function apagarImagens(db, urls) {
    const ids = urls.map(idDaImagem).filter(Boolean);
    if (ids.length) await db.query('DELETE FROM imagens WHERE id = ANY($1)', [ids]);
  }

  function responderErro(res, err, padrao) {
    if (err instanceof ErroAnuncio) return res.status(err.status).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: padrao });
  }

  // Vitrine: só os anúncios ativos e o pop-up da tela inicial (null = nenhum)
  async function publico(req, res) {
    try {
      const { rows } = await req.db.query(
        `SELECT a.*, (SELECT COUNT(*) FROM produtos p WHERE p.anuncio_id = a.id AND p.status IN ('DISPONIVEL', 'CONDICIONAL'))::int AS produtos
         FROM anuncios a WHERE a.ativo ORDER BY a.id`
      );
      const popup = await lerPopupSalvo(req.db);
      let pop = null;
      if (popup === 'provador') pop = { tipo: 'provador' };
      else if (popup !== 'nenhum') {
        const a = rows.find((r) => r.id === popup);
        if (a && a.imagem_url) pop = { tipo: 'anuncio', anuncio_id: a.id };
      }
      res.json({ anuncios: rows.map((r) => ({ ...anuncioPublico(r), produtos: r.produtos })), popup: pop });
    } catch (err) {
      responderErro(res, err, 'Erro ao buscar as promoções');
    }
  }

  // Painel: todos, com quantos produtos cada um tem, e o pop-up escolhido
  async function listar(req, res) {
    try {
      const { rows } = await req.db.query(
        `SELECT a.*, (SELECT COUNT(*) FROM produtos p WHERE p.anuncio_id = a.id)::int AS produtos
         FROM anuncios a ORDER BY a.id`
      );
      res.json({
        anuncios: rows.map((r) => ({ ...anuncioPublico(r), ativo: r.ativo, produtos: r.produtos })),
        popup: await lerPopupSalvo(req.db),
      });
    } catch (err) {
      responderErro(res, err, 'Erro ao buscar os anúncios');
    }
  }

  async function criar(req, res) {
    let client;
    try {
      const corpo = req.body || {};
      const nome = texto(corpo.nome, NOME_MAX);
      if (!nome) throw new ErroAnuncio(400, 'Dê um nome ao anúncio (ex.: Black Friday)');
      const ativo = lerAtivo(corpo.ativo);
      if (ativo === null) throw new ErroAnuncio(400, 'Campo "ativo" inválido');
      const { selo, imagem } = arquivos(req);
      client = await req.db.connect();
      await client.query('BEGIN');
      const seloUrl = selo ? await salvarImagem(client, selo) : null;
      const imagemUrl = imagem ? await salvarImagem(client, imagem) : null;
      const { rows } = await client.query(
        `INSERT INTO anuncios (nome, selo_url, imagem_url, botao_texto, ativo)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [nome, seloUrl, imagemUrl, texto(corpo.botao_texto, BOTAO_MAX) || BOTAO_PADRAO, ativo !== false]
      );
      await client.query('COMMIT');
      res.status(201).json({ ...anuncioPublico(rows[0]), ativo: rows[0].ativo, produtos: 0 });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      responderErro(res, err, 'Erro ao salvar o anúncio');
    } finally {
      if (client) client.release();
    }
  }

  // Só o que vier muda. remover_selo / remover_imagem = 'true' tiram a imagem sem trocar.
  async function atualizar(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Anúncio não encontrado' });
    let client;
    try {
      const corpo = req.body || {};
      const { selo, imagem } = arquivos(req);
      const ativo = lerAtivo(corpo.ativo);
      if (ativo === null) throw new ErroAnuncio(400, 'Campo "ativo" inválido');
      client = await req.db.connect();
      await client.query('BEGIN');
      const atual = (await client.query('SELECT * FROM anuncios WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!atual) throw new ErroAnuncio(404, 'Anúncio não encontrado');
      const sets = [];
      const valores = [id];
      const set = (campo, valor) => { valores.push(valor); sets.push(`${campo} = $${valores.length}`); };
      const sair = [];
      if (corpo.nome !== undefined) {
        const nome = texto(corpo.nome, NOME_MAX);
        if (!nome) throw new ErroAnuncio(400, 'Dê um nome ao anúncio (ex.: Black Friday)');
        set('nome', nome);
      }
      if (corpo.botao_texto !== undefined) set('botao_texto', texto(corpo.botao_texto, BOTAO_MAX) || BOTAO_PADRAO);
      if (ativo !== undefined) set('ativo', ativo);
      for (const [campo, file, remover] of [['selo_url', selo, corpo.remover_selo], ['imagem_url', imagem, corpo.remover_imagem]]) {
        if (file) {
          set(campo, await salvarImagem(client, file));
          if (atual[campo]) sair.push(atual[campo]);
        } else if (lerAtivo(remover) === true && atual[campo]) {
          set(campo, null);
          sair.push(atual[campo]);
        }
      }
      let row = atual;
      if (sets.length) {
        row = (await client.query(
          `UPDATE anuncios SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, valores
        )).rows[0];
      }
      await apagarImagens(client, sair);
      const produtos = (await client.query('SELECT COUNT(*)::int AS n FROM produtos WHERE anuncio_id = $1', [id])).rows[0].n;
      await client.query('COMMIT');
      res.json({ ...anuncioPublico(row), ativo: row.ativo, produtos });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      responderErro(res, err, 'Erro ao salvar o anúncio');
    } finally {
      if (client) client.release();
    }
  }

  // Excluir: os produtos ficam, só sem a promoção; se era o pop-up da tela inicial, o pop-up sai.
  async function excluir(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Anúncio não encontrado' });
    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const apagado = (await client.query('DELETE FROM anuncios WHERE id = $1 RETURNING *', [id])).rows[0];
      if (!apagado) throw new ErroAnuncio(404, 'Anúncio não encontrado');
      await apagarImagens(client, [apagado.selo_url, apagado.imagem_url]);
      if ((await lerPopupSalvo(client)) === id) await salvarPopup(client, 'nenhum');
      await client.query('COMMIT');
      res.json({ excluido: id });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      responderErro(res, err, 'Erro ao excluir o anúncio');
    } finally {
      if (client) client.release();
    }
  }

  // Pop-up da tela inicial: { popup: 'nenhum' | 'provador' | <id do anúncio> }
  async function escolherPopup(req, res) {
    try {
      const v = (req.body || {}).popup;
      let valor;
      if (v === 'nenhum' || v === 'provador') valor = v;
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw new ErroAnuncio(400, 'Escolha o pop-up da tela inicial');
        const a = (await req.db.query('SELECT id, ativo, imagem_url FROM anuncios WHERE id = $1', [n])).rows[0];
        if (!a) throw new ErroAnuncio(404, 'Anúncio não encontrado');
        if (!a.imagem_url) throw new ErroAnuncio(400, 'Esse anúncio não tem a imagem do pop-up. Envie a imagem do anúncio antes.');
        valor = n;
      }
      await salvarPopup(req.db, valor);
      res.json({ popup: valor });
    } catch (err) {
      responderErro(res, err, 'Erro ao salvar o pop-up');
    }
  }

  return { publico, listar, criar, atualizar, excluir, escolherPopup };
}

module.exports = { criarTabela, criarHandlers, lerAnuncioId, lerPrecoPromocional, sqlPrecoPromocional, lerPopup, BOTAO_PADRAO, CHAVE_POPUP };
