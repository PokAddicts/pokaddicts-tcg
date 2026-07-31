/* ==========================================================================
   PokAddicts - Local Card Catalog
   A one-time (resumable) bulk import of the TCGdex card database - names,
   sets, numbers, and language (English + Japanese, matching the app's
   scan-language toggle - see js/tcgdex-client.js for why not all 12
   languages TCGdex supports), stored in IndexedDB and mirrored in memory
   so Intake/Trade search is instant and works offline at a tradeshow.

   When Supabase is configured, the catalog and sync progress are shared
   across every device (see the `cards` / `catalog_sync_state` tables in
   supabase/schema.sql, NOT scoped by room_code since card data is
   universal): once any phone has fetched a card from TCGdex, every other
   phone just reads it back from Supabase instead of re-fetching it.
   Without Supabase configured, this falls back to a fully local per-device
   sync against TCGdex directly.

   Only text is bulk-imported; images and live prices are fetched on demand
   (when a specific card is selected, or during the daily refresh) to keep
   the initial sync itself light and fast.
   ========================================================================== */

const CARD_CATALOG_DB_NAME = 'pokaddicts_card_catalog';
const CARD_CATALOG_STORE = 'cards';
// Bumped to v3 for the PokeWallet -> TCGdex migration - card ids, number
// formats, and the sets-per-language shape are all different now, so any
// old in-progress sync state would be nonsensical to resume from.
const CARD_CATALOG_SYNC_STATE_KEY = 'pokaddicts_catalog_sync_state_v3';

// Small delay between per-set sync requests - TCGdex has no hard rate
// limit, but their own FAQ asks callers to "be considerate" rather than
// hammering the free community-run API, and each request here already
// pulls a whole set's cards in one shot (no pagination needed).
const SYNC_REQUEST_DELAY_MS = 150;

// Builds the printed-style "080/073" number string - the denominator is
// zero-padded to match the card's own digit width when it came back
// shorter (e.g. "73" -> "073" alongside localId "080").
//
// Uses "official", not TCGdex's "total" - secret/bonus rares are numbered
// BEYOND the official set count but still print the official count as
// their own denominator (that's literally what makes them "secret": e.g.
// Champion's Path's Charizard VMAX secret rare is card 74 of a 73-card
// set, printed as "74/73", and its Charizard V secret rare is "79/73" -
// verified directly against real PokeWallet card records, same pattern as
// the original SV1a Magikarp case ("080/073") that surfaced this. An
// earlier attempt to validate this via aggregate per-SET card counts
// (rather than real individual printed numbers) wrongly concluded "total"
// was more often correct - that was comparing the wrong signal (how many
// cards PokeWallet has indexed for a set, not what's printed on any one
// of them) and got reverted.
function formatCardNumber(localId, official) {
  if (!official) return localId || '';
  const officialStr = String(official).padStart((localId || '').length, '0');
  return `${localId}/${officialStr}`;
}

// raw: TCGdex's brief per-card shape from a set's card list -
// { id, localId, name, image }. set: { id, name, total } for the
// enclosing set. lang: 'en' | 'ja'.
function normalizeCatalogCard(raw, set, lang) {
  return {
    id: raw.id,
    name: raw.name || 'Unknown Card',
    set: set.name || '',
    setId: set.id || '',
    number: formatCardNumber(raw.localId, set.total),
    language: lang,
    image: raw.image || ''
  };
}

function cardRowFromCatalogCard(c) {
  return { id: c.id, name: c.name, set_name: c.set, set_id: c.setId, card_number: c.number, language: c.language, image: c.image || '', low_quality: !!c.lowQuality };
}

