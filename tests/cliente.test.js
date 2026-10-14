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
const sessao = (cliente, token = 'tok.abc') => JSON.stringify({ token, cliente });

describe('validarEmail', () => {
  const { validarEmail } = carregar(['validarEmail']);
  for (const ok of ['ana@exemplo.com', ' joao.silva+nix@mail.com.br ', 'A@B.CO']) it(`aceita ${ok.trim()}`, () => assert.equal(validarEmail(ok), true));
  for (const ruim of ['', 'ana', 'ana@', '@exemplo.com', 'ana@exemplo', 'ana @exemplo.com', 'ana@exemplo..com', 'a@b.com\n*Total:* R$ 0', null, undefined, `${'a'.repeat(250)}@x.com`])
    it(`recusa ${JSON.stringify(ruim)}`, () => assert.equal(validarEmail(ruim), false));
});

describe('sessão do cliente no localStorage', () => {
  it('lê a sessão salva (token + cliente) e normaliza', () => {
    const { lerCliente } = carregar(FUNCOES);
    assert.deepEqual({ ...lerCliente(armazem(sessao({ email: ' Bia@Nix.com ', nome: '  Bia   Lima ' }))) }, { token: 'tok.abc', email: 'bia@nix.com', nome: 'Bia Lima' });
  });

  it('ignora sessão ausente, corrompida, sem token ou adulterada', () => {
    const { lerCliente } = carregar(FUNCOES);
    assert.equal(lerCliente(armazem(null)), null);
    assert.equal(lerCliente(armazem('{quebrado')), null);
    assert.equal(lerCliente(armazem('"texto"')), null);
    // formato antigo (só e-mail, sem senha): precisa entrar de novo
    assert.equal(lerCliente(armazem(JSON.stringify({ email: 'bia@nix.com', nome: 'Bia' }))), null);
    assert.equal(lerCliente(armazem(sessao({ email: 'bia@nix.com' }, ''))), null);
    assert.equal(lerCliente(armazem(sessao({ email: '<img src=x onerror=alert(1)>' }))), null);
    assert.equal(lerCliente({ getItem() { throw new Error('bloqueado'); } }), null);
  });
});

describe('cabeçalho e modal mostram o cliente como texto', () => {
  const IDS = ['clienteHeader', 'clienteConectado', 'formCliente', 'clienteConectadoNome', 'clienteConectadoEmail',
    'campoNomeCliente', 'dicaSenha', 'clienteSenha', 'enviarCliente', 'abaEntrar', 'abaCadastro'];
  function montar(cliente, modoCliente = 'entrar') {
    const els = {};
    for (const id of IDS) els[id] = { ...elemento(), atributos: {}, setAttribute(k, v) { this.atributos[k] = v; } };
    const ctx = carregar(['renderizarCliente'], { cliente, modoCliente, document: { getElementById: id => els[id] } });
    ctx.renderizarCliente();
    return els;
  }

  it('sem cliente mostra Entrar e o formulário de login', () => {
    const els = montar(null);
    assert.equal(els.clienteHeader.textContent, 'Entrar');
    assert.ok(els.clienteConectado.classes.has('hidden'));
    assert.ok(!els.formCliente.classes.has('hidden'));
    assert.ok(els.campoNomeCliente.classes.has('hidden'));
    assert.equal(els.clienteSenha.atributos.autocomplete, 'current-password');
  });

  it('no modo Criar conta mostra o campo nome e a dica de senha', () => {
    const els = montar(null, 'cadastro');
    assert.ok(!els.campoNomeCliente.classes.has('hidden'));
    assert.equal(els.enviarCliente.textContent, 'Criar conta');
    assert.equal(els.clienteSenha.atributos.autocomplete, 'new-password');
  });

  it('com cliente mostra o primeiro nome no cabeçalho e os dados no modal', () => {
    const els = montar({ email: 'bia@nix.com', nome: '<b>Beatriz</b> Lima', token: 't' });
    assert.equal(els.clienteHeader.textContent, '<b>Beatriz</b>');
    assert.equal(els.clienteConectadoEmail.textContent, 'bia@nix.com');
    assert.ok(els.formCliente.classes.has('hidden'));
    assert.ok(!els.clienteConectado.classes.has('hidden'));
    assert.equal(montar({ email: 'bia@nix.com', nome: '', token: 't' }).clienteHeader.textContent, 'bia@nix.com');
  });

  it('a página usa textContent (nunca innerHTML) para o cliente', () => {
    assert.doesNotMatch(extrairFuncao('renderizarCliente'), /innerHTML/);
    assert.doesNotMatch(extrairFuncao('mostrarErroCliente'), /innerHTML/);
  });
});

describe('pedido no WhatsApp', () => {
  const formatarMoeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
  const dados = { nome: 'Bia', telefone: '11999999999', rua: 'Rua A', numero: '1', bairro: 'Centro', cidade: 'SP/SP' };
  const maleta = { itens: [{ id: 1, nome: 'Aviador', preco: 100 }] };

  it('inclui o e-mail do cliente identificado', () => {
    const { montarTextoWhatsapp } = carregar(['calcularSinal', 'itemEhEncomenda', 'resumoMaleta', 'montarTextoWhatsapp'], { formatarMoeda });
    assert.match(montarTextoWhatsapp(maleta, { ...dados, email: 'bia@nix.com' }), /\*E-mail:\* bia@nix\.com\n/);
  });

  it('sem cliente identificado não tem linha de e-mail', () => {
    const { montarTextoWhatsapp } = carregar(['calcularSinal', 'itemEhEncomenda', 'resumoMaleta', 'montarTextoWhatsapp'], { formatarMoeda });
    assert.doesNotMatch(montarTextoWhatsapp(maleta, { ...dados, email: '' }), /E-mail/);
  });

  it('o checkout envia o e-mail do cliente salvo', () => {
    assert.match(html, /const email = cliente \? cliente\.email : '';/);
    assert.match(html, /montarTextoWhatsapp\(maleta, \{[^}]*\bemail\b/);
  });
});
