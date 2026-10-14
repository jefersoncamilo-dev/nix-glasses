// Área do Cliente: identificação leve por e-mail guardada no localStorage,
// mostrada no cabeçalho e enviada na mensagem do pedido no WhatsApp.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extrairFuncao(nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

function carregar(funcoes, globais = {}) {
  const ctx = vm.createContext({ ...globais, Intl, Number, String, JSON });
  vm.runInContext(`${funcoes.map(extrairFuncao).join('\n')}\n${funcoes.map(f => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

function elemento() {
  const classes = new Set(['hidden']);
  return {
    textContent: '', title: '', value: '', classes,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c) },
  };
}

const armazem = (valor) => ({ getItem: () => valor });
const FUNCOES = ['validarEmail', 'normalizarCliente', 'lerCliente'];

describe('validarEmail', () => {
  const { validarEmail } = carregar(['validarEmail']);
  for (const ok of ['ana@exemplo.com', ' joao.silva+nix@mail.com.br ', 'A@B.CO']) it(`aceita ${ok.trim()}`, () => assert.equal(validarEmail(ok), true));
  for (const ruim of ['', 'ana', 'ana@', '@exemplo.com', 'ana@exemplo', 'ana @exemplo.com', 'ana@exemplo..com', 'a@b.com\n*Total:* R$ 0', null, undefined, `${'a'.repeat(250)}@x.com`])
    it(`recusa ${JSON.stringify(ruim)}`, () => assert.equal(validarEmail(ruim), false));
});

describe('cliente no localStorage', () => {
  it('normaliza e-mail e nome', () => {
    const { normalizarCliente } = carregar(FUNCOES);
    assert.deepEqual({ ...normalizarCliente({ email: '  Ana@Exemplo.COM ', nome: '  Ana   Souza ' }) }, { email: 'ana@exemplo.com', nome: 'Ana Souza' });
    assert.equal(normalizarCliente({ email: 'invalido', nome: 'X' }), null);
  });

  it('ignora dado ausente, corrompido ou adulterado', () => {
    const { lerCliente } = carregar(FUNCOES);
    assert.equal(lerCliente(armazem(null)), null);
    assert.equal(lerCliente(armazem('{quebrado')), null);
    assert.equal(lerCliente(armazem('"texto"')), null);
    assert.equal(lerCliente(armazem(JSON.stringify({ email: '<img src=x onerror=alert(1)>' }))), null);
    assert.equal(lerCliente({ getItem() { throw new Error('bloqueado'); } }), null);
  });

  it('lê o cliente salvo', () => {
    const { lerCliente } = carregar(FUNCOES);
    assert.deepEqual({ ...lerCliente(armazem(JSON.stringify({ email: 'bia@nix.com', nome: 'Bia' }))) }, { email: 'bia@nix.com', nome: 'Bia' });
  });
});

describe('cabeçalho mostra o cliente como texto', () => {
  function montar(cliente) {
    const els = { clienteHeader: elemento(), sairCliente: elemento() };
    const ctx = carregar(['renderizarCliente'], { cliente, document: { getElementById: id => els[id] } });
    ctx.renderizarCliente();
    return els;
  }

  it('sem cliente mostra Entrar e esconde Sair', () => {
    const els = montar(null);
    assert.equal(els.clienteHeader.textContent, 'Entrar');
    assert.ok(els.sairCliente.classes.has('hidden'));
  });

  it('com cliente mostra o primeiro nome, ou o e-mail se não houver nome', () => {
    let els = montar({ email: 'bia@nix.com', nome: 'Beatriz Lima' });
    assert.equal(els.clienteHeader.textContent, 'Beatriz');
    assert.equal(els.clienteHeader.title, 'bia@nix.com');
    assert.ok(!els.sairCliente.classes.has('hidden'));
    els = montar({ email: 'bia@nix.com', nome: '' });
    assert.equal(els.clienteHeader.textContent, 'bia@nix.com');
  });

  it('a página usa textContent (nunca innerHTML) para o cliente', () => {
    assert.doesNotMatch(extrairFuncao('renderizarCliente'), /innerHTML/);
  });
});

describe('pedido no WhatsApp', () => {
  const formatarMoeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
  const dados = { nome: 'Bia', telefone: '11999999999', rua: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'SP/SP' };
  const maleta = { itens: [{ id: 1, nome: 'Aviador', preco: 100 }] };

  it('inclui o e-mail do cliente identificado', () => {
    const { montarTextoWhatsapp } = carregar(['montarTextoWhatsapp'], { formatarMoeda });
    assert.match(montarTextoWhatsapp(maleta, { ...dados, email: 'bia@nix.com' }), /\*E-mail:\* bia@nix\.com\n/);
  });

  it('sem cliente identificado não tem linha de e-mail', () => {
    const { montarTextoWhatsapp } = carregar(['montarTextoWhatsapp'], { formatarMoeda });
    assert.doesNotMatch(montarTextoWhatsapp(maleta, { ...dados, email: '' }), /E-mail/);
  });

  it('o checkout envia o e-mail do cliente salvo', () => {
    assert.match(html, /const email = cliente \? cliente\.email : '';/);
    assert.match(html, /montarTextoWhatsapp\(maleta, \{[^}]*\bemail\b/);
  });
});
