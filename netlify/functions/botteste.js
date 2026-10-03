const { Telegraf } = require('telegraf');

// Token do seu bot
const bot = new Telegraf('8602408215:AAEBMp1TABQfPth6e8D_TW6EoAJrQh4Wbcs');

// Lista padrão de cupons ativos (salva fixo para nao perder na memoria da Netlify)
let cuponsAtivos = [
  {
    regraTexto: "R$30 OFF EM COMPRAS ACIMA DE R$299 TODAS AS LOJAS",
    porcentagem: null,
    valorFixo: 30,
    limiteMaximo: null,
    valorMinimo: 299,
    apenasLojaOficial: false
  },
  {
    regraTexto: "R$90 OFF EM COMPRAS ACIMA DE R$899 TODAS AS LOJAS",
    porcentagem: null,
    valorFixo: 90,
    limiteMaximo: null,
    valorMinimo: 899,
    apenasLojaOficial: false
  },
  {
    regraTexto: "20% OFF EM COMPRAS ACIMA DE R$0 COM LIMITE DE R$20 LOJAS OFICIAIS",
    porcentagem: 0.20,
    valorFixo: null,
    limiteMaximo: 20,
    valorMinimo: 0,
    apenasLojaOficial: true
  }
];

// Processa a mensagem #ativar caso queira atualizar dinamicamente
function processarListaCupons(textoMensagem) {
  const textoLimpo = textoMensagem.replace(/#ativar/i, '').trim();
  const linhas = textoLimpo.split('\n');
  const cupons = [];

  for (let linha of linhas) {
    linha = linha.trim();
    if (!linha) continue;

    const ehLojaOficial = /LOJAS? OFICIAIS|SHOPEE MALL/i.test(linha);
    const pctMatch = linha.match(/(\d+)%/);
    const pctDesconto = pctMatch ? parseFloat(pctMatch[1]) / 100 : null;
    const fixoMatch = linha.match(/R\$\s*(\d+)\s*OFF/i);
    const valorFixo = fixoMatch ? parseFloat(fixoMatch[1]) : null;
    const tetoMatch = linha.match(/(?:LIMITE DE|ATE)\s*R\$\s*(\d+)/i);
    const limiteMaximo = tetoMatch ? parseFloat(tetoMatch[1]) : null;
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

// Calcula o melhor cupom para um valor
function calcularMelhorCupom(precoOriginal, isLojaOficial = false) {
  if (!cuponsAtivos || cuponsAtivos.length === 0) return null;

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

// Resposta ao comando /start ou oi
bot.start((ctx) => ctx.reply('🤖 Olá! O bot está ativo na Netlify! Envie /testar 100 oficial para testar um produto.'));

// Handler para #ativar
bot.hears(/#ativar/i, (ctx) => {
  const novosCupons = processarListaCupons(ctx.message.text);
  if (novosCupons.length > 0) {
    cuponsAtivos = novosCupons;
  }
  
  let resposta = `✅ *${cuponsAtivos.length} Cupons Ativos no Bot!*\n\n`;
  cuponsAtivos.forEach((c, idx) => {
    resposta += `*${idx + 1}.* ${c.regraTexto}\n`;
  });

  return ctx.replyWithMarkdown(resposta);
});

// Handler para /testar
bot.command('testar', (ctx) => {
  const args = ctx.message.text.split(' ');
  const preco = parseFloat(args[1]);
  const isOficial = args[2] && args[2].toLowerCase() === 'oficial';

  if (isNaN(preco)) {
    return ctx.reply('⚠️ Use: `/testar 350 oficial` ou `/testar 100`', { parse_mode: 'Markdown' });
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

// Responde a qualquer mensagem de texto comum para testar conexão
bot.on('text', (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  return ctx.reply(`🤖 Recebi sua mensagem: "${ctx.message.text}". O bot está ligado! Use /testar 100 oficial para calcular cupons.`);
});

// ESTRUTURA SERVERLESS DA NETLIFY
exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'POST' && event.body) {
      const update = JSON.parse(event.body);
      await bot.handleUpdate(update);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }
    return { statusCode: 200, body: 'Bot Netlify OK' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.toString() };
  }
};
