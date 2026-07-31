/* ==========================================================================
   PokAddicts - Currency Conversion
   PokeWallet/TCGdex prices come in USD (TCGPlayer) or EUR (CardMarket),
   and Yuyu-tei's in JPY - this converts them all to SGD (the business's
   operating currency) using Frankfurter, a free, no-key exchange rate API
   (ECB-sourced), cached and refreshed once a day.
   ========================================================================== */

const FX_BASE_URL = 'https://api.frankfurter.dev/v1';
const FX_CACHE_KEY = 'pokaddicts_fx_rates_v1';
const FX_TARGET_CURRENCY = 'SGD';

// Rough fallback rates, used only until the first live fetch completes (or
// if that fetch ever fails) so conversions still work offline/on error.
const FX_FALLBACK_RATES = { USD: 1.29, EUR: 1.41, JPY: 0.0088 };

class FxRates {
  constructor() {
    this.rates = { ...FX_FALLBACK_RATES };
    this.lastFetchedDate = null;
    this.loadFromCache();
  }

  loadFromCache() {
    const raw = localStorage.getItem(FX_CACHE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      this.rates = { ...this.rates, ...(parsed.rates || {}) };
      this.lastFetchedDate = parsed.date || null;
    } catch (err) {
      console.warn('Failed to parse cached FX rates:', err);
    }
  }

  saveToCache() {
    localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ rates: this.rates, date: this.lastFetchedDate }));
  }

  async ensureFreshRates() {
    const today = new Date().toISOString().split('T')[0];
    if (this.lastFetchedDate === today) return;

    try {
      const [usdRes, eurRes, jpyRes] = await Promise.all([
        fetch(`${FX_BASE_URL}/latest?from=USD&to=${FX_TARGET_CURRENCY}`).then(r => r.json()),
        fetch(`${FX_BASE_URL}/latest?from=EUR&to=${FX_TARGET_CURRENCY}`).then(r => r.json()),
        fetch(`${FX_BASE_URL}/latest?from=JPY&to=${FX_TARGET_CURRENCY}`).then(r => r.json())
      ]);

      if (usdRes.rates?.[FX_TARGET_CURRENCY]) this.rates.USD = usdRes.rates[FX_TARGET_CURRENCY];
      if (eurRes.rates?.[FX_TARGET_CURRENCY]) this.rates.EUR = eurRes.rates[FX_TARGET_CURRENCY];
      if (jpyRes.rates?.[FX_TARGET_CURRENCY]) this.rates.JPY = jpyRes.rates[FX_TARGET_CURRENCY];
      this.lastFetchedDate = today;
      this.saveToCache();
    } catch (err) {
      console.warn('Failed to refresh FX rates - using cached/fallback values:', err);
    }
  }

  // Converts an amount in USD, EUR, or JPY to SGD.
  convertToSGD(amount, fromCurrency) {
    const rate = this.rates[fromCurrency] || FX_FALLBACK_RATES[fromCurrency] || 1;
    return amount * rate;
  }
}

window.fxRates = new FxRates();
