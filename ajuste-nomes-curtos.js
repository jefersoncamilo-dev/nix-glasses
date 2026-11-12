// Ajuste único dos nomes curtos (dinossauros raros) dos modelos já cadastrados na Nix
// (pedido do Jefe, 2026-11-12; tabela em nomes-modelos/tabela-nomes.md). Roda uma vez no
// banco da Nix ao subir o servidor e guarda o antes/depois em configuracoes (chave abaixo).
// Cada modelo (todas as cores, pela grade) é achado pelo código do fornecedor no Cód. fornec.,
// Nome fornec. ou nome. O nome curto só é trocado quando está vazio ou fora da lista de
// dinossauros (um nome de dinossauro já digitado fica). O formato só é preenchido quando vazio.
const CHAVE = 'ajuste_nomes_curtos_2026_11_12';
const LOJA = 'nix';

// "NV 560", "NV-560", "nv560", sem pegar "NV 5602"
const cod = (letras, numero) => new RegExp(`(^|[^a-z0-9])${letras}[\\s-]*${numero}(?![0-9])`, 'i');
const palavra = (p) => new RegExp(`\\b${p}\\b`, 'i');

// [padrão, nome curto, formato a preencher quando vazio]
const TABELA = [
  // Aviador
  [cod('SAR', '9073'), 'Dimorph', 'AVIADOR'],
  [cod('SAR', '9077'), 'Quetzal', 'AVIADOR'],
  [cod('SAR', '9079'), 'Rhampho', 'AVIADOR'],
  [cod('JJ', '16098'), 'Zhenyue', 'AVIADOR'],
  [cod('NV', '3026'), 'Tapejara', 'AVIADOR'],
  [cod('CE', '7037'), 'Alanqa', 'AVIADOR'],
  [cod('CE', '5160'), 'Haopterus', 'AVIADOR'],
  [cod('JJ', '7023'), 'Nycto', 'AVIADOR'],
  [cod('SAR', '9078'), 'Tupan', 'AVIADOR'],
  [cod('NV', '722'), 'Anhanga', 'AVIADOR'],
  // Quadrada
  [cod('NV', '5205'), 'Styraco', ''],
  [cod('NV', '560'), 'Carnot', ''],
  [palavra('Sheila'), 'Bary', ''],
  [cod('XFG', '59090'), 'Pachy', ''],
  [cod('XFG', '1501'), 'Giga', ''],
  [cod('NV', '5171'), 'Ankylos', ''],
  [cod('NV', '2575'), 'Carnotaur', ''],
  [cod('HLL', '944'), 'Shantung', ''],
  [cod('CE', '009'), 'Torvos', ''],
  [cod('SAR', '04'), 'Zuul', ''],
  [cod('SAR', '02'), 'Nodo', ''],
  [cod('JJ', '7055'), 'Sauropel', ''],
  [cod('SAR', '38'), 'Edmonto', ''],
  [cod('BRSC', '50258'), 'Kentro', 'QUADRADO'],
  [cod('NV', '417'), 'Gastonia', 'QUADRADO'],
  // Redonda
  [palavra('Blogueira'), 'Amber', ''],
  [palavra('Melinda'), 'Mosas', ''],
  [cod('XFG', '81105'), 'Amargas', ''],
  [cod('SAR', '48'), 'Patago', ''],
  [cod('NV', '1720'), 'Fossil', ''],
  // Esportiva
  [cod('BRSA', '15164'), 'Pyroraptor', 'ESPORTIVO'],
  [palavra('Jasper'), 'Deinony', 'ESPORTIVO'],
  [cod('NV', '1828'), 'Megaptor', 'ESPORTIVO'],
  [cod('SAR', '4022'), 'Utah', ''],
];

// Todos os nomes de dinossauro das 4 linhas (os da tabela e as reservas do painel)
const DINOS = new Set([
  'Deinony', 'Troodon', 'Cerato', 'Utah', 'Triássico', 'Megaptor', 'Concaven', 'Pyroraptor', 'Dakotaraptor',
  'Velocis', 'Austro', 'Buitre', 'Microraptor', 'Linheraptor',
  'Dimorph', 'Quetzal', 'Rhampho', 'Zhenyue', 'Tapejara', 'Alanqa', 'Haopterus', 'Nycto', 'Tupan', 'Anhanga',
  'Thalasso', 'Caiuajara', 'Pterodaustro', 'Hatzeg',
  'Styraco', 'Carnot', 'Bary', 'Pachy', 'Giga', 'Ankylos', 'Carnotaur', 'Shantung', 'Torvos', 'Zuul', 'Nodo',
  'Sauropel', 'Edmonto', 'Kentro', 'Gastonia',
  'Amargas', 'Patago', 'Mosas', 'Fossil', 'Nautilus', 'Diplodoc', 'Brontops', 'Ovirapt', 'Amber',
  'Ammonite', 'Trilobit', 'Saltasaur', 'Argento', 'Dreadnou',
].map(n => semAcento(n)));

