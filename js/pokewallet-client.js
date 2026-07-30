/* ==========================================================================
   PokAddicts - PokeWallet API Client
   Single source for both the card catalog (names/sets/numbers, including
   distinct Japanese/German/etc. sets - not just localized art on the same
   English card) AND live TCGPlayer/CardMarket pricing. Free tier: 100
   requests/hour, 1,000/day, so bulk catalog sync (card-catalog.js) paces
   itself well under that cap and can take a while for the full multi-
   language database - it resumes automatically across sessions.

   The real PokeWallet key never reaches the browser: every call here goes
   through a Supabase Edge Function (supabase/functions/pokewallet-proxy)
   that holds POKEWALLET_API_KEY as a server-side secret and forwards the
   request as-is (JSON or binary image, whichever the endpoint returns).
   The only credential shipped here is Supabase's own publishable key
   (js/supabase-client.js) - that one's meant to be public by design.
   ========================================================================== */

const POKEWALLET_BASE_URL = `${typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : ''}/functions/v1/pokewallet-proxy`;

class PokeWalletClient {
  constructor() {
    this.configured = typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL.startsWith('http');
    if (!this.configured) {
      console.warn('Supabase is not configured - PokeWallet catalog sync and price lookups are disabled until js/supabase-client.js has a real project URL.');
    }
  }

  authHeaders() {
    return { 'apiKey': SUPABASE_ANON_KEY };
  }

  async request(path) {
    if (!this.configured) throw new Error('PokeWallet proxy not configured');
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

  // Unlike extractMarketPrice() (which picks one "best" price), this
  // returns every printing variant with its own price - e.g. Normal,
  // Holofoil, Reverse Holofoil, 1st Edition - since the same card/set/
  // number can have very different market values depending on which
  // finish the physical copy actually is.
  extractAllVariants(cardDetail) {
    const variants = [];

    const tcgPrices = cardDetail?.tcgplayer?.prices || [];
    tcgPrices.forEach(p => {
      if (p.market_price) {
        variants.push({ label: p.sub_type_name || 'Normal', price: p.market_price, currency: 'USD', source: 'TCGPlayer' });
      }
    });

    // Only fall back to CardMarket variants if TCGPlayer had none at all
    // (the norm for Japanese-only cards) - don't mix currencies/sources
    // within the same variant list.
    if (variants.length === 0) {
      const cmPrices = cardDetail?.cardmarket?.prices || [];
      cmPrices.forEach(p => {
        if (p.avg) {
          variants.push({ label: p.variant_type || 'Normal', price: p.avg, currency: 'EUR', source: 'CardMarket' });
        }
      });
    }

    return variants;
  }

  // Same as extractAllVariants, but each variant's price is converted to
  // SGD.
  extractAllVariantsSGD(cardDetail) {
    return this.extractAllVariants(cardDetail).map(v => ({
      label: v.label,
      price: window.fxRates.convertToSGD(v.price, v.currency),
      source: `${v.source} (${v.currency}→SGD)`
    }));
  }
}

window.pokeWalletClient = new PokeWalletClient();
