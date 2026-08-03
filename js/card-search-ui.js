/* ==========================================================================
   PokAddicts - Card Search Widget
   Reusable "type a name, see instant text suggestions from the local
   catalog, tap one to confirm with the real image + live price" flow.
   Used by both the Intake form and Trade Studio's Add Card Received form.
   Only one instance is ever active at a time (one form visible at once),
   so this is a simple singleton rather than a per-field registry.
   ========================================================================== */

class CardSearchUI {
  constructor() {
    this.ids = null;
    this.onConfirmCallback = null;
    this.resolvedCard = null;
    this.debounceTimer = null;
    this.isGradedSlab = () => false;
  }

  // ids: { inputId, dropdownId, previewId }
  // onConfirm(card) fires with { name, set, marketValue, catalogCardId }
  // once the user taps "Use This Card" on the preview.
  // options.isGradedSlab: a () => boolean checked at price-render time
  // (not captured once here) - SnkrDunk prices Japanese cards by
  // CONDITION, including both raw grades (A/B/C/D) and third-party graded
  // ones (PSA 9/10, ARS 10, etc.), and only one set makes sense to show
  // depending on whether the item being added is itself a graded slab or
  // a raw card. Checking it fresh each time (rather than once at attach())
  // matters because the caller's raw/slab toggle can change after
  // attaching without necessarily re-attaching (e.g. Intake's type
  // selector swaps form sections in place).
  attach(ids, onConfirm, options = {}) {
    const input = document.getElementById(ids.inputId);
    if (!input) return;

    this.ids = ids;
    this.onConfirmCallback = onConfirm;
    this.isGradedSlab = options.isGradedSlab || (() => false);
    this.resolvedCard = null;

    input.oninput = () => {
      clearTimeout(this.debounceTimer);
      const val = input.value;
      this.debounceTimer = setTimeout(() => this.renderSuggestions(val), 120);
    };
  }

  // Defensive dedup: append the card number to its name for display,
  // unless it's somehow already embedded in the name.
  formatCardTitle(name, number) {
    if (!number) return name || '';
    if ((name || '').includes(number)) return name;
    return `${name} #${number}`;
  }

  // Clean display label for where a price came from - strips the
  // internal "(USD→SGD)" conversion note, just showing which marketplace
  // it's based on.
  formatPriceSource(source) {
    if (!source) return '';
    if (source.startsWith('TCGPlayer')) return 'TCG Player';
    if (source.startsWith('CardMarket')) return 'CardMarket';
    return source;
  }

  // Display label for a card's language - "JP"/"ENG" rather than the raw
  // "ja"/"en" catalog codes uppercased.
  formatLanguageLabel(lang) {
    if (lang === 'ja') return 'JP';
    if (lang === 'en') return 'ENG';
    return (lang || '').toUpperCase();
  }