function semAcento(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// -> { alterar: [{ id, modelo, nome, antes, depois, formato_antes, formato_depois }], semRegra, ambiguos }
function planejarAjuste(produtos) {
  const modelos = new Map();
  for (const p of produtos) {
    if (p.arquivado) continue;
    const chave = String(p.grade || '').trim() || p.codigo_sku;
    if (!modelos.has(chave)) modelos.set(chave, []);
    modelos.get(chave).push(p);
  }
  const alterar = [];
  const ambiguos = [];
  const encontrados = new Set();
  for (const [modelo, cores] of modelos) {
    const texto = cores.map(p => [p.codigo_fornecedor, p.nome_fornecedor, p.nome].join(' ')).join(' | ');
    const regras = TABELA.filter(([re]) => re.test(texto));
    if (!regras.length) continue;
    if (new Set(regras.map(r => r[1])).size > 1) {
      ambiguos.push({ modelo, nomes: regras.map(r => r[1]), nome: cores[0].nome });
      continue;
    }
    const [, nomeCurto, formato] = regras[0];
    encontrados.add(nomeCurto);
    for (const p of cores) {
      const atual = String(p.nome_curto || '').trim();
      const trocarNome = !atual || !DINOS.has(semAcento(atual));
      const trocarFormato = formato && !String(p.formato || '').trim();
      if (!trocarNome && !trocarFormato) continue;
      alterar.push({
        id: p.id, modelo, nome: p.nome,
        antes: atual, depois: trocarNome ? nomeCurto : atual,
        formato_antes: p.formato || '', formato_depois: trocarFormato ? formato : (p.formato || ''),
      });
    }
  }
  const semRegra = TABELA.map(r => r[1]).filter(n => !encontrados.has(n));
  return { alterar, ambiguos, naoEncontrados: semRegra };
}

async function aplicarUmaVez(slug, pool) {
  if (slug !== LOJA) return null;
  const { rows: [feito] } = await pool.query('SELECT 1 FROM configuracoes WHERE chave = $1', [CHAVE]);
  if (feito) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, nome, nome_curto, nome_fornecedor, codigo_fornecedor, codigo_sku, grade, formato, arquivado
         FROM produtos ORDER BY id FOR UPDATE`);
    const plano = planejarAjuste(rows);
    for (const i of plano.alterar) {
      await client.query('UPDATE produtos SET nome_curto = $2, formato = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [i.id, i.depois, i.formato_depois]);
    }
    await client.query('INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)',
      [CHAVE, JSON.stringify({ data: new Date().toISOString(), ...plano })]);
    await client.query('COMMIT');
    console.log(`[ajuste-nomes] ${plano.alterar.length} produtos alterados, ${plano.ambiguos.length} ambíguos, não encontrados: ${plano.naoEncontrados.join(', ') || 'nenhum'} (backup em configuracoes.${CHAVE})`);
    for (const i of plano.alterar) console.log(`[ajuste-nomes] ALTERADO ${JSON.stringify(i)}`);
    for (const i of plano.ambiguos) console.log(`[ajuste-nomes] AMBIGUO ${JSON.stringify(i)}`);
    return plano;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ajuste-nomes] Não consegui ajustar os nomes curtos:', err.message);
    return null;
  } finally {
    client.release();
  }
}

// Correção (Jefe, 2026-11-12): o "NIX Brachio B" (modelo NIX-JJ7-PTE) estava com o código
// JJ7023 e ganhou Nycto (Aviador), mas a foto e a referência do fornecedor (K&L-7055) são de
// armação redonda grande: vira Diplodoc, formato Redondo. Uma vez, com antes/depois guardado.
const CHAVE_CORRECAO = 'ajuste_nomes_curtos_2026_11_12_b';
const CORRECOES = [{ grade: 'NIX-JJ7-PTE', nome_curto: 'Diplodoc', formato: 'REDONDO' }];

async function corrigirUmaVez(slug, pool) {
  if (slug !== LOJA) return null;
  const { rows: [feito] } = await pool.query('SELECT 1 FROM configuracoes WHERE chave = $1', [CHAVE_CORRECAO]);
  if (feito) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const alterados = [];
    for (const c of CORRECOES) {
      const { rows } = await client.query(
        `UPDATE produtos p SET nome_curto = $2, formato = $3, updated_at = CURRENT_TIMESTAMP
           FROM (SELECT id, nome_curto, formato FROM produtos WHERE grade = $1 FOR UPDATE) a
          WHERE p.id = a.id
          RETURNING p.id, p.nome, a.nome_curto AS antes, a.formato AS formato_antes`, [c.grade, c.nome_curto, c.formato]);
      for (const r of rows) alterados.push({ ...r, depois: c.nome_curto, formato_depois: c.formato });
    }
    await client.query('INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)',
      [CHAVE_CORRECAO, JSON.stringify({ data: new Date().toISOString(), alterados })]);
    await client.query('COMMIT');
    console.log(`[ajuste-nomes] correção: ${alterados.length} produtos ${JSON.stringify(alterados)}`);
    return alterados;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ajuste-nomes] Não consegui aplicar a correção:', err.message);
    return null;
  } finally {
    client.release();
  }
}

module.exports = { CHAVE, CHAVE_CORRECAO, TABELA, planejarAjuste, aplicarUmaVez, corrigirUmaVez };
