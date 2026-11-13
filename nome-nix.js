// Nome de exibição dos óculos no padrão do Jefe (2026-11-13):
//   NIX + nome curto + tipo + formato da lente      ex.: "NIX Pyroraptor Polarizado Esportivo"
// Modelo com cores (código do modelo/grade preenchido) guarda " - <cor>" no fim, que a
// vitrine tira nos detalhes e a maleta/WhatsApp mostram. Campos vazios simplesmente somem
// (nada de "•" ou "-" soltos). A mesma função existe no painel (admin/index.html, nomeNix)
// para a importação pelo link já preencher o nome nesse formato.
//
// Ajuste único: troca só o NOME dos óculos já cadastrados na Nix (não mexe em preço,
// estoque, SKU, nome curto nem nome do fornecedor). Roda uma vez ao subir o servidor e
// guarda o antes/depois em configuracoes (chave abaixo) como backup.

const CHAVE = 'ajuste_nome_nix_2026_11_13';
const LOJA = 'nix';

function limparTexto(t) {
  return String(t ?? '').replace(/[•·|]/g, ' ').replace(/\s+/g, ' ').trim();
}

// "QUADRADO" -> "Quadrado"; "UV400", "G15" e palavras já com maiúscula ficam como estão
function capitalizar(t) {
  return limparTexto(t).split(' ').filter(Boolean)
    .map(p => (/^[A-ZÀ-Ý]{4,}$/.test(p) || /^[a-zà-ÿ]/.test(p) ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p))
    .join(' ');
}

// Tipo da lente para o nome: "Polarizado UV400" -> "Polarizado" (todo polarizado já é UV400);
// "Proteção UV400" ou "UV400" sozinho -> "UV400"
function tipoParaNome(tipo) {
  const palavras = capitalizar(tipo).split(' ').filter(Boolean);
  if (!palavras.length) return '';
  const resto = palavras.filter(p => !/^(uv-?400|uv|prote[cç][aã]o)$/i.test(p));
  if (resto.length) return resto.join(' ');
  return /uv/i.test(palavras.join(' ')) ? 'UV400' : '';
}

function nomeNix({ nome_curto: nomeCurto, tipo, formato } = {}) {
  const curto = limparTexto(nomeCurto).replace(/^nix\s+/i, '');
  const partes = [];
  const vistas = new Set();
  for (const parte of [curto, tipoParaNome(tipo), capitalizar(formato)]) {
    // Palavra que já apareceu (ex.: tipo "Polarizado Esportivo" + formato "Esportivo") não repete
    const palavras = parte.split(' ').filter(p => p && !vistas.has(p.toLowerCase()));
    palavras.forEach(p => vistas.add(p.toLowerCase()));
    if (palavras.length) partes.push(palavras.join(' '));
  }
  return curto ? `NIX ${partes.join(' ')}`.slice(0, 255) : '';
}

// Sem nome curto: o modelo tirado do nome atual ("Nix Dilo Soul - Onyx Black" -> "Dilo Soul")
function nomeCurtoDoNome(nome) {
  return limparTexto(String(nome ?? '').split(/\s+[-–]\s+|\s+-\s*$/)[0]).replace(/^nix\s+/i, '').trim();
}

// Nome novo de um produto cadastrado (com " - cor" / " - tamanho" no modelo com grade)
function nomeNovo(p) {
  const base = nomeNix({ nome_curto: String(p.nome_curto || '').trim() || nomeCurtoDoNome(p.nome), tipo: p.tipo, formato: p.formato });
  if (!base) return '';
  const grade = String(p.grade || '').trim();
  const sufixo = String(p.tamanho || '').trim() || (grade ? limparTexto(p.cor_armacao) : '');
  return (sufixo ? `${base} - ${sufixo}` : base).slice(0, 255);
}

// -> { alterar: [{ id, sku, antes, depois }], iguais: [[nome, ids]] }
function planejarAjuste(produtos) {
  const alterar = [];
  for (const p of produtos) {
    if (p.arquivado) continue;
    const depois = nomeNovo(p);
    if (!depois || depois === p.nome) continue;
    alterar.push({ id: p.id, sku: p.codigo_sku, antes: p.nome, depois });
  }
  // Modelos diferentes que ficaram com o mesmo nome (só aviso, para conferir no painel)
  const porNome = new Map();
  for (const p of produtos) {
    if (p.arquivado) continue;
    const nome = (alterar.find(a => a.id === p.id) || {}).depois || p.nome;
    const modelo = String(p.grade || '').trim() || p.codigo_sku;
    if (!porNome.has(nome)) porNome.set(nome, new Map());
    porNome.get(nome).set(modelo, p.id);
  }
  const iguais = [...porNome].filter(([, m]) => m.size > 1).map(([nome, m]) => [nome, [...m.values()]]);
  return { alterar, iguais };
}

async function aplicarUmaVez(slug, pool) {
  if (slug !== LOJA) return null;
  const { rows: [feito] } = await pool.query('SELECT 1 FROM configuracoes WHERE chave = $1', [CHAVE]);
  if (feito) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, nome, nome_curto, tipo, formato, cor_armacao, tamanho, grade, codigo_sku, arquivado
         FROM produtos ORDER BY id FOR UPDATE`);
    const plano = planejarAjuste(rows);
    for (const i of plano.alterar) {
      await client.query('UPDATE produtos SET nome = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [i.id, i.depois]);
    }
    await client.query('INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)',
      [CHAVE, JSON.stringify({ data: new Date().toISOString(), ...plano })]);
    await client.query('COMMIT');
    console.log(`[nome-nix] ${plano.alterar.length} nomes alterados (backup em configuracoes.${CHAVE}); nomes repetidos entre modelos: ${plano.iguais.length}`);
    for (const i of plano.alterar) console.log(`[nome-nix] ALTERADO ${JSON.stringify(i)}`);
    for (const i of plano.iguais) console.log(`[nome-nix] REPETIDO ${JSON.stringify(i)}`);
    return plano;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[nome-nix] Não consegui ajustar os nomes:', err.message);
    return null;
  } finally {
    client.release();
  }
}

module.exports = { CHAVE, nomeNix, tipoParaNome, nomeCurtoDoNome, nomeNovo, planejarAjuste, aplicarUmaVez };
