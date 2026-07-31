/* ==========================================================================
   PokAddicts - SnkrDunk API Client (Japanese card pricing)
   SnkrDunk has no public/documented API, but their own frontend calls a
   real, unauthenticated JSON API to load search results and prices -
   found by inspecting real browser network traffic (their card prices
   load via client-side JS, so the raw page HTML alone never has them,
   unlike Yuyu-tei). Routed through a Supabase Edge Function
   (supabase/functions/snkrdunk-proxy) - not for CORS reasons this time
   (unclear if SnkrDunk sends CORS headers), but to keep the parsing/URL
   logic in one server-side place. Confirmed NOT IP-blocked from
   Supabase's infrastructure (unlike Yuyu-tei, which was dropped for
   exactly that reason).

   Unlike TCGPlayer (USD)/CardMarket (EUR), SnkrDunk's prices come back
   already in SGD - no currency conversion needed. SnkrDunk also deals in
   BOTH raw and graded cards, so a single card has a price per CONDITION
   (raw grades A/B/D, PSA 9/10, ARS 10, etc.) rather than one number - see
   extractConditionPrices().
   ========================================================================== */

const SNKRDUNK_BASE_URL = `${typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : ''}/functions/v1/snkrdunk-proxy`;

class SnkrDunkClient {
  constructor() {
    this.configured = typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL.startsWith('http');
    // "name" -> in-flight/resolved search Promise, shared across concurrent
    // callers asking about the same card (same pattern as PokeWallet's
    // _matchCache - price and image lookups for the same card can fire
    // at once).
    this._matchCache = new Map();
  }

  authHeaders() {
    return { apikey: SUPABASE_ANON_KEY };
  }

  async search(keyword) {
    if (!this.configured) return [];
    const res = await fetch(`${SNKRDUNK_BASE_URL}?q=${encodeURIComponent(keyword)}`, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`SnkrDunk search error ${res.status}`);
    const data = await res.json();
    return data.results || [];
  }

  async getConditionPrices(id) {
    if (!this.configured) return [];
    const res = await fetch(`${SNKRDUNK_BASE_URL}?id=${encodeURIComponent(id)}`, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`SnkrDunk price lookup error ${res.status}`);
    const data = await res.json();
    return data.conditions || [];
  }

  // Convenience: search by name, pick the closest match by card number.
  // Shares one in-flight request across concurrent callers asking about
  // the same card.
  async findCardByNameAndNumber(name, number) {
    if (!this.configured || !name) return null;
    const cacheKey = name.toLowerCase();
    if (this._matchCache.has(cacheKey)) return this._matchCache.get(cacheKey);

    const matchPromise = (async () => {
      const results = await this.search(name);
      if (results.length === 0) return null;

      if (number) {
        const exact = results.find(r => r.number === number);
        if (exact) return exact;
      }
      return results[0];
    })();

    this._matchCache.set(cacheKey, matchPromise);
    return matchPromise;
  }

  // Every condition SnkrDunk lists a price for, already in SGD, tagged
  // with whether it's a third-party GRADED condition (PSA 9/10, ARS 10,
  // "Other Graded", etc.) or a RAW one (single-letter A/B/C/D) - callers
  // should only show one or the other depending on whether the item being
  // added is itself a graded slab or a raw card, not mix both together.
  // "A" (raw) is ordered first as the closest equivalent to TCGPlayer/
  // CardMarket's plain "market price", which is implicitly ungraded.
  extractConditionPricesSGD(conditions) {
    const rawOrder = ['A', 'B', 'C', 'D'];
    const isRaw = (condition) => rawOrder.includes(condition);
    return [...conditions].sort((a, b) => {
      const aRaw = rawOrder.indexOf(a.condition);
      const bRaw = rawOrder.indexOf(b.condition);
      if (aRaw !== -1 && bRaw !== -1) return aRaw - bRaw;
      if (aRaw !== -1) return -1;
      if (bRaw !== -1) return 1;
      return 0;
    }).map(c => ({ label: c.condition, price: c.priceSgd, source: 'SnkrDunk', graded: !isRaw(c.condition) }));
  }
}

window.snkrDunkClient = new SnkrDunkClient();
