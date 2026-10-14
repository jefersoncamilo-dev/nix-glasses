// Sobe o server.js real num processo filho, apontando para um Postgres de teste.
// Assim os testes exercitam a aplicação exatamente como roda no Render, sem
// precisar mudar o server.js para ser importável.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
// Só TEST_DATABASE_URL, de propósito: os testes apagam as tabelas, então nunca
// reaproveitamos o DATABASE_URL (que pode ser o banco de produção).
const DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('Defina TEST_DATABASE_URL com um banco só de testes (ex.: postgres://postgres:postgres@localhost:5432/nix_test)');
}

const ADMIN_USER = 'admin-teste';
const ADMIN_PASS = 'senha-de-teste-123';
const JWT_SECRET = 'segredo-de-teste';

function hashSenha(pass) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pass, salt, 64).toString('hex')}`;
}

function portaLivre() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// comAdmin=false sobe o servidor sem ADMIN_USER/ADMIN_PASS_HASH (admin deve ficar fechado)
async function iniciarServidor({ comAdmin = true } = {}) {
  const port = await portaLivre();
  const env = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL,
    NODE_ENV: 'test',
    JWT_SECRET,
    ADMIN_USER: comAdmin ? ADMIN_USER : '',
    ADMIN_PASS_HASH: comAdmin ? hashSenha(ADMIN_PASS) : '',
  };
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Servidor não subiu a tempo:\n${log}`)), 15000);
    const onData = (chunk) => {
      log += chunk;
      if (log.includes('Servidor rodando')) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Servidor saiu com código ${code}:\n${log}`));
    });
  });
  proc.removeAllListeners('exit');

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    url: (p) => base + p,
    async parar() {
      if (proc.exitCode !== null) return;
      const saiu = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await saiu;
    },
  };
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function limparBanco() {
  await pool.query('TRUNCATE produtos, imagens RESTART IDENTITY');
  await pool.query(`UPDATE configuracoes SET valor = '' WHERE chave = 'whatsapp_number'`);
}

async function fecharBanco() {
  await pool.end();
}

async function login(srv) {
  const res = await fetch(srv.url('/api/admin/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (!res.ok) throw new Error(`login falhou: ${res.status}`);
  return (await res.json()).token;
}

// Mesmo formato de token do server.js: base64url(payload).hmacHex
function tokenForjado(payload, secret = JWT_SECRET) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

// PNG 1x1 válido
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

module.exports = {
  ADMIN_USER,
  ADMIN_PASS,
  JWT_SECRET,
  PNG_1x1,
  pool,
  iniciarServidor,
  limparBanco,
  fecharBanco,
  login,
  tokenForjado,
};
