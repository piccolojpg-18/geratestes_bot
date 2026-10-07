# Monitor Shopee -> Telegram

Monitora:
- https://promosdarafa.com.br/lojas/shopee
- https://promosdaluh.com/ofertas.html

O programa:
1. abre as páginas com Playwright;
2. encontra páginas de ofertas;
3. entra nas páginas e verifica se a loja é Shopee;
4. extrai o link real da Shopee (priorizando "Pegar promoção");
5. evita duplicatas;
6. envia a novidade para seu bot do Telegram.

## 1. Instalação

No Windows:

```powershell
py -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
```

## 2. Configuração

Copie `.env.example` para `.env` ou configure as variáveis no terminal:

```powershell
$env:TELEGRAM_BOT_TOKEN="SEU_TOKEN"
$env:TELEGRAM_CHAT_ID="SEU_CHAT_ID"
$env:CHECK_INTERVAL_SECONDS="60"
```

O projeto não lê `.env` automaticamente; para simplicidade, as variáveis podem ser configuradas no terminal ou no Windows.

## 3. Rodar

```powershell
python monitor.py
```

Na primeira execução, por padrão, as ofertas já existentes são apenas cadastradas e NÃO são enviadas. A partir daí, somente novas ofertas são enviadas.

## Telegram

Crie o bot pelo @BotFather e coloque o token em `TELEGRAM_BOT_TOKEN`.

Para receber em um grupo/canal, adicione o bot ao destino e use o respectivo `chat_id` em `TELEGRAM_CHAT_ID`.

Não compartilhe o token do bot publicamente.