  // Groups a flat variant/price list (extractAllVariantsSGD's shape -
  // {label, price, source}, one entry per marketplace×finish combination)
  // by physical FINISH, so the UI can ask "which finish is this copy?"
  // first (Normal / Reverse Holofoil / 1st Edition Holofoil / etc.), then
  // show every marketplace's price for whichever finish gets picked -
  // instead of a flat list mixing finishes and marketplaces together.
  //
  // TCGPlayer's per-key variants already have their own distinct label
  // (e.g. "Reverse Holofoil") and become their own group as-is. CardMarket
  // only distinguishes "Normal" vs a generic "Holo" (no finer finish
  // detail) - a CardMarket entry merges into TCGPlayer's own entry of the
  // EXACT same label if one exists (e.g. both say "Normal" - same finish,
  // different marketplace); otherwise it merges into the single
  // non-generic finish TCGPlayer actually has, IF there's exactly one
  // candidate. This covers two real, confirmed cases: Gastly (TCGPlayer
  // has both "Normal" and "Reverse Holofoil" - CardMarket's "Holo" merges
  // into "Reverse Holofoil" since that's the only non-generic option) and
  // Magikarp 080/073 (TCGPlayer has ONLY "Holofoil", no "Normal" listing
  // at all - CardMarket's "Normal" must merge into "Holofoil" too, since
  // this card is genuinely holo-only and CardMarket's price is for that
  // same card, just filed under their generic default bucket rather than
  // a real second non-holo print). With 0 or 2+ non-generic candidates
  // (e.g. Blaine's Moltres, which has two TCGPlayer editions) there's no
  // safe way to guess which one a generic CardMarket price refers to, so
  // it stays its own separate group rather than risk mislabeling a price.
  groupVariantsByFinish(allPrices) {
    const GENERIC_LABELS = ['Normal', 'Holo'];
    // Real source strings carry a currency-conversion suffix (extractAllVariantsSGD
    // produces "TCGPlayer (USD→SGD)", not plain "TCGPlayer") - matching on
    // startsWith rather than exact equality was the actual reason this
    // merge never engaged in production despite passing an isolated test
    // that used a simplified fake source string without the suffix.
    const isTcgPlayer = (p) => (p.source || '').startsWith('TCGPlayer');
    const tcgPlayerLabels = new Set(allPrices.filter(isTcgPlayer).map(p => p.label));
    const namedTcgPlayerLabels = [...new Set(
      allPrices.filter(p => isTcgPlayer(p) && !GENERIC_LABELS.includes(p.label)).map(p => p.label)
    )];

    const groups = new Map();
    for (const p of allPrices) {
      let label = p.label || 'Normal';
      if (GENERIC_LABELS.includes(label) && !tcgPlayerLabels.has(label) && namedTcgPlayerLabels.length === 1) {
        label = namedTcgPlayerLabels[0];
      }
      if (!groups.has(label)) groups.set(label, { label, entries: [] });
      groups.get(label).entries.push({ price: p.price, source: p.source });
    }
    return Array.from(groups.values());
  }

