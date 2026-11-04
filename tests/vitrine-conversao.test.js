// Vitrine focada em conversão: detalhes do produto com a ficha técnica numa sanfona
// fechada e "Adicionar à Maleta" como ação principal; maleta numa gaveta lateral aberta
// pelo botão do topo (com contador) e "Finalizar pelo WhatsApp" no rodapé dela.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extrairFuncao(html, nome) {
  const inicio = html.search(new RegExp(`(async )?function ${nome}\\(`));
  assert.notEqual(inicio, -1, `função ${nome} não encontrada`);
  let i = html.indexOf('{', inicio);
  for (let nivel = 0; ; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}' && --nivel === 0) return html.slice(inicio, i + 1);
  }
}

function carregar(funcoes, globais = {}) {
  const ctx = vm.createContext({ ...globais });
  vm.runInContext(`${funcoes.map((f) => extrairFuncao(HTML, f)).join('\n')}\n${funcoes.map((f) => `this.${f} = ${f};`).join('\n')}`, ctx);
  return ctx;
}

const formatarMoeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v).replace(/\u00a0/g, ' ');

describe('vitrine: detalhes do produto', () => {
  const FUNCOES = ['escapeHtml', 'fotosDoProduto', 'indiceCircular', 'ehSobEncomenda', 'calcularSinal',
    'etiquetaProduto', 'especificacoesProduto', 'renderizarDetalhes', 'ordemTamanho', 'agruparCards', 'nomeModelo', 'grupoDoProduto', 'botoesTamanho'];

  function detalhesDe(produto, detalhes = {}, itens = []) {
    const detalhesConteudo = { innerHTML: '' };
    const ctx = carregar(FUNCOES, {
      produtos: [produto],
      NICHO: 'oculos', rotulos: { formato: 'Formato da lente', formatos: 'Todos os formatos', material: 'Material', tipo: 'Tipo' }, ORDEM_TAMANHOS: [],
      maleta: { itens },
      detalhes: { id: produto.id, indice: 0, ...detalhes },
      detalhesConteudo,
      formatarMoeda,
      fecharDetalhes() {},
      Intl, Number, String, Math,
    });
    ctx.renderizarDetalhes();
    return detalhesConteudo.innerHTML;
  }

  const oculos = {
    id: 5, nome: 'Raptor Preto', codigo_sku: 'RP-1', preco_venda: '299.90', status: 'DISPONIVEL', disponibilidade: 'PRONTA_ENTREGA',
    fotos: ['/imagens/aaa'], imagem_url: '/imagens/aaa', diametro_cm: '5.6', ponte_cm: '1.8', material: 'Acetato', estilo: 'Esportivo', genero: 'UNISSEX',
  };

  it('a ficha técnica fica numa sanfona "Mais Detalhes e Medidas Técnicas", fechada por padrão', () => {
    const html = detalhesDe(oculos);
    const sanfona = html.match(/<details data-detalhes-tecnicos[^>]*>/);
    assert.ok(sanfona, 'tem a sanfona');
    assert.doesNotMatch(sanfona[0], /\sopen/);
    assert.match(html, /<summary[\s\S]*📋 Mais Detalhes e Medidas Técnicas[\s\S]*<\/summary>/);
    // Medidas, material e estilo só dentro da sanfona
    const fora = html.replace(/<details[\s\S]*<\/details>/, '');
    assert.doesNotMatch(fora, /Diâmetro|5,6 cm|Acetato|Esportivo|Especificações Técnicas/);
    const dentro = html.match(/<details[\s\S]*<\/details>/)[0];
    for (const t of ['Diâmetro', '5,6 cm', 'Ponte', '1,8 cm', 'Acetato', 'Esportivo', 'Unissex']) assert.ok(dentro.includes(t), t);
  });

  it('a sanfona continua aberta quando os detalhes são redesenhados (ex.: ao pôr na maleta)', () => {
    const html = detalhesDe(oculos, { tecnicosAbertos: true });
    assert.match(html, /<details data-detalhes-tecnicos[^>]*\sopen[\s>]/);
    assert.match(html, /ontoggle="if \(detalhes\) detalhes\.tecnicosAbertos = this\.open"/);
  });

  it('sem nada técnico preenchido, não mostra a sanfona vazia', () => {
    const html = detalhesDe({ ...oculos, diametro_cm: null, ponte_cm: null, material: '', estilo: '', genero: '' });
    assert.doesNotMatch(html, /data-detalhes-tecnicos/);
  });

  it('"Adicionar à Maleta" é o botão principal (sólido) e "Provar virtualmente" vem logo abaixo, como apoio', () => {
    const html = detalhesDe(oculos);
    const maleta = html.search(/onclick="toggleMaleta\(5\); renderizarDetalhes\(\)"/);
    const provar = html.search(/onclick="abrirProvador\(5\)"/);
    assert.ok(maleta > 0 && provar > maleta, 'maleta antes do provador');
    assert.match(html, /toggleMaleta\(5\)[^>]*class="btn btn-lg btn-maleta w-full btn-destaque">Adicionar à Maleta</);
    assert.match(html, /abrirProvador\(5\)[^>]*class="btn btn-secundario w-full">Provar virtualmente</);
    assert.ok(provar < html.indexOf('data-detalhes-tecnicos'), 'botões antes da ficha técnica');
    // Já na maleta, o botão volta ao contorno prateado
    assert.match(detalhesDe(oculos, {}, [{ id: 5 }]), /btn-na-maleta">✓ Na Maleta · Remover</);
  });

  it('encomenda: selo "SOB ENCOMENDA" com o sinal de 50% e o que fica para a entrega', () => {
    const html = detalhesDe({ ...oculos, disponibilidade: 'SOB_ENCOMENDA', preco_venda: '299.99' });
    assert.match(html, /data-aviso-encomenda[\s\S]*>SOB ENCOMENDA<\/span>Reserva com sinal de 50%/);
    assert.match(html, /<strong>R\$ 150,00<\/strong> de sinal ao fechar pelo WhatsApp e <strong>R\$ 149,99<\/strong> na entrega/);
    assert.match(html, /btn-destaque">Encomendar \(adicionar à Maleta\)</);
    // A etiqueta pequena azul dá lugar ao aviso completo
    assert.doesNotMatch(html, /bg-blue-100 text-blue-700/);
  });
});

describe('vitrine: maleta no topo e na gaveta lateral', () => {
  it('o topo tem o botão da maleta com contador que abre a gaveta', () => {
    assert.match(HTML, /<button id="btnMaleta"[^>]*aria-controls="modalMaleta"/);
    assert.match(HTML, /id="btnMaleta"[\s\S]{0,900}>Maleta<\/span>[\s\S]{0,300}id="maletaCount"/);
    assert.match(HTML, /btnMaleta\.addEventListener\('click', abrirModalMaleta\)/);
  });

  it('a maleta é uma gaveta que desliza da direita, com "Finalizar pelo WhatsApp" no rodapé', () => {
    assert.match(HTML, /<div id="modalMaleta" class="[^"]*\bflex justify-end"/);
    assert.match(HTML, /<div class="gaveta-maleta [^"]*h-full/);
    assert.match(HTML, /#modalMaleta \.gaveta-maleta \{ transform: translateX\(100%\)/);
    assert.match(HTML, /#modalMaleta\.aberta \.gaveta-maleta \{ transform: translateX\(0\)/);
    assert.match(HTML, /<button id="finalizarPedido" class="btn btn-lg btn-whatsapp w-full">[\s\S]*?Finalizar pelo WhatsApp\s*<\/button>/);
    assert.match(extrairFuncao(HTML, 'abrirModalMaleta'), /classList\.add\('aberta'\)/);
    assert.match(extrairFuncao(HTML, 'fecharModalMaleta'), /classList\.remove\('aberta'\)[\s\S]*classList\.add\('hidden'\)/);
  });

  it('o contador do topo acompanha a maleta em tempo real e diz quantos modelos há', () => {
    const el = () => ({ innerHTML: '', textContent: '', classList: { add() {}, remove() {} } });
    const porId = {};
    const btnMaleta = { atributos: {}, setAttribute(k, v) { this.atributos[k] = v; } };
    const ctx = carregar(['escapeHtml', 'calcularSinal', 'itemEhEncomenda', 'resumoMaleta', 'textoGuiaCatalogo', 'atualizarGuias', 'atualizarBarraMaleta', 'atualizarMaletaUI'], {
      maletaVazia: el(), maletaItens: el(), maletaFormulario: el(), maletaFooter: el(), maletaTotal: el(), maletaSinal: el(),
      maleta: { itens: [{ id: 1, nome: 'Aviador', preco: 100 }, { id: 2, nome: 'Cat Eye', preco: 200, encomenda: true }] },
      filtroStatus: { value: '' }, NICHO: 'oculos', formatarMoeda, btnMaleta,
      document: { getElementById: (id) => (porId[id] ||= el()) },
      Intl, Number, String, Math,
    });
    ctx.atualizarMaletaUI();
    assert.equal(porId.maletaCount.textContent, 2);
    assert.equal(btnMaleta.atributos['aria-label'], 'Minha Maleta: 2 modelos');
    ctx.maleta.itens = [];
    ctx.atualizarMaletaUI();
    assert.equal(porId.maletaCount.textContent, '0');
    assert.equal(btnMaleta.atributos['aria-label'], 'Minha Maleta: vazia');
  });
});
