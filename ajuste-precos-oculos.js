// Ajuste único dos preços de venda dos óculos (pedido do Jefe, 2026-11-12):
// polarizado R$ 169,90, os outros R$ 149,90. Roda uma vez no banco da Nix ao subir o
// servidor e guarda o antes/depois em configuracoes (chave abaixo) para dar para reverter.
// Arquivados ficam de fora; o preço promocional não muda (só avisa no log se ficou >= ao novo).
// Modelo sem Tipo e sem Nome fornec. (e sem "polarizado" no nome) fica pendente, sem mudar.
const CHAVE = 'ajuste_precos_oculos_2026_11_12';
const LOJA = 'nix';
const POLARIZADO = 169.9;
const COMUM = 149.9;

const temPolariz = (t) => /polariz/i.test(String(t || ''));
const vazio = (t) => !String(t || '').trim();

// Agrupa as cores pelo modelo (grade, ou o SKU quando não tem) e decide o preço de cada um.
function planejarAjuste(produtos) {
  const modelos = new Map();
  for (const p of produtos) {
    if (p.arquivado) continue;
    const chave = String(p.grade || '').trim() || p.codigo_sku;
    if (!modelos.has(chave)) modelos.set(chave, []);
    modelos.get(chave).push(p);
  }
  const alterar = [];
  const iguais = [];
  const pendentes = [];
  for (const [modelo, cores] of modelos) {
    const polarizado = cores.some(p => temPolariz(p.tipo) || temPolariz(p.nome_fornecedor) || temPolariz(p.nome));
    const semInfo = !polarizado && cores.every(p => vazio(p.tipo) && vazio(p.nome_fornecedor));
    for (const p of cores) {
      const antes = Number(p.preco_venda);
      const item = { id: p.id, modelo, sku: p.codigo_sku, nome: p.nome, tipo: p.tipo || '', antes, polarizado };
      if (semInfo) { pendentes.push(item); continue; }
      const depois = polarizado ? POLARIZADO : COMUM;
      item.depois = depois;
      const promo = p.preco_promocional === null || p.preco_promocional === undefined ? null : Number(p.preco_promocional);
      if (promo !== null && promo > 0 && promo >= depois) item.aviso_promocional = promo;
      (Math.round(antes * 100) === Math.round(depois * 100) ? iguais : alterar).push(item);
    }
  }
  return { alterar, iguais, pendentes };
}

async function aplicarUmaVez(slug, pool) {
  if (slug !== LOJA) return null;
  const { rows: [feito] } = await pool.query('SELECT 1 FROM configuracoes WHERE chave = $1', [CHAVE]);
  if (feito) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, nome, nome_fornecedor, codigo_sku, grade, tipo, preco_venda, preco_promocional, arquivado
         FROM produtos ORDER BY id FOR UPDATE`);
    const plano = planejarAjuste(rows);
    for (const item of plano.alterar) {
      await client.query('UPDATE produtos SET preco_venda = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [item.id, item.depois]);
    }
    const backup = { data: new Date().toISOString(), ...plano };
    await client.query('INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)', [CHAVE, JSON.stringify(backup)]);
    await client.query('COMMIT');
    console.log(`[ajuste-precos] ${plano.alterar.length} alterados, ${plano.iguais.length} já no preço, ${plano.pendentes.length} pendentes (backup em configuracoes.${CHAVE})`);
    for (const i of plano.alterar) console.log(`[ajuste-precos] ALTERADO ${JSON.stringify(i)}`);
    for (const i of plano.iguais) console.log(`[ajuste-precos] IGUAL ${JSON.stringify(i)}`);
    for (const i of plano.pendentes) console.log(`[ajuste-precos] PENDENTE ${JSON.stringify(i)}`);
    return plano;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ajuste-precos] Não consegui ajustar os preços:', err.message);
    return null;
  } finally {
    client.release();
  }
}

module.exports = { CHAVE, planejarAjuste, aplicarUmaVez };