  // Renders the price picker into priceLine as three fixed rows instead
  // of a single "pick a finish, see its sources below" cascade:
  //   Row 1: a chip per selectable option - any real named finish
  //          (Normal / Reverse Holofoil / etc. - only shown when there's
  //          more than one, i.e. actual ambiguity to resolve) FIRST, then
  //          SnkrDunk's own conditions (All / A / B / C / etc.) tagged
  //          "(SnkrDunk)" at the end.
  //   Row 2: TCG Player's price for whichever finish is selected.
  //   Row 3: CardMarket's price for whichever finish is selected.
  // SnkrDunk conditions don't have a matching per-condition TCGPlayer/
  // CardMarket price (SnkrDunk prices by physical grade, not print
  // finish), so selecting one only changes this.resolvedCard.marketValue
  // and which chip is marked selected - rows 2/3 keep showing whichever
  // finish is currently active.
  // Renders the price picker as: an optional row of real finish variants
  // (Normal / Reverse Holofoil / etc, only when there's more than one),
  // a compact side-by-side row of SnkrDunk tier chips (All / A / B / C /
  // etc - no price on the chip itself, keeps the row short), then three
  // clickable price lines - "SNKRDUNK S$X" (reflects whichever tier chip
  // was last picked), "TCG Player S$X", "CardMarket S$X". Exactly one of
  // these (a variant chip, a tier chip, or one of the two marketplace
  // lines) is ever the active selection at a time, and that's what
  // becomes this.resolvedCard.marketValue - clicking any of them clears
  // every other selected state first.
  renderPriceGroups(priceLine, allPrices) {
    const snkrDunkEntries = allPrices.filter(p => p.source === 'SnkrDunk');
    const marketplaceEntries = allPrices.filter(p => p.source !== 'SnkrDunk');
    const finishGroups = marketplaceEntries.length > 0 ? this.groupVariantsByFinish(marketplaceEntries) : [];

    const variantChips = finishGroups.length > 1 ? finishGroups.map(g => ({ label: g.label, entries: g.entries })) : [];
    const snkrDunkTiers = snkrDunkEntries.map(e => ({ label: e.label, price: e.price }));
    const defaultEntries = (finishGroups[0] || { entries: [] }).entries;
    const findEntry = (entries, prefix) => entries.find(e => (e.source || '').startsWith(prefix));

    priceLine.innerHTML = `
      <div class="price-finish-row"></div>
      <div class="price-tier-chip-row"></div>
      <div class="price-source-info price-selectable price-snkrdunk-row"></div>
      <div class="price-source-info price-selectable price-tcgplayer-row"></div>
      <div class="price-source-info price-selectable price-cardmarket-row"></div>
    `;
    const finishRow = priceLine.querySelector('.price-finish-row');
    const tierChipRow = priceLine.querySelector('.price-tier-chip-row');
    const snkrDunkRow = priceLine.querySelector('.price-snkrdunk-row');
    const tcgRow = priceLine.querySelector('.price-tcgplayer-row');
    const cmRow = priceLine.querySelector('.price-cardmarket-row');

    let referenceEntries = defaultEntries;
    const selectables = [];
    const clearSelection = () => selectables.forEach(el => el.classList.remove('selected'));
    const select = (el, price) => {
      clearSelection();
      el.classList.add('selected');
      this.resolvedCard.marketValue = price;
    };

    const refreshReferenceRows = () => {
      const tcg = findEntry(referenceEntries, 'TCGPlayer');
      const cm = findEntry(referenceEntries, 'CardMarket');
      tcgRow.textContent = tcg ? `TCG Player S$${tcg.price.toFixed(2)}` : 'TCG Player -';
      cmRow.textContent = cm ? `CardMarket S$${cm.price.toFixed(2)}` : 'CardMarket -';
      tcgRow.classList.toggle('disabled', !tcg);
      cmRow.classList.toggle('disabled', !cm);
    };

    if (variantChips.length === 0) {
      finishRow.remove();
    } else {
      finishRow.innerHTML = variantChips.map((c, i) => `
        <button type="button" class="price-variant-chip" data-index="${i}">${c.label}</button>
      `).join('');
      finishRow.querySelectorAll('.price-variant-chip').forEach((chipEl, i) => {
        selectables.push(chipEl);
        chipEl.addEventListener('click', () => {
          select(chipEl, variantChips[i].entries[0].price);
          referenceEntries = variantChips[i].entries;
          refreshReferenceRows();
        });
      });
    }

    // Selecting a tier highlights BOTH that chip and the SNKRDUNK line
    // together (a linked pair) - clicking the SNKRDUNK line itself (not a
    // specific chip) just re-activates whichever tier was last picked, so
    // switching to TCG Player/CardMarket and back doesn't lose it.
    let currentTierIndex = 0;
    const selectTier = (i) => {
      currentTierIndex = i;
      snkrDunkRow.textContent = `SNKRDUNK S$${snkrDunkTiers[i].price.toFixed(2)}`;
      clearSelection();
      tierChipRow.children[i].classList.add('selected');
      snkrDunkRow.classList.add('selected');
      this.resolvedCard.marketValue = snkrDunkTiers[i].price;
    };

    if (snkrDunkTiers.length === 0) {
      tierChipRow.remove();
      snkrDunkRow.remove();
    } else {
      tierChipRow.innerHTML = snkrDunkTiers.map((t, i) => `
        <button type="button" class="price-variant-chip" data-index="${i}">${t.label}</button>
      `).join('');
      tierChipRow.querySelectorAll('.price-variant-chip').forEach((chipEl, i) => {
        selectables.push(chipEl);
        chipEl.addEventListener('click', () => selectTier(i));
      });
      selectables.push(snkrDunkRow);
      snkrDunkRow.addEventListener('click', () => selectTier(currentTierIndex));
    }

    selectables.push(tcgRow, cmRow);
    tcgRow.addEventListener('click', () => {
      const tcg = findEntry(referenceEntries, 'TCGPlayer');
      if (tcg) select(tcgRow, tcg.price);
    });
    cmRow.addEventListener('click', () => {
      const cm = findEntry(referenceEntries, 'CardMarket');
      if (cm) select(cmRow, cm.price);
    });

    refreshReferenceRows();

    // Default selection: a SnkrDunk tier ("All" - the most accurate
    // current-market figure, the lowest active listing rather than an
    // average) wins if present, otherwise the first variant finish,
    // otherwise whichever marketplace price is actually available.
    if (snkrDunkTiers.length > 0) {
      selectTier(0);
    } else if (variantChips.length > 0) {
      finishRow.querySelector('.price-variant-chip').click();
    } else {
      const tcg = findEntry(defaultEntries, 'TCGPlayer');
      const cm = findEntry(defaultEntries, 'CardMarket');
      if (tcg) select(tcgRow, tcg.price);
      else if (cm) select(cmRow, cm.price);
    }
  }

