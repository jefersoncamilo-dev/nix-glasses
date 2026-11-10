// Conferência de estoque (Produtos > Conferência de estoque).
// Com a lista de um pedido do fornecedor (ou qualquer filtro) na tela, o lojista
// marca os produtos e escolhe o que fazer com as peças da LOJA (produtos.estoque):
//   VENDIDO   vendeu fora do sistema (balcão, Instagram...): tira N peças e registra a venda
//   BAIXA     saiu sem venda (defeito, quebra, brinde...): tira N peças
//   ENCOMENDA sem peça na loja: volta para a vitrine como Sob Encomenda
//   ESGOTADO  sai da vitrine: zera a loja (o que sobrar vira baixa) e Sob Encomenda volta a pronta entrega
// Em VENDIDO/BAIXA, quando a loja zera, `depois` diz se fica ESGOTADO ou vai para ENCOMENDA.
// Peças em maleta com cliente nunca entram aqui (são do Acerto de Maleta).
// O servidor confere tudo antes e de novo dentro da transação: se algum produto
// não puder (sem peça, quantidade maior que a loja, última peça de um pedido
// aberto), nada é gravado (409). Cada ação vira uma linha em movimentos_estoque.

const { sqlPrecoPromocional } = require('./anuncios');

const ACOES = ['VENDIDO', 'BAIXA', 'ENCOMENDA', 'ESGOTADO'];
const DEPOIS = ['ESGOTADO', 'ENCOMENDA'];
const MAX_ITENS = 500;
const MAX_QUANTIDADE = 9999;

