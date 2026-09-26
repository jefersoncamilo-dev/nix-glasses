// Gera ADMIN_PASS_HASH (salt:hashHex via scrypt) a partir de uma senha forte.
// Uso: node scripts/generate-admin-hash.js "sua-senha-forte"
// NUNCA commite a senha nem o hash no Git — defina via env (local .env / Render).
const crypto = require('crypto');

const pass = process.argv[2];
if (!pass || pass.length < 8) {
  console.error('Uso: node scripts/generate-admin-hash.js "senha-com-minimo-8-chars"');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pass, salt, 64);
console.log(`${salt.toString('hex')}:${hash.toString('hex')}`);