  renderRows(cards) {
    return cards.map(c => {
      // TCGdex's Japanese catalog inconsistently stores cards under their
      // native-script name - translate back to English for display, or
      // showing raw Japanese text leaves no way to tell which card it is.
      const displayName = window.cardCatalog.translateJapaneseName(c.name) || c.name;
      return `
      <div class="card-search-row" onclick="window.cardSearchUI.selectCard('${c.id}')">
        <div class="card-search-row-name">${this.formatCardTitle(displayName, c.number)}</div>
        <div class="card-search-row-meta">${c.set}${c.language ? ' • ' + this.formatLanguageLabel(c.language) : ''}</div>
      </div>
    `;
    }).join('');
  }

  // TCGdex's brief search results only carry { id, localId, name, image } -
  // no set name or card total, needed for the "8/102" number format. The
  // set id is recoverable from the card id itself ("me05-001" -> "me05",
  // since localId is always the trailing segment), then the full sets
  // list (fetched once, up front, well before per-card sync catches up)
  // fills in the name/total/language without an extra network call.
  extractSetIdFromCardId(id, localId) {
    if (!id || !localId) return '';
    const suffix = `-${localId}`;
    return id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
  }

  normalizeLiveSearchResult(raw, lang = 'en') {
    const setId = this.extractSetIdFromCardId(raw.id, raw.localId);
    const setInfo = window.cardCatalog ? window.cardCatalog.getSetInfoById(setId) : null;
    const total = setInfo?.total || 0;
    return {
      id: raw.id,
      name: raw.name || 'Unknown Card',
      set: setInfo?.name || '',
      setId,
      number: window.formatCardNumber(raw.localId, total),
      language: setInfo?.language || lang,
      image: raw.image || ''
    };
  }

