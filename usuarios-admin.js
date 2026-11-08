// Usuários do painel admin de cada loja (Configurações > Usuários).
//
// O login da loja (definido no painel master / ADMIN_USER) é o DONO: entra em tudo,
// cadastra os usuários e é o único que zera dados. Os outros usuários ficam na tabela
// admin_usuarios do banco da própria loja (então só existem nela) e entram só nas
// áreas marcadas. As rotas conferem a área no servidor, não só o menu.

// Áreas do painel. A chave é a mesma do data-tab do menu (Cadastro em Lote vai com Produtos).
const AREAS = [
  { chave: 'produtos', nome: 'Produtos e cadastro em lote' },
  { chave: 'pedidos', nome: 'Pedidos' },
  { chave: 'encomendas', nome: 'Encomendas' },
  { chave: 'acessorios', nome: 'Acessórios' },
  { chave: 'clientes', nome: 'Clientes' },
  { chave: 'acerto', nome: 'Acerto de maleta' },
  { chave: 'metricas', nome: 'Métricas e relatórios' },
  { chave: 'config', nome: 'Configurações da loja (WhatsApp, dados e logo)' },
];
const CHAVES_AREAS = new Set(AREAS.map((a) => a.chave));

const LOGIN_RE = /^[a-z0-9][a-z0-9._@-]{2,59}$/;
const SENHA_MIN = 8;
const SENHA_MAX = 200;

class ErroUsuario extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

function normalizarLogin(login) {
  return typeof login === 'string' ? login.trim().toLowerCase() : '';
}

function limparPermissoes(lista) {
  if (!Array.isArray(lista)) return [];
  return [...new Set(lista.filter((p) => typeof p === 'string' && CHAVES_AREAS.has(p)))];
}

// Lê a coluna permissoes (texto com as chaves separadas por vírgula).
function lerPermissoes(texto) {
  return limparPermissoes(String(texto || '').split(','));
}

function usuarioPublico(row) {
  return {
    id: row.id,
    nome: row.nome,
    login: row.login,
    ativo: row.ativo,
    permissoes: lerPermissoes(row.permissoes),
    ultimo_acesso: row.ultimo_acesso,
    created_at: row.created_at,
  };
}

