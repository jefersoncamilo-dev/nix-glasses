// Painel master: o dono do serviço (não o admin de cada loja) cadastra e configura as
// lojas por um painel, sem mexer nas variáveis do Render a cada cliente novo.
//
// O cadastro fica na tabela master_lojas, no banco da empresa padrão (DATABASE_URL).
// Cada linha completa ou substitui o que veio das variáveis EMPRESA_<SLUG>_*:
//   - loja só do painel: a linha tem tudo (banco, login, domínios);
//   - loja das variáveis: campos preenchidos na linha valem mais que as variáveis,
//     campos nulos seguem as variáveis.
// A connection string do banco de cada loja fica cifrada (AES-256-GCM, chave derivada
// do JWT_SECRET) e nunca volta para o navegador.

const crypto = require('crypto');
const { normalizarHost } = require('./empresas');

const SLUG_VALIDO = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Endereços que não podem virar loja (subdomínio do painel e nomes comuns de serviço).
const SLUGS_RESERVADOS = new Set(['admin', 'master', 'www', 'api', 'app', 'painel', 'mail', 'smtp']);
const HOST_VALIDO = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_DOMINIOS = 10;

async function criarTabelaMaster(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS master_lojas (
      slug VARCHAR(40) PRIMARY KEY,
      nome VARCHAR(100) NOT NULL DEFAULT '',
      dominios TEXT,
      banco_cifrado TEXT,
      admin_user VARCHAR(60),
      admin_pass_hash TEXT,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      sessao INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ---------- Cifra da connection string ----------
function chaveBanco(segredo) {
  return crypto.createHmac('sha256', segredo).update('master:banco').digest();
}

function cifrar(texto, segredo) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chaveBanco(segredo), iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), dados.toString('base64')].join(':');
}

function decifrar(cifrado, segredo) {
  const [versao, iv, tag, dados] = String(cifrado || '').split(':');
  if (versao !== 'v1' || !iv || !tag || !dados) throw new Error('Banco cifrado em formato desconhecido');
  const d = crypto.createDecipheriv('aes-256-gcm', chaveBanco(segredo), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dados, 'base64')), d.final()]).toString('utf8');
}

// ---------- Leitura do formulário ----------
function lerDominios(v) {
  const lista = Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/);
  const dominios = [...new Set(lista.map(normalizarHost).filter(Boolean))];
  if (dominios.length > MAX_DOMINIOS) return { erro: `Use no máximo ${MAX_DOMINIOS} endereços` };
  const ruim = dominios.find((d) => !HOST_VALIDO.test(d));
  if (ruim) return { erro: `Endereço "${ruim}" inválido (ex.: minhaloja.temcatalogo.com.br, sem https://)` };
  return { dominios };
}

