const { Telegraf } = require('telegraf');
const axios = require('axios');

// Inicializa o bot utilizando o TOKEN fornecido
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '8602408215:AAEBMp1TABQfPth6e8D_TW6EoAJrQh4Wbcs');

// Armazena os cupons ativos em memória durante a execução contínua
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

    // Valor mínimo de compra
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
 * Função para seguir o link encurtado (promodegrazi / shope.ee) e verificar no HTML se é Loja Oficial
 */
async function verificarSeEhLojaOficial(url) {
  try {
    // Faz a requisição seguindo os redirecionamentos
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      },
      maxRedirects: 5,
      timeout: 8000
    });

    const htmlContent = response.data || '';
    const finalUrl = response.request.res.responseUrl || url;

    // Busca indícios de Loja Oficial no HTML ou na URL final
    const termoMatch = /shopee\s*mall|loja\s*oficial|official\s*store|vendedor_oficial/i.test(htmlContent) ||
                       /official|mall/i.test(finalUrl);

    return termoMatch;
  } catch (error) {
    console.error('Erro ao verificar link da loja:', error.message);
    return false; // Se der falha de timeout, trata como loja comum por segurança
  }
}

/**
 * Calcula o melhor cupom aplicável ao produto
 */
function calcularMelhorCupom(precoOriginal, isLojaOficial = false) {
  if (!cuponsAtivos || cuponsAtivos.length === 0) {
    return null;
  }

  let melhorDesconto = 0;
  let melhorCupom = null;

  for (const cupom of cuponsAtivos) {
    if (cupom.apenasLojaOficial && !isLojaOficial) {
      continue;
    }

    if (precoOriginal < cupom.valorMinimo) {
      continue;
    }

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
// HANDLERS DO TELEGRAM (EXECUTADOS EM SERVIDOR CONTÍNUO)
// ------------------------------------------------------------------

// Handler para registrar os cupons enviados com #ativar
bot.hears(/#ativar/i, (ctx) => {
  const textoMensagem = ctx.message.text;
  cuponsAtivos = processarListaCupons(textoMensagem);

  let resposta = `✅ *${cuponsAtivos.length} Cupons Ativados com Sucesso!*\n\n`;
  cuponsAtivos.forEach((c, idx) => {
    resposta += `*${idx + 1}.* ${c.regraTexto}\n`;
  });

  return ctx.replyWithMarkdown(resposta);
});

// Handler automático que recebe as mensagens com links de produtos
bot.on('text', async (ctx, next) => {
  const texto = ctx.message.text;

  // Ignora mensagens de comando ou ativador
  if (texto.startsWith('/') || texto.toLowerCase().includes('#ativar')) {
    return next();
  }

  // Identifica links na mensagem do produto (ex: promodegrazi.com.br, shope.ee, etc)
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const links = texto.match(urlRegex);

  // Extrai o preço do produto na mensagem (ex: R$ 150,00 ou R$150)
  const precoMatch = texto.match(/R\$\s*([\d\.,]+)/i);

  if (precoMatch) {
    const precoString = precoMatch[1].replace('.', '').replace(',', '.');
    const precoOriginal = parseFloat(precoString);

    let ehLojaOficial = false;

    // Se houver um link de produto na mensagem, verifica na web se é de Loja Oficial
    if (links && links.length > 0) {
      ehLojaOficial = await verificarSeEhLojaOficial(links[0]);
    }

    // Calcula o melhor cupom entre os que estão salvos na memória
    const cupomAplicado = calcularMelhorCupom(precoOriginal, ehLojaOficial);

    if (cupomAplicado) {
      let mensagemAtualizada = texto + `\n\n🔥 *Com Cupom:* R$ ${cupomAplicado.precoFinal.toFixed(2).replace('.', ',')}` +
                                `\n📌 *Cupom Aplicado:* ${cupomAplicado.regraTexto}`;

      return ctx.replyWithMarkdown(mensagemAtualizada);
    }
  }

  return next();
});

// Inicializa o servidor contínuo (Render / Node.js)
bot.launch().then(() => {
  console.log('🤖 Bot iniciado com sucesso em modo contínuo!');
});

// Permite parada limpa do processo
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
