// Várias empresas (lojas) num único serviço. Cada uma tem o próprio banco, o
// próprio login do admin e o próprio endereço; a empresa de cada requisição é
// escolhida pelo Host (ex.: pasucportas.temcatalogo.com.br).
//
// Sem EMPRESAS definido, tudo funciona como antes: uma empresa só ("nix") com
// DATABASE_URL, ADMIN_USER e ADMIN_PASS_HASH.
//
// Com EMPRESAS=nix,pasucportas, cada empresa lê EMPRESA_<SLUG>_<CAMPO>:
//   EMPRESA_PASUCPORTAS_DATABASE_URL   banco Neon só dessa empresa (obrigatório)
//   EMPRESA_PASUCPORTAS_ADMIN_USER     login do painel
//   EMPRESA_PASUCPORTAS_ADMIN_PASS_HASH  hash da senha (scripts/generate-admin-hash.js)
//   EMPRESA_PASUCPORTAS_NOME           nome inicial da loja (o admin pode trocar depois)
//   EMPRESA_PASUCPORTAS_DOMINIOS       endereços, separados por vírgula. Sem ele, vale
//                                      qualquer endereço que comece com "<slug>."
// A primeira empresa da lista é a padrão: atende o endereço do Render
// (nix-glasses.onrender.com) e, sem as variáveis EMPRESA_<SLUG>_*,
// usa DATABASE_URL, ADMIN_USER e ADMIN_PASS_HASH, como antes.

const SLUG_VALIDO = /^[a-z0-9][a-z0-9-]{0,39}$/;

function prefixoEnv(slug) {
  return `EMPRESA_${slug.toUpperCase().replace(/-/g, '_')}_`;
}

function normalizarHost(host) {
  return String(host || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

// Lê as empresas das variáveis de ambiente. Erros de configuração param o boot,
// porque servir a empresa errada (ou com o banco de outra) seria pior.
function lerEmpresas(env) {
  const lista = String(env.EMPRESAS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const slugs = lista.length ? lista : ['nix'];
  const empresas = [];
  for (const [i, slug] of slugs.entries()) {
    if (!SLUG_VALIDO.test(slug)) throw new Error(`EMPRESAS: nome "${slug}" inválido (use letras minúsculas, números e hífen)`);
    if (empresas.some((e) => e.slug === slug)) throw new Error(`EMPRESAS: "${slug}" aparece duas vezes`);
    const padrao = i === 0;
    const p = prefixoEnv(slug);
    const v = (campo, legado) => env[p + campo] || (padrao && legado ? env[legado] || '' : '');
    const databaseUrl = v('DATABASE_URL', 'DATABASE_URL');
    if (!databaseUrl) throw new Error(`Defina ${p}DATABASE_URL com o banco da empresa "${slug}"`);
    const dominios = String(env[p + 'DOMINIOS'] || '').split(',').map(normalizarHost).filter(Boolean);
    empresas.push({
      slug,
      padrao,
      nome: String(env[p + 'NOME'] || '').trim(),
      dominios,
      databaseUrl,
      adminUser: v('ADMIN_USER', 'ADMIN_USER'),
      adminPassHash: v('ADMIN_PASS_HASH', 'ADMIN_PASS_HASH'),
    });
  }
  const bancos = new Set();
  for (const e of empresas) {
    if (bancos.has(e.databaseUrl)) throw new Error(`A empresa "${e.slug}" usa o mesmo banco de outra empresa: cada uma precisa do seu`);
    bancos.add(e.databaseUrl);
  }
  return empresas;
}

// Endereços que sempre vão para a empresa padrão: o do Render e os internos (testes, health check).
function hostInterno(h) {
  return h === '' || h === 'localhost' || h.endsWith('.onrender.com') || /^[\d.]+$/.test(h) || h.includes(':');
}

// Empresa dona do endereço: domínio listado, senão "<slug>." no começo. Com uma empresa só,
// qualquer endereço é dela (como antes). Com várias, um endereço que não é de nenhuma
// (subdomínio digitado errado, DNS apontado sem configurar) devolve null em vez de mostrar
// a loja padrão por engano.
function empresaDoHost(empresas, host) {
  const h = normalizarHost(host);
  const dona = empresas.find((e) => e.dominios.includes(h))
    || empresas.find((e) => !e.dominios.length && h.startsWith(e.slug + '.'));
  if (dona) return dona;
  return empresas.length === 1 || hostInterno(h) ? empresas[0] : null;
}

module.exports = { lerEmpresas, empresaDoHost, normalizarHost };