function lerBanco(v) {
  const t = String(v || '').trim();
  let u;
  try {
    u = new URL(t);
  } catch {
    return { erro: 'Connection string do banco inválida' };
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return { erro: 'A connection string precisa começar com postgresql://' };
  if (!u.hostname) return { erro: 'Connection string sem servidor' };
  return { banco: t };
}

// Campos que o painel master manda. `nova` exige o que uma loja nova precisa.
// Devolve { erro } ou { campos } só com o que veio.
function lerLojaMaster(body, { nova = false } = {}) {
  const b = body || {};
  const campos = {};
  if (nova) {
    const slug = String(b.slug || '').trim().toLowerCase();
    if (!SLUG_VALIDO.test(slug)) return { erro: 'Identificador inválido: use letras minúsculas, números e hífen (ex.: donatti)' };
    if (SLUGS_RESERVADOS.has(slug)) return { erro: `"${slug}" é reservado, escolha outro identificador` };
    campos.slug = slug;
  }
  if (b.nome !== undefined || nova) {
    const nome = typeof b.nome === 'string' ? b.nome.trim().replace(/\s+/g, ' ') : '';
    if (!nome) return { erro: 'Informe o nome da loja' };
    campos.nome = nome.slice(0, 100);
  }
  if (b.nicho !== undefined) campos.nicho = b.nicho;
  if (b.dominios !== undefined) {
    const r = lerDominios(b.dominios);
    if (r.erro) return r;
    campos.dominios = r.dominios;
  }
  if (b.banco !== undefined && b.banco !== '') {
    const r = lerBanco(b.banco);
    if (r.erro) return r;
    campos.banco = r.banco;
  } else if (nova) {
    return { erro: 'Cole a connection string do banco da loja (Neon)' };
  }
  if (b.admin_user !== undefined && b.admin_user !== '') {
    const u = String(b.admin_user).trim();
    if (!/^[^\s]{3,60}$/.test(u)) return { erro: 'Usuário do admin: de 3 a 60 caracteres, sem espaços' };
    campos.adminUser = u;
  } else if (nova) {
    return { erro: 'Informe o usuário do admin da loja' };
  }
  if (b.senha !== undefined && b.senha !== '') {
    if (typeof b.senha !== 'string' || b.senha.length < 8 || b.senha.length > 200) return { erro: 'A senha do admin precisa de pelo menos 8 caracteres' };
    campos.senha = b.senha;
  } else if (nova) {
    return { erro: 'Defina a senha do admin da loja' };
  }
  if (b.ativo !== undefined) {
    if (typeof b.ativo !== 'boolean') return { erro: 'Campo "ativo" inválido' };
    campos.ativo = b.ativo;
  }
  return { campos };
}

// ---------- Junta as variáveis do Render com o cadastro do painel ----------
// `decifrarBanco` lê a connection string da linha (pode lançar). A loja que não dá para
// montar entra com `erro` (aparece no painel, e o endereço dela responde 503) em vez de
// derrubar as outras.
function aplicarRegistro(empresa, linha, decifrarBanco) {
  if (linha.nome && !empresa.nome) empresa.nome = linha.nome;
  if (linha.dominios !== null && linha.dominios !== undefined) {
    empresa.dominios = String(linha.dominios).split(',').map(normalizarHost).filter(Boolean);
  }
  if (linha.admin_user) empresa.adminUser = linha.admin_user;
  if (linha.admin_pass_hash) empresa.adminPassHash = linha.admin_pass_hash;
  empresa.sessao = linha.sessao || 0;
  if (!empresa.padrao) empresa.ativo = linha.ativo !== false;
  if (linha.banco_cifrado && !empresa.padrao) {
    try {
      empresa.databaseUrl = decifrarBanco(linha.banco_cifrado);
      empresa.bancoDoPainel = true;
    } catch {
      empresa.erro = 'Não consegui ler o banco salvo (o JWT_SECRET do Render mudou?). Cole a connection string de novo.';
    }
  }
  empresa.noPainel = true;
  return empresa;
}

function mesclarEmpresas(doEnv, linhas, decifrarBanco) {
  const empresas = doEnv.map((e) => ({ ...e, ativo: true, sessao: 0, origem: 'render' }));
  for (const linha of linhas) {
    let empresa = empresas.find((e) => e.slug === linha.slug);
    if (empresa) {
      empresa.origem = 'render+painel';
    } else {
      empresa = {
        slug: linha.slug,
        padrao: false,
        nome: '',
        dominios: [],
        hostRender: '',
        databaseUrl: '',
        adminUser: '',
        adminPassHash: '',
        ativo: true,
        sessao: 0,
        origem: 'painel',
      };
      if (!linha.banco_cifrado) empresa.erro = 'Loja sem banco: cole a connection string.';
      empresas.push(empresa);
    }
    aplicarRegistro(empresa, linha, decifrarBanco);
  }
  return empresas;
}

// Endereço para abrir a loja: o primeiro domínio, senão "<slug>." no mesmo domínio do
// painel (admin.temcatalogo.com.br -> donatti.temcatalogo.com.br).
function enderecoDaLoja(empresa, hostDoPainel) {
  if (empresa.dominios.length) return empresa.dominios[0];
  if (empresa.padrao && empresa.hostRender) return empresa.hostRender;
  const partes = normalizarHost(hostDoPainel).split('.');
  if (partes.length >= 3 && HOST_VALIDO.test(partes.join('.'))) return `${empresa.slug}.${partes.slice(1).join('.')}`;
  return '';
}

module.exports = {
  SLUGS_RESERVADOS,
  criarTabelaMaster,
  cifrar,
  decifrar,
  lerDominios,
  lerLojaMaster,
  aplicarRegistro,
  mesclarEmpresas,
  enderecoDaLoja,
};