async function criarTabela(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS movimentos_estoque (
      id SERIAL PRIMARY KEY,
      produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
      nome VARCHAR(255) NOT NULL DEFAULT '',
      codigo_sku VARCHAR(100) NOT NULL DEFAULT '',
      tipo VARCHAR(20) NOT NULL,
      quantidade INTEGER NOT NULL DEFAULT 0,
      preco_venda DECIMAL(10,2) NOT NULL DEFAULT 0,
      preco_custo DECIMAL(10,2) NOT NULL DEFAULT 0,
      estoque_antes INTEGER NOT NULL DEFAULT 0,
      estoque_depois INTEGER NOT NULL DEFAULT 0,
      depois VARCHAR(20) NOT NULL DEFAULT '',
      motivo VARCHAR(200) NOT NULL DEFAULT '',
      pedido_fornecedor VARCHAR(60) NOT NULL DEFAULT '',
      fornecedor VARCHAR(120) NOT NULL DEFAULT '',
      usuario VARCHAR(100) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS movimentos_estoque_data_idx ON movimentos_estoque (created_at DESC, id DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS movimentos_estoque_pedido_idx ON movimentos_estoque (lower(pedido_fornecedor))');
}

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const listaIds = (ids) => (ids || []).map((x) => `#${x}`).join(', ');

function criarHandlers({ recalcularStatus, textoCurto }) {
  // Lê e valida o pedido do navegador. Devolve { erro } ou o pedido normalizado.
  function lerPedido(body) {
    const b = body && typeof body === 'object' ? body : {};
    const acao = String(b.acao || '').toUpperCase();
    if (!ACOES.includes(acao)) return { erro: 'Escolha o que fazer com os produtos' };
    const depois = b.depois === undefined || b.depois === null || b.depois === '' ? 'ESGOTADO' : String(b.depois).toUpperCase();
    if (!DEPOIS.includes(depois)) return { erro: 'Escolha se o produto fica esgotado ou disponível para encomenda' };
    const lista = b.itens;
    if (!Array.isArray(lista) || !lista.length) return { erro: 'Marque ao menos um produto' };
    if (lista.length > MAX_ITENS) return { erro: `No máximo ${MAX_ITENS} produtos por vez` };
    const porId = new Map();
    const comQuantidade = acao === 'VENDIDO' || acao === 'BAIXA';
    for (const item of lista) {
      const id = Number(item && item.id);
      if (!Number.isInteger(id) || id <= 0 || id >= 2 ** 31) return { erro: 'Lista de produtos inválida' };
      if (porId.has(id)) return { erro: 'Produto repetido na lista' };
      let quantidade = 0;
      if (comQuantidade) {
        quantidade = Number(item.quantidade === undefined ? 1 : item.quantidade);
        if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > MAX_QUANTIDADE) {
          return { erro: 'Quantidade inválida (use um número inteiro a partir de 1)' };
        }
      }
      porId.set(id, quantidade);
    }
    return {
      acao,
      depois,
      itens: [...porId].map(([id, quantidade]) => ({ id, quantidade })),
      motivo: textoCurto(b.motivo, 200),
      pedido_fornecedor: textoCurto(b.pedido_fornecedor, 60),
      fornecedor: textoCurto(b.fornecedor, 120),
    };
  }

  // Confere cada produto e diz o que vai acontecer (sem gravar nada).
  async function conferir(db, pedido, bloquear = false) {
    const ids = pedido.itens.map((i) => i.id);
    const produtos = (await db.query(
      // Em promoção com preço promocional, a venda vale pelo preço promocional
      `SELECT id, nome, codigo_sku, tamanho, estoque, disponibilidade,
              COALESCE(${sqlPrecoPromocional('p')}, preco_venda)::float AS preco_venda,
              preco_custo::float AS preco_custo, imagem_url
       FROM produtos p WHERE id = ANY($1) ORDER BY id ${bloquear ? 'FOR UPDATE' : ''}`, [ids]
    )).rows;
    const maletas = new Map((await db.query(
      `SELECT produto_id, COUNT(*)::int AS pecas, array_agg(DISTINCT pedido_id) FILTER (WHERE pedido_id IS NOT NULL) AS pedidos
       FROM maleta_pecas WHERE produto_id = ANY($1) GROUP BY produto_id`, [ids]
    )).rows.map((r) => [Number(r.produto_id), r]));
    const pedidosAbertos = new Map((await db.query(
      `SELECT (i->>'produto_id')::int AS produto_id, array_agg(DISTINCT pe.id ORDER BY pe.id) AS pedidos
       FROM pedidos pe CROSS JOIN LATERAL jsonb_array_elements(pe.itens) i
       WHERE pe.status IN ('NOVO', 'EM_ANDAMENTO') AND i->>'produto_id' = ANY($1::text[])
       GROUP BY 1`, [ids.map(String)]
    )).rows.map((r) => [Number(r.produto_id), r.pedidos]));

    const porId = new Map(produtos.map((p) => [Number(p.id), p]));
    const itens = [];
    for (const { id, quantidade } of pedido.itens) {
      const p = porId.get(id);
      if (!p) continue;
      const estoque = Math.max(0, Number(p.estoque) || 0);
      const encomenda = p.disponibilidade === 'SOB_ENCOMENDA';
      const m = maletas.get(id);
      const emMaleta = m ? m.pecas : 0;
      const abertos = pedidosAbertos.get(id);
      const bloqueios = [];
      const avisos = [];
      // q = peças que saem da loja; fica = peças reais que ficam na loja
      let q = 0;
      let fica = encomenda ? 0 : estoque;
      let depois = '';
      let nada = false;

      if (pedido.acao === 'VENDIDO' || pedido.acao === 'BAIXA') {
        q = quantidade;
        if (encomenda) {
          bloqueios.push('Está Sob Encomenda: não tem peça na loja para vender ou baixar. Para tirar da vitrine, use "Marcar como esgotado".');
        } else if (estoque === 0) {
          bloqueios.push(`Não tem peça na loja (0 em estoque).${emMaleta ? ` ${plural(emMaleta, 'peça está', 'peças estão')} em maleta: essas saem pelo Acerto de Maleta.` : ''}`);
        } else if (q > estoque) {
          bloqueios.push(`Só tem ${plural(estoque, 'peça', 'peças')} na loja e a quantidade é ${q}.`);
        } else {
          fica = estoque - q;
          if (fica === 0) {
            depois = pedido.depois;
            if (abertos) bloqueios.push(`É a última peça da loja e está no pedido aberto ${listaIds(abertos)}. Entregue ou cancele o pedido antes.`);
          }
        }
      } else if (pedido.acao === 'ENCOMENDA') {
        if (encomenda) {
          nada = true;
          avisos.push('Já está Sob Encomenda. Nada muda.');
        } else if (estoque > 0) {
          bloqueios.push(`Ainda tem ${plural(estoque, 'peça', 'peças')} na loja. Venda ou dê baixa antes (dá para escolher "disponível para encomenda" na baixa).`);
        } else {
          depois = 'ENCOMENDA';
        }
      } else if (pedido.acao === 'ESGOTADO') {
        if (encomenda) {
          depois = 'ESGOTADO';
          avisos.push('Deixa de ser Sob Encomenda e sai da vitrine.');
        } else if (estoque > 0) {
          q = estoque;
          fica = 0;
          depois = 'ESGOTADO';
          avisos.push(`${plural(estoque, 'peça da loja sai', 'peças da loja saem')} do estoque (fica registrado como baixa).`);
          if (abertos) bloqueios.push(`Está no pedido aberto ${listaIds(abertos)} e ficaria sem peça na loja. Entregue ou cancele o pedido antes.`);
        } else {
          nada = true;
          avisos.push('Já está sem peça na loja. Nada muda.');
        }
      }

      if (emMaleta && !bloqueios.length) {
        avisos.push(`${plural(emMaleta, 'peça está', 'peças estão')} em maleta com cliente${m.pedidos && m.pedidos.length ? ` (pedido ${listaIds(m.pedidos)})` : ''}: não ${emMaleta === 1 ? 'entra' : 'entram'} aqui, ${emMaleta === 1 ? 'sai' : 'saem'} pelo Acerto de Maleta.`);
      }
      if (abertos && !bloqueios.length && q > 0) {
        avisos.push(`Está no pedido aberto ${listaIds(abertos)}: confira se a peça que fica na loja é a da cliente.`);
      }

      // Como o produto fica depois (texto curto para o resumo)
      let resultado = '';
      if (!bloqueios.length && !nada) {
        if (depois === 'ENCOMENDA') resultado = 'Fica na vitrine como Sob Encomenda';
        else if (depois === 'ESGOTADO') resultado = emMaleta ? 'Esgotado na loja (segue em maleta)' : 'Esgotado: sai da vitrine';
        else resultado = `Fica com ${plural(fica, 'peça', 'peças')} na loja`;
      }

      itens.push({
        id, nome: p.nome, codigo_sku: p.codigo_sku, tamanho: p.tamanho, imagem_url: p.imagem_url,
        disponibilidade: p.disponibilidade, estoque, em_maleta: emMaleta,
        quantidade: q, fica, depois, nada, resultado,
        preco_venda: p.preco_venda, preco_custo: p.preco_custo,
        valor_venda: pedido.acao === 'VENDIDO' ? Math.round(p.preco_venda * 100) * q / 100 : 0,
        bloqueios, avisos,
      });
    }
    const encontrados = new Set(itens.map((i) => i.id));
    const validos = itens.filter((i) => !i.bloqueios.length);
    return {
      acao: pedido.acao,
      depois: pedido.depois,
      itens,
      nao_encontrados: ids.filter((id) => !encontrados.has(id)),
      totais: {
        produtos: validos.filter((i) => !i.nada).length,
        pecas: validos.reduce((t, i) => t + i.quantidade, 0),
        valor_venda: validos.reduce((t, i) => t + Math.round(i.valor_venda * 100), 0) / 100,
        bloqueados: itens.length - validos.length,
      },
    };
  }

  async function handleConferir(req, res) {
    const pedido = lerPedido(req.body);
    if (pedido.erro) return res.status(400).json({ error: pedido.erro });
    try {
      res.json(await conferir(req.db, pedido));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao conferir os produtos' });
    }
  }

  async function handleAplicar(req, res) {
    const pedido = lerPedido(req.body);
    if (pedido.erro) return res.status(400).json({ error: pedido.erro });
    const usuario = textoCurto((req.admin && (req.admin.u || req.admin.user)) || '', 100);
    let client;
    try {
      client = await req.db.connect();
      await client.query('BEGIN');
      const conf = await conferir(client, pedido, true);
      const bloqueados = conf.itens.filter((i) => i.bloqueios.length);
      if (bloqueados.length || conf.nao_encontrados.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: bloqueados.length
            ? `${plural(bloqueados.length, 'produto não pode', 'produtos não podem')} agora. Nada foi gravado.`
            : 'Algum produto já não existe (a lista mudou). Nada foi gravado.',
          ...conf,
        });
      }
      const mudaram = [];
      for (const i of conf.itens) {
        if (i.nada) continue;
        if (i.quantidade > 0) {
          await client.query('UPDATE produtos SET estoque = estoque - $2 WHERE id = $1', [i.id, i.quantidade]);
        }
        if (i.depois === 'ENCOMENDA') {
          // Sob Encomenda precisa de 1 no estoque do cadastro para aparecer na vitrine
          // (as Métricas e o relatório não contam esse estoque como peça)
          await client.query(`UPDATE produtos SET disponibilidade = 'SOB_ENCOMENDA', estoque = GREATEST(estoque, 1) WHERE id = $1`, [i.id]);
        } else if (i.depois === 'ESGOTADO' && i.disponibilidade === 'SOB_ENCOMENDA') {
          await client.query(`UPDATE produtos SET disponibilidade = 'PRONTA_ENTREGA', estoque = 0 WHERE id = $1`, [i.id]);
        }
        const tipo = pedido.acao === 'ESGOTADO' && i.quantidade > 0 ? 'BAIXA' : pedido.acao;
        const motivo = pedido.motivo || (pedido.acao === 'ESGOTADO' && i.quantidade > 0 ? 'Marcado como esgotado' : '');
        await client.query(
          `INSERT INTO movimentos_estoque (produto_id, nome, codigo_sku, tipo, quantidade, preco_venda, preco_custo,
                                           estoque_antes, estoque_depois, depois, motivo, pedido_fornecedor, fornecedor, usuario)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [i.id, i.nome, i.codigo_sku, tipo, i.quantidade, i.preco_venda, i.preco_custo,
            i.disponibilidade === 'SOB_ENCOMENDA' ? 0 : i.estoque, i.fica, i.depois, motivo,
            pedido.pedido_fornecedor, pedido.fornecedor, usuario]
        );
        mudaram.push(i.id);
      }
      const atualizados = await recalcularStatus(client, mudaram);
      await client.query('COMMIT');
      console.log(`[${req.empresa && req.empresa.slug}] conferência de estoque (${pedido.acao}) por ${usuario}: ${conf.itens.filter((i) => !i.nada).map((i) => `${i.codigo_sku}${i.quantidade ? ' x' + i.quantidade : ''}`).join(', ')}`);
      res.json({
        ...conf,
        produtos: atualizados.map((p) => ({ id: p.id, estoque: p.estoque, status: p.status, disponibilidade: p.disponibilidade })),
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      res.status(500).json({ error: 'Erro ao gravar a conferência. Nada foi gravado.' });
    } finally {
      if (client) client.release();
    }
  }

  // Histórico: últimas vendas/baixas/mudanças (de um pedido do fornecedor ou de todos)
  async function handleListar(req, res) {
    const numero = textoCurto(req.query.numero, 60);
    const fornecedor = textoCurto(req.query.fornecedor, 120);
    try {
      const params = [];
      let onde = '';
      if (numero) {
        // Do pedido = registrado com esse pedido escolhido ou produto que veio nele
        params.push(numero, fornecedor);
        onde = `WHERE (lower(m.pedido_fornecedor) = lower($1) AND ($2 = '' OR lower(m.fornecedor) = lower($2)))
                   OR m.produto_id IN (SELECT produto_id FROM compras_fornecedor c
                                       WHERE lower(c.pedido_fornecedor) = lower($1) AND ($2 = '' OR lower(c.fornecedor) = lower($2)))`;
      }
      const { rows } = await req.db.query(
        `SELECT m.id, m.produto_id, m.nome, m.codigo_sku, m.tipo, m.quantidade, m.preco_venda::float AS preco_venda,
                m.preco_custo::float AS preco_custo, m.estoque_antes, m.estoque_depois, m.depois, m.motivo,
                m.pedido_fornecedor, m.fornecedor, m.usuario, to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS criado_em,
                COALESCE(p.fotos[1], p.imagem_url) AS foto
         FROM movimentos_estoque m LEFT JOIN produtos p ON p.id = m.produto_id
         ${onde}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 200`, params
      );
      const vendidos = rows.filter((r) => r.tipo === 'VENDIDO');
      res.json({
        movimentos: rows,
        totais: {
          vendidas: vendidos.reduce((t, r) => t + r.quantidade, 0),
          valor_vendido: vendidos.reduce((t, r) => t + Math.round(r.preco_venda * 100) * r.quantidade, 0) / 100,
          baixadas: rows.filter((r) => r.tipo === 'BAIXA').reduce((t, r) => t + r.quantidade, 0),
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erro ao buscar o histórico do estoque' });
    }
  }

  return { handleConferir, handleAplicar, handleListar, lerPedido, conferir };
}

module.exports = { criarTabela, criarHandlers, ACOES, DEPOIS };
