// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Bulk-refreshes cached SnkrDunk pricing for the shared Japanese card
// catalog, one batch per invocation - meant to be triggered on a schedule
// (see supabase/schema.sql's cron.schedule call), same pattern as
// refresh-catalog-prices (English/TCGdex). Japanese only - SnkrDunk is a
// Japanese resale marketplace, see js/snkrdunk-client.js.
//
// Each card needs a one-time SEARCH to resolve its SnkrDunk trading-card
// id (cards.snkrdunk_id), then a price lookup by that id. Once resolved,
// later refreshes skip straight to the price lookup - only ~1 request
// instead of 2 - so throughput increases after the first full pass.
// snkrdunk_id = '' means "searched, no match found" and is retried on its
// next turn in the queue rather than treated as permanent (unlike a
// missing image, a new SnkrDunk listing could appear for a card that has
// none today).
//
// STRICTLY SEQUENTIAL with a deliberate delay between every request -
// SnkrDunk DOES rate-limit (429) this endpoint, discovered the hard way:
// an initial small-scale test (30 concurrent requests, once) came back
// clean, but a sustained batch even at only 5-way concurrency still hit
// 429 on the majority of requests. Whatever the actual threshold is,
// going fully sequential with real spacing between requests is the safe
// fix - confirmed clean (0 failures) at a 1-second delay.
//
// That's slow per-card (~2.6-3.1s each, measured directly across several
// runs), so hitting the requested ~12-hour full-catalog freshness target
// needs a SHORT cron interval (3 minutes, see supabase/schema.sql) with a
// small batch per tick, rather than one huge batch - confirmed the hard
// way that a batch of 60 (~2.5 minutes of real work) triggers a 504
// Gateway Timeout from Supabase's own infrastructure well before the
// function itself would have failed. Batch size 35 measured at ~110s,
// comfortably under both that gateway limit and the 180s tick interval,
// and 35 cards/tick * (12h / 3min = 240 ticks) = 8,400 cards >= the
// ~8,159-card Japanese catalog on the slower first pass (every card
// needing both a search AND a price request). Subsequent cycles are
// faster still, since most cards will already have a cached snkrdunk_id
// and only need the single price request.
const SEARCH_URL = "https://snkrdunk.com/en/v1/search";
const PRICE_URL = "https://snkrdunk.com/en/v1/trading-cards";
const BATCH_SIZE = 35;
const REQUEST_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SnkrDunk's search result names embed the set code + card number in
// brackets, e.g. "MEGA Charizard X ex SR [M2 094/080](Expansion Pack...)"
// - same pattern as js/snkrdunk-client.js's search parsing (kept in sync
// manually since Edge Functions can't share code with the browser bundle
// without a build step this project doesn't have).
const NUMBER_PATTERN = /\[[A-Za-z0-9.-]+\s+(\d+\/\d+)\]/;
const RAW_CONDITIONS = ["A", "B", "C", "D"];

async function searchSnkrDunk(keyword: string): Promise<{ id: string; number: string }[]> {
  // perPage=100 (not 21) - a common Pokemon name matches far more than
  // one page of results across every set it's appeared in; see the
  // matching fix below for why a narrower page silently caused wrong
  // matches rather than just missing them.
  const url = `${SEARCH_URL}?keyword=${encodeURIComponent(keyword)}&perPage=100&page=1&type=`;
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`SnkrDunk search returned ${res.status}`);
  const data = await res.json();
  const cards = (data.streetwears || []).filter((item: any) => item.isTradingCard);
  return cards.map((item: any) => {
    const numberMatch = String(item.name || "").match(NUMBER_PATTERN);
    return { id: String(item.id), number: numberMatch ? numberMatch[1] : "" };
  });
}

async function priceByConditions(id: string) {
  const url = `${PRICE_URL}/${encodeURIComponent(id)}/min-prices-by-conditions`;
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`SnkrDunk price lookup returned ${res.status}`);
  const data = await res.json();
  return (data.conditionPrices || []).map((c: any) => ({
    label: c.conditionName,
    price: c.minPrice || 0,
    source: "SnkrDunk",
    graded: !RAW_CONDITIONS.includes(c.conditionName),
  }));
}

export default {
  fetch: withSupabase({ auth: ["secret"] }, async (_req, ctx) => {
    const admin = ctx.supabaseAdmin;

    const { data: cards, error } = await admin
      .from("cards")
      .select("id, name, card_number, snkrdunk_id")
      .eq("language", "ja")
      .order("snkrdunk_updated_at", { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!cards || cards.length === 0) {
      return Response.json({ message: "No Japanese cards found.", processed: 0 });
    }

    let resolved = 0;
    let priced = 0;
    let noMatch = 0;
    let failed = 0;
    const sampleErrors: string[] = [];

    for (const card of cards) {
      try {
        let snkrdunkId = card.snkrdunk_id;

        if (!snkrdunkId) {
          const results = await searchSnkrDunk(card.name);
          await sleep(REQUEST_DELAY_MS);
          // STRICT when there's a card number to match against - a real,
          // confirmed bug fell back to results[0] (the single most
          // "relevant" hit for the bare name) whenever the real match
          // wasn't among the results returned, silently attaching a
          // totally unrelated card's price for any common name (verified:
          // 265 Japanese catalog rows had wrongly-shared SnkrDunk ids from
          // exactly this). A wrong price is worse than no price.
          const match = card.card_number ? results.find((r) => r.number === card.card_number) : results[0];
          snkrdunkId = match ? match.id : "";
          resolved++;
        }

        if (!snkrdunkId) {
          noMatch++;
          await admin
            .from("cards")
            .update({ snkrdunk_id: "", snkrdunk_updated_at: new Date().toISOString() })
            .eq("id", card.id);
          continue;
        }

        const conditions = await priceByConditions(snkrdunkId);
        await sleep(REQUEST_DELAY_MS);
        await admin
          .from("cards")
          .update({
            snkrdunk_id: snkrdunkId,
            snkrdunk_conditions: conditions,
            snkrdunk_updated_at: new Date().toISOString(),
          })
          .eq("id", card.id);
        priced++;
      } catch (err) {
        failed++;
        if (sampleErrors.length < 10) sampleErrors.push(`${card.id} (${card.name}): ${err}`);
        console.warn(`Failed to refresh SnkrDunk price for ${card.id}:`, err);
        await sleep(REQUEST_DELAY_MS);
      }
    }

    return Response.json({ processed: cards.length, resolved, priced, noMatch, failed, sampleErrors });
  }),
};

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/refresh-snkrdunk-prices' \
    --header 'apiKey: <service-role-key>'

*/