  async renderSuggestions(query) {
    const dropdown = document.getElementById(this.ids.dropdownId);
    if (!dropdown) return;

    const trimmedQuery = (query || '').trim();
    // A single digit is still a meaningful start of a card-number search
    // (e.g. "5"), so only apply the 2-char minimum to letters - requiring
    // it for numbers meant nothing appeared until a second digit was
    // typed, which read as the search being unresponsive.
    const isNumberQuery = /^\d+$/.test(trimmedQuery);
    if (!trimmedQuery || (trimmedQuery.length < 2 && !isNumberQuery)) {
      dropdown.style.display = 'none';
      dropdown.innerHTML = '';
      return;
    }

    const localMatches = window.cardCatalog ? window.cardCatalog.searchLocal(query, 15) : [];

    // Local catalog sync is still incomplete for some eras (very recent
    // sets, and vintage sets alike) - so rather than only falling back to
    // a live search when local has NOTHING, supplement whenever local
    // results are thin, merge the two, and re-rank together (so the best
    // number/name match wins regardless of which source it came from).
    // If a number was typed, this fast path only fires when one of the
    // local matches actually has that exact number - a pile of same-named
    // but wrong-numbered English matches (e.g. several "Magikarp" cards,
    // none of them #080) shouldn't short-circuit past the live/Japanese
    // fallback below, which is what would actually find the right card.
    const LOCAL_RESULT_THRESHOLD = 5;
    const queryNumberPart = window.cardCatalog.parseCardQuery(query).numberPart;
    const queryNum = queryNumberPart ? parseInt(queryNumberPart, 10) : null;
    const hasExactNumberMatch = !queryNum || localMatches.some(c => {
      const leadingDigits = (c.number || '').toString().match(/^0*(\d+)/);
      return leadingDigits && parseInt(leadingDigits[1], 10) === queryNum;
    });
    if (localMatches.length >= LOCAL_RESULT_THRESHOLD && hasExactNumberMatch) {
      dropdown.style.display = 'block';
      dropdown.innerHTML = this.renderRows(window.cardCatalog.dedupeByNumber(localMatches));
      return;
    }

    dropdown.style.display = 'block';
    dropdown.innerHTML = localMatches.length > 0
      ? this.renderRows(localMatches) + `<div class="card-search-empty">Searching for more...</div>`
      : `<div class="card-search-empty">Searching...</div>`;

    if (!window.tcgdexClient || !window.tcgdexClient.configured) {
      if (localMatches.length === 0) {
        dropdown.innerHTML = `<div class="card-search-empty">No catalog matches - type your own details below.</div>`;
      }
      return;
    }

    try {
      const results = await window.tcgdexClient.searchCards(query, { limit: 10 });
      const liveCards = results.map(r => this.normalizeLiveSearchResult(r, 'en'));
      await window.cardCatalog.cacheLiveResults(liveCards);

      const merged = [...localMatches];
      liveCards.forEach(lc => { if (!merged.some(m => m.id === lc.id)) merged.push(lc); });
      let ranked = window.cardCatalog.rankCards(merged, query).slice(0, 15);

      // TCGdex's Japanese catalog inconsistently stores cards under their
      // native-script name rather than an English one (e.g. Magikarp #080
      // is "コイキング"), so typing the English name/number never matches it
      // through the English-only search above - try the Japanese catalog
      // too (strict name match, same logic the scanner uses) whenever the
      // English search came up thin, whether or not a number was typed.
      const { namePart, numberPart } = window.cardCatalog.parseCardQuery(query);
      if (ranked.length < 5 && namePart) {
        const nameHints = window.cardCatalog.buildJapaneseNameHints(namePart);
        const jpMatches = await window.cardCatalog.findJapaneseMatches(numberPart, nameHints, 5);
        jpMatches.forEach(m => { if (!ranked.some(r => r.id === m.id)) ranked.push(m); });
      }

      ranked = window.cardCatalog.dedupeByNumber(ranked);

      if (ranked.length === 0) {
        dropdown.innerHTML = `<div class="card-search-empty">No matches found - type your own details below.</div>`;
        return;
      }

      dropdown.innerHTML = this.renderRows(ranked);
    } catch (err) {
      console.error('Live search fallback failed:', err);
      dropdown.innerHTML = localMatches.length > 0
        ? this.renderRows(window.cardCatalog.dedupeByNumber(localMatches))
        : `<div class="card-search-empty">No catalog matches - type your own details below.</div>`;
    }
  }

