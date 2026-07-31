// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Bulk-populates a PERMANENT image cache for the shared card catalog, one
// batch per invocation - meant to be triggered on a schedule (see
// supabase/schema.sql's cron.schedule call), same pattern as
// refresh-catalog-prices. Unlike price, a card's image never changes once
// printed, so this only ever needs to run ONCE per card, forever - no
// daily refresh needed.
//
// English cards: TCGdex has no rate limit and (almost) always has the
// image already (cards.image, filled in during catalog sync), so these
// are cached in large batches straight from TCGdex.
//
// Japanese cards: many also already have a TCGdex image and are just as
// cheap - those are tried first, for free. Only the ones TCGdex has
// nothing for (a confirmed real gap for some Japanese sets/secret rares -
// see js/pokewallet-client.js) fall back to PokeWallet, which IS
// rate-limited (100 requests/hour - see js/pokewallet-client.js). Those
// fallback requests are hard-capped per invocation (see
// MAX_POKEWALLET_REQUESTS_PER_RUN below) so this background sweep can
// never eat the whole hourly budget and starve real-time user lookups
// happening the same hour.
//
// "secret" auth only (not "publishable") - privileged bulk write, only
// meant to be called by the cron job (service role key, kept server-side).

const TCGDEX_QUALITY = "low";
const EN_BATCH_SIZE = 200; // no rate limit on TCGdex, so a large batch clears the whole English catalog in a handful of cron ticks
const JA_BATCH_SIZE = 25; // candidates considered per run - most already have a free TCGdex image; only cards actually missing one touch the PokeWallet budget below
const MAX_POKEWALLET_REQUESTS_PER_RUN = 10; // worst case (search + image = 2 requests/card) = 20 PokeWallet calls/run; every 10 min via cron = well under the 100/hour cap, leaving headroom for live user lookups
const STORAGE_BUCKET = "card-images";
const POKEWALLET_BASE_URL = "https://api.pokewallet.io";

async function cacheImage(admin: any, cardId: string, blob: Blob, contentType: string) {
  const ext = contentType.includes("png") ? "png" : contentType.includes("jpeg") ? "jpg" : "webp";
  const path = `${cardId}.${ext}`;
  const { error: uploadErr } = await admin.storage
    .from(STORAGE_BUCKET)
    .upload(path, blob, { contentType, upsert: true });
  if (uploadErr) throw uploadErr;
  const { data } = admin.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl as string;
}

async function markCard(admin: any, cardId: string, cachedImageUrl: string) {
  await admin.from("cards").update({ cached_image_url: cachedImageUrl }).eq("id", cardId);
}

async function tryTcgdexImage(imageBase: string | null): Promise<{ blob: Blob; contentType: string } | null> {
  if (!imageBase) return null;
  try {
    const res = await fetch(`${imageBase}/${TCGDEX_QUALITY}.webp`);
    if (!res.ok) return null;
    return { blob: await res.blob(), contentType: res.headers.get("content-type") || "image/webp" };
  } catch {
    return null;
  }
}

async function cacheEnglishBatch(admin: any) {
  const { data: cards, error } = await admin
    .from("cards")
    .select("id, image")
    .eq("language", "en")
    .is("cached_image_url", null)
    .not("image", "is", null)
    .neq("image", "")
    .order("id")
    .limit(EN_BATCH_SIZE);

  if (error) throw error;
  let cached = 0;
  let failed = 0;

  for (const card of cards || []) {
    try {
      const found = await tryTcgdexImage(card.image);
      if (!found) {
        await markCard(admin, card.id, ""); // sentinel: attempted, nothing found - don't keep retrying every run
        failed++;
        continue;
      }
      const url = await cacheImage(admin, card.id, found.blob, found.contentType);
      await markCard(admin, card.id, url);
      cached++;
    } catch (err) {
      failed++;
      console.warn(`Failed to cache EN image ${card.id}:`, err);
    }
  }

  return { candidates: (cards || []).length, cached, failed };
}

async function cacheJapaneseBatch(admin: any, pwKey: string | null) {
  const { data: cards, error } = await admin
    .from("cards")
    .select("id, name, card_number, image")
    .eq("language", "ja")
    .is("cached_image_url", null)
    .order("id")
    .limit(JA_BATCH_SIZE);

  if (error) throw error;
  let cached = 0;
  let failed = 0;
  let pwRequests = 0;
  let pwBudgetExhausted = false;

  for (const card of cards || []) {
    try {
      // Free path first - many Japanese cards already have a TCGdex image,
      // and trying it costs nothing against the PokeWallet budget.
      let found = await tryTcgdexImage(card.image);

      if (!found && pwKey && !pwBudgetExhausted) {
        if (pwRequests + 2 > MAX_POKEWALLET_REQUESTS_PER_RUN) {
          pwBudgetExhausted = true; // leave this (and remaining) cards for the next cron tick rather than blow the hourly cap
        } else {
          // Strip non-Latin characters first - PokeWallet's search silently
          // returns zero results for a mixed-script query (confirmed:
          // "マグマ団の Numel 001/034" -> 0 results, "Numel 001/034" -> exact
          // match), a real gap for cards whose name still carries an
          // untranslated Japanese prefix (e.g. Team Magma/Aqua promo sets).
          const asciiName = (card.name || "").replace(/[^\x00-\x7F]+/g, " ").replace(/\s+/g, " ").trim();
          const query = [asciiName, card.card_number].filter(Boolean).join(" ").trim();
          const searchRes = await fetch(
            `${POKEWALLET_BASE_URL}/search?q=${encodeURIComponent(query)}&limit=5`,
            { headers: { "X-API-Key": pwKey } }
          );
          pwRequests++;
          if (searchRes.ok) {
            const searchData = await searchRes.json();
            const results = searchData?.results || [];
            const match =
              (card.card_number && results.find((r: any) => (r.card_info?.card_number || "").startsWith(card.card_number))) ||
              results[0];
            if (match?.id) {
              const imgRes = await fetch(
                `${POKEWALLET_BASE_URL}/images/${encodeURIComponent(match.id)}?size=${TCGDEX_QUALITY}`,
                { headers: { "X-API-Key": pwKey } }
              );
              pwRequests++;
              if (imgRes.ok) {
                found = { blob: await imgRes.blob(), contentType: imgRes.headers.get("content-type") || "image/webp" };
              }
            }
          }
        }
      }

      if (pwBudgetExhausted && !found) continue; // skip marking - retry this card next run instead of sentinel-ing it as "no image"

      if (!found) {
        await markCard(admin, card.id, ""); // sentinel: tried TCGdex and PokeWallet, nothing found anywhere
        failed++;
        continue;
      }

      const url = await cacheImage(admin, card.id, found.blob, found.contentType);
      await markCard(admin, card.id, url);
      cached++;
    } catch (err) {
      failed++;
      console.warn(`Failed to cache JA image ${card.id}:`, err);
    }
  }

  return { candidates: (cards || []).length, cached, failed, pwRequests };
}

export default {
  fetch: withSupabase({ auth: ["secret"] }, async (_req, ctx) => {
    const admin = ctx.supabaseAdmin;
    const pwKey = Deno.env.get("POKEWALLET_API_KEY") || null;

    const [en, ja] = await Promise.all([cacheEnglishBatch(admin), cacheJapaneseBatch(admin, pwKey)]);

    return Response.json({ english: en, japanese: ja });
  }),
};

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/cache-card-images' \
    --header 'apiKey: <service-role-key>'

*/
