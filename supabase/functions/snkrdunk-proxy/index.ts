// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Thin proxy for SnkrDunk's real (undocumented, but public/no-auth-needed)
// trading-card endpoints - found by inspecting real browser network traffic
// (SnkrDunk's card prices load via client-side JS, so the raw page HTML
// alone never has them, unlike Yuyu-tei; this calls the same JSON API
// their own frontend calls, sidestepping that entirely). Unlike Yuyu-tei,
// SnkrDunk's endpoints are NOT IP-blocked from Supabase - confirmed by
// direct testing before wiring this up as the reason the Yuyu-tei
// integration was dropped.
//
// Two operations, chosen by which query param is present:
//   ?q=<keyword>   -> search results (id, name, embedded set/number, a
//                      quick minPrice already in SGD)
//   ?id=<id>       -> full price breakdown by card CONDITION for one
//                      specific card (raw grades A/B/D, PSA 9/10, etc. -
//                      SnkrDunk deals in both raw and graded cards, unlike
//                      TCGPlayer/CardMarket's single "market price")
//
// Both SnkrDunk responses already come back in SGD (confirmed directly:
// "minPriceFormat":"SG $304") - no currency conversion needed, unlike
// TCGPlayer (USD)/CardMarket (EUR)/Yuyu-tei (JPY).

const SEARCH_URL = "https://snkrdunk.com/en/v1/search";
const PRICE_URL = "https://snkrdunk.com/en/v1/trading-cards";

// SnkrDunk's search result names embed the set code + card number in
// brackets, e.g. "MEGA Charizard X ex SR [M2 094/080](Expansion Pack...)"
// or "Charizard VMAX SSR[S4a 308/190](High Class Pack...)" - the space
// before "[" varies, but there's always one between the set code and the
// number itself inside the brackets. Set codes can include hyphens (promo
// variants like "S8a-P").
const NUMBER_PATTERN = /\[[A-Za-z0-9.-]+\s+(\d+\/\d+)\]/;

async function search(keyword: string) {
  // perPage=100 (not 21) - a common Pokemon name (e.g. "Pikachu") matches
  // far more than one page of results across every set it's ever
  // appeared in, and confirmed directly that the correct card can sit
  // well past the first 21: a real bug caused by this - card-catalog.js's
  // own matching only looks within whatever this returns, so with a
  // 21-result page it silently fell back to the wrong card whenever the
  // real match wasn't on that first page.
  const url = `${SEARCH_URL}?keyword=${encodeURIComponent(keyword)}&perPage=100&page=1&type=`;
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`SnkrDunk search returned ${res.status}`);
  const data = await res.json();

  const cards = (data.streetwears || []).filter((item: any) => item.isTradingCard);
  return cards.map((item: any) => {
    const numberMatch = String(item.name || "").match(NUMBER_PATTERN);
    return {
      id: item.id,
      name: item.name,
      number: numberMatch ? numberMatch[1] : "",
      minPriceSgd: item.minPrice || 0,
      thumbnailUrl: item.thumbnailUrl || "",
    };
  });
}

async function priceByConditions(id: string) {
  const url = `${PRICE_URL}/${encodeURIComponent(id)}/min-prices-by-conditions`;
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`SnkrDunk price lookup returned ${res.status}`);
  const data = await res.json();

  return (data.conditionPrices || []).map((c: any) => ({
    condition: c.conditionName,
    priceSgd: c.minPrice || 0,
  }));
}

export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, _ctx) => {
    const url = new URL(req.url);
    const q = url.searchParams.get("q");
    const id = url.searchParams.get("id");

    try {
      if (id) {
        const conditions = await priceByConditions(id);
        return Response.json({ conditions });
      }
      if (q) {
        const results = await search(q);
        return Response.json({ results });
      }
      return Response.json({ error: "Provide either 'q' (search) or 'id' (price lookup)" }, { status: 400 });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 502 });
    }
  }),
};

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/snkrdunk-proxy?q=charizard' \
    --header 'apiKey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'

*/