  // Japanese cards use PokeWallet for pricing, not TCGdex - TCGdex's own
  // price data for Japanese secret/art rares can be badly wrong (a real
  // ~$177 Magikarp Art Rare priced at €0.08 on TCGdex, apparently linked
  // to the wrong product). English cards keep using TCGdex, which priced
  // normally in testing. Falls back to TCGdex for a Japanese card if
  // PokeWallet doesn't have it either.
  // Always does a live lookup and returns EVERY sub-variant (Normal,
  // Reverse Holofoil, 1st Edition Holofoil, etc.) TCGdex/PokeWallet has
  // pricing for - a real gap existed here where this only ever returned
  // ONE number (extractAllMarketPricesSGD, "normal" preferred), silently
  // hiding every other variant a card had (e.g. Gastly 63/112's reverse
  // holo, or Blaine's Moltres 1/132's non-1st-edition print). TCGdex has
  // no rate limit, so there's no real cost to always doing this live -
  // see selectCard() for the instant provisional price shown from cache
  // while this resolves.
  async fetchAllPricesForCard(cardId, cardLang, name, number) {
    if (cardLang === 'ja') {
      const wantGraded = this.isGradedSlab();

      // Instant read paths: refresh-snkrdunk-prices caches every Japanese
      // card's condition breakdown on a ~3-6h cycle (see
      // supabase/schema.sql) - a fresh cached array here skips the live
      // search+price-lookup round trip entirely. PokeWallet has no bulk
      // cron (its 100/hour rate limit rules that out for the whole
      // catalog) but gets cached LAZILY the first time any device
      // actually looks a card up - see cachePokeWalletPricePermanently.
      // 24h freshness for PokeWallet (matches the English cache's own
      // window) since there's no reason to re-burn rate-limited requests
      // more often than that; 12h for SnkrDunk to match its cron's target
      // cycle time.
      const cachedCard = window.cardCatalog.getCardById(cardId);
      const snkrDunkFresh = cachedCard?.snkrdunkUpdatedAt && cachedCard.snkrdunkConditions?.length > 0
        && (Date.now() - new Date(cachedCard.snkrdunkUpdatedAt).getTime()) < 12 * 60 * 60 * 1000;
      const pokeWalletFresh = cachedCard?.pokewalletUpdatedAt
        && (Date.now() - new Date(cachedCard.pokewalletUpdatedAt).getTime()) < 24 * 60 * 60 * 1000;

      // PokeWallet (finish-based: Normal/Holo/etc.) and SnkrDunk
      // (condition/grade-based: raw A/B/D, PSA 9/10, etc. - SnkrDunk deals
      // in graded cards too) fetched at the same time, not one after the
      // other - they're independent sources so there's no reason to wait
      // for one before starting the other.
      // Fallback used whenever a live re-check is attempted (cache older
      // than the freshness window above) but fails or finds nothing - a
      // stale cached price is still far more useful than blank, and a
      // transient failure (PokeWallet's 100/hour cap in particular) is
      // common enough that silently showing nothing was a real, confirmed
      // gap: a card priced just yesterday would go blank on any rate-limit
      // blip today instead of keeping its still-reasonable last price.
      const stalePokeWalletVariants = cachedCard?.pokewalletVariants || [];
      const staleSnkrDunkDisplay = cachedCard?.snkrdunkConditions?.length > 0
        ? window.snkrDunkClient.buildDisplayList(cachedCard.snkrdunkConditions, wantGraded)
        : [];

      const [pokeWalletPrices, snkrDunkPrices] = await Promise.all([
        (async () => {
          if (pokeWalletFresh) return cachedCard.pokewalletVariants || [];
          if (!window.pokeWalletClient?.configured) return stalePokeWalletVariants;
          try {
            const match = await window.pokeWalletClient.findCardByNameAndNumber(name, number);
            if (!match) return stalePokeWalletVariants;
            const detail = await window.pokeWalletClient.getCard(match.id);
            const variants = window.pokeWalletClient.extractAllVariantsSGD(detail);
            // Fire-and-forget: cache this result now so the NEXT lookup
            // of the same card (this device or any other) is instant,
            // rather than repeating the same live round trip forever.
            if (variants.length > 0) window.cardCatalog.cachePokeWalletPricePermanently(cardId, variants);
            return variants.length > 0 ? variants : stalePokeWalletVariants;
          } catch (err) {
            console.warn('PokeWallet price fetch failed:', err);
            return stalePokeWalletVariants;
          }
        })(),
        (async () => {
          // "All" (SnkrDunk's own cheapest-across-every-condition figure -
          // confirmed directly against their site) always leads, followed
          // by the individual conditions filtered to just raw or just
          // graded - a raw card intake showing PSA 10 prices (or vice
          // versa) would be actively misleading.
          if (snkrDunkFresh) {
            return window.snkrDunkClient.buildDisplayList(cachedCard.snkrdunkConditions, wantGraded);
          }
          if (!window.snkrDunkClient?.configured) return staleSnkrDunkDisplay;
          try {
            const match = await window.snkrDunkClient.findCardByNameAndNumber(name, number);
            if (!match) return staleSnkrDunkDisplay;
            const conditions = await window.snkrDunkClient.getConditionPrices(match.id);
            const conditionPrices = window.snkrDunkClient.extractConditionPricesSGD(conditions);
            const display = window.snkrDunkClient.buildDisplayList(conditionPrices, wantGraded);
            return display.length > 0 ? display : staleSnkrDunkDisplay;
          } catch (err) {
            console.warn('SnkrDunk price fetch failed:', err);
            return staleSnkrDunkDisplay;
          }
        })(),
      ]);

      // SnkrDunk first so its "All" entry (the overall cheapest listing
      // across every condition - the most accurate current-market figure,
      // not an average) leads and becomes the default-selected finish,
      // with PokeWallet's finish-based variants (Normal/Holo/etc.)
      // available right after.
      const combined = [...snkrDunkPrices, ...pokeWalletPrices];
      if (combined.length > 0) return combined;
    }

    try {
      const detail = await window.tcgdexClient.getCard(cardId, cardLang)
        .catch(() => window.tcgdexClient.getCard(cardId, cardLang === 'ja' ? 'en' : 'ja'));
      return window.tcgdexClient.extractAllVariantsSGD(detail);
    } catch (err) {
      console.warn('TCGdex price fetch failed:', err);
      return [];
    }
  }

