const Jimp = require('jimp');

// Memória em escopo global da Lambda
let cuponsAtivos = [];

exports.handler = async (event) => {
    // ---------------------------------------------------------------------
    // 1. CREDENCIAIS E CONFIGURAÇÕES DE TESTE
    // ---------------------------------------------------------------------
    // Token do seu novo Bot de testes
    const TELEGRAM_TOKEN = (process.env.TELEGRAM_TOKEN || "8602408215:AAEBMp1TABQfPth6e8D_TW6EoAJrQh4Wbcs").trim();

    // ---------------------------------------------------------------------
    // 2. FUNÇÃO DE EXTRAÇÃO DE DADOS DA SHOPEE
    // ---------------------------------------------------------------------
    async function obterDadosShopee(url) {
        try {
            // Resolve links encurtados ou de redirecionamento (ex: promodegrazi, s.shopee)
            let urlFinal = url;
            try {
                const resRedir = await fetch(url, { method: 'HEAD', redirect: 'follow' });
                if (resRedir.url) urlFinal = resRedir.url;
            } catch (e) {
                console.warn("⚠️ Não foi possível seguir o redirecionamento HEAD, usando URL original.");
            }

            // Busca os IDs da loja (shopid) e produto (itemid) na URL
            const matchIds = urlFinal.match(/i\.(\d+)\.(\d+)/) || urlFinal.match(/\/(\d+)\/(\d+)/);
            
            let shopid = null;
            let itemid = null;

            if (matchIds) {
                shopid = matchIds[1];
                itemid = matchIds[2];
            } else {
                const urlObj = new URL(urlFinal);
                shopid = urlObj.searchParams.get("shopid");
                itemid = urlObj.searchParams.get("itemid");
            }

            if (!shopid || !itemid) {
                console.error("❌ Não foi possível extrair shopid e itemid da URL:", urlFinal);
                return null;
            }

            // Consulta a API interna/pública da Shopee
            const apiUrl = `https://shopee.com.br/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`;
            const res = await fetch(apiUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            
            const data = await res.json();
            if (data && data.data) {
                const item = data.data;
                return {
                    titulo: item.title || item.name,
                    // A Shopee retorna o preço multiplicado por 100.000
                    precoExato: item.price ? item.price / 100000 : null,
                    isOficial: !!(item.is_official_shop || item.shopee_verified)
                };
            }
        } catch (err) {
            console.error("❌ Erro ao consultar a API da Shopee:", err);
        }
        return null;
    }

    // ---------------------------------------------------------------------
    // 3. FUNÇÕES AUXILIARES DE IMAGEM E TELEGRAM
    // ---------------------------------------------------------------------

    async function baixarFotoTelegram(fileId) {
        try {
            const resFile = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
            const dataFile = await resFile.json();
            
            if (dataFile.ok && dataFile.result && dataFile.result.file_path) {
                const urlDownload = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${dataFile.result.file_path}`;
                const resImg = await fetch(urlDownload);
                const arrayBuffer = await resImg.arrayBuffer();
                return Buffer.from(arrayBuffer);
            }
        } catch (err) {
            console.error("❌ Erro ao baixar foto do Telegram:", err);
        }
        return null;
    }

    async function cortarImagemProduto(bufferOriginal) {
        try {
            const image = await Jimp.read(bufferOriginal);
            const largura = image.getWidth();
            const altura = image.getHeight();

            const pctTopo = 0.10;
            const pctBase = 0.32;
            const pctEsquerda = 0.10;
            const pctDireita = 0.10;

            const inicioX = Math.floor(largura * pctEsquerda);
            const inicioY = Math.floor(altura * pctTopo);

            const novaLargura = largura - Math.floor(largura * pctEsquerda) - Math.floor(largura * pctDireita);
            const novaAltura = altura - Math.floor(altura * pctTopo) - Math.floor(altura * pctBase);

            image.crop(inicioX, inicioY, novaLargura, novaAltura);

            return await image.getBufferAsync(Jimp.MIME_JPEG);
        } catch (err) {
            console.error("❌ Erro no processamento do Jimp:", err);
            return bufferOriginal;
        }
    }

    async function enviarFotoTelegram(chatId, bufferFoto, legenda) {
        try {
            const { default: fetch } = await import('node-fetch');
            const FormData = (await import('form-data')).default;

            const form = new FormData();
            form.append('chat_id', chatId);
            form.append('photo', bufferFoto, { filename: 'oferta.jpg', contentType: 'image/jpeg' });
            form.append('caption', legenda);
            form.append('parse_mode', 'Markdown');

            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
                method: 'POST',
                body: form
            });
        } catch (err) {
            console.error(`❌ Erro foto Telegram (${chatId}):`, err);
        }
    }

    async function enviarTextoTelegram(chatId, texto) {
        try {
            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown' })
            });
        } catch (err) {
            console.error(`❌ Erro texto Telegram (${chatId}):`, err);
        }
    }

    // ---------------------------------------------------------------------
    // 4. TRATAMENTO DO WEBHOOK / MENSAGEM RECEBIDA
    // ---------------------------------------------------------------------
    if (event.httpMethod === "POST") {
        let body = {};
        try {
            body = JSON.parse(event.body || "{}");
        } catch (e) {
            return { statusCode: 400, body: "JSON Inválido" };
        }

        const message = body.message || body;
        if (!message) return { statusCode: 200, body: "Sem mensagem" };

        const textoOriginal = message.text || message.caption || "";
        const chatOrigemId = message.chat ? String(message.chat.id) : null;

        if (!chatOrigemId) return { statusCode: 200, body: "Sem chat de origem" };

        let fileIdFoto = null;
        if (message.photo && message.photo.length > 0) {
            fileIdFoto = message.photo[message.photo.length - 1].file_id;
        }

        // -----------------------------------------------------------------
        // CASO 1: ATIVAÇÃO DE CUPONS (#ativar)
        // -----------------------------------------------------------------
        if (/#ativar/i.test(textoOriginal)) {
            cuponsAtivos = [];

            const linhas = textoOriginal.split('\n');
            for (let linha of linhas) {
                const matchFixo = linha.match(/R\$\s*([\d.,]+)\s*OFF.*ACIMA DE\s*R\$\s*([\d.,]+)/i);
                const matchPorcentagem = linha.match(/([\d.,]+)%\s*OFF(?:.*LIMITE DE\s*R\$\s*([\d.,]+))?/i);

                if (matchFixo) {
                    cuponsAtivos.push({
                        tipo: 'FIXO',
                        desconto: parseFloat(matchFixo[1].replace(',', '.')),
                        minimo: parseFloat(matchFixo[2].replace(',', '.')),
                        textoCupom: `R$${matchFixo[1]} OFF`
                    });
                } else if (matchPorcentagem) {
                    cuponsAtivos.push({
                        tipo: 'PORCENTAGEM',
                        pct: parseFloat(matchPorcentagem[1].replace(',', '.')),
                        limite: matchPorcentagem[2] ? parseFloat(matchPorcentagem[2].replace(',', '.')) : Infinity,
                        textoCupom: `ATIVE ${matchPorcentagem[1]}% OFF`
                    });
                }
            }

            await enviarTextoTelegram(chatOrigemId, `🚀 *[MODO TESTE]* Cupons ativados com sucesso! Total: ${cuponsAtivos.length}`);
            return { statusCode: 200, body: "Cupons Ativados" };
        }

        // -----------------------------------------------------------------
        // CASO 2: PROCESSAMENTO DE PRODUTO
        // -----------------------------------------------------------------
        const links = textoOriginal.match(/https?:\/\/[^\s]+/g) || [];
        const matchPor = textoOriginal.match(/por\s*R\$\s*([\d.]+,\d{2})/i);

        let valorBase = null;
        let titulo = textoOriginal.split('\n')[0].trim();
        let eLojaOficial = false;

        // Tenta extrair diretamente da Shopee se houver link
        if (links[0]) {
            await enviarTextoTelegram(chatOrigemId, "🔍 *[TESTE]* Consultando produto na Shopee...");
            const dadosShopee = await obterDadosShopee(links[0]);
            
            if (dadosShopee && dadosShopee.precoExato) {
                valorBase = dadosShopee.precoExato;
                if (dadosShopee.titulo) titulo = dadosShopee.titulo;
                eLojaOficial = dadosShopee.isOficial;
            }
        }

        // Fallback para regex
        if (!valorBase && matchPor) {
            valorBase = parseFloat(matchPor[1].replace(/\./g, '').replace(',', '.'));
        }

        if (valorBase) {
            let maiorDescontoBRL = 0;
            let cupomNome = "";

            if (cuponsAtivos.length > 0) {
                for (let cupom of cuponsAtivos) {
                    let descontoTeste = 0;

                    if (cupom.tipo === 'PORCENTAGEM') {
                        descontoTeste = valorBase * (cupom.pct / 100);
                        if (descontoTeste > cupom.limite) descontoTeste = cupom.limite;
                    } else if (cupom.tipo === 'FIXO') {
                        if (valorBase >= cupom.minimo) descontoTeste = cupom.desconto;
                    }

                    if (descontoTeste > maiorDescontoBRL) {
                        maiorDescontoBRL = descontoTeste;
                        cupomNome = cupom.textoCupom;
                    }
                }
            }

            let valorPorFinal = valorBase - maiorDescontoBRL;
            let pctSorteada = Math.floor(Math.random() * (79 - 30 + 1)) + 30;
            let valorDeFicticio = valorPorFinal * (1 + (pctSorteada / 100));
            let pctExibida = Math.round(((valorDeFicticio - valorPorFinal) / valorDeFicticio) * 100);

            const formatar = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

            let seloOficial = eLojaOficial ? " 🏆 *(LOJA OFICIAL)*" : "";
            let resposta = `${titulo}${seloOficial}\n\n`;
            resposta += `💸💸 ~~de ${formatar(valorDeFicticio)}~~\n`;
            resposta += `por ${formatar(valorPorFinal)} 🔥\n`;
            resposta += `✨ ${pctExibida}% de desconto! 🔥\n\n`;

            if (cupomNome) {
                resposta += `🎟️Use o cupom: ${cupomNome}\n\n`;
            }

            if (links[0]) resposta += `Compre aqui: ${links[0]}\n\n`;

            const temDesativar = /#desativar/i.test(textoOriginal);
            if (!temDesativar) {
                if (links[1]) {
                    resposta += `🚨 Ative os cupons do dia aqui: ${links[1]}`;
                } else {
                    resposta += `🚨 Ative os cupons do dia aqui: https://s.shopee.com.br/z2ECVAKV`;
                }
            }

            resposta = resposta.trim();

            let bufferCortado = null;
            if (fileIdFoto) {
                const bufferOriginal = await baixarFotoTelegram(fileIdFoto);
                if (bufferOriginal) {
                    bufferCortado = await cortarImagemProduto(bufferOriginal);
                }
            }

            // ENVIO EXCLUSIVO DE RETORNO PARA O PRÓPRIO CHAT DE TESTE
            if (bufferCortado) {
                await enviarFotoTelegram(chatOrigemId, bufferCortado, resposta);
            } else {
                await enviarTextoTelegram(chatOrigemId, resposta);
            }
        } else {
            await enviarTextoTelegram(chatOrigemId, "❌ *[TESTE]* Não foi possível identificar o valor do produto nem extrair dados da URL.");
        }

        return { statusCode: 200, body: "OK" };
    }

    return { statusCode: 200, body: "Servidor Ativo em Modo Teste" };
};