// market_value_sgd/price_source/price_updated_at are written by the
// refresh-catalog-prices Edge Function (English cards only, on a cron
// schedule - see supabase/schema.sql) rather than by anything in this
// file, but need to flow through here so search can use them instead of
// always doing a live lookup. cached_image_url is written the same way by
// the cache-card-images Edge Function (both languages - see
// supabase/functions/cache-card-images) - null means "not attempted yet",
// '' means "attempted, no image found anywhere" (a real, permanent gap,
// not worth retrying), a real URL means an instant Storage read is
// available and getCardImageUrl() can skip the live TCGdex/PokeWallet
// race entirely.
function catalogCardFromRow(r) {
  return {
    id: r.id, name: r.name, set: r.set_name || '', setId: r.set_id || '', number: r.card_number || '',
    language: r.language || '', image: r.image || '', lowQuality: !!r.low_quality,
    marketValueSgd: r.market_value_sgd ?? null, priceSource: r.price_source || null, priceUpdatedAt: r.price_updated_at || null,
    cachedImageUrl: r.cached_image_url ?? null,
    // Written by refresh-snkrdunk-prices (Japanese cards only, ~3-6h cron
    // cycle - see supabase/schema.sql) rather than by anything in this
    // file - see js/card-search-ui.js's fetchAllPricesForCard for how a
    // fresh cached array here skips the live SnkrDunk search+price race.
    snkrdunkConditions: r.snkrdunk_conditions || null, snkrdunkUpdatedAt: r.snkrdunk_updated_at || null
  };
}

class CardCatalog {
  constructor() {
    this.db = null;
    this.cards = []; // in-memory mirror of everything imported so far, for instant search
    this.syncState = { status: 'not_started', sets: null, setIndex: 0, page: 1, totalCards: 0 };
    this.syncing = false;
    this.ready = this.init();
  }

  get remote() {
    return window.supabaseClient;
  }

  async init() {
    if ('indexedDB' in window) {
      try {
        this.db = await this.openDb();
        this.cards = await this.loadAllFromDb();
      } catch (err) {
        console.error('Card catalog init failed:', err);
      }
    } else {
      console.warn('IndexedDB not available - local card catalog cache disabled.');
    }

    if (this.remote) {
      await this.loadFromSupabase();
    } else {
      this.loadSyncStateFromLocalStorage();
    }
  }

  // Pulls the shared sync-progress row and any cards this device doesn't
  // have locally yet. Falls back to local-only state on any failure.
  async loadFromSupabase() {
    try {
      const { data: stateRow, error: stateErr } = await this.remote.from('catalog_sync_state').select('*').eq('id', 'main').maybeSingle();
      if (stateErr) throw stateErr;

      if (stateRow) {
        this.syncState = {
          status: stateRow.status,
          sets: stateRow.sets,
          setIndex: stateRow.set_index,
          page: stateRow.page,
          totalCards: stateRow.total_cards
        };
      }

      if (this.cards.length < this.syncState.totalCards) {
        const rows = await this.pullAllCardRows();
        const cards = rows.map(catalogCardFromRow);
        await this.saveCards(cards);
        this.cards = cards;
      }
    } catch (err) {
      console.error('Failed to load shared card catalog from Supabase, using local cache:', err);
      this.loadSyncStateFromLocalStorage();
    }
  }

