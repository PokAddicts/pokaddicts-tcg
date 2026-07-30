/* ==========================================================================
   PokAddicts - PokeWallet API Client
   Single source for both the card catalog (names/sets/numbers, including
   distinct Japanese/German/etc. sets - not just localized art on the same
   English card) AND live TCGPlayer/CardMarket pricing. Free tier: 100
   requests/hour, 1,000/day, so bulk catalog sync (card-catalog.js) paces
   itself well under that cap and can take a while for the full multi-
   language database - it resumes automatically across sessions.

   Get a free API key at https://www.pokewallet.io/ (no card required) and
   paste it below.
   ========================================================================== */

const POKEWALLET_API_KEY = 'pk_live_aeef5aec40e0857e154b48ba6ad4291671414cf26c1c6895';
const POKEWALLET_BASE_URL = 'https://api.pokewallet.io';

class PokeWalletClient {
  constructor() {
    this.configured = /^pk_(live|test)_/.test(POKEWALLET_API_KEY || '');
    if (!this.configured) {
      console.warn('PokeWallet is not configured yet - fill in POKEWALLET_API_KEY in js/pokewallet-client.js. Card catalog sync and price lookups are disabled until then.');
    }
  }

  authHeaders() {
    return { 'X-API-Key': POKEWALLET_API_KEY };
  }

  async request(path) {
    if (!this.configured) throw new Error('PokeWallet API key not configured');
    const res = await fetch(`${POKEWALLET_BASE_URL}${path}`, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`PokeWallet API error ${res.status}`);
    return res.json();
  }

  // All sets across all languages in one call (each has its own set_id,
  // name, card_count, and language code e.g. "eng", "jap", "ger").
  listSets() {
    return this.request('/sets');
  }

  // Full (paginated) card list for one set. Use the numeric set_id, not
  // set_code, to avoid ambiguity when the same code is shared across
  // language editions of a set.
  getSetCards(setId, { page = 1, limit = 200 } = {}) {
    return this.request(`/sets/${encodeURIComponent(setId)}?page=${page}&limit=${limit}`);
  }

  getCard(id) {
    return this.request(`/cards/${encodeURIComponent(id)}`);
  }

  // Live text search - used as a fallback in the search widget when the
  // local catalog has no match yet (e.g. a card so new the bulk sync
  // hasn't reached its set), and to self-heal the local catalog from
  // there on.
  searchCards(query, { page = 1, limit = 10 } = {}) {
    return this.request(`/search?q=${encodeURIComponent(query)}&limit=${limit}&page=${page}`);
  }

  async getImageBlobUrl(id, size = 'low') {
    if (!this.configured) return null;
    const res = await fetch(`${POKEWALLET_BASE_URL}/images/${encodeURIComponent(id)}?size=${size}`, {
      headers: this.authHeaders()
    });
    if (!res.ok) throw new Error(`PokeWallet image fetch failed ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  // TCGPlayer market price is the primary figure (USD); falls back to
  // CardMarket average (EUR) if a card has no TCGPlayer listing (this is
  // the norm for Japanese-only cards, which TCGPlayer doesn't carry).
  extractMarketPrice(cardDetail) {
    const tcgPrices = cardDetail?.tcgplayer?.prices || [];
    if (tcgPrices.length > 0) {
      const preferred = tcgPrices.find(p => p.sub_type_name === 'Normal') || tcgPrices[0];
      if (preferred && preferred.market_price) {
        return { price: preferred.market_price, currency: 'USD', source: 'TCGPlayer' };
      }
    }

    const cmPrices = cardDetail?.cardmarket?.prices || [];
    if (cmPrices.length > 0) {
      const preferred = cmPrices.find(p => p.variant_type === 'normal') || cmPrices[0];
      if (preferred && preferred.avg) {
        return { price: preferred.avg, currency: 'EUR', source: 'CardMarket' };
      }
    }

    return { price: 0, currency: null, source: null };
  }

  // Same as extractMarketPrice, but converted to SGD (this business's
  // operating currency) using live-cached FX rates - see fx-rates.js.
  extractMarketPriceSGD(cardDetail) {
    const { price, currency, source } = this.extractMarketPrice(cardDetail);
    if (price <= 0 || !currency) return { price: 0, source: null };
    const sgdPrice = window.fxRates.convertToSGD(price, currency);
    return { price: sgdPrice, source: `${source} (${currency}→SGD)` };
  }
}

window.pokeWalletClient = new PokeWalletClient();
