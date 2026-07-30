/* ==========================================================================
   PokAddicts - Gemini Vision Client
   Photo-based trading card identification for Quick Scan - replaces
   CardSight AI with Google's Gemini vision model.

   The actual Gemini API key never reaches the browser: this client calls a
   Supabase Edge Function (supabase/functions/gemini-identify) which holds
   GEMINI_API_KEY as a server-side secret and forwards the request. The
   only credential shipped here is Supabase's own publishable key (from
   js/supabase-client.js) - that one is meant to be public by design, the
   same way it already is for the shared card catalog sync.

   Confirmed end-to-end against a real Charizard Base Set photo via the
   deployed function: correctly returned name "Charizard", number
   "4/102", isJapanese: false, high confidence.
   ========================================================================== */

const GEMINI_FUNCTION_URL = `${typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : ''}/functions/v1/gemini-identify`;

class GeminiClient {
  get configured() {
    return typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL.startsWith('http');
  }

  async blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // imageBlob: a Blob (e.g. from canvas.toBlob()).
  // Returns an array of normalized detections (empty if nothing was
  // identified) - one photo only ever yields one detection here, but kept
  // as an array since scanner.js just reads detections[0].
  async identifyCards(imageBlob) {
    if (!this.configured) throw new Error('Supabase is not configured - cannot reach the Gemini identify function');

    const base64 = await this.blobToBase64(imageBlob);

    const res = await fetch(GEMINI_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apiKey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ imageBase64: base64, mimeType: imageBlob.type || 'image/jpeg' })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini identify failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data?.detections || [];
  }
}

window.geminiClient = new GeminiClient();
