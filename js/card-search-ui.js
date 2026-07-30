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

  // PokeWallet card names sometimes already embed the number (e.g.
  // "Flareon ex - 202/187"), so blindly appending "#202/187" again would
  // duplicate it - only append if it isn't already there.
  formatCardTitle(name, number) {
    if (!number) return name || '';
    if ((name || '').includes(number)) return name;
    return `${name} #${number}`;
  }

  renderRows(cards) {
    return cards.map(c => `
      <div class="card-search-row" onclick="window.cardSearchUI.selectCard('${c.id}')">
        <div class="card-search-row-name">${this.formatCardTitle(c.name, c.number)}</div>
        <div class="card-search-row-meta">${c.set}${c.language ? ' • ' + c.language.toUpperCase() : ''}</div>
      </div>
    `).join('');
  }

  normalizeLiveSearchResult(raw) {
    const info = raw.card_info || {};
    return {
      id: raw.id,
      name: info.name || 'Unknown Card',
      set: info.set_name || '',
      setId: info.set_id || '',
      number: info.card_number || '',
      language: ''
    };
  }

  async renderSuggestions(query) {
    const dropdown = document.getElementById(this.ids.dropdownId);
    if (!dropdown) return;

    if (!query || query.trim().length < 2) {
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
    const LOCAL_RESULT_THRESHOLD = 5;
    if (localMatches.length >= LOCAL_RESULT_THRESHOLD) {
      dropdown.style.display = 'block';
      dropdown.innerHTML = this.renderRows(localMatches);
      return;
    }

    dropdown.style.display = 'block';
    dropdown.innerHTML = localMatches.length > 0
      ? this.renderRows(localMatches) + `<div class="card-search-empty">Searching PokeWallet for more...</div>`
      : `<div class="card-search-empty">Searching PokeWallet directly...</div>`;

    if (!window.pokeWalletClient || !window.pokeWalletClient.configured) {
      if (localMatches.length === 0) {
        dropdown.innerHTML = `<div class="card-search-empty">No catalog matches - type your own details below.</div>`;
      }
      return;
    }

    try {
      const res = await window.pokeWalletClient.searchCards(query, { limit: 10 });
      const results = res.results || [];
      const liveCards = results.map(r => this.normalizeLiveSearchResult(r));
      await window.cardCatalog.cacheLiveResults(liveCards);

      const merged = [...localMatches];
      liveCards.forEach(lc => { if (!merged.some(m => m.id === lc.id)) merged.push(lc); });
      const ranked = window.cardCatalog.rankCards(merged, query).slice(0, 15);

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

  async selectCard(cardId) {
    const dropdown = document.getElementById(this.ids.dropdownId);
    const preview = document.getElementById(this.ids.previewId);
    if (dropdown) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }

    const card = window.cardCatalog.getCardById(cardId);
    if (!card) return;

    if (preview) {
      preview.style.display = 'block';
      preview.innerHTML = `
        <div style="display: flex; gap: 12px; align-items: center;">
          <div id="card-search-image-slot" style="width: 60px; flex-shrink: 0;"></div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 700; color: var(--text-primary);">${this.formatCardTitle(card.name, card.number)}</div>
            <div style="font-size: 0.75rem; color: var(--text-secondary);">${card.set}${card.language ? ' • ' + card.language.toUpperCase() : ''}</div>
            <div id="card-search-price-line" style="font-size: 0.82rem; color: var(--accent-gold); font-weight: 700; margin-top: 4px;">Looking up card details...</div>
          </div>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 10px;">
          <button type="button" class="btn btn-green btn-sm" style="flex: 1;" onclick="window.cardSearchUI.confirmSelection()">✓ Use This Card</button>
          <button type="button" class="btn btn-secondary btn-sm" style="flex: 1;" onclick="window.cardSearchUI.dismissPreview()">✕ Not This One</button>
        </div>
      `;
    }

    this.resolvedCard = {
      name: card.name,
      set: card.set,
      marketValue: 0,
      catalogCardId: card.id
    };

    // Image and price are fetched independently in parallel, each
    // updating the preview the moment IT resolves - waiting for the
    // slower of the two to show either was the main cause of the
    // sluggish-feeling preview. If NEITHER ever turns up anything, this
    // entry is likely one of PokeWallet's broken/duplicate rows - flag it
    // so it sinks in future searches instead of cluttering results again.
    let gotImage = false;
    let gotPrice = false;

    const imagePromise = window.pokeWalletClient.getImageBlobUrl(cardId, 'low')
      .then((imageUrl) => {
        if (!imageUrl) return;
        gotImage = true;
        const imageSlot = document.getElementById('card-search-image-slot');
        if (imageSlot) {
          imageSlot.innerHTML = `<img src="${imageUrl}" style="width: 60px; border-radius: 8px;" alt="${card.name}">`;
        }
      })
      .catch((err) => console.warn('Card image fetch failed:', err));

    const pricePromise = window.pokeWalletClient.getCard(cardId)
      .then((detail) => {
        const { price, source } = window.pokeWalletClient.extractMarketPriceSGD(detail);
        this.resolvedCard.marketValue = price;
        if (price > 0) gotPrice = true;

        const priceLine = document.getElementById('card-search-price-line');
        if (priceLine) {
          priceLine.textContent = price > 0 ? `S$${price.toFixed(2)} ${source ? `(${source})` : ''}` : 'No live price found';
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