  async selectCard(cardId) {
    const dropdown = document.getElementById(this.ids.dropdownId);
    const preview = document.getElementById(this.ids.previewId);
    if (dropdown) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }

    const card = window.cardCatalog.getCardById(cardId);
    if (!card) return;

    // Translate back to English for both display AND what actually gets
    // stored - a raw Japanese-script name saved as the inventory item's
    // name would be just as unreadable later as it was in the dropdown.
    const displayName = window.cardCatalog.translateJapaneseName(card.name) || card.name;

    if (preview) {
      preview.style.display = 'block';
      preview.innerHTML = `
        <div style="display: flex; gap: 12px; align-items: center;">
          <div id="card-search-image-slot" style="width: 60px; flex-shrink: 0;"></div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 700; color: var(--text-primary);">${this.formatCardTitle(displayName, card.number)}</div>
            <div style="font-size: 0.75rem; color: var(--text-secondary);">${card.set}${card.language ? ' • ' + this.formatLanguageLabel(card.language) : ''}</div>
            <div id="card-search-price-line" style="font-size: 0.82rem; color: var(--accent-gold); font-weight: 700; margin-top: 4px;">Looking up card details...</div>
          </div>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 10px;">
          <button type="button" class="btn btn-green btn-sm btn-wrap-safe" style="flex: 1;" onclick="window.cardSearchUI.confirmSelection()">✓ Use This</button>
          <button type="button" class="btn btn-secondary btn-sm btn-wrap-safe" style="flex: 1;" onclick="window.cardSearchUI.dismissPreview()">✕ Not This</button>
        </div>
      `;
    }

    this.resolvedCard = {
      // Include the card number in the stored name (e.g. "Dark Houndoom
      // #5") so it shows up that way everywhere the item appears later -
      // not just in this confirm preview.
      name: this.formatCardTitle(displayName, card.number),
      set: card.set,
      marketValue: 0,
      catalogCardId: card.id
    };

