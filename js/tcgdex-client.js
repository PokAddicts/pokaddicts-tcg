/* ==========================================================================
   PokAddicts - TCGdex API Client
   Replaces PokeWallet as the card catalog + pricing source. TCGdex is free,
   requires no API key, and has no meaningful rate limit (their own FAQ:
   "be considerate, cache locally" rather than a hard cap) - confirmed
   directly against the live API, not just docs:
   - Base URL: https://api.tcgdex.net/v2/{lang} (lang e.g. "en", "ja")
   - GET /sets -> brief list [{id, name, logo, symbol, cardCount}]
   - GET /sets/{id} -> full detail incl. releaseDate + ALL of that set's
     cards in one response (no pagination needed, unlike PokeWallet)
   - GET /cards/{id} -> full card detail incl. pricing (both TCGPlayer USD
     and CardMarket EUR, bundled directly - no separate price call needed)
   - GET /cards?name=like:X&localId=Y -> brief search results
   - Images: `${image}/${quality}.${ext}` - quality "low"|"high", ext
     "webp"|"png"|"jpg" (webp is much smaller - ~15KB vs ~165KB for a low
     quality png on the same card - so used for all in-app thumbnails).
   - Verified current: their newest English set ("Pitch Black") has a
     release date only ~2 weeks old, and a Japanese set's release date
     matched PokeWallet's own data for the same set exactly.
   Only English + Japanese are synced by card-catalog.js for now, matching
   the app's actual EN/JP scan-language toggle - TCGdex supports 10 more
   languages (fr/de/es/it/pt/zh-tw/id/th/ko/zh-cn) if that's ever wanted.
   ========================================================================== */

const TCGDEX_BASE_URL = 'https://api.tcgdex.net/v2';

class TCGdexClient {
  get configured() {
    return true; // no API key needed at all
  }

  async request(lang, path) {
    const res = await fetch(`${TCGDEX_BASE_URL}/${lang}${path}`);
    if (!res.ok) throw new Error(`TCGdex API error ${res.status}`);
    return res.json();
  }

  listSets(lang) {
    return this.request(lang, '/sets');
  }

  // Returns the full set detail, including releaseDate and every card in
  // the set in one response - no pagination/looping needed.
  getSetCards(setId, lang) {
    return this.request(lang, `/sets/${encodeURIComponent(setId)}`);
  }

  getCard(id, lang = 'en') {
    return this.request(lang, `/cards/${encodeURIComponent(id)}`);
  }

  // Brief search (id/localId/name/image only - no set name/total, see
  // card-search-ui.js's normalizeLiveSearchResult() for how that gets
  // filled in from already-synced local set metadata without an extra
  // request).
  async searchCards(query, { limit = 10, lang = 'en' } = {}) {
    const { namePart, numberPart } = window.cardCatalog ? window.cardCatalog.parseCardQuery(query) : { namePart: query, numberPart: null };
    // A pure-number query (namePart empty - e.g. searching by card number
    // alone, or the scanner's Japanese fallback search which deliberately
    // skips the name filter, see scanner.js) must NOT fall back to
    // filtering by the whole raw query as a "name" - a number is never a
    // substring of a card's name, so that silently returned zero results.
    const params = [];
    if (namePart) params.push(`name=like:${encodeURIComponent(namePart)}`);
    if (numberPart) params.push(`localId=${encodeURIComponent(numberPart)}`);
    if (params.length === 0) params.push(`name=like:${encodeURIComponent(query)}`);

    const results = await this.request(lang, `/cards?${params.join('&')}`);
    return (results || []).slice(0, limit);
  }

  // Returns the plain image URL directly - deliberately NOT fetched into a
  // blob URL. TCGdex's asset CDN (assets.tcgdex.net) sends no CORS headers
  // at all (confirmed directly: no Access-Control-Allow-Origin on the real
  // GET response, and a bare 405 on an OPTIONS preflight), so a fetch()
  // call to it is blocked outright by a real browser - curl and
  // server-side code (this app's own Edge Functions) don't enforce CORS,
  // which is exactly why this went unnoticed through every test so far
  // and only surfaced once a real device hit it. A plain <img src> load is
  // NOT subject to CORS the way fetch()/XHR is, so handing back the URL
  // directly (for the caller to drop straight into an <img> tag) is what
  // actually makes these images display, instead of silently failing and
  // leaving PokeWallet's rate-limited fallback to do ALL the real work.
  async getImageUrl(id, quality = 'low') {
    const cached = window.cardCatalog ? window.cardCatalog.getCardById(id) : null;
    let imageBase = cached?.image;

    if (!imageBase) {
      const lang = cached?.language || 'en';
      const detail = await this.getCard(id, lang).catch(() => null);
      imageBase = detail?.image;
    }
    if (!imageBase) return null;

    return `${imageBase}/${quality}.webp`;
  }

