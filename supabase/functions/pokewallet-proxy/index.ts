// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Thin pass-through proxy for the PokeWallet API - so the real
// POKEWALLET_API_KEY never ships to the browser. The client calls this
// function with the same path/query it used to send straight to
// api.pokewallet.io (e.g. "/sets", "/cards/{id}", "/search?q=...",
// "/images/{id}?size=low"), and this just forwards it with the secret key
// attached server-side, streaming back whatever comes back (JSON for most
// endpoints, binary for /images) unchanged.

const POKEWALLET_BASE_URL = "https://api.pokewallet.io";

export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, _ctx) => {
    const pwKey = Deno.env.get("POKEWALLET_API_KEY");
    if (!pwKey) {
      return Response.json({ error: "POKEWALLET_API_KEY not configured on the server" }, { status: 500 });
    }

    const url = new URL(req.url);
    // Strip everything up to and including "/pokewallet-proxy" - whatever
    // remains is the real PokeWallet path (plus its original query string).
    const marker = "/pokewallet-proxy";
    const idx = url.pathname.indexOf(marker);
    const subPath = idx >= 0 ? url.pathname.slice(idx + marker.length) : "/";
    const target = `${POKEWALLET_BASE_URL}${subPath || "/"}${url.search}`;

    const pwRes = await fetch(target, { headers: { "X-API-Key": pwKey } });

    const contentType = pwRes.headers.get("content-type") || "application/json";
    const body = await pwRes.arrayBuffer();

    return new Response(body, {
      status: pwRes.status,
      headers: { "Content-Type": contentType },
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/pokewallet-proxy/sets' \
    --header 'apiKey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'

*/
