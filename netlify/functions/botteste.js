const { Telegraf } = require('telegraf');

// Inicialize seu bot com o TOKEN fornecido pelo @BotFather
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Variável para armazenar os cupons ativos em memória
let cuponsAtivos = [];

/**
 * Função para extrair e interpretar a lista de cupons enviada no modelo:
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

    // Identifica se o cupom é exclusivo para Lojas Oficiais (Shopee Mall)
    const ehLojaOficial = /LOJAS? OFICIAIS|SHOPEE MALL/i.test(linha);

    // Extrai desconto em porcentagem (ex: 20%)
    const pctMatch = linha.match(/(\d+)%/);
    const pctDesconto = pctMatch ? parseFloat(pctMatch[1]) / 100 : null;

    // Extrai desconto fixo em Reais (ex: R$30 ou R$ 30)
    const fixoMatch = linha.match(/R\$\s*(\d+)\s*OFF/i);
    const valorFixo = fixoMatch ? parseFloat(fixoMatch[1]) : null;

    // Extrai limite máximo do desconto (ex: COM LIMITE DE R$20 ou ATE R$20)
    const tetoMatch = linha.match(/(?:LIMITE DE|ATE)\s*R\$\s*(\d+)/i);
    const limiteMaximo = tetoMatch ? parseFloat(tetoMatch[1]) : null;

    // Extrai valor mínimo de compra (ex: ACIMA DE R$299)
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
 * Função para calcular o melhor cupom aplicável a um determinado produto
 * @param {number} precoOriginal - Preço atual do produto
 * @param {boolean} isLojaOficial - Se o vendedor é Loja Oficial / Shopee Mall
 */
function calcularMelhorCupom(precoOriginal, isLojaOficial = false) {
  if (!cuponsAtivos || cuponsAtivos.length === 0) {
    return null;
  }

  let melhorDesconto = 0;
  let melhorCupom = null;

  for (const cupom of cuponsAtivos) {
    // Valida se o produto atende ao requisito de Loja Oficial
    if (cupom.apenasLojaOficial && !isLojaOficial) {
      continue;
    }

    // Valida se o valor do produto atinge o mínimo exigido pelo cupom
    if (precoOriginal < cupom.valorMinimo) {
      continue;
    }

    let descontoCalculado = 0;

    // Cálculo se for Cupom de Porcentagem
    if (cupom.porcentagem) {
      descontoCalculado = precoOriginal * cupom.porcentagem;
      // Aplica o teto/limite de desconto, se houver
      if (cupom.limiteMaximo && descontoCalculado > cupom.limiteMaximo) {
        descontoCalculado = cupom.limiteMaximo;
      }
    } 
    // Cálculo se for Cupom de Valor Fixo
    else if (cupom.valorFixo) {
      descontoCalculado = cupom.valorFixo;
    }

    // Garante que o desconto não seja maior que o preço total do produto
    if (descontoCalculado > precoOriginal) {
      descontoCalculado = precoOriginal;
    }

    // Compara para guardar sempre o cupom que concede O MAIOR desconto em R$
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
// HANDLERS DO TELEGRAM BOT
// ------------------------------------------------------------------

// Handler para registrar e ativar a lista de cupons via #ativar
bot.hears(/#ativar/i, (ctx) => {
  const textoMensagem = ctx.message.text;
  cuponsAtivos = processarListaCupons(textoMensagem);

  let resposta = `✅ *${cuponsAtivos.length} Cupons Ativados com Sucesso!*\n\n`;
  cuponsAtivos.forEach((c, idx) => {
    resposta += `*${idx + 1}.* ${c.regraTexto}\n`;
  });

  return ctx.replyWithMarkdown(resposta);
});

// Exemplo de Handler para testar um preço manualmente
// Envie no chat: /testar 350 oficial (ou /testar 350)
bot.command('testar', (ctx) => {
  const args = ctx.message.text.split(' ');
  const preco = parseFloat(args[1]);
  const isOficial = args[2] && args[2].toLowerCase() === 'oficial';

  if (isNaN(preco)) {
    return ctx.reply('⚠️ Por favor, informe um valor válido. Exemplo: `/testar 350 oficial`', { parse_mode: 'Markdown' });
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

// Exporta o handler para uso no Netlify / Serverless / Render
module.exports = {
  bot,
  processarListaCupons,
  calcularMelhorCupom
};

// Se executado diretamente em ambiente Node local:
if (require.main === module) {
  bot.launch().then(() => console.log('🤖 Bot rodando com sucesso!'));
}
