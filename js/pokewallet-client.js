/* ==========================================================================
   PokAddicts - PokeWallet API Client (pricing fallback)
   Reintroduced after the TCGdex migration specifically as a PRICING
   source for Japanese-language cards - TCGdex's own pricing for Japanese
   secret/art rares proved unreliable (confirmed directly: a Japanese
   Magikarp Art Rare secret rare priced at €0.08 on TCGdex vs a real
   ~$177 USD / €175 EUR on PokeWallet, for the exact same physical card -
   almost certainly a mismatched product link on TCGdex's side for that
   print). TCGdex remains the catalog/search/English-pricing backbone;
   PokeWallet is only reached for Japanese card pricing.

   The real PokeWallet key never reaches the browser: every call here goes
   through a Supabase Edge Function (supabase/functions/pokewallet-proxy)
   that holds POKEWALLET_API_KEY as a server-side secret and forwards the
   request as-is (JSON here - the /images endpoint isn't used by this
   client, TCGdex already covers images). The only credential shipped here
   is Supabase's own publishable key (js/supabase-client.js) - that one's
   meant to be public by design.
   ========================================================================== */

const POKEWALLET_BASE_URL = `${typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : ''}/functions/v1/pokewallet-proxy`;

class PokeWalletClient {
  constructor() {
    this.configured = typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL.startsWith('http');
    if (!this.configured) {
      console.warn('Supabase is not configured - PokeWallet pricing fallback is disabled until js/supabase-client.js has a real project URL.');
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

  searchCards(query, { page = 1, limit = 10 } = {}) {
    return this.request(`/search?q=${encodeURIComponent(query)}&limit=${limit}&page=${page}`);
  }

  getCard(id) {
    return this.request(`/cards/${encodeURIComponent(id)}`);
  }

  // TCGPlayer (USD) is the primary figure; falls back to CardMarket (EUR)
  // if a card has no TCGPlayer listing at all.
  extractMarketPrice(cardDetail) {
    const tcgPrices = cardDetail?.tcgplayer?.prices || [];
    if (tcgPrices.length > 0) {
      const preferred = tcgPrices.find(p => p.sub_type_name === 'Normal') || tcgPrices[0];
      if (preferred?.market_price) return { price: preferred.market_price, currency: 'USD', source: 'TCGPlayer' };
    }

    const cmPrices = cardDetail?.cardmarket?.prices || [];
    if (cmPrices.length > 0) {
      const preferred = cmPrices.find(p => p.variant_type === 'normal') || cmPrices[0];
      if (preferred?.avg) return { price: preferred.avg, currency: 'EUR', source: 'CardMarket' };
    }

    return { price: 0, currency: null, source: null };
  }

  extractMarketPriceSGD(cardDetail) {
    const { price, currency, source } = this.extractMarketPrice(cardDetail);
    if (price <= 0 || !currency) return { price: 0, source: null };
    const sgdPrice = window.fxRates.convertToSGD(price, currency);
    return { price: sgdPrice, source: `${source} (${currency}→SGD)` };
  }

  extractAllMarketPrices(cardDetail) {
    const prices = [];
    const tcgPrices = cardDetail?.tcgplayer?.prices || [];
    const preferredTcg = tcgPrices.find(p => p.sub_type_name === 'Normal') || tcgPrices[0];
    if (preferredTcg?.market_price) prices.push({ price: preferredTcg.market_price, currency: 'USD', source: 'TCGPlayer' });

    const cmPrices = cardDetail?.cardmarket?.prices || [];
    const preferredCm = cmPrices.find(p => p.variant_type === 'normal') || cmPrices[0];
    if (preferredCm?.avg) prices.push({ price: preferredCm.avg, currency: 'EUR', source: 'CardMarket' });

    return prices;
  }

  extractAllMarketPricesSGD(cardDetail) {
    return this.extractAllMarketPrices(cardDetail).map(p => ({
      price: window.fxRates.convertToSGD(p.price, p.currency),
      source: `${p.source} (${p.currency}→SGD)`
    }));
  }

  // Unlike extractMarketPrice() (one "best" price), this returns every
  // sellable variant (Normal, Holo, Reverse Holo, etc.) with its own
  // price - the same card/set/number can have very different market
  // values depending on which finish the physical copy actually is.
  extractAllVariants(cardDetail) {
    const variants = [];

    const tcgPrices = cardDetail?.tcgplayer?.prices || [];
    tcgPrices.forEach(p => {
      if (p.market_price) variants.push({ label: p.sub_type_name || 'Normal', price: p.market_price, currency: 'USD', source: 'TCGPlayer' });
    });

    if (variants.length === 0) {
      const cmPrices = cardDetail?.cardmarket?.prices || [];
      cmPrices.forEach(p => {
        if (p.avg) variants.push({ label: p.variant_type || 'Normal', price: p.avg, currency: 'EUR', source: 'CardMarket' });
      });
    }

    return variants;
  }

  extractAllVariantsSGD(cardDetail) {
    return this.extractAllVariants(cardDetail).map(v => ({
      label: v.label,
      price: window.fxRates.convertToSGD(v.price, v.currency),
      source: `${v.source} (${v.currency}→SGD)`
    }));
  }

  // Convenience: search by name+number, pick the closest match by number,
  // and fetch its full pricing in one call - used as the Japanese-card
  // pricing path in scanner.js/card-search-ui.js/card-catalog.js.
  async findCardByNameAndNumber(name, number) {
    if (!this.configured) return null;
    const query = [name, number].filter(Boolean).join(' ').trim();
    if (!query) return null;

    const res = await this.searchCards(query, { limit: 10 });
    const results = res.results || [];
    if (results.length === 0) return null;

    if (number) {
      const exact = results.find(r => (r.card_info?.card_number || '').startsWith(number));
      if (exact) return exact;
    }
    return results[0];
  }
}

window.pokeWalletClient = new PokeWalletClient();
