const { Telegraf } = require('telegraf');

// Inicializa o bot utilizando o TOKEN configurado nas variáveis de ambiente
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Armazena os cupons ativos em memória
let cuponsAtivos = [];

/**
 * Processa a mensagem de ativacao no formato:
 * #ativar
 * R$30 OFF EM COMPRAS ACIMA DE R$299 TODAS AS LOJAS
 * R$90 OFF EM COMPRAS ACIMA DE R$899 TODAS AS LOJAS
 * 20% OFF EM COMPRAS ACIMA DE R$0 COM LIMITE DE R$20 LOJAS OFICIAIS
 */
function processarListaCupons(textoMensagem) {
  const textoLimpo = textoMensagem.replace(/#ativar/i, '').trim();
  const linhas = textoLimpo.split('\n');
  const cupons = [];

  for (let linha of linhas) {
    linha = linha.trim();
    if (!linha) continue;

    // Identifica se o cupom e exclusivo para Lojas Oficiais / Shopee Mall
    const ehLojaOficial = /LOJAS? OFICIAIS|SHOPEE MALL/i.test(linha);

    // Extrai desconto em porcentagem (ex: 20%)
    const pctMatch = linha.match(/(\d+)%/);
    const pctDesconto = pctMatch ? parseFloat(pctMatch[1]) / 100 : null;

    // Extrai desconto fixo em Reais (ex: R$30 OFF)
    const fixoMatch = linha.match(/R\$\s*(\d+)\s*OFF/i);
    const valorFixo = fixoMatch ? parseFloat(fixoMatch[1]) : null;

    // Extrai limite maximo de desconto (ex: COM LIMITE DE R$20 ou ATE R$20)
    const tetoMatch = linha.match(/(?:LIMITE DE|ATE)\s*R\$\s*(\d+)/i);
    const limiteMaximo = tetoMatch ? parseFloat(tetoMatch[1]) : null;

    // Extrai valor minimo da compra (ex: ACIMA DE R$299 ou ACIMA DE R$0)
    const minMatch = linha.match(/ACIMA DE\s*R\$\s*(\d+)/i);
    const valorMinimo = minMatch ? parseFloat(minMatch[1]) : 0;

    cupons.push({
      regraTexto: linha,
      porcentagem: pctDesconto,
      valorFixo: valorFixo,
      limiteMaximo: limiteMaximo,
      valorMinimo: valorMinimo,
      apenasLojaOficial: ehLojaOficial
    });
  }

  return cupons;
}

/**
 * Calcula qual o melhor cupom aplicavel para determinado valor e tipo de loja
 * @param {number} precoOriginal - Preco do produto
 * @param {boolean} isLojaOficial - Se e loja oficial / Shopee Mall
 */
function calcularMelhorCupom(precoOriginal, isLojaOficial = false) {
  if (!cuponsAtivos || cuponsAtivos.length === 0) {
    return null;
  }

  let melhorDesconto = 0;
  let melhorCupom = null;

  for (const cupom of cuponsAtivos) {
    // Verifica restricao de loja oficial
    if (cupom.apenasLojaOficial && !isLojaOficial) {
      continue;
    }

    // Verifica valor minimo da compra
    if (precoOriginal < cupom.valorMinimo) {
      continue;
    }

    let descontoCalculado = 0;

    // Cupom em porcentagem
    if (cupom.porcentagem) {
      descontoCalculado = precoOriginal * cupom.porcentagem;
      // Aplica o teto de desconto, se houver
      if (cupom.limiteMaximo && descontoCalculado > cupom.limiteMaximo) {
        descontoCalculado = cupom.limiteMaximo;
      }
    } 
    // Cupom em valor fixo
    else if (cupom.valorFixo) {
      descontoCalculado = cupom.valorFixo;
    }

    // O desconto nao pode exceder o preco do produto
    if (descontoCalculado > precoOriginal) {
      descontoCalculado = precoOriginal;
    }

    // Guarda sempre o cupom que dá a MAIOR economia em Reais
    if (descontoCalculado > melhorDesconto) {
      melhorDesconto = descontoCalculado;
      melhorCupom = {
        ...cupom,
        valorDesconto: descontoCalculado,
        precoFinal: precoOriginal - descontoCalculado
      };
    }
  }

  return melhorCupom;
}

// ------------------------------------------------------------------
// COMANDOS DO BOT
// ------------------------------------------------------------------

// Handler para cadastrar os cupons ao enviar a mensagem com #ativar
bot.hears(/#ativar/i, (ctx) => {
  const textoMensagem = ctx.message.text;
  cuponsAtivos = processarListaCupons(textoMensagem);

  let resposta = `✅ *${cuponsAtivos.length} Cupons Ativados com Sucesso!*\n\n`;
  cuponsAtivos.forEach((c, idx) => {
    resposta += `*${idx + 1}.* ${c.regraTexto}\n`;
  });

  return ctx.replyWithMarkdown(resposta);
});

// Handler para testar o calculo do cupom manualmente no Telegram
// Exemplo: /testar 350 oficial ou /testar 150
bot.command('testar', (ctx) => {
  const args = ctx.message.text.split(' ');
  const preco = parseFloat(args[1]);
  const isOficial = args[2] && args[2].toLowerCase() === 'oficial';

  if (isNaN(preco)) {
    return ctx.reply('⚠️ Use o comando informando o valor. Exemplo: `/testar 350 oficial`', { parse_mode: 'Markdown' });
  }

  const resultado = calcularMelhorCupom(preco, isOficial);

  if (!resultado) {
    return ctx.reply(`❌ Nenhum cupom aplicável para R$ ${preco.toFixed(2)} ${isOficial ? '(Loja Oficial)' : ''}.`);
  }

  const msg = `🏷️ *Melhor Cupom Encontrado!*\n\n` +
              `💰 *Preço Original:* R$ ${preco.toFixed(2)}\n` +
              `🔻 *Desconto:* R$ ${resultado.valorDesconto.toFixed(2)}\n` +
              `🔥 *Preço Final:* R$ ${resultado.precoFinal.toFixed(2)}\n` +
              `📌 *Regra Aplicada:* ${resultado.regraTexto}`;

  return ctx.replyWithMarkdown(msg);
});

// Exporta as funcoes/bot para servicos serverless/webhooks (Render, Netlify, etc)
module.exports = {
  bot,
  processarListaCupons,
  calcularMelhorCupom
};

// Se executado localmente ou em servidor continuo
if (require.main === module) {
  bot.launch().then(() => console.log('🤖 Bot iniciado e pronto para receber comandos!'));
}
