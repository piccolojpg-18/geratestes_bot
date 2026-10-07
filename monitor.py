import asyncio
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright


SITES = [
    {
        "name": "Promos da Rafa",
        "base": "https://promosdarafa.com.br",
        "listing": "https://promosdarafa.com.br/lojas/shopee",
    },
    {
        "name": "Promos da Luh",
        "base": "https://promosdaluh.com",
        "listing": "https://promosdaluh.com/ofertas.html",
    },
]

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
CHECK_INTERVAL = int(os.getenv("CHECK_INTERVAL_SECONDS", "60"))
SEED_EXISTING = os.getenv("SEED_EXISTING", "true").lower() in {"1", "true", "yes", "sim"}
STATE_FILE = Path(os.getenv("STATE_FILE", "enviados.json"))
MAX_CANDIDATES_PER_SITE = int(os.getenv("MAX_CANDIDATES_PER_SITE", "40"))

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/140.0 Safari/537.36"
    )
}


def load_state():
    if not STATE_FILE.exists():
        return set()
    try:
        return set(json.loads(STATE_FILE.read_text(encoding="utf-8")))
    except Exception:
        return set()


def save_state(state):
    STATE_FILE.write_text(
        json.dumps(sorted(state), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def normalize_url(url):
    if not url:
        return ""
    url = url.strip()
    # Remove fragments; tracking query parameters are intentionally preserved
    # because affiliate/redirect links can depend on them.
    p = urlparse(url)
    return p._replace(fragment="").geturl()


def fingerprint(source, page_url, shopee_url):
    raw = f"{source}|{page_url}|{shopee_url}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def looks_like_detail(url, site):
    if not url or url.startswith(("mailto:", "javascript:", "#")):
        return False
    p = urlparse(url)
    if p.netloc and p.netloc != urlparse(site["base"]).netloc:
        return False
    path = p.path.lower()

    if "promosdarafa" in site["base"]:
        return "/p/" in path

    # Promos da Luh can change its route names, so accept likely offer/product
    # paths and reject obvious navigation/legal/static paths.
    bad = ("/cupom", "/sobre", "/privacidade", "/termos", "/bombando",
           ".js", ".css", ".png", ".jpg", ".jpeg", ".webp", ".svg")
    if any(x in path for x in bad):
        return False
    return path not in ("", "/", "/ofertas.html")


def is_shopee_text(text):
    return "shopee" in (text or "").lower()


def extract_shopee_link(soup, page_url):
    candidates = []

    # Prefer the actual "Pegar promoção" link.
    for a in soup.find_all("a", href=True):
        label = " ".join(a.stripped_strings).lower()
        href = normalize_url(urljoin(page_url, a["href"]))
        if not href:
            continue

        host = urlparse(href).netloc.lower()
        if "shopee" in host or "shopee" in href.lower():
            score = 0
            if "pegar promoção" in label or "pegar promocao" in label:
                score += 100
            if "s.shopee" in host or "shopee.com.br" in host:
                score += 20
            candidates.append((score, href))

    if candidates:
        candidates.sort(reverse=True)
        return candidates[0][1]

    return ""


def extract_title(soup):
    h1 = soup.find("h1")
    if h1:
        return " ".join(h1.stripped_strings)
    if soup.title:
        return soup.title.get_text(" ", strip=True)
    return "Oferta Shopee"


def extract_price(soup):
    text = soup.get_text(" ", strip=True)
    # Simple display-only extraction; the Telegram message only needs the link.
    import re
    m = re.search(r"R\$\s*[\d.]+,\d{2}", text)
    return m.group(0) if m else ""


def extract_coupon(soup):
    text = soup.get_text(" ", strip=True)
    import re
    patterns = [
        r"(ATIVE(?:\s+O)?\s+CUPOM[^.]{0,80})",
        r"(CUPOM[^.]{0,80})",
        r"(\d{1,3}%\s*OFF[^.]{0,50})",
        r"(R\$\s*\d+\s*OFF[^.]{0,50})",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, re.I)
        if m:
            return m.group(1).strip()
    return ""


async def collect_candidate_urls(page, site):
    await page.goto(site["listing"], wait_until="domcontentloaded", timeout=45000)
    try:
        await page.wait_for_load_state("networkidle", timeout=10000)
    except Exception:
        pass
    await page.wait_for_timeout(2500)

    hrefs = await page.locator("a[href]").evaluate_all(
        """els => els.map(a => ({
            href: a.href,
            text: (a.innerText || '').trim()
        }))"""
    )

    result = []
    seen = set()

    for item in hrefs:
        url = normalize_url(item.get("href", ""))
        if not looks_like_detail(url, site):
            continue
        if url in seen:
            continue
        seen.add(url)
        result.append(url)

    return result[:MAX_CANDIDATES_PER_SITE]


async def inspect_offer(context, site, url):
    page = await context.new_page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        try:
            await page.wait_for_load_state("networkidle", timeout=6000)
        except Exception:
            pass

        html = await page.content()
        soup = BeautifulSoup(html, "html.parser")
        text = soup.get_text(" ", strip=True)

        if not is_shopee_text(text):
            return None

        shopee_url = extract_shopee_link(soup, page.url)
        if not shopee_url:
            return None

        return {
            "source": site["name"],
            "page_url": normalize_url(page.url),
            "shopee_url": shopee_url,
            "title": extract_title(soup),
            "price": extract_price(soup),
            "coupon": extract_coupon(soup),
        }
    except Exception as e:
        print(f"[ERRO] {site['name']} -> {url}: {e}")
        return None
    finally:
        await page.close()


def telegram_send(message):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    r = requests.post(
        url,
        json={
            "chat_id": CHAT_ID,
            "text": message,
            "disable_web_page_preview": False,
        },
        timeout=20,
    )
    r.raise_for_status()


def format_message(offer):
    # O pedido principal é enviar os links. Título/fonte ajudam a identificar
    # a origem sem transformar a mensagem em um anúncio diferente.
    return (
        f"🛍️ Shopee\n\n"
        f"{offer['title']}\n\n"
        f"🔗 {offer['shopee_url']}\n"
        f"📌 Fonte: {offer['source']}"
    )


async def main():
    if not BOT_TOKEN or not CHAT_ID:
        raise SystemExit(
            "Configure TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID antes de executar."
        )

    state = load_state()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=HEADERS["User-Agent"],
            locale="pt-BR",
        )

        first_cycle = True

        try:
            while True:
                print("\n" + "=" * 60)
                print("Verificando ofertas Shopee...")

                discovered = []

                for site in SITES:
                    try:
                        page = await context.new_page()
                        urls = await collect_candidate_urls(page, site)
                        await page.close()

                        print(f"{site['name']}: {len(urls)} páginas candidatas")

                        # Inspect concurrently in small batches.
                        for i in range(0, len(urls), 8):
                            batch = urls[i:i + 8]
                            results = await asyncio.gather(
                                *(inspect_offer(context, site, u) for u in batch)
                            )
                            discovered.extend(x for x in results if x)
                    except Exception as e:
                        print(f"[ERRO] listagem {site['name']}: {e}")

                # Newest/current pages may appear in both sources. Deduplicate
                # primarily by the actual Shopee link.
                unique = {}
                for offer in discovered:
                    unique[offer["shopee_url"]] = offer

                new_offers = []
                for offer in unique.values():
                    key = fingerprint(
                        offer["source"],
                        offer["page_url"],
                        offer["shopee_url"],
                    )
                    offer["_key"] = key
                    if key not in state:
                        new_offers.append(offer)

                if first_cycle and SEED_EXISTING:
                    # First run: mark what is currently on the sites as seen,
                    # so you don't receive dozens of old promotions.
                    for offer in new_offers:
                        state.add(offer["_key"])
                    save_state(state)
                    print(
                        f"Primeira execução: {len(new_offers)} ofertas "
                        "marcadas como já vistas."
                    )
                else:
                    for offer in reversed(new_offers):
                        try:
                            telegram_send(format_message(offer))
                            state.add(offer["_key"])
                            print(f"[ENVIADO] {offer['title']}")
                            save_state(state)
                        except Exception as e:
                            print(f"[ERRO TELEGRAM] {e}")

                first_cycle = False
                print(f"Próxima verificação em {CHECK_INTERVAL}s.")
                await asyncio.sleep(CHECK_INTERVAL)

        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
