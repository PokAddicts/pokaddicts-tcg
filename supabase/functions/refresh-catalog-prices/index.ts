// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Bulk-refreshes cached pricing for the shared English card catalog, one
// batch per invocation - meant to be triggered on a schedule (see
// supabase/schema.sql's cron.schedule call) rather than by the app
// directly. English only: TCGdex has no rate limit, so refreshing all
// ~23,000 English cards daily is realistic, but Japanese pricing comes
// from PokeWallet (100 requests/hour cap - see js/pokewallet-client.js
// for why), which can't sustain a full-catalog daily sweep without
// starving real-time lookups the rest of the day. Japanese cards keep
// their price fetched live, on demand, same as before.
//
// "secret" auth only (not "publishable") - this does a privileged bulk
// write and shouldn't be callable with the same public key the browser
// ships, only from the cron job (which authenticates with the service
// role key, kept server-side).
//
// Batched (not the whole catalog in one call) because Edge Functions have
// an execution time limit - cron re-invokes this every few minutes,
// always picking up the least-recently-refreshed cards first, so it
// cycles through the full catalog over the course of a day.

const TCGDEX_BASE_URL = "https://api.tcgdex.net/v2";
const BATCH_SIZE = 300;
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

function extractMarketPrice(cardDetail: any) {
  const tcg = cardDetail?.pricing?.tcgplayer;
  if (tcg) {
    const subVariant = tcg.normal || Object.values(tcg).find((v: any) => v && typeof v === "object" && v.marketPrice);
    if ((subVariant as any)?.marketPrice) {
      return { price: (subVariant as any).marketPrice, currency: "USD", source: "TCGPlayer" };
    }
  }
  const cm = cardDetail?.pricing?.cardmarket;
  if (cm?.avg) {
    return { price: cm.avg, currency: "EUR", source: "CardMarket" };
  }
  return { price: 0, currency: null as string | null, source: null as string | null };
}

function humanizeVariantLabel(key: string) {
  return key.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Same logic as js/tcgdex-client.js's extractAllVariants - every sellable
// TCGPlayer sub-variant (Normal, Holofoil, Reverse Holofoil, 1st Edition
// Holofoil, etc.) plus CardMarket, not just the one "best" number
// extractMarketPrice above collapses down to for market_value_sgd. Kept in
// sync manually since Edge Functions can't share code with the browser
// bundle without a build step this project doesn't have.
function extractAllVariantsSGD(cardDetail: any, fx: Record<string, number>) {
  const variants: { label: string; price: number; source: string }[] = [];
  const tcg = cardDetail?.pricing?.tcgplayer;
  if (tcg) {
    for (const [key, v] of Object.entries(tcg)) {
      if (v && typeof v === "object" && (v as any).marketPrice) {
        variants.push({ label: humanizeVariantLabel(key), price: (v as any).marketPrice * (fx.USD || 1), source: "TCGPlayer (USD→SGD)" });
      }
    }
  }
  const cm = cardDetail?.pricing?.cardmarket;
  if (cm?.avg) variants.push({ label: "Normal", price: cm.avg * (fx.EUR || 1), source: "CardMarket (EUR→SGD)" });
  if (cm?.["avg-holo"]) variants.push({ label: "Holo", price: cm["avg-holo"] * (fx.EUR || 1), source: "CardMarket (EUR→SGD)" });
  return variants;
}

export default {
  fetch: withSupabase({ auth: ["secret"] }, async (_req, ctx) => {
    const admin = ctx.supabaseAdmin;

    const { data: cards, error } = await admin
      .from("cards")
      .select("id, name")
      .eq("language", "en")
      .order("price_updated_at", { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!cards || cards.length === 0) {
      return Response.json({ message: "No English cards found.", processed: 0 });
    }

    const fx = await getFxRates();
    let updated = 0;
    let failed = 0;

    for (const card of cards) {
      try {
        const res = await fetch(`${TCGDEX_BASE_URL}/en/cards/${encodeURIComponent(card.id)}`);
        if (!res.ok) throw new Error(`TCGdex ${res.status}`);
        const detail = await res.json();
        const { price, currency, source } = extractMarketPrice(detail);

        const marketValueSgd = price > 0 && currency ? price * (fx[currency] || 1) : 0;
        const priceSource = price > 0 && currency ? `${source} (${currency}→SGD)` : null;
        const variants = extractAllVariantsSGD(detail, fx);

        const { error: updateErr } = await admin
          .from("cards")
          .update({
            market_value_sgd: marketValueSgd,
            price_source: priceSource,
            price_updated_at: new Date().toISOString(),
            tcgdex_variants: variants.length > 0 ? variants : null,
          })
          .eq("id", card.id);

        if (updateErr) throw updateErr;
        updated++;
      } catch (err) {
        failed++;
        console.warn(`Failed to refresh ${card.id}:`, err);
      }
    }

    return Response.json({ processed: cards.length, updated, failed });
  }),
};
