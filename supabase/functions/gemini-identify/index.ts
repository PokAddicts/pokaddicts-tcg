// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Proxies Gemini vision card identification so the real Google AI key
// never ships to the browser - the client only needs this project's
// public "publishable" key (already used elsewhere in the app for
// Supabase, and safe to expose by design), while GEMINI_API_KEY lives only
// as a server-side secret (set via `supabase secrets set`).
//
// Contract mirrors what js/gemini-client.js used to call directly:
// request body { imageBase64, mimeType }, response is the same normalized
// shape the client expects: { name, set, number, isJapanese, confidence,
// isSlab, grade, gradingCompany, certNumber } or null if nothing detected.

const GEMINI_MODEL = "gemini-flash-latest";

const GEMINI_CARD_SCHEMA = {
  type: "object",
  properties: {
    detectedName: { type: "string" },
    isJapanese: { type: "boolean" },
    cardNumber: { type: "string" },
    isGradedSlab: { type: "boolean" },
    gradingCompany: { type: "string" },
    grade: { type: "string" },
    certNumber: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["detectedName", "isJapanese", "cardNumber", "isGradedSlab", "confidence"],
};

const GEMINI_CARD_PROMPT = `You are identifying a single Pokemon or One Piece trading card from a photo for an inventory app. Only Pokemon and One Piece cards are relevant - ignore any other TCG.
1. Determine the exact name shown on the card (Pokemon species, or One Piece character name). Only return a real, known name - never invent one. If genuinely unrecognizable, return "None".
2. Determine whether the text printed on the card is Japanese or not (English, or any other non-Japanese language) - judge this from the actual characters printed on the card, don't guess from art style.
3. Read the card number printed on the card (usually bottom-left or bottom-center, format like "8/102" or "025/165") - transcribe it literally as printed, do not estimate or infer it.
4. Determine if this card is sealed inside a hard plastic graded slab holder (PSA/BGS/CGC/SGC/etc), as opposed to a bare/raw card. If it is a slab, also read the grading company name, the numeric grade, and the certification number from the slab label if visible.
Return "None" for any text field you cannot determine with reasonable confidence.`;

function clean(v: unknown): string {
  return typeof v === "string" && v !== "None" ? v : "";
}

function normalizeDetection(parsed: any) {
  return {
    name: clean(parsed.detectedName),
    set: "",
    number: clean(parsed.cardNumber),
    isJapanese: !!parsed.isJapanese,
    confidence: parsed.confidence || "",
    isSlab: !!parsed.isGradedSlab,
    grade: clean(parsed.grade),
    gradingCompany: clean(parsed.gradingCompany).toUpperCase(),
    certNumber: clean(parsed.certNumber),
  };
}

export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, _ctx) => {
    if (req.method !== "POST") {
      return Response.json({ error: "POST only" }, { status: 405 });
    }

    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      return Response.json({ error: "GEMINI_API_KEY not configured on the server" }, { status: 500 });
    }

    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64) {
      return Response.json({ error: "imageBase64 is required" }, { status: 400 });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: GEMINI_CARD_PROMPT },
              { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } },
            ],
          }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: GEMINI_CARD_SCHEMA,
          },
        }),
      },
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => "");
      return Response.json({ error: `Gemini identify failed (${geminiRes.status}): ${errText}` }, { status: 502 });
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return Response.json({ detections: [] });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return Response.json({ detections: [] });
    }

    const detection = normalizeDetection(parsed);
    const detections = detection.name && detection.name.toLowerCase() !== "none" ? [detection] : [];
    return Response.json({ detections });
  }),
};

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/gemini-identify' \
    --header 'apiKey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
    --data '{"imageBase64":"...","mimeType":"image/jpeg"}'

*/