  async pullAllCardRows() {
    const pageSize = 1000;
    let all = [];
    let from = 0;
    while (true) {
      const { data, error } = await this.remote.from('cards').select('*').range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all = all.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }

  loadSyncStateFromLocalStorage() {
    const raw = localStorage.getItem(CARD_CATALOG_SYNC_STATE_KEY);
    this.syncState = raw ? JSON.parse(raw) : { status: 'not_started', sets: null, setIndex: 0, page: 1, totalCards: 0 };
  }

  openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CARD_CATALOG_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CARD_CATALOG_STORE)) {
          const store = db.createObjectStore(CARD_CATALOG_STORE, { keyPath: 'id' });
          store.createIndex('name', 'name', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  loadAllFromDb() {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve([]);
      const tx = this.db.transaction(CARD_CATALOG_STORE, 'readonly');
      const req = tx.objectStore(CARD_CATALOG_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  saveCards(cards) {
    return new Promise((resolve, reject) => {
      if (!this.db || cards.length === 0) return resolve();
      const tx = this.db.transaction(CARD_CATALOG_STORE, 'readwrite');
      const store = tx.objectStore(CARD_CATALOG_STORE);
      cards.forEach(c => store.put(c));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Fire-and-forget: pushes newly-fetched cards into the shared Supabase
  // table so other devices never need to re-fetch them from PokeWallet.
  pushCardsToSupabase(cards) {
    if (!this.remote || cards.length === 0) return;
    this.remote.from('cards').upsert(cards.map(cardRowFromCatalogCard))
      .then(({ error }) => { if (error) console.error('Failed to push cards to Supabase:', error); });
  }

  // Splits "flareon 202" into { namePart: "flareon", numberPart: "202" } -
  // people search by card number as much as by name, so a trailing (or
  // leading) number in the query is treated as the card number, not part
  // of the name. Almost nobody types "#" before the number, so it's
  // stripped wherever it appears rather than only matched optionally right
  // before the digits.
  parseCardQuery(query) {
    const trimmed = (query || '').replace(/#/g, ' ').trim().replace(/\s+/g, ' ');

    // "110/080" style - the printed numerator/denominator format people
    // type verbatim off the card. Checked BEFORE the plain-trailing-number
    // case below, or that one would greedily swallow the "/080" into the
    // name (nothing but whitespace separates a name from a trailing
    // number in that pattern, and "/" isn't whitespace) and search by the
    // denominator instead - which is meaningless on its own since many
    // completely unrelated cards share the same set-size denominator.
    // Only the numerator (this card's own number) is meaningful to search.
    let match = trimmed.match(/^(.*?)\s*(\d+)\s*\/\s*\d+$/);
    if (match) {
      return { namePart: match[1].toLowerCase().trim(), numberPart: match[2] };
    }

    match = trimmed.match(/^(.*?)\s*(\d+)$/);
    if (match) {
      return { namePart: match[1].toLowerCase().trim(), numberPart: match[2] };
    }

    match = trimmed.match(/^(\d+)\s*(.*)$/);
    if (match) {
      return { namePart: match[2].toLowerCase().trim(), numberPart: match[1] };
    }

    return { namePart: trimmed.toLowerCase(), numberPart: null };
  }

  // Ranks a list of cards against a query: name must match (prefix beats
  // substring); if a number was typed, an exact/prefix/substring match on
  // the card's number is scored far above a name-only match, without
  // excluding non-matching numbers outright (catalog data is incomplete,
  // so a strict filter would hide otherwise-good name matches).
  rankCards(cards, query) {
    const { namePart, numberPart } = this.parseCardQuery(query);
    // Card numbers are almost always zero-padded in the catalog (e.g.
    // "005", or "005/102" with the set total) even though nobody types the
    // leading zeros - compare by numeric VALUE (not string equality) so
    // "5" matches "005" and "005/102" alike, instead of only matching
    // cards that happen to share the exact same padding/suffix format.
    const queryNum = numberPart ? parseInt(numberPart, 10) : null;
    const scored = [];

    for (const c of cards) {
      const name = (c.name || '').toLowerCase();
      const cardNumber = (c.number || '').toString();
      const leadingDigits = cardNumber.match(/^0*(\d+)/);
      const cardNum = leadingDigits ? parseInt(leadingDigits[1], 10) : null;

      if (namePart && !name.includes(namePart)) continue;

      let score = namePart && name.startsWith(namePart) ? 0 : 1;

      if (numberPart) {
        if (cardNum !== null && cardNum === queryNum) score -= 100;
        else if (cardNumber.includes(numberPart)) score -= 10;
        // A number was typed but this card's number doesn't contain it at
        // all - drop it entirely rather than showing it ranked below the
        // actual matches, even when the name also matches.
        else continue;
      }

      // Known-broken/duplicate entries (no image AND no price ever found)
      // sink to the bottom instead of cluttering results - still shown if
      // nothing else matches, since the flag isn't a guarantee, just a
      // signal from a previous lookup.
      if (c.lowQuality) score += 1000;

      scored.push({ card: c, score, cardNum });
    }

    // Within the same score tier, break ties by ascending card number - so
    // when several cards contain the typed digits (e.g. query "5" matching
    // 005, 015, 105, 025), the lowest number surfaces first instead of
    // whatever order the catalog happened to store them in.
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.cardNum === null) return 1;
      if (b.cardNum === null) return -1;
      return a.cardNum - b.cardNum;
    });
    return scored.map(s => s.card);
  }

  // Case-insensitive name+number search over the in-memory catalog.
  searchLocal(query, limit = 15) {
    if (!query || !query.trim()) return [];
    return this.rankCards(this.cards, query).slice(0, limit);
  }

  // Keeps only the first entry for each distinct card NUMBER. Once a
  // number has already been shown, further entries sharing it (different
  // sets/prints that all happen to use the same number, or entries the
  // Japanese name-only search fallback pulls in from several sources) just
  // read as repeated/duplicate suggestions rather than useful extra
  // choices. Entries with no number at all are never deduped against each
  // other (nothing to compare).
  dedupeByNumber(cards) {
    const seen = new Set();
    const result = [];
    for (const c of cards) {
      const key = (c.number || '').toString();
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      result.push(c);
    }
    return result;
  }

  // Same idea as searchLocal, but restricted to one set-language edition
  // (e.g. 'ja'), and ALWAYS REQUIRING a name-hint match - not just as a
  // tiebreaker. A card number is reused across hundreds of unrelated
  // species across all the sets in a language (e.g. ~50+ completely
  // different Pokemon all use number "080" across Japanese sets), so
  // number alone is nowhere near enough signal; a "match" that's actually
  // the wrong species is worse than showing no match at all. numberQuery
  // is optional - a name-only search (no number typed) still requires a
  // name-hint match, just across every number in that language, the same
  // way a name-only search of the English catalog would. nameHints should
  // include both an English guess and (via translateEnglishToJapanese) a
  // guessed native-script name, since TCGdex's Japanese catalog
  // inconsistently stores cards under either an English or Japanese name.
  searchLocalByLanguage(numberQuery, languageCode, limit = 15, nameHints = []) {
    const lang = languageCode.toLowerCase();
    const hints = nameHints.filter(Boolean).map(h => h.toLowerCase());
    if (hints.length === 0) return [];
    const queryNum = numberQuery ? parseInt(numberQuery, 10) : null;

    const matches = [];
    for (const c of this.cards) {
      if (!(c.language || '').toLowerCase().startsWith(lang)) continue;
      if (queryNum !== null) {
        const leadingDigits = (c.number || '').toString().match(/^0*(\d+)/);
        const cardNum = leadingDigits ? parseInt(leadingDigits[1], 10) : null;
        if (cardNum !== queryNum) continue;
      }
      if (!hints.some(h => (c.name || '').toLowerCase().includes(h))) continue;

      matches.push(c);
    }

    return matches.slice(0, limit);
  }

  // Looks for a known Japanese species name as a substring of the given
  // text, returning the raw Japanese text itself (not translated) - used
  // to build a query that can actually match a Japanese-edition catalog
  // entry, since those carry their own native-script name rather than an
  // English translation.
  findJapaneseSpeciesMatch(text) {
    if (!window.POKEMON_JP_NAMES) return null;

    let bestMatch = null;
    for (const jpName in window.POKEMON_JP_NAMES) {
      if (text.includes(jpName) && (!bestMatch || jpName.length > bestMatch.length)) {
        bestMatch = jpName;
      }
    }
    return bestMatch;
  }

  // Looks for a known Japanese species name as a substring of the given
  // text and rebuilds the whole name in English around it, rather than
  // just returning the bare species alone - a card like "メガリザードンXex"
  // (Mega Charizard X ex) would otherwise translate down to just
  // "Charizard", losing the Mega/X/ex modifiers that actually distinguish
  // it from a regular Charizard. Handles the small fixed set of Japanese
  // prefix words that precede a species name (Mega Evolution + the four
  // regional forms); anything else before/after the species (trainer
  // names in possessive form, card-type suffixes not already in Latin
  // script) is left as-is since there's no lookup table for those. Covers
  // Gen 1-7 species - a species not in the table (e.g. very recent Gen
  // 8/9 prints), or a Trainer/Energy card with no species name in it at
  // all, returns null and the raw text is used as a fallback by callers.
  translateJapaneseName(text) {
    if (!text) return null;
    const bestMatch = this.findJapaneseSpeciesMatch(text);
    if (!bestMatch) return null;

    const idx = text.indexOf(bestMatch);
    let before = text.slice(0, idx).trim();
    let after = text.slice(idx + bestMatch.length).trim();
    const english = window.POKEMON_JP_NAMES[bestMatch];

    const prefixTranslations = { 'メガ': 'Mega', 'アローラ': 'Alolan', 'ガラル': 'Galarian', 'ヒスイ': 'Hisuian', 'パルデア': 'Paldean' };
    for (const [jp, en] of Object.entries(prefixTranslations)) {
      if (before.endsWith(jp)) {
        before = (before.slice(0, -jp.length).trim() + ' ' + en).trim();
        break;
      }
    }

    // TCGdex's own English catalog confirms the real spacing: "Mega
    // Charizard X ex", not "Mega Charizard Xex" - a form letter (X/Y) is
    // its own separate word from the following "ex"/"gx" suffix, even
    // though the raw Japanese text has them jammed together with no space.
    // Requiring the prefix to be fully uppercase avoids ever matching a
    // genuine word that happens to end in "ex"/"gx".
    after = after.replace(/^([A-Z]+)(ex|gx)$/, '$1 $2');

    return [before, english, after].filter(Boolean).join(' ').trim();
  }

  // Reverse of POKEMON_JP_NAMES (English -> Japanese), built once on first
  // use - lets an English guess be translated into a plausible Japanese
  // name, used as a permissive hint (not a filter) when searching TCGdex's
  // Japanese catalog, since many of its entries only have their native-
  // script name filled in rather than an English one.
  translateEnglishToJapanese(name) {
    if (!name || !window.POKEMON_JP_NAMES) return null;
    if (!this._enToJpMap) {
      this._enToJpMap = {};
      for (const jpName in window.POKEMON_JP_NAMES) {
        const en = window.POKEMON_JP_NAMES[jpName].toLowerCase();
        if (!this._enToJpMap[en]) this._enToJpMap[en] = jpName;
      }
    }
    return this._enToJpMap[name.toLowerCase()] || null;
  }

  // Builds a broader set of name hints for matching against TCGdex's
  // Japanese catalog. Two problems compound here: modifier suffixes like
  // "ex"/"GX"/"V"/"X"/"Mega" won't appear in the reverse-translation table
  // (which only knows base species names, e.g. "charizard" not "charizard
  // x ex"), AND a compound name like "Charizard X EX" won't literally
  // substring-match a native-script name like "メガリザードンXex" either -
  // but the base species alone, translated ("リザードン"), DOES appear
  // inside it. So this also tries just the first word of the name, both
  // as literal English text and translated, alongside the full name.
  buildJapaneseNameHints(name) {
    if (!name) return [];
    const hints = [name];
    const firstWord = name.trim().split(/\s+/)[0];
    if (firstWord && firstWord.toLowerCase() !== name.toLowerCase()) hints.push(firstWord);
    hints.push(this.translateEnglishToJapanese(name));
    if (firstWord) hints.push(this.translateEnglishToJapanese(firstWord));
    return [...new Set(hints.filter(Boolean))];
  }

  // Strict name-hint search against TCGdex's Japanese catalog (optionally
  // narrowed further by number, if one was given) - a card only counts as
  // a match if its name actually matches one of the hints (an English
  // guess, or its reverse-translated Japanese guess). A card number alone
  // is reused across dozens of unrelated species within the Japanese card
  // pool (~50+ completely different Pokemon all share number "080"
  // alone), so a same-numbered-but-wrong-species result is worse than no
  // result at all - and a name with no number at all should still be
  // searchable, the same way a name-only search of the English catalog
  // already is. Local cache first, live fallback. Shared by both the
  // scanner (js/scanner.js) and the manual card search widget
  // (js/card-search-ui.js), so typing a Japanese card's English name into
  // Intake/Trade search works the same way scanning it does.
  async findJapaneseMatches(number, nameHints, limit = 6) {
    const hints = nameHints.filter(Boolean);
    if (hints.length === 0) return [];

    let matches = this.searchLocalByLanguage(number, 'ja', limit, hints);

    if (matches.length === 0 && window.tcgdexClient?.configured) {
      try {
        // The live endpoint needs some text to search on - prefer a
        // Japanese-script hint if one was built (translateEnglishToJapanese
        // succeeded), since TCGdex's Japanese catalog inconsistently
        // stores cards under either an English or native-script name and
        // the native-script one is more likely to actually hit.
        const jpHint = hints.find(h => /[぀-ヿ一-鿿]/.test(h));
        const queryText = [jpHint || hints[0], number].filter(Boolean).join(' ').trim();
        const results = await window.tcgdexClient.searchCards(queryText, { limit: 20, lang: 'ja' });
        const liveCards = results.map(r => window.cardSearchUI.normalizeLiveSearchResult(r, 'ja'));
        await this.cacheLiveResults(liveCards);
        const lowerHints = hints.map(h => h.toLowerCase());
        const queryNum = number ? parseInt(number, 10) : null;
        matches = liveCards.filter(c => {
          if (queryNum !== null) {
            const leadingDigits = (c.number || '').toString().match(/^0*(\d+)/);
            const cardNum = leadingDigits ? parseInt(leadingDigits[1], 10) : null;
            if (cardNum !== queryNum) return false;
          }
          return lowerHints.some(h => (c.name || '').toLowerCase().includes(h));
        }).slice(0, limit);
      } catch (err) {
        console.warn('Live Japanese-edition search failed:', err);
      }
    }

    return matches;
  }

  // Cross-references a set id against the full sets list (fetched once, up
  // front, before the much slower per-card sync even starts) to find that
  // set's language/name/card total - works even when full card-level sync
  // is nowhere near that set yet, which is why this is used to enrich live
  // TCGdex search results (which only return id/localId/name/image, no set
  // name or total) without an extra network round trip.
  getSetInfoById(setId) {
    if (!this._setInfoMap) {
      this._setInfoMap = new Map();
      (this.syncState.sets || []).forEach(s => this._setInfoMap.set(String(s.id), s));
    }
    return this._setInfoMap.get(String(setId)) || null;
  }

  getCardById(id) {
    return this.cards.find(c => c.id === id) || null;
  }

  // Fetches a card's image from TCGdex and PokeWallet AT THE SAME TIME
  // (not one after the other) and returns whichever comes back with a
  // real image first - TCGdex usually has it, but a confirmed real gap
  // for some Japanese sets/secret rares means it sometimes has nothing at
  // all, and waiting for that failure before even starting the PokeWallet
  // attempt added a full extra round trip of delay for no reason.
  //
  // Checked first: cards.cached_image_url, a permanent Supabase Storage
  // copy populated by the cache-card-images Edge Function (background
  // cron, both languages - see supabase/schema.sql). An image never
  // changes once printed, so once cached it's cached forever - this skips
  // the TCGdex/PokeWallet race entirely and is why lookups feel instant
  // for any card someone else has already searched before.
  async getCardImageUrl(catalogCardId, size = 'low') {
    const card = this.getCardById(catalogCardId);
    if (card?.cachedImageUrl) return card.cachedImageUrl;

    // TCGdex's own URL can't be re-fetched client-side to feed the
    // permanent cache (see tcgdex-client.js - no CORS support), so it's
    // marked non-cacheable here; the server-side cache-card-images cron
    // already covers it without any CORS restriction. Only a PokeWallet
    // result (a real blob: URL from our own CORS-enabled proxy) is
    // actually fetchable client-side, so only that gets cached below.
    const tcgdexPromise = window.tcgdexClient.getImageUrl(catalogCardId, size)
      .then((url) => ({ url, cacheable: false }))
      .catch((err) => { console.warn('TCGdex image fetch failed:', err); return { url: null, cacheable: false }; });

    const pokeWalletPromise = (async () => {
      // Skipped entirely once TCGdex already has an image for this card -
      // firing it anyway would waste a PokeWallet request that's
      // essentially never going to win the race (TCGdex now resolves near
      // instantly, since it's just a URL, not a fetch) AND was quietly
      // exhausting PokeWallet's hourly quota (100/hour) on lookups that
      // never even needed it - confirmed directly: ordinary usage plus
      // the background image-cache backfill pushed hourly usage to
      // 200/100, breaking every Japanese lookup for the rest of that hour.
      if (!window.pokeWalletClient?.configured || !card || card.image) return { url: null, cacheable: false };
      try {
        const displayName = this.translateJapaneseName(card.name) || card.name;
        const match = await window.pokeWalletClient.findCardByNameAndNumber(displayName, card.number);
        if (!match) return { url: null, cacheable: false };
        const url = await window.pokeWalletClient.getImageBlobUrl(match.id, size);
        return { url, cacheable: true };
      } catch (err) {
        console.warn('PokeWallet image fetch failed:', err);
        return { url: null, cacheable: false };
      }
    })();

    const contenders = [tcgdexPromise, pokeWalletPromise];
    return new Promise((resolve) => {
      let remaining = contenders.length;
      let settled = false;
      contenders.forEach((p) => {
        p.then(({ url, cacheable }) => {
          if (!settled && url) {
            settled = true;
            resolve(url);
            // Fire-and-forget: this card just got looked up live (it had
            // no cached_image_url yet, or getCardImageUrl would have
            // returned above), so cache it now rather than leaving it for
            // the background cron to reach in sequential id order (which,
            // for a ~23,000/~8,000-card catalog, can be hours away). The
            // cards actually being searched right now are exactly the
            // ones worth caching first - this is what makes a SECOND
            // lookup of the same card (from any device) instant, without
            // waiting on the bulk sweep at all.
            if (card && size === 'low' && cacheable) this.cacheImagePermanently(card.id, url);
          }
          remaining -= 1;
          if (remaining === 0 && !settled) resolve(null);
        });
      });
    });
  }

  // Uploads a live-fetched image to the shared card-images Storage bucket
  // and records its public URL on the card's row, so every future lookup
  // (this device or any other) hits the instant cached path above instead
  // of repeating the same TCGdex/PokeWallet race. Never awaited by the
  // caller - the user already has their image the moment this starts.
  async cacheImagePermanently(cardId, blobUrl) {
    if (!this.remote) return;
    try {
      const blob = await (await fetch(blobUrl)).blob();
      const ext = blob.type.includes('png') ? 'png' : blob.type.includes('jpeg') ? 'jpg' : 'webp';
      const path = `${cardId}.${ext}`;

      const { error: uploadErr } = await this.remote.storage
        .from('card-images')
        .upload(path, blob, { contentType: blob.type || 'image/webp', upsert: true });
      if (uploadErr) throw uploadErr;

      const { data } = this.remote.storage.from('card-images').getPublicUrl(path);
      await this.remote.from('cards').update({ cached_image_url: data.publicUrl }).eq('id', cardId);

      // Update the in-memory copy too, so this same session's next lookup
      // of the same card is instant without waiting for a re-sync.
      const card = this.getCardById(cardId);
      if (card) card.cachedImageUrl = data.publicUrl;
    } catch (err) {
      console.warn('Permanent image cache upload failed:', err);
    }
  }

  // Called after a confirm-step lookup finds neither an image nor a
  // price for a selected card - marks it locally and in the shared
  // Supabase table so every device's search deprioritizes it from then on.
  async flagCardAsLowQuality(cardId) {
    const card = this.getCardById(cardId);
    if (!card || card.lowQuality) return;

    card.lowQuality = true;
    await this.saveCards([card]);

    if (this.remote) {
      this.remote.from('cards').update({ low_quality: true }).eq('id', cardId)
        .then(({ error }) => { if (error) console.error('Failed to flag low-quality card in Supabase:', error); });
    }
  }

  // Folds live PokeWallet /search hits into the local catalog (memory +
  // IndexedDB + shared Supabase table) so a card the bulk sync hasn't
  // reached yet only ever needs a live lookup once, from any device.
  async cacheLiveResults(cards) {
    const newCards = (cards || []).filter(c => !this.cards.some(existing => existing.id === c.id));
    if (newCards.length === 0) return;
    await this.saveCards(newCards);
    this.cards.push(...newCards);
    this.pushCardsToSupabase(newCards);
  }

  // Small status line shown above the card search field in Intake / Trade
  // forms, so it's obvious whether search is backed by the full catalog
  // yet without interrupting whatever the user is currently typing.
  renderStatusLineHTML() {
    const state = this.getSyncState();

    if (state.status === 'complete') {
      return `<div style="font-size: 0.72rem; color: var(--text-muted); margin-bottom: 8px;">✓ Card catalog ready (${state.totalCards.toLocaleString()} cards)</div>`;
    }
    if (state.status === 'in_progress') {
      return `<div style="font-size: 0.72rem; color: var(--text-muted); margin-bottom: 8px;">🔄 Syncing card catalog in the background (${state.totalCards.toLocaleString()} cards so far)...</div>`;
    }
    if (state.status === 'paused') {
      return `<div style="font-size: 0.72rem; color: var(--accent-red); margin-bottom: 8px; cursor: pointer;" onclick="window.cardCatalog.syncCatalog()">⚠ Catalog sync paused - tap to retry (${state.totalCards.toLocaleString()} cards so far)</div>`;
    }
    return `<div style="font-size: 0.72rem; color: var(--text-muted); margin-bottom: 8px; cursor: pointer;" onclick="window.cardCatalog.syncCatalog()">Card catalog not synced yet - tap to start.</div>`;
  }

  getSyncState() {
    return this.syncState;
  }

  // Persists locally always; also pushes to the shared Supabase row when
  // configured, so other devices see (and resume from) the same progress.
  saveSyncState() {
    localStorage.setItem(CARD_CATALOG_SYNC_STATE_KEY, JSON.stringify(this.syncState));

    if (this.remote) {
      this.remote.from('catalog_sync_state').upsert({
        id: 'main',
        sets: this.syncState.sets,
        set_index: this.syncState.setIndex,
        page: this.syncState.page,
        total_cards: this.syncState.totalCards,
        status: this.syncState.status,
        updated_at: new Date().toISOString()
      }).then(({ error }) => { if (error) console.error('Failed to push sync progress to Supabase:', error); });
    }
  }

  // Resumable bulk import: walks every set across English + Japanese.
  // Safe to stop (close the tab) and resume later - progress is saved
  // after every set, shared across devices when Supabase is configured.
  // Each set is fetched in ONE request (TCGdex returns a whole set's
  // cards in its set-detail response, no pagination loop needed).
  async syncCatalog(onProgress) {
    if (!window.tcgdexClient.configured || this.syncing) return;
    await this.ready;

    if (this.syncState.status === 'complete') return;

    this.syncing = true;
    this.syncState.status = 'in_progress';
    this.saveSyncState();

    try {
      if (!this.syncState.sets) {
        const languages = ['en', 'ja'];
        let allSets = [];
        for (const lang of languages) {
          const setsRes = await window.tcgdexClient.listSets(lang);
          // "official" (not "total" - see formatCardNumber()'s comment for
          // why) is what's actually printed on the card.
          allSets = allSets.concat((setsRes || []).map(s => ({
            id: s.id, name: s.name, language: lang, total: s.cardCount?.official || s.cardCount?.total || 0
          })));
        }
        this.syncState.sets = allSets;
        this.syncState.setIndex = 0;
        this.saveSyncState();
      }

      while (this.syncState.setIndex < this.syncState.sets.length) {
        const set = this.syncState.sets[this.syncState.setIndex];

        const res = await window.tcgdexClient.getSetCards(set.id, set.language);
        const cardsRaw = res.cards || [];
        const total = res.cardCount?.official || res.cardCount?.total || set.total;
        const cards = cardsRaw.map(c => normalizeCatalogCard(c, { id: set.id, name: res.name || set.name, total }, set.language));

        await this.saveCards(cards);
        this.cards.push(...cards);
        this.pushCardsToSupabase(cards);
        this.syncState.totalCards += cards.length;

        this.syncState.setIndex += 1;
        this.saveSyncState();

        if (onProgress) onProgress({ ...this.syncState, setName: set.name });

        if (this.syncState.setIndex >= this.syncState.sets.length) break;
        await new Promise(r => setTimeout(r, SYNC_REQUEST_DELAY_MS));
      }

      this.syncState.status = 'complete';
      this.saveSyncState();
      if (onProgress) onProgress({ ...this.syncState });
    } catch (err) {
      console.error('Card catalog sync paused due to an error (will resume next time it runs):', err);
      this.syncState.status = 'paused';
      this.saveSyncState();
    } finally {
      this.syncing = false;
    }
  }

  // Live price lookup (in SGD) used during the daily inventory price
  // refresh - the local catalog id IS the TCGdex id, so this is a direct,
  // unambiguous lookup once we know which language endpoint it lives on.
  // Japanese cards use PokeWallet for pricing instead of TCGdex - see
  // js/scanner.js's fetchVariantsForCard() for why (TCGdex's own pricing
  // for Japanese secret/art rares proved unreliable).
  async fetchLivePrice(cardId) {
    const card = this.getCardById(cardId);
    const lang = card?.language || 'en';

    if (lang === 'ja' && window.pokeWalletClient?.configured) {
      try {
        const match = await window.pokeWalletClient.findCardByNameAndNumber(card.name, card.number);
        if (match) {
          const detail = await window.pokeWalletClient.getCard(match.id);
          const result = window.pokeWalletClient.extractMarketPriceSGD(detail);
          if (result.price > 0) return result;
        }
      } catch (err) {
        console.warn('PokeWallet price lookup failed, falling back to TCGdex:', err);
      }
    }

    try {
      const detail = await window.tcgdexClient.getCard(cardId, lang)
        .catch(() => window.tcgdexClient.getCard(cardId, lang === 'ja' ? 'en' : 'ja'));
      return window.tcgdexClient.extractMarketPriceSGD(detail);
    } catch (err) {
      console.warn('Price lookup failed:', err);
      return { price: 0, source: null };
    }
  }
}

window.cardCatalog = new CardCatalog();
// Shared with card-search-ui.js's normalizeLiveSearchResult() so a live
// TCGdex search result is formatted identically to a synced catalog card.
window.formatCardNumber = formatCardNumber;