  // TCGPlayer (USD) is the primary figure, preferring the "normal"
  // sub-variant if present; falls back to CardMarket (EUR) average if a
  // card has no TCGPlayer listing at all (the norm for Japanese-only
  // cards, which TCGPlayer doesn't carry).
  extractMarketPrice(cardDetail) {
    const tcg = cardDetail?.pricing?.tcgplayer;
    if (tcg) {
      const subVariant = tcg.normal || Object.values(tcg).find(v => v && typeof v === 'object' && v.marketPrice);
      if (subVariant?.marketPrice) {
        return { price: subVariant.marketPrice, currency: 'USD', source: 'TCGPlayer' };
      }
    }

    const cm = cardDetail?.pricing?.cardmarket;
    if (cm?.avg) {
      return { price: cm.avg, currency: 'EUR', source: 'CardMarket' };
    }

    return { price: 0, currency: null, source: null };
  }

  extractMarketPriceSGD(cardDetail) {
    const { price, currency, source } = this.extractMarketPrice(cardDetail);
    if (price <= 0 || !currency) return { price: 0, source: null };
    const sgdPrice = window.fxRates.convertToSGD(price, currency);
    return { price: sgdPrice, source: `${source} (${currency}→SGD)` };
  }

  // Unlike extractMarketPrice() (one "best" price, TCGPlayer preferred),
  // this returns BOTH marketplace prices whenever TCGdex has them - the
  // two are genuinely different marketplaces (TCGPlayer is the US
  // secondary market, CardMarket is the EU one) and can diverge quite a
  // bit, so showing both lets the user judge for themselves rather than
  // silently picking one.
  extractAllMarketPrices(cardDetail) {
    const prices = [];

    const tcg = cardDetail?.pricing?.tcgplayer;
    if (tcg) {
      const subVariant = tcg.normal || Object.values(tcg).find(v => v && typeof v === 'object' && v.marketPrice);
      if (subVariant?.marketPrice) prices.push({ price: subVariant.marketPrice, currency: 'USD', source: 'TCGPlayer' });
    }

    const cm = cardDetail?.pricing?.cardmarket;
    if (cm?.avg) prices.push({ price: cm.avg, currency: 'EUR', source: 'CardMarket' });

    return prices;
  }

  extractAllMarketPricesSGD(cardDetail) {
    return this.extractAllMarketPrices(cardDetail).map(p => ({
      price: window.fxRates.convertToSGD(p.price, p.currency),
      source: `${p.source} (${p.currency}→SGD)`
    }));
  }

  // Unlike extractMarketPrice() (one "best" price), this returns every
  // sellable sub-variant (Normal, Reverse Holofoil, 1st Edition Holofoil,
  // etc.) with its own price - the same card/set/number can have very
  // different market values depending on which finish the physical copy
  // actually is.
  extractAllVariants(cardDetail) {
    const variants = [];

    const tcg = cardDetail?.pricing?.tcgplayer;
    if (tcg) {
      for (const [key, v] of Object.entries(tcg)) {
        if (v && typeof v === 'object' && v.marketPrice) {
          variants.push({ label: this.humanizeVariantLabel(key), price: v.marketPrice, currency: 'USD', source: 'TCGPlayer' });
        }
      }
    }

    // Only fall back to CardMarket variants if TCGPlayer had none at all
    // (the norm for Japanese-only cards) - don't mix currencies/sources
    // within the same variant list. CardMarket only distinguishes
    // normal vs. holo, not every TCGPlayer-style sub-variant.
    if (variants.length === 0) {
      const cm = cardDetail?.pricing?.cardmarket;
      if (cm?.avg) variants.push({ label: 'Normal', price: cm.avg, currency: 'EUR', source: 'CardMarket' });
      if (cm?.['avg-holo']) variants.push({ label: 'Holo', price: cm['avg-holo'], currency: 'EUR', source: 'CardMarket' });
    }

    return variants;
  }

  humanizeVariantLabel(key) {
    return key
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  extractAllVariantsSGD(cardDetail) {
    return this.extractAllVariants(cardDetail).map(v => ({
      label: v.label,
      price: window.fxRates.convertToSGD(v.price, v.currency),
      source: `${v.source} (${v.currency}→SGD)`
    }));
  }
}

window.tcgdexClient = new TCGdexClient();
