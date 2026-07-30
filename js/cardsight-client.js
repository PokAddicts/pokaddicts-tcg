/* ==========================================================================
   PokAddicts - CardSight AI Client
   Photo-based trading card identification for Quick Scan - replaces the
   earlier OCR-guess approach with a real card-ID API.

   cardsight.ai/documentation is a JS-rendered SPA that couldn't be
   scraped for exact field names, so this was reverse-engineered against
   the live API by direct probing:
   - POST https://api.cardsight.ai/v1/identify/card
   - Auth: X-API-Key header (confirmed - wrong header formats return 401,
     this one gets past auth to real validation errors)
   - Missing image file responds 400 {"error":"No image file provided"}
   - The multipart image field name is a best guess ("image") - a few
     candidates all passed the "missing" check with a 1x1 test pixel, so
     this hasn't been confirmed against a real card photo.
   - Their Node SDK exposes identify.cardBySegment('football', image),
     confirming a per-request "segment" filter exists with "Pokemon" as a
     known valid value. The exact form field name ("segment"), the One
     Piece value, and whether multiple segments can be combined in one
     call are NOT confirmed - sent as a best guess below.
   - Grading/slab info: CardSight's docs list "Grading information" as a
     capability separate from identification, so whether a graded slab's
     grade/company comes back inline on a normal identify call is
     unconfirmed. normalizeDetection() below checks a few plausible field
     names and treats a detection as a slab if any are present.
   All of this should be verified against real card/slab photos - if
   something's off (wrong field names, segment filter not applying,
   grading never detected), that's the first place to look.
   ========================================================================== */

const CARDSIGHT_API_KEY = '994f23fde499428c800138a0dff7ce3e';
const CARDSIGHT_BASE_URL = 'https://api.cardsight.ai/v1';

class CardSightClient {
  get configured() {
    return !!CARDSIGHT_API_KEY;
  }

  authHeaders() {
    return { 'X-API-Key': CARDSIGHT_API_KEY };
  }

  // imageBlob: a Blob (e.g. from canvas.toBlob()).
  // Returns an array of normalized detections (possibly empty if nothing
  // was identified). One photo can contain more than one physical card.
  async identifyCards(imageBlob) {
    if (!this.configured) throw new Error('CardSight API key not configured');

    const formData = new FormData();
    formData.append('image', imageBlob, 'card.jpg');
    // Best-effort: scope identification to Pokemon + One Piece TCG only,
    // so sports cards (baseball/football/etc - which CardSight also
    // covers) don't show up as suggestions.
    formData.append('segment', 'pokemon,onepiece');

    const res = await fetch(`${CARDSIGHT_BASE_URL}/identify/card`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: formData
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`CardSight identify failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const detections = data?.detections || [];

    return detections
      .filter(d => d.card && d.card.name)
      .map(d => this.normalizeDetection(d));
  }

  normalizeDetection(d) {
    const card = d.card || {};
    const gradingInfo = card.grading || d.grading || null;
    const grade = card.grade || gradingInfo?.grade || '';
    const gradingCompany = card.gradingCompany || card.grader || gradingInfo?.company || '';
    const certNumber = card.certNumber || card.cert || '';
    const isSlab = !!(grade || gradingCompany || certNumber);

    return {
      name: card.name,
      set: card.releaseName || card.setName || '',
      number: card.number || '',
      confidence: d.confidence || '',
      isSlab,
      grade,
      gradingCompany,
      certNumber
    };
  }
}

window.cardSightClient = new CardSightClient();