    // Image and price are fetched independently in parallel, each
    // updating the preview the moment IT resolves - waiting for the
    // slower of the two to show either was the main cause of the
    // sluggish-feeling preview. If NEITHER ever turns up anything, this
    // entry is likely a broken/duplicate catalog row - flag it so it
    // sinks in future searches instead of cluttering results again.
    let gotImage = false;
    let gotPrice = false;

    const imagePromise = window.cardCatalog.getCardImageUrl(cardId, 'low')
      .then((imageUrl) => {
        if (!imageUrl) return;
        gotImage = true;
        const imageSlot = document.getElementById('card-search-image-slot');
        if (imageSlot) {
          imageSlot.innerHTML = `<img src="${imageUrl}" style="width: 60px; border-radius: 8px; cursor: zoom-in;" alt="${card.name}">`;
          // Listener attached directly (not inline onclick) so the card
          // name/URL never has to be escaped into an HTML attribute.
          imageSlot.querySelector('img').addEventListener('click', () => window.openImageViewer(imageUrl, card.name));
        }
      })
      .catch((err) => console.warn('Card image fetch failed:', err));

    const cardLang = card.language || 'en';

    // Instant provisional price from the daily-refreshed cache (English
    // only - see supabase/functions/refresh-catalog-prices), shown
    // immediately while the live full-variant fetch below resolves. The
    // cache only ever stores ONE number, so it can't reflect every
    // sub-variant a card has - this is just a placeholder to paint
    // something right away, always superseded by the live result a
    // moment later.
    if (cardLang === 'en') {
      const cachedCard = window.cardCatalog.getCardById(cardId);
      if (cachedCard?.priceUpdatedAt && cachedCard.marketValueSgd > 0) {
        const ageMs = Date.now() - new Date(cachedCard.priceUpdatedAt).getTime();
        if (ageMs < 24 * 60 * 60 * 1000) {
          const priceLine = document.getElementById('card-search-price-line');
          if (priceLine) priceLine.innerHTML = `<div>S$${cachedCard.marketValueSgd.toFixed(2)} (${this.formatPriceSource(cachedCard.priceSource || '')})</div>`;
        }
      }
    }

    const pricePromise = this.fetchAllPricesForCard(cardId, cardLang, displayName, card.number)
      .then((allPrices) => {
        if (allPrices.length > 0) gotPrice = true;

        const priceLine = document.getElementById('card-search-price-line');
        if (!priceLine) return;

        if (allPrices.length === 0) {
          this.resolvedCard.marketValue = 0;
          priceLine.textContent = 'No live price found';
          return;
        }

        // Finish chips (only when there's more than one real finish) plus
        // SnkrDunk's own conditions in row 1, TCG Player/CardMarket as
        // their own fixed reference rows below - see renderPriceGroups.
        this.renderPriceGroups(priceLine, allPrices);
      })
      .catch((err) => {
        console.error('Live price lookup failed:', err);
        const priceLine = document.getElementById('card-search-price-line');
        if (priceLine) priceLine.textContent = 'Price lookup failed - enter it manually below.';
      });

    Promise.allSettled([imagePromise, pricePromise]).then(() => {
      if (!gotImage && !gotPrice) {
        window.cardCatalog.flagCardAsLowQuality(cardId);
      }
    });
  }

  confirmSelection() {
    if (!this.resolvedCard) return;
    if (this.onConfirmCallback) this.onConfirmCallback(this.resolvedCard);
    this.dismissPreview();
  }

  dismissPreview() {
    const preview = document.getElementById(this.ids.previewId);
    if (preview) {
      preview.style.display = 'none';
      preview.innerHTML = '';
    }
    this.resolvedCard = null;
  }
}

window.cardSearchUI = new CardSearchUI();
