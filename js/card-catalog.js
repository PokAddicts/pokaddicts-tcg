/* ==========================================================================
   PokAddicts - Local Card Catalog
   A one-time (resumable) bulk import of the PokeWallet card database -
   names, sets, numbers, and language - across ALL languages (English,
   Japanese, German, etc. are distinct sets with their own card pools, not
   just localized art), stored in IndexedDB and mirrored in memory so
   Intake/Trade search is instant and works offline at a tradeshow.

   When Supabase is configured, the catalog and sync progress are shared
   across every device (see the `cards` / `catalog_sync_state` tables in
   supabase/schema.sql, NOT scoped by room_code since card data is
   universal): once any phone has fetched a card from PokeWallet, every
   other phone just reads it back from Supabase instead of re-fetching it.
   Without Supabase configured, this falls back to a fully local per-device
   sync against PokeWallet directly.

   Only text is bulk-imported; images and live prices are fetched on demand
   (when a specific card is selected, or during the daily refresh) since
   PokeWallet's free tier is rate-limited.
   ========================================================================== */

const CARD_CATALOG_DB_NAME = 'pokaddicts_card_catalog';
const CARD_CATALOG_STORE = 'cards';
// Bumped to v2 so any in-progress local-only sync restarts with newest-
// sets-first ordering (see parseSetReleaseDate) instead of continuing in
// whatever order /sets happened to return the first time.
const CARD_CATALOG_SYNC_STATE_KEY = 'pokaddicts_catalog_sync_state_v2';

// Parses PokeWallet's "31st March, 2023" style release_date strings into
// a sortable timestamp (0 if unparseable).
function parseSetReleaseDate(str) {
  if (!str) return 0;
  const cleaned = str.replace(/(\d+)(st|nd|rd|th)/, '$1');
  const match = cleaned.match(/(\d+)\s+(\w+),?\s+(\d+)/);
  if (match) {
    const [, day, month, year] = match;
    const parsed = new Date(`${month} ${day}, ${year}`);
    if (!isNaN(parsed.getTime())) return parsed.getTime();
  }
  const fallback = new Date(str);
  return isNaN(fallback.getTime()) ? 0 : fallback.getTime();
}

// Delay between paginated sync requests. Keeps bulk import comfortably
// under the free tier's 100/hour cap even while other lookups (live price
// confirms, daily refresh) happen alongside it. A full multi-language
// catalog has a lot of sets, so this can take a while - it resumes
// automatically across app sessions (and, with Supabase configured,
// across every device) rather than needing to finish in one sitting.
const SYNC_REQUEST_DELAY_MS = 45000;

function normalizeCatalogCard(raw, set) {
  const info = raw.card_info || {};
  return {
    id: raw.id,
    name: info.name || 'Unknown Card',
    set: info.set_name || set.name || '',
    setId: set.id || info.set_id || '',
    number: info.card_number || '',
    language: set.language || ''
  };
}

function cardRowFromCatalogCard(c) {
  return { id: c.id, name: c.name, set_name: c.set, set_id: c.setId, card_number: c.number, language: c.language, low_quality: !!c.lowQuality };
}

function catalogCardFromRow(r) {
  return { id: r.id, name: r.name, set: r.set_name || '', setId: r.set_id || '', number: r.card_number || '', language: r.language || '', lowQuality: !!r.low_quality };
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

    let match = trimmed.match(/^(.*?)\s*(\d+)$/);
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
      }

      // Known-broken/duplicate entries (no image AND no price ever found)
      // sink to the bottom instead of cluttering results - still shown if
      // nothing else matches, since the flag isn't a guarantee, just a
      // signal from a previous lookup.
      if (c.lowQuality) score += 1000;

      scored.push({ card: c, score });
    }

    scored.sort((a, b) => a.score - b.score);
    return scored.map(s => s.card);
  }

  // Case-insensitive name+number search over the in-memory catalog.
  searchLocal(query, limit = 15) {
    if (!query || !query.trim()) return [];
    return this.rankCards(this.cards, query).slice(0, limit);
  }

  getCardById(id) {
    return this.cards.find(c => c.id === id) || null;
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

  // Resumable bulk import: walks every set across every language. Safe to
  // stop (close the tab) and resume later - progress is saved after every
  // page, shared across devices when Supabase is configured.
  async syncCatalog(onProgress) {
    if (!window.pokeWalletClient.configured || this.syncing) return;
    await this.ready;

    if (this.syncState.status === 'complete') return;

    this.syncing = true;
    this.syncState.status = 'in_progress';
    this.saveSyncState();

    try {
      if (!this.syncState.sets) {
        const setsRes = await window.pokeWalletClient.listSets();
        this.syncState.sets = (setsRes.data || setsRes.sets || [])
          .map(s => ({ id: s.set_id, name: s.name, language: s.language, releaseDate: s.release_date }))
          // Newest sets first, so recently released cards become
          // searchable quickly instead of waiting for a full alphabetical
          // sweep of every language's entire catalog.
          .sort((a, b) => parseSetReleaseDate(b.releaseDate) - parseSetReleaseDate(a.releaseDate));
        this.syncState.setIndex = 0;
        this.syncState.page = 1;
        this.saveSyncState();
      }

      while (this.syncState.setIndex < this.syncState.sets.length) {
        const set = this.syncState.sets[this.syncState.setIndex];

        const res = await window.pokeWalletClient.getSetCards(set.id, { page: this.syncState.page, limit: 200 });
        const cardsRaw = res.cards || [];
        const cards = cardsRaw.map(c => normalizeCatalogCard(c, set));

        await this.saveCards(cards);
        this.cards.push(...cards);
        this.pushCardsToSupabase(cards);
        this.syncState.totalCards += cards.length;

        const hasMore = res.pagination
          ? this.syncState.page < res.pagination.total_pages
          : cardsRaw.length === 200;

        if (hasMore) {
          this.syncState.page += 1;
        } else {
          this.syncState.setIndex += 1;
          this.syncState.page = 1;
        }
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
  // refresh - the local catalog id IS the PokeWallet id, so this is a
  // direct, unambiguous lookup.
  async fetchLivePrice(cardId) {
    if (!window.pokeWalletClient.configured) return { price: 0, source: null };
    try {
      const detail = await window.pokeWalletClient.getCard(cardId);
      return window.pokeWalletClient.extractMarketPriceSGD(detail);
    } catch (err) {
      console.warn('Price lookup failed:', err);
      return { price: 0, source: null };
    }
  }
}

window.cardCatalog = new CardCatalog();