async function criarTabela(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_usuarios (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(100) NOT NULL,
      login VARCHAR(60) NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      permissoes TEXT NOT NULL DEFAULT '',
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      sessao INTEGER NOT NULL DEFAULT 1,
      ultimo_acesso TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Confere o corpo do cadastro/edição. novo=true exige senha.
function validarDados(body, { novo, loginDono }) {
  const b = body || {};
  const dados = {};
  if (novo || b.nome !== undefined) {
    const nome = typeof b.nome === 'string' ? b.nome.trim().replace(/\s+/g, ' ') : '';
    if (!nome || nome.length > 100) throw new ErroUsuario(400, 'Informe o nome (até 100 letras)');
    dados.nome = nome;
  }
  if (novo || b.login !== undefined) {
    const login = normalizarLogin(b.login);
    if (!LOGIN_RE.test(login)) {
      throw new ErroUsuario(400, 'Login inválido: use de 3 a 60 letras minúsculas, números, ponto, hífen, _ ou @ (sem espaço)');
    }
    if (loginDono && login === String(loginDono).trim().toLowerCase()) {
      throw new ErroUsuario(409, 'Esse login já é o do dono da loja');
    }
    dados.login = login;
  }
  if (novo || (b.senha !== undefined && b.senha !== '')) {
    if (typeof b.senha !== 'string' || b.senha.length < SENHA_MIN || b.senha.length > SENHA_MAX) {
      throw new ErroUsuario(400, `A senha precisa ter pelo menos ${SENHA_MIN} caracteres`);
    }
    dados.senha = b.senha;
  }
  if (novo || b.permissoes !== undefined) {
    if (b.permissoes !== undefined && !Array.isArray(b.permissoes)) throw new ErroUsuario(400, 'Permissões inválidas');
    dados.permissoes = limparPermissoes(b.permissoes);
  }
  if (b.ativo !== undefined) {
    if (typeof b.ativo !== 'boolean') throw new ErroUsuario(400, 'Ativo inválido');
    dados.ativo = b.ativo;
  } else if (novo) {
    dados.ativo = true;
  }
  return dados;
}

const COLUNAS = 'id, nome, login, ativo, permissoes, ultimo_acesso, created_at';

function erroDeBanco(err) {
  if (err && err.code === '23505') return new ErroUsuario(409, 'Já existe um usuário com esse login');
  return err;
}

// hashSenha: (senha) => Promise<string> no formato salt:hash do server.js.
function criarHandlers({ hashSenha, loginDono }) {
  function falha(res, acao) {
    return (err) => {
      if (err instanceof ErroUsuario) return res.status(err.status).json({ error: err.message });
      console.error(`Erro ao ${acao}:`, err);
      res.status(500).json({ error: `Erro ao ${acao}` });
    };
  }

  async function listar(req, res) {
    try {
      const { rows } = await req.db.query(`SELECT ${COLUNAS} FROM admin_usuarios ORDER BY lower(nome), id`);
      res.json({ areas: AREAS, usuarios: rows.map(usuarioPublico) });
    } catch (err) {
      falha(res, 'listar os usuários')(err);
    }
  }

  async function criar(req, res) {
    try {
      const d = validarDados(req.body, { novo: true, loginDono: loginDono(req) });
      const { rows } = await req.db
        .query(
          `INSERT INTO admin_usuarios (nome, login, senha_hash, permissoes, ativo)
           VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUNAS}`,
          [d.nome, d.login, await hashSenha(d.senha), d.permissoes.join(','), d.ativo]
        )
        .catch((err) => { throw erroDeBanco(err); });
      res.status(201).json(usuarioPublico(rows[0]));
    } catch (err) {
      falha(res, 'cadastrar o usuário')(err);
    }
  }

  async function atualizar(req, res) {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new ErroUsuario(400, 'Usuário inválido');
      const d = validarDados(req.body, { novo: false, loginDono: loginDono(req) });
      const sets = [];
      const valores = [];
      const por = (sql, valor) => { valores.push(valor); sets.push(`${sql} = $${valores.length}`); };
      if (d.nome !== undefined) por('nome', d.nome);
      if (d.login !== undefined) por('login', d.login);
      if (d.permissoes !== undefined) por('permissoes', d.permissoes.join(','));
      if (d.ativo !== undefined) por('ativo', d.ativo);
      if (d.senha !== undefined) por('senha_hash', await hashSenha(d.senha));
      if (!sets.length) throw new ErroUsuario(400, 'Nada para alterar');
      // Nova senha, login trocado ou usuário desativado derrubam as sessões abertas dele.
      const derruba = d.senha !== undefined || d.login !== undefined || d.ativo === false;
      if (derruba) sets.push('sessao = sessao + 1');
      sets.push('updated_at = CURRENT_TIMESTAMP');
      valores.push(id);
      const { rows } = await req.db
        .query(`UPDATE admin_usuarios SET ${sets.join(', ')} WHERE id = $${valores.length} RETURNING ${COLUNAS}`, valores)
        .catch((err) => { throw erroDeBanco(err); });
      if (!rows.length) throw new ErroUsuario(404, 'Usuário não encontrado');
      res.json(usuarioPublico(rows[0]));
    } catch (err) {
      falha(res, 'salvar o usuário')(err);
    }
  }

  async function excluir(req, res) {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new ErroUsuario(400, 'Usuário inválido');
      const { rowCount } = await req.db.query('DELETE FROM admin_usuarios WHERE id = $1', [id]);
      if (!rowCount) throw new ErroUsuario(404, 'Usuário não encontrado');
      res.json({ ok: true });
    } catch (err) {
      falha(res, 'excluir o usuário')(err);
    }
  }

  return { listar, criar, atualizar, excluir };
}

module.exports = {
  AREAS,
  CHAVES_AREAS,
  criarTabela,
  criarHandlers,
  lerPermissoes,
  normalizarLogin,
  usuarioPublico,
};
