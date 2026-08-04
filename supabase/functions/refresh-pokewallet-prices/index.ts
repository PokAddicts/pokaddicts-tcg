// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Continuous, whole-catalog PokeWallet refresh - same role for the
// Japanese card catalog's TCGPlayer/CardMarket pricing that
// refresh-snkrdunk-prices plays for SnkrDunk pricing, and
// refresh-catalog-prices plays for the English catalog.
//
// Replaces the old lazy "look it up live when someone searches the card"
// model entirely (see js/card-search-ui.js's fetchAllPricesForCard) - the
// app now ALWAYS reads whatever's cached here and shows a "last updated"
// timestamp alongside it, rather than blocking the search UI on a live
// PokeWallet round trip. That live-on-search path was also the ONLY thing
// that ever refreshed PokeWallet data before this cron existed - removing
// it without this would have left most of the catalog's TCGPlayer/
// CardMarket price permanently stuck at whatever it last was.
//
// PokeWallet has a hard 100 requests/hour cap. Since the interactive app
// no longer makes any live PokeWallet calls of its own (this cron is now
// the only caller), there's no concurrent usage to reserve headroom for -
// BATCH_SIZE=7 on a 5-minute tick = 84/hour, comfortably under the cap
// with a safety margin. Continuous (not self-draining): ordered by oldest
// pokewallet_updated_at first (nulls first), so it naturally cycles
// through the whole ~9,000-card Japanese catalog and back around to the
// start again, keeping everything reasonably fresh on a multi-day rolling
// basis rather than a one-time pass.
//
// Only 1 PokeWallet request per card (search) - the search response
// already embeds full tcgplayer/cardmarket pricing per result, same as
// js/pokewallet-client.js's findCardByNameAndNumber + extractAllVariantsSGD
// combined, so there's no need for a second per-card detail request.

const POKEWALLET_BASE_URL = "https://api.pokewallet.io";
const BATCH_SIZE = 7;
const FX_FALLBACK: Record<string, number> = { USD: 1.29, EUR: 1.41 };

async function getFxRates(): Promise<Record<string, number>> {
  try {
    const [usdRes, eurRes] = await Promise.all([
      fetch("https://api.frankfurter.dev/v1/latest?from=USD&to=SGD").then((r) => r.json()),
      fetch("https://api.frankfurter.dev/v1/latest?from=EUR&to=SGD").then((r) => r.json()),
    ]);
    return {
      USD: usdRes?.rates?.SGD || FX_FALLBACK.USD,
      EUR: eurRes?.rates?.SGD || FX_FALLBACK.EUR,
    };
  } catch {
    return FX_FALLBACK;
  }
}

