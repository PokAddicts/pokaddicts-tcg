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
  }

  // ids: { inputId, dropdownId, previewId }
  // onConfirm(card) fires with { name, set, marketValue, catalogCardId }
  // once the user taps "Use This Card" on the preview.
  attach(ids, onConfirm) {
    const input = document.getElementById(ids.inputId);
    if (!input) return;

    this.ids = ids;
    this.onConfirmCallback = onConfirm;
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

  renderRows(cards) {
    return cards.map(c => {
      // TCGdex's Japanese catalog inconsistently stores cards under their
      // native-script name - translate back to English for display, or
      // showing raw Japanese text leaves no way to tell which card it is.
      const displayName = window.cardCatalog.translateJapaneseName(c.name) || c.name;
      return `
      <div class="card-search-row" onclick="window.cardSearchUI.selectCard('${c.id}')">
        <div class="card-search-row-name">${this.formatCardTitle(displayName, c.number)}</div>
        <div class="card-search-row-meta">${c.set}${c.language ? ' • ' + c.language.toUpperCase() : ''}</div>
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
      dropdown.innerHTML = this.renderRows(localMatches);
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
      // too (strict number+name match, same logic the scanner uses) when
      // the query includes a number and the English search came up thin.
      const { namePart, numberPart } = window.cardCatalog.parseCardQuery(query);
      if (ranked.length < 5 && numberPart) {
        const nameHints = window.cardCatalog.buildJapaneseNameHints(namePart);
        const jpMatches = await window.cardCatalog.findJapaneseMatches(numberPart, nameHints, 5);
        jpMatches.forEach(m => { if (!ranked.some(r => r.id === m.id)) ranked.push(m); });
      }

      if (ranked.length === 0) {
        dropdown.innerHTML = `<div class="card-search-empty">No matches found - type your own details below.</div>`;
        return;
      }

      dropdown.innerHTML = this.renderRows(ranked);
    } catch (err) {
      console.error('Live search fallback failed:', err);
      dropdown.innerHTML = localMatches.length > 0
        ? this.renderRows(localMatches)
        : `<div class="card-search-empty">No catalog matches - type your own details below.</div>`;
    }
  }

  // Japanese cards use PokeWallet for pricing, not TCGdex - TCGdex's own
  // price data for Japanese secret/art rares can be badly wrong (a real
  // ~$177 Magikarp Art Rare priced at €0.08 on TCGdex, apparently linked
  // to the wrong product). English cards keep using TCGdex, which priced
  // normally in testing. Falls back to TCGdex for a Japanese card if
  // PokeWallet doesn't have it either.
  async fetchAllPricesForCard(cardId, cardLang, name, number) {
    if (cardLang === 'ja' && window.pokeWalletClient?.configured) {
      try {
        const match = await window.pokeWalletClient.findCardByNameAndNumber(name, number);
        if (match) {
          const detail = await window.pokeWalletClient.getCard(match.id);
          const prices = window.pokeWalletClient.extractAllMarketPricesSGD(detail);
          if (prices.length > 0) return prices;
        }
      } catch (err) {
        console.warn('PokeWallet price fetch failed, falling back to TCGdex:', err);
      }
    }

    try {
      const detail = await window.tcgdexClient.getCard(cardId, cardLang)
        .catch(() => window.tcgdexClient.getCard(cardId, cardLang === 'ja' ? 'en' : 'ja'));
      return window.tcgdexClient.extractAllMarketPricesSGD(detail);
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
            <div style="font-size: 0.75rem; color: var(--text-secondary);">${card.set}${card.language ? ' • ' + card.language.toUpperCase() : ''}</div>
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

    const imagePromise = window.tcgdexClient.getImageBlobUrl(cardId, 'low')
      .then((imageUrl) => {
        if (!imageUrl) return;
        gotImage = true;
        const imageSlot = document.getElementById('card-search-image-slot');
        if (imageSlot) {
          imageSlot.innerHTML = `<img src="${imageUrl}" style="width: 60px; border-radius: 8px;" alt="${card.name}">`;
        }
      })
      .catch((err) => console.warn('Card image fetch failed:', err));

    const cardLang = card.language || 'en';
    const pricePromise = this.fetchAllPricesForCard(cardId, cardLang, displayName, card.number)
      .then((allPrices) => {
        // TCGPlayer (US) and CardMarket (EU) are genuinely different
        // marketplaces and can diverge quite a bit - show both whenever
        // available, rather than silently picking one. The stored
        // marketValue still uses just the first one, since cost/margin
        // tracking needs a single number.
        this.resolvedCard.marketValue = allPrices[0]?.price || 0;
        if (allPrices.length > 0) gotPrice = true;

        const priceLine = document.getElementById('card-search-price-line');
        if (priceLine) {
          priceLine.innerHTML = allPrices.length > 0
            ? allPrices.map(p => `<div>S$${p.price.toFixed(2)} (${this.formatPriceSource(p.source)})</div>`).join('')
            : 'No live price found';
        }
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
