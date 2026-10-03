const { Telegraf } = require('telegraf');

// Token do bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '8602408215:AAEBMp1TABQfPth6e8D_TW6EoAJrQh4Wbcs');

// Armazena os cupons em memória
let cuponsAtivos = [];

/**
 * Processa a mensagem de ativação (#ativar)
 */
function processarListaCupons(textoMensagem) {
  const textoLimpo = textoMensagem.replace(/#ativar/i, '').trim();
  const linhas = textoLimpo.split('\n');
  const cupons = [];

  for (let linha of linhas) {
    linha = linha.trim();
    if (!linha) continue;

    const ehLojaOficial = /LOJAS? OFICIAIS|SHOPEE MALL/i.test(linha);

    // Desconto em %
    const pctMatch = linha.match(/(\d+)%/);
    const pctDesconto = pctMatch ? parseFloat(pctMatch[1]) / 100 : null;

    // Desconto fixo em R$
    const fixoMatch = linha.match(/R\$\s*(\d+)\s*OFF/i);
    const valorFixo = fixoMatch ? parseFloat(fixoMatch[1]) : null;

    // Teto / Limite de desconto
    const tetoMatch = linha.match(/(?:LIMITE DE|ATE)\s*R\$\s*(\d+)/i);
    const limiteMaximo = tetoMatch ? parseFloat(tetoMatch[1]) : null;

    // Valor mínimo
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
 * Calcula o melhor cupom para o produto
 */
function calcularMelhorCupom(precoOriginal, isLojaOficial = false) {
  if (!cuponsAtivos || cuponsAtivos.length === 0) {
    return null;
  }

  let melhorDesconto = 0;
  let melhorCupom = null;

  for (const cupom of cuponsAtivos) {
    if (cupom.apenasLojaOficial && !isLojaOficial) continue;
    if (precoOriginal < cupom.valorMinimo) continue;

    let descontoCalculado = 0;

    if (cupom.porcentagem) {
      descontoCalculado = precoOriginal * cupom.porcentagem;
      if (cupom.limiteMaximo && descontoCalculado > cupom.limiteMaximo) {
        descontoCalculado = cupom.limiteMaximo;
      }
    } else if (cupom.valorFixo) {
      descontoCalculado = cupom.valorFixo;
    }

    if (descontoCalculado > precoOriginal) {
      descontoCalculado = precoOriginal;
    }

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
// REGRAS DO TELEGRAM
// ------------------------------------------------------------------

bot.hears(/#ativar/i, (ctx) => {
  const textoMensagem = ctx.message.text;
  cuponsAtivos = processarListaCupons(textoMensagem);

  let resposta = `✅ *${cuponsAtivos.length} Cupons Ativados com Sucesso!*\n\n`;
  cuponsAtivos.forEach((c, idx) => {
    resposta += `*${idx + 1}.* ${c.regraTexto}\n`;
  });

  return ctx.replyWithMarkdown(resposta);
});

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

// ------------------------------------------------------------------
// ESTRUTURA HANDLER OBRIGATÓRIA DA NETLIFY (SERVERLESS)
// ------------------------------------------------------------------
exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'POST' && event.body) {
      const update = JSON.parse(event.body);
      await bot.handleUpdate(update);
      return { statusCode: 200, body: 'OK' };
    }
    return { statusCode: 200, body: 'Bot de testes está rodando!' };
  } catch (error) {
    console.error('Erro no processamento:', error);
    return { statusCode: 500, body: error.toString() };
  }
};