async function pokeWalletSearch(pwKey: string, query: string) {
  const res = await fetch(`${POKEWALLET_BASE_URL}/search?q=${encodeURIComponent(query)}&limit=10&page=1`, {
    headers: { "X-API-Key": pwKey },
  });
  if (!res.ok) throw new Error(`PokeWallet search ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

// Same progressive-relaxation as js/pokewallet-client.js's
// findCardByNameAndNumber, but trims the query itself (not just relying on
// one shot) since some catalog names carry leftover cruft (e.g. "Zeraora V
// SR: SA") that a single exact query might miss.
async function findMatch(pwKey: string, name: string, number: string) {
  const words = name.split(/\s+/).filter(Boolean);
  for (let trim = 0; trim <= 3 && words.length - trim > 0; trim++) {
    const query = [words.slice(0, words.length - trim).join(" "), number].filter(Boolean).join(" ").trim();
    if (!query) continue;
    const results = await pokeWalletSearch(pwKey, query);
    if (results.length === 0) continue;
    const exact = results.find((r: any) => (r.card_info?.card_number || "").startsWith(number));
    if (exact) return exact;
  }
  return null;
}

function extractMarketPriceSGD(cardInfoResult: any, fx: Record<string, number>) {
  const tcgPrices = cardInfoResult?.tcgplayer?.prices || [];
  const preferredTcg = tcgPrices.find((p: any) => p.sub_type_name === "Normal") || tcgPrices[0];
  if (preferredTcg?.market_price) {
    return { price: preferredTcg.market_price * (fx.USD || 1), source: "TCGPlayer (USD→SGD)" };
  }
  const cmPrices = cardInfoResult?.cardmarket?.prices || [];
  const preferredCm = cmPrices.find((p: any) => p.variant_type === "normal") || cmPrices[0];
  if (preferredCm?.avg) {
    return { price: preferredCm.avg * (fx.EUR || 1), source: "CardMarket (EUR→SGD)" };
  }
  return { price: null, source: null };
}

function extractAllVariantsSGD(cardInfoResult: any, fx: Record<string, number>) {
  const variants: { label: string; price: number; source: string }[] = [];
  const tcgPrices = cardInfoResult?.tcgplayer?.prices || [];
  tcgPrices.forEach((p: any) => {
    if (p.market_price) variants.push({ label: p.sub_type_name || "Normal", price: p.market_price * (fx.USD || 1), source: "TCGPlayer (USD→SGD)" });
  });
  const cmPrices = cardInfoResult?.cardmarket?.prices || [];
  cmPrices.forEach((p: any) => {
    if (p.avg) {
      const label = (p.variant_type || "").toLowerCase() === "holo" ? "Holo" : "Normal";
      variants.push({ label, price: p.avg * (fx.EUR || 1), source: "CardMarket (EUR→SGD)" });
    }
  });
  return variants;
}

export default {
  fetch: withSupabase({ auth: ["secret"] }, async (_req, ctx) => {
    const admin = ctx.supabaseAdmin;
    const pwKey = Deno.env.get("POKEWALLET_API_KEY");
    if (!pwKey) {
      return Response.json({ error: "POKEWALLET_API_KEY not configured on the server" }, { status: 500 });
    }

    const { data: cards, error } = await admin
      .from("cards")
      .select("id, name, card_number")
      .eq("language", "ja")
      .order("pokewallet_updated_at", { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!cards || cards.length === 0) {
      return Response.json({ message: "No Japanese cards found.", processed: 0 });
    }

    const fx = await getFxRates();
    let matched = 0;
    let noMatch = 0;
    let failed = 0;
    const sampleErrors: string[] = [];

    for (const card of cards) {
      try {
        const match = await findMatch(pwKey, card.name, card.card_number || "");

        if (!match) {
          noMatch++;
          await admin.from("cards").update({ pokewallet_updated_at: new Date().toISOString() }).eq("id", card.id);
          continue;
        }

        const cleanName = match.card_info?.clean_name || (match.card_info?.name || "").split(" - ")[0].trim();
        const rawSetName = match.card_info?.set_name || "";
        const setName = rawSetName.replace(/^[^:]+:\s*/, "").trim() || rawSetName;
        const { price, source } = extractMarketPriceSGD(match, fx);
        const variants = extractAllVariantsSGD(match, fx);

        const update: Record<string, unknown> = { pokewallet_updated_at: new Date().toISOString() };
        if (variants.length > 0) update.pokewallet_variants = variants;
        if (price !== null) {
          update.market_value_sgd = price;
          update.price_source = source;
          update.price_updated_at = new Date().toISOString();
        }

        await admin.from("cards").update(update).eq("id", card.id);
        matched++;
      } catch (err) {
        failed++;
        if (sampleErrors.length < 10) sampleErrors.push(`${card.id} (${card.name}): ${err}`);
        console.warn(`Failed PokeWallet refresh for ${card.id}:`, err);
      }
    }

    return Response.json({ processed: cards.length, matched, noMatch, failed, sampleErrors });
  }),
};

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/refresh-pokewallet-prices' \
    --header 'apiKey: <service-role-key>'

*/
