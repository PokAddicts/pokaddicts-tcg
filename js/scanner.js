/* ==========================================================================
   PokAddicts - Quick Scan Controller
   Full-screen camera scanning surface: a card-shaped frame guide, a
   persistent manual-search bar pinned to the top (always available), a
   plain capture icon button, and a fixed-height horizontal strip of
   scanned cards along the bottom (rolls sideways, never grows taller and
   covers the camera).

   Capture flow: tap the capture button -> only the region inside the
   card-frame guide is cropped out and sent for identification (see
   getFrameCropRect()), so other cards visible elsewhere in the camera
   view don't get misidentified. Gemini vision then identifies that photo
   (see js/gemini-client.js) for a name/number guess, whether the printed
   text is Japanese, and a best-effort raw-vs-slab (+ grade/cert) tag, all
   in one call. Gemini's own guess is often slightly off (wrong number,
   near-miss name), so rather than trust it directly, that guess seeds a
   real PokeWallet catalog search (the same ranking logic used by the live
   search-as-you-type widget elsewhere in the app) - the actual card
   usually still surfaces in the top few ranked results even when Gemini's
   guess isn't exact, giving you several candidates to pick from instead
   of one likely-wrong answer.
   - Raw: the picked candidate already carries a PokeWallet catalog id, so
     its real market price is fetched immediately.
   - Slab: no free graded-price source exists yet, so you fill in grading
     company/grade/cost/market yourself.
   Confirming a suggestion just adds it to the running strip - nothing is
   forced. Only tapping "Done Scanning" moves to a Review screen where you
   can double check everything (optionally splitting one collective price
   across the cards by market value) before committing the whole batch as
   either a Buyback (straight into inventory) or a Trade (dropped into
   Trade Studio's incoming list to execute there).
   ========================================================================== */

class PokAddictsScanner {
  constructor() {
    this.stream = null;
    this.scanList = []; // [{ tempId, name, set, type, gradingCompany, grade, condition, certNumber, catalogCardId, marketValue, imageUrl }]

    this.view = 'capture'; // 'capture' | 'suggestions' | 'variantPick' | 'slabDetails' | 'finalize'

    this.pendingSuggestions = []; // candidate cards awaiting a tap-to-confirm
    this.suggestionsExpanded = false; // false = show only the top match + "N More" link, true = show the full list
    this.pendingIsSlab = false; // whether Gemini's original detection looked like a graded slab
    this.pendingSlabInfo = null; // { grade, gradingCompany, certNumber } read off the slab by Gemini, pre-fills the slab form
    this.pendingSlabSuggestion = null; // the confirmed card being filled in as a slab (grading/cost/market)
    this.pendingVariantChoice = null; // { name, set, catalogCardId, variants } - awaiting a Normal/Holo/Reverse Holo pick
    this.scanLanguage = 'eng'; // 'eng' | 'jap' - which language edition to prioritize in suggestions
  }

  // --- Modal lifecycle ---

  openScannerModal() {
    const modal = document.getElementById('scanner-modal');
    if (modal) modal.classList.add('active');

    this.scanList = [];
    this.pendingSuggestions = [];
    this.suggestionsExpanded = false;
    this.pendingIsSlab = false;
    this.pendingSlabInfo = null;
    this.pendingSlabSuggestion = null;
    this.pendingVariantChoice = null;
    this.scanLanguage = 'eng';
    this.view = 'capture';

    this.renderScanWorkspace();
    this.startCamera();
  }

  // Only toggles the active class on the two buttons directly, rather than
  // re-rendering the workspace - renderScanWorkspace() rebuilds the whole
  // body including a fresh <video> element, which would blank the camera
  // feed until startCamera() reattached it.
  setScanLanguage(lang) {
    this.scanLanguage = lang;
    document.querySelectorAll('.scanner-lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });
  }

  closeScannerModal() {
    const modal = document.getElementById('scanner-modal');
    if (modal) modal.classList.remove('active');
    this.stopCamera();
  }

  // Brief camera-shutter-style flash so a manual capture tap feels
  // responsive and it's obvious a snapshot was taken.
  triggerCaptureFlash() {
    const flash = document.getElementById('scanner-flash');
    if (!flash) return;
    flash.classList.remove('fading');
    flash.classList.add('active');
    setTimeout(() => {
      flash.classList.remove('active');
      flash.classList.add('fading');
    }, 80);
  }

  // --- Camera ---

  async startCamera() {
    const videoElement = document.getElementById('scanner-video');

    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (videoElement) {
          videoElement.srcObject = this.stream;
          await videoElement.play();
        }
      } else {
        window.app.showToast('⚠️ Camera unavailable - use search above.');
      }
    } catch (err) {
      console.warn('Camera access error:', err);
      window.app.showToast('⚠️ Camera access blocked - use search above.');
    }
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
  }

  // --- Layout ---

  renderScanWorkspace() {
    const body = document.getElementById('scanner-modal-body');
    if (!body) return;

    const showScanChrome = this.view !== 'finalize';

    body.innerHTML = `
      <div class="scanner-video-layer">
        <video id="scanner-video" playsinline muted></video>
      </div>
      <canvas id="scanner-canvas" style="display: none;"></canvas>
      <div id="scanner-flash" class="scanner-flash"></div>

      <div class="scanner-top-header">
        <span class="scanner-top-header-title">📷 Scan Card</span>
        <div class="scanner-lang-toggle">
          <button type="button" class="scanner-lang-btn ${this.scanLanguage === 'eng' ? 'active' : ''}" data-lang="eng" onclick="window.scanner.setScanLanguage('eng')">EN</button>
          <button type="button" class="scanner-lang-btn ${this.scanLanguage === 'jap' ? 'active' : ''}" data-lang="jap" onclick="window.scanner.setScanLanguage('jap')">JP</button>
        </div>
      </div>

      ${showScanChrome ? `
        <div class="scanner-card-frame">
          <div class="scanner-corner tl"></div>
          <div class="scanner-corner tr"></div>
          <div class="scanner-corner bl"></div>
          <div class="scanner-corner br"></div>
        </div>
      ` : ''}

      ${showScanChrome ? `
        <div class="scanner-top-bar">
          <div class="form-group card-search-wrap" style="margin-bottom: 0;">
            <input type="text" id="scanner-search-name" class="form-control" placeholder="🔍 Or search manually..." autocomplete="off">
            <div id="scanner-search-dropdown" class="card-search-dropdown"></div>
          </div>
          <div id="scanner-search-preview" class="card-search-preview"></div>
        </div>
      ` : ''}

      <div class="scanner-bottom-sheet">
        <div id="scanner-dynamic-section">
          ${this.renderDynamicSection()}
        </div>
      </div>
    `;

    this.attachCardSearch();
    this.loadPendingThumbnail();
    this.loadScannedChipThumbnails();
  }

  renderDynamicSectionOnly() {
    const section = document.getElementById('scanner-dynamic-section');
    if (section) section.innerHTML = this.renderDynamicSection();
    this.attachCardSearch();
    this.loadPendingThumbnail();
    this.loadScannedChipThumbnails();
  }

  renderDynamicSection() {
    if (this.view === 'finalize') return this.renderFinalizeHTML();

    let html = '';
    if (this.view === 'slabDetails') html += this.renderSlabDetailsHTML();
    else if (this.view === 'variantPick') html += this.renderVariantPickHTML();
    else if (this.view === 'suggestions') html += this.renderSuggestionsHTML();

    html += this.renderScannedStripHTML();
    html += this.renderCaptureControlsHTML();
    return html;
  }

  // Plain icon capture button - stays visible even while reviewing
  // suggestions so there's always a way to retake the photo without first
  // hunting for the small dismiss (X) on the result card. Still hidden
  // during the variant/slab forms, which are short deliberate follow-up
  // steps right after a confirm rather than something to retry.
  renderCaptureControlsHTML() {
    if (this.view === 'slabDetails' || this.view === 'variantPick') return '';

    return `
      <div class="scanner-controls-row">
        <button class="scanner-capture-btn" onclick="window.scanner.captureAndIdentify()" aria-label="Capture"></button>
        ${this.scanList.length > 0 ? `
          <button class="btn btn-green btn-sm scanner-done-btn" onclick="window.scanner.goToFinalize()">✅ Done (${this.scanList.length})</button>
        ` : ''}
      </div>
    `;
  }

  // Fixed-height horizontal strip of scanned cards - rolls sideways
  // instead of stacking downward, so the camera above never gets covered
  // no matter how many cards get scanned.
  renderScannedStripHTML() {
    if (this.scanList.length === 0) return '';

    const totalValue = this.scanList.reduce((sum, e) => sum + (e.marketValue || 0), 0);

    return `
      <div class="scanner-strip-counter">📋 ${this.scanList.length} scanned • Total Mkt: $${totalValue.toFixed(2)}</div>
      <div class="scanner-scanned-strip">
        ${this.scanList.map(entry => `
          <div class="scanner-scanned-chip">
            <span class="scanner-scanned-chip-remove" onclick="window.scanner.removeFromScanList('${entry.tempId}')">✕</span>
            <div class="scanner-scanned-chip-thumb" id="scan-chip-thumb-${entry.tempId}">${entry.imageUrl ? `<img src="${entry.imageUrl}" alt="${entry.name}">` : (entry.type === 'slab' ? '🏆' : '🎴')}</div>
            <div class="scanner-scanned-chip-price">$${(entry.marketValue || 0).toFixed(0)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // Fetches and caches thumbnails for chips that don't have one yet -
  // in parallel (not a sequential for-await loop), since each image is an
  // independent network request and waiting for one before starting the
  // next only added up delay for no reason.
  async loadScannedChipThumbnails() {
    await Promise.all(this.scanList.map(async (entry) => {
      if (entry.imageUrl || !entry.catalogCardId || !window.tcgdexClient?.configured) return;
      try {
        const url = await window.cardCatalog.getCardImageUrl(entry.catalogCardId, 'low');
        if (!url) return;
        entry.imageUrl = url;
        const el = document.getElementById(`scan-chip-thumb-${entry.tempId}`);
        if (el) el.innerHTML = `<img src="${url}" alt="${entry.name}">`;
      } catch (err) {
        console.warn('Chip thumbnail fetch failed:', err);
      }
    }));
  }

  // Fetches the card image for whichever result is currently the
  // collapsed top-match card, matching PriceCharting's result-card look.
  async loadPendingThumbnail() {
    if (this.view !== 'suggestions' || this.suggestionsExpanded) return;
    const top = this.pendingSuggestions[0];
    if (!top || !top.catalogCardId || !window.tcgdexClient?.configured) return;

    try {
      const url = await window.cardCatalog.getCardImageUrl(top.catalogCardId, 'low');
      const el = document.getElementById('scanner-result-thumb-0');
      if (url && el) el.innerHTML = `<img src="${url}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px;" alt="${top.name}">`;
    } catch (err) {
      console.warn('Thumbnail fetch failed:', err);
    }
  }

  // --- Photo capture -> CardSight identify -> PokeWallet-ranked candidates ---

  // Works out the card-frame guide's position in actual video-pixel
  // coordinates (accounting for object-fit:cover scaling/cropping between
  // the video's native resolution and its on-screen display size), so the
  // capture only includes what's inside the frame - other cards visible
  // elsewhere in the camera view don't get sent to CardSight at all.
  getFrameCropRect(video) {
    const container = document.querySelector('.scanner-video-layer');
    const dispW = container ? container.clientWidth : window.innerWidth;
    const dispH = container ? container.clientHeight : window.innerHeight;
    const vidW = video.videoWidth;
    const vidH = video.videoHeight;

    const scale = Math.max(dispW / vidW, dispH / vidH);
    const renderedW = vidW * scale;
    const renderedH = vidH * scale;
    const offsetX = (renderedW - dispW) / 2;
    const offsetY = (renderedH - dispH) / 2;

    // Matches .scanner-card-frame's CSS: top:44%, left:50%, width:70%,
    // aspect-ratio 63/88, centered via translate(-50%, -50%).
    const frameWidthDisp = dispW * 0.70;
    const frameHeightDisp = frameWidthDisp * (88 / 63);
    const centerXDisp = dispW * 0.5;
    const centerYDisp = dispH * 0.44;
    const leftDisp = centerXDisp - frameWidthDisp / 2;
    const topDisp = centerYDisp - frameHeightDisp / 2;

    const x = (leftDisp + offsetX) / scale;
    const y = (topDisp + offsetY) / scale;
    const width = frameWidthDisp / scale;
    const height = frameHeightDisp / scale;

    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.min(width, vidW),
      height: Math.min(height, vidH)
    };
  }

  async captureAndIdentify() {
    const video = document.getElementById('scanner-video');
    const canvas = document.getElementById('scanner-canvas');
    if (!video || !canvas || !video.videoWidth) {
      window.app.showToast('⚠️ Camera not ready yet - try again in a second.');
      return;
    }

    const crop = this.getFrameCropRect(video);
    canvas.width = crop.width;
    canvas.height = crop.height;
    canvas.getContext('2d').drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);

    this.triggerCaptureFlash();

    try {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));

      const detections = await window.geminiClient.identifyCards(blob).catch(err => {
        console.error('Card identification failed:', err);
        return [];
      });

      const primary = detections[0] || null;

      if (!primary) {
        this.pendingSuggestions = [];
        this.view = 'capture';
        window.app.showToast('⚠️ Could not identify this card - search manually above.');
      } else {
        this.pendingSuggestions = await this.buildCandidateList(primary);
        this.pendingIsSlab = primary.isSlab;
        // Carried through to confirmSuggestion() so a detected graded slab
        // pre-fills its grading company/grade/cert number instead of
        // always starting blank, even though Gemini already read them off
        // the slab label photo.
        this.pendingSlabInfo = { grade: primary.grade || '', gradingCompany: primary.gradingCompany || '', certNumber: primary.certNumber || '' };
        this.suggestionsExpanded = false;
        this.view = this.pendingSuggestions.length > 0 ? 'suggestions' : 'capture';
        if (this.pendingSuggestions.length === 0) {
          window.app.showToast('⚠️ Could not find a matching card - search manually above.');
        }
      }
    } catch (err) {
      console.error('Card identification failed:', err);
      window.app.showToast('⚠️ Could not identify the card - search manually above.');
      this.pendingSuggestions = [];
      this.view = 'capture';
    } finally {
      this.renderDynamicSectionOnly();
    }
  }

  // Gemini's guess seeds a real PokeWallet catalog search (local cache
  // first, live search fallback) - the correct card usually surfaces
  // among the top ranked results even if the guess wasn't exact, giving
  // several real candidates instead of one possibly-wrong answer. The raw
  // Gemini guess is kept as a fallback option too, in case the actual
  // card isn't in the TCGdex catalog yet.
  // Wrapped in an outer try/catch so that any unexpected failure here
  // (a bad response shape, a rate-limited request that throws somewhere
  // not already guarded, etc.) still falls back to Gemini's raw guess
  // instead of bubbling up to captureAndIdentify's catch block, which
  // would wipe out suggestions entirely and leave the scan looking dead.
  async buildCandidateList(primary) {
    try {
      return await this._buildCandidateListInner(primary);
    } catch (err) {
      console.warn('buildCandidateList failed, falling back to raw guess:', err);
      return primary.name ? [{ name: primary.name, set: primary.set, number: primary.number, catalogCardId: '', source: 'gemini' }] : [];
    }
  }

  async _buildCandidateListInner(primary) {
    const query = [primary.name, primary.number].filter(Boolean).join(' ').trim();
    // Local search is instant; a live TCGdex call is not - only reach for
    // it when local is genuinely sparse (< 5), not just short of the full
    // display count. TCGdex has no rate limit, but there's no reason to
    // add network latency to every scan when local usually already has
    // plenty of candidates.
    let matches = window.cardCatalog ? window.cardCatalog.searchLocal(query, 12) : [];

    if (matches.length < 5 && window.tcgdexClient?.configured) {
      try {
        const results = await window.tcgdexClient.searchCards(query, { limit: 12, lang: 'en' });
        const liveCards = results.map(r => window.cardSearchUI.normalizeLiveSearchResult(r, 'en'));
        await window.cardCatalog.cacheLiveResults(liveCards);
        const merged = [...matches];
        liveCards.forEach(lc => { if (!merged.some(m => m.id === lc.id)) merged.push(lc); });
        matches = window.cardCatalog.rankCards(merged, query);
      } catch (err) {
        console.warn('TCGdex live search fallback failed:', err);
      }
    }

    const candidates = matches.slice(0, 8).map(m => ({
      name: m.name, set: m.set, number: m.number, catalogCardId: m.id, source: 'tcgdex'
    }));

    if (candidates.length === 0 || candidates[0].name.toLowerCase() !== (primary.name || '').toLowerCase()) {
      candidates.push({ name: primary.name, set: primary.set, number: primary.number, catalogCardId: '', source: 'gemini' });
    }

    // TCGdex's Japanese catalog is inconsistent - some cards have an
    // English name filled in, many still only have their native
    // Japanese-script name (confirmed by inspection: e.g. Magikarp #080
    // in the Japanese SV1a set is stored as "コイキング", not "Magikarp").
    // Triggers whenever Japanese is explicitly in play (the language
    // toggle, or Gemini reading Japanese text on the card), OR as a safety
    // net when the English search above found nothing at all - Gemini's
    // own Japanese-detection isn't perfect, and a genuinely Japanese-only
    // card will never turn up in an English-only search regardless of
    // what Gemini thought the language was.
    const wantJapanese = this.scanLanguage === 'jap' || primary.isJapanese || matches.length === 0;
    if (wantJapanese && primary.name) {
      const nameHints = window.cardCatalog.buildJapaneseNameHints(primary.name);
      const jpMatches = await window.cardCatalog.findJapaneseMatches(primary.number, nameHints, 6);

      jpMatches.forEach(m => {
        if (!candidates.some(c => c.catalogCardId === m.id)) {
          // Translate back to English for display - showing raw Japanese
          // script left no way to tell which card was actually suggested.
          candidates.unshift({ name: window.cardCatalog.translateJapaneseName(m.name) || m.name, set: m.set, number: m.number, catalogCardId: m.id, source: 'japanese' });
        }
      });
    }

    return candidates;
  }

  sourceLabel(source) {
    if (source === 'gemini') return ' • AI guess, unverified';
    if (source === 'japanese') return ' • Japanese edition match';
    return '';
  }

  renderSuggestionsHTML() {
    if (this.pendingSuggestions.length === 0) return '';

    const top = this.pendingSuggestions[0];
    const restCount = this.pendingSuggestions.length - 1;

    if (!this.suggestionsExpanded) {
      return `
        <div class="scanner-result-card">
          <span class="scanner-result-remove" onclick="window.scanner.dismissSuggestions()">✕</span>
          <div id="scanner-result-thumb-0" class="scanner-result-thumb">🎴</div>
          <div class="scanner-result-info" style="cursor: pointer;" onclick="window.scanner.confirmSuggestion(0)">
            <div class="scanner-result-name">${top.name}${top.number ? ' #' + top.number : ''}</div>
            <div class="scanner-result-meta">${top.set || ''}${this.sourceLabel(top.source)}</div>
          </div>
          ${restCount > 0 ? `<span class="scanner-result-more" onclick="window.scanner.expandSuggestions()">☰ ${restCount} More</span>` : ''}
        </div>
      `;
    }

    return `
      <div class="card-panel glow-gold">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div style="font-weight: 700; font-size: 0.85rem;">Which card is this?</div>
          <span style="color: var(--accent-cyan); cursor: pointer; font-size: 0.78rem; font-weight: 700;" onclick="window.scanner.collapseSuggestions()">Show Top Match</span>
        </div>
        ${this.pendingSuggestions.map((s, idx) => `
          <div class="trade-item-pill" style="padding: 10px; cursor: pointer;" onclick="window.scanner.confirmSuggestion(${idx})">
            <span>
              <strong>${s.name}</strong>${s.number ? ` #${s.number}` : ''}
              <div style="font-size: 0.7rem; color: var(--text-secondary);">${s.set || ''}${this.sourceLabel(s.source)}</div>
            </span>
            <span style="color: var(--accent-green); font-weight: 700;">✓ Use</span>
          </div>
        `).join('')}
        <button class="btn btn-secondary btn-sm" style="width: 100%; margin-top: 8px;" onclick="window.scanner.dismissSuggestions()">None of these - search above</button>
      </div>
    `;
  }

  expandSuggestions() {
    this.suggestionsExpanded = true;
    this.renderDynamicSectionOnly();
  }

  collapseSuggestions() {
    this.suggestionsExpanded = false;
    this.renderDynamicSectionOnly();
  }

  dismissSuggestions() {
    this.pendingSuggestions = [];
    this.suggestionsExpanded = false;
    this.pendingIsSlab = false;
    this.view = 'capture';
    this.renderDynamicSectionOnly();
    // Deliberately no auto-focus on the search box here - that popped the
    // on-screen keyboard immediately, making a simple "back out" feel like
    // it was forcing you into a search instead of just returning to the
    // camera to retake the photo.
  }

  confirmSuggestion(idx) {
    const suggestion = this.pendingSuggestions[idx];
    if (!suggestion) return;

    const isSlab = this.pendingIsSlab;
    const slabInfo = this.pendingSlabInfo || {};
    this.pendingSuggestions = [];
    this.suggestionsExpanded = false;
    this.pendingIsSlab = false;
    this.pendingSlabInfo = null;

    if (isSlab) {
      // Pre-fill whatever Gemini already read off the slab label - grade,
      // grading company, cert number - so the form only needs a manual fix
      // when it got something wrong, not a full re-entry every time.
      this.pendingSlabSuggestion = {
        name: suggestion.name,
        set: suggestion.set,
        isSlab: true,
        grade: slabInfo.grade || '',
        gradingCompany: slabInfo.gradingCompany || '',
        certNumber: slabInfo.certNumber || ''
      };
      this.view = 'slabDetails';
      this.renderDynamicSectionOnly();
      return;
    }

    this.view = 'capture';
    this.renderDynamicSectionOnly();
    this.resolveAndAddRaw(suggestion);
  }

  // --- Persistent top search bar (manual search) ---

  attachCardSearch() {
    window.cardSearchUI.attach(
      { inputId: 'scanner-search-name', dropdownId: 'scanner-search-dropdown', previewId: 'scanner-search-preview' },
      (card) => this.handleSearchCardConfirmed(card)
    );
  }

  handleSearchCardConfirmed(card) {
    this.pendingSuggestions = [];
    this.view = 'capture';
    this.renderDynamicSectionOnly();
    this.resolveAndAddRaw({ name: card.name, set: card.set, number: '', catalogCardId: card.catalogCardId || '' });
  }

  // --- Raw singles: resolve against PokeWallet for a real price ---

  async resolveAndAddRaw(suggestion) {
    // Japanese names are official localized names, not literal
    // translations (e.g. "フシギダネ" -> "Bulbasaur" isn't a translation
    // of the text at all) - look it up in a real species table instead.
    const hasJapanese = /[぀-ヿ一-鿿]/.test(suggestion.name);
    const translatedTo = hasJapanese ? window.cardCatalog.translateJapaneseName(suggestion.name) : null;
    const finalName = translatedTo || suggestion.name;

    let catalogCardId = suggestion.catalogCardId || '';
    let setName = suggestion.set || '';
    let cardLang = 'en';

    if (!catalogCardId) {
      window.app.showToast(`Looking up price for ${finalName}...`);
      const match = await this.resolveCatalogMatch(finalName, suggestion.number);
      if (match) {
        catalogCardId = match.id;
        setName = match.set || setName;
        cardLang = match.language || 'en';
      }
    } else {
      cardLang = window.cardCatalog?.getCardById(catalogCardId)?.language || 'en';
    }

    if (!catalogCardId) {
      this.addRawToScanList(finalName, setName, '', 0);
      window.app.showToast(`Added ${finalName} to scan list (${this.scanList.length}) - no price found, edit manually`);
      this.renderDynamicSectionOnly();
      return;
    }

    const catalogCard = window.cardCatalog?.getCardById(catalogCardId);
    const variants = await this.fetchVariantsForCard(catalogCardId, cardLang, finalName, catalogCard?.number || suggestion.number);

    if (variants.length <= 1) {
      const marketValue = variants[0]?.price || 0;
      this.addRawToScanList(finalName, setName, catalogCardId, marketValue);
      window.app.showToast(`Added ${finalName} ($${marketValue.toFixed(2)}) to scan list (${this.scanList.length})`);
      this.renderDynamicSectionOnly();
      return;
    }

    // Same card/set/number can print in several finishes (Normal, Holo,
    // Reverse Holo, 1st Edition, etc.) at very different market values -
    // let the user pick which one their physical copy actually is instead
    // of guessing.
    this.pendingVariantChoice = { name: finalName, set: setName, catalogCardId, variants };
    this.view = 'variantPick';
    this.renderDynamicSectionOnly();
  }

  // Japanese cards use PokeWallet for pricing, not TCGdex - confirmed
  // directly that TCGdex's own price data for Japanese secret/art rares
  // can be badly wrong (a real ~$177 Magikarp Art Rare priced at €0.08 on
  // TCGdex, apparently linked to the wrong product). English cards keep
  // using TCGdex, which priced normally in testing. Falls back to TCGdex
  // for a Japanese card if PokeWallet doesn't have it either.
  async fetchVariantsForCard(catalogCardId, cardLang, name, number) {
    if (cardLang === 'ja' && window.pokeWalletClient?.configured) {
      try {
        const match = await window.pokeWalletClient.findCardByNameAndNumber(name, number);
        if (match) {
          const detail = await window.pokeWalletClient.getCard(match.id);
          const variants = window.pokeWalletClient.extractAllVariantsSGD(detail);
          if (variants.length > 0) return variants;
        }
      } catch (err) {
        console.warn('PokeWallet price fetch failed, falling back to TCGdex:', err);
      }
    }

    try {
      let detail;
      try {
        detail = await window.tcgdexClient.getCard(catalogCardId, cardLang);
      } catch (err) {
        // cardLang came from a local-catalog lookup that may be stale or
        // have missed - a card only exists under its real language's
        // endpoint (a Japanese-only id 404s under /en/), so try the other
        // language before giving up on price entirely.
        detail = await window.tcgdexClient.getCard(catalogCardId, cardLang === 'ja' ? 'en' : 'ja');
      }
      return window.tcgdexClient.extractAllVariantsSGD(detail);
    } catch (err) {
      console.warn('TCGdex price fetch failed:', err);
      return [];
    }
  }

  addRawToScanList(name, set, catalogCardId, marketValue, variantLabel) {
    this.scanList.push({
      tempId: 'scan-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      name,
      set,
      type: 'raw',
      gradingCompany: 'Raw',
      grade: 'NM',
      condition: 'Near Mint',
      catalogCardId,
      marketValue,
      variantLabel: variantLabel || ''
    });
  }

  renderVariantPickHTML() {
    const v = this.pendingVariantChoice;
    if (!v) return '';

    return `
      <div class="card-panel glow-gold">
        <div style="font-weight: 700; font-size: 0.85rem; margin-bottom: 4px;">Which version is this?</div>
        <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 10px;">${v.name}${v.set ? ' • ' + v.set : ''}</div>
        ${v.variants.map((variant, idx) => `
          <div class="trade-item-pill" style="padding: 10px; cursor: pointer;" onclick="window.scanner.confirmVariant(${idx})">
            <span>${variant.label}</span>
            <span style="color: var(--accent-green); font-weight: 700; font-family: 'JetBrains Mono', monospace;">$${variant.price.toFixed(2)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  confirmVariant(idx) {
    const v = this.pendingVariantChoice;
    if (!v) return;
    const variant = v.variants[idx];
    this.pendingVariantChoice = null;
    this.view = 'capture';

    this.addRawToScanList(v.name, v.set, v.catalogCardId, variant.price, variant.label);
    window.app.showToast(`Added ${v.name} (${variant.label}) - $${variant.price.toFixed(2)} to scan list (${this.scanList.length})`);
    this.renderDynamicSectionOnly();
  }

  // Finds a TCGdex catalog match for a confirmed card name (+ optional
  // number) - local cache first, live search fallback. When picking the
  // raw "AI guess, unverified" suggestion specifically, this is what tries
  // to actually attach a real price - so if the English search comes up
  // empty, it's worth also trying the Japanese catalog (strict number+name
  // match, see findJapaneseMatches) before giving up, in case the card is
  // Japanese-only and just wasn't caught by the scan-time Japanese search.
  async resolveCatalogMatch(name, number) {
    const query = [name, number].filter(Boolean).join(' ').trim();
    let matches = [];

    if (query) {
      matches = window.cardCatalog ? window.cardCatalog.searchLocal(query, 5) : [];

      if (matches.length === 0 && window.tcgdexClient?.configured) {
        try {
          const results = await window.tcgdexClient.searchCards(query, { limit: 5, lang: 'en' });
          const liveCards = results.map(r => window.cardSearchUI.normalizeLiveSearchResult(r, 'en'));
          await window.cardCatalog.cacheLiveResults(liveCards);
          matches = window.cardCatalog.rankCards(liveCards, query);
        } catch (err) {
          console.warn('TCGdex live search fallback failed:', err);
        }
      }
    }

    if (matches.length === 0 && name) {
      const nameHints = window.cardCatalog.buildJapaneseNameHints(name);
      matches = await window.cardCatalog.findJapaneseMatches(number, nameHints, 3);
    }

    return matches[0] || null;
  }

  // Japanese name lookup/translation (findJapaneseSpeciesMatch,
  // translateJapaneseName, translateEnglishToJapanese, findJapaneseMatches)
  // now lives on window.cardCatalog - shared with card-search-ui.js's
  // manual search widget, not scanner-specific.

  // --- Graded slabs: manual grading/cost/market entry ---

  renderSlabDetailsHTML() {
    const s = this.pendingSlabSuggestion || {};

    return `
      <div class="card-panel glow-gold">
        <div style="font-weight: 700; font-size: 0.85rem; margin-bottom: 4px;">🏆 Confirm Slab Details</div>
        <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 10px;">${s.name || ''}</div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label class="form-label">Grading Company</label>
            <select id="scan-cert-company" class="form-control">
              ${window.POKEMON_DB.gradingCompanies.map(c => `<option value="${c}" ${c === s.gradingCompany ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Grade</label>
            <select id="scan-cert-grade" class="form-control">
              ${window.POKEMON_DB.slabGrades.map(g => `<option value="${g}" ${s.grade && s.grade.startsWith(g) ? 'selected' : ''}>${g}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Cert Number${s.certNumber ? ' (read from slab)' : ''}</label>
          <input type="text" id="scan-cert-number" class="form-control" placeholder="e.g. 48658983" value="${s.certNumber || ''}">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label class="form-label">Cost Basis ($)</label>
            <input type="number" id="scan-cert-cost" class="form-control" placeholder="0.00" step="0.01">
          </div>
          <div class="form-group">
            <label class="form-label">Market Value ($)</label>
            <input type="number" id="scan-cert-market" class="form-control" placeholder="No graded price source yet" step="0.01">
          </div>
        </div>
        <div style="font-size: 0.72rem; color: var(--text-muted); margin-bottom: 10px;">No free graded-price source yet - enter it yourself for now.</div>

        <button class="btn btn-primary" style="width: 100%;" onclick="window.scanner.commitSlabToScanList()">+ Add to Scan List</button>
      </div>
    `;
  }

  commitSlabToScanList() {
    const s = this.pendingSlabSuggestion;
    if (!s || !s.name) { alert('Search and confirm the card first.'); return; }

    const company = document.getElementById('scan-cert-company')?.value || s.gradingCompany || 'PSA';
    const gradeVal = document.getElementById('scan-cert-grade')?.value || s.grade || '10';
    const certNumber = document.getElementById('scan-cert-number')?.value.trim() || '';
    const cost = parseFloat(document.getElementById('scan-cert-cost')?.value) || 0;
    const market = parseFloat(document.getElementById('scan-cert-market')?.value) || 0;

    const hasJapanese = /[぀-ヿ一-鿿]/.test(s.name);
    const translatedTo = hasJapanese ? window.cardCatalog.translateJapaneseName(s.name) : null;
    const finalName = translatedTo || s.name;

    this.scanList.push({
      tempId: 'scan-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      name: finalName,
      set: s.set || '',
      type: 'slab',
      gradingCompany: company,
      grade: gradeVal === '10' ? '10 GEM MT' : gradeVal,
      certNumber,
      marketValue: market,
      presetCost: cost
    });

    window.app.showToast(`Added ${finalName} to scan list (${this.scanList.length})`);

    this.pendingSlabSuggestion = null;
    this.view = 'capture';
    this.renderScanWorkspace();
    this.startCamera();
  }

  removeFromScanList(tempId) {
    this.scanList = this.scanList.filter(e => e.tempId !== tempId);
    this.renderDynamicSectionOnly();
  }

  goToFinalize() {
    if (this.scanList.length === 0) return;
    this.view = 'finalize';
    this.renderScanWorkspace();
  }

  backToScanning() {
    this.view = 'capture';
    this.renderScanWorkspace();
    this.startCamera();
  }

  // --- Finalize: review everything, optionally split one collective
  // price across the cards by market value, then commit the whole batch ---

  renderFinalizeHTML() {
    const totalValue = this.scanList.reduce((sum, e) => sum + (e.marketValue || 0), 0);

    return `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <span style="font-size: 0.95rem; font-weight: 800; color: #fff;">Review Scan (${this.scanList.length})</span>
        <span style="color: var(--accent-cyan); cursor: pointer; font-weight: 700; font-size: 0.8rem;" onclick="window.scanner.backToScanning()">← Back to Scanning</span>
      </div>

      <div style="color: #fff; font-weight: 700; font-size: 0.9rem; margin-bottom: 10px;">Total Market Value: $${totalValue.toFixed(2)}</div>

      ${this.scanList.map(entry => `
        <div class="card-panel" style="margin-bottom: 10px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
            <div>
              <div style="font-weight: 700; font-size: 0.9rem; color: var(--text-primary);">${entry.name}</div>
              <div style="font-size: 0.72rem; color: var(--text-secondary);">${entry.set || ''}${entry.type === 'slab' ? ` • ${entry.gradingCompany} ${entry.grade}` : ''}${entry.variantLabel ? ` • ${entry.variantLabel}` : ''}</div>
            </div>
            <span style="color: var(--accent-red); cursor: pointer;" onclick="window.scanner.removeFromScanList('${entry.tempId}')">✕</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: flex-end; gap: 10px;">
            <div>
              <div style="font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;">Market Value</div>
              <div style="font-size: 1.1rem; font-weight: 800; color: var(--accent-cyan); font-family: 'JetBrains Mono', monospace;">$${(entry.marketValue || 0).toFixed(2)}</div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;">Your Cost</div>
              <input type="number" id="scan-cost-${entry.tempId}" class="form-control" style="width: 90px; padding: 6px; text-align: right;" value="${(entry.presetCost || entry.marketValue * 0.7 || 0).toFixed(2)}" step="0.01">
            </div>
          </div>
        </div>
      `).join('')}

      <div class="card-panel glow-gold">
        <div class="form-group" style="margin-top: 0;">
          <label class="form-label">Collective Price ($) - optional</label>
          <input type="number" id="scanner-collective-price" class="form-control" placeholder="Leave blank to use each card's cost above" step="0.01">
          <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">Bought the whole stack for one price? Enter it here - it'll be split across the cards above by their market value, instead of using the per-card costs (only applies to Buyback).</div>
        </div>

        <div class="form-group">
          <label class="form-label">Tradeshow / Event (for Buyback)</label>
          <select id="scanner-finalize-event" class="form-control">
            ${window.db.getEventTags().map(tag => `<option value="${tag}" ${tag === (window.db.settings.currentEventTag || 'Normal Sale') ? 'selected' : ''}>${tag}</option>`).join('')}
          </select>
        </div>

        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <button class="btn btn-green btn-wrap-safe" style="flex: 1;" onclick="window.scanner.markBatchBought()">💰 Bought</button>
          <button class="btn btn-cyan btn-wrap-safe" style="flex: 1;" onclick="window.scanner.markBatchTraded()">🔄 Traded</button>
        </div>
      </div>
    `;
  }

  // --- Committing the batch ---

  markBatchBought() {
    if (this.scanList.length === 0) return;
    const eventTag = document.getElementById('scanner-finalize-event')?.value || window.db.settings.currentEventTag || 'Normal Sale';

    // A collective price overrides the per-card cost inputs, splitting
    // proportionally by market value - the same weighted-allocation
    // approach db.executeTrade() already uses for trade-acquired items.
    const collectiveVal = document.getElementById('scanner-collective-price')?.value;
    const collectivePrice = (collectiveVal !== undefined && collectiveVal !== '') ? parseFloat(collectiveVal) : NaN;
    const useCollective = !isNaN(collectivePrice);
    const totalMarket = this.scanList.reduce((sum, e) => sum + (e.marketValue || 0), 0);

    this.scanList.forEach(entry => {
      let cost;
      if (useCollective) {
        cost = totalMarket > 0
          ? (entry.marketValue / totalMarket) * collectivePrice
          : collectivePrice / this.scanList.length;
      } else {
        const costInput = document.getElementById(`scan-cost-${entry.tempId}`);
        const parsedCost = parseFloat(costInput?.value);
        cost = isNaN(parsedCost) ? (entry.marketValue || 0) * 0.7 : parsedCost;
      }

      window.db.addItem({
        name: entry.name,
        set: entry.set || '',
        type: entry.type,
        gradingCompany: entry.gradingCompany,
        grade: entry.grade,
        condition: entry.condition || '',
        certNumber: entry.certNumber || '',
        costBasis: parseFloat(cost.toFixed(2)),
        marketValue: entry.marketValue || 0,
        askingPrice: entry.marketValue || 0,
        catalogCardId: entry.catalogCardId || '',
        intakeSource: 'buyback',
        eventTag,
        notes: 'Bought back via Quick Scan'
      });
    });

    window.syncManager.broadcast('SCAN_BATCH_BOUGHT');
    window.app.showToast(`Bought back ${this.scanList.length} card${this.scanList.length === 1 ? '' : 's'} @ ${eventTag}`);
    this.scanList = [];
    this.closeScannerModal();
    window.app.renderAllPages();
    window.app.switchTab('inventory');
  }

  markBatchTraded() {
    if (this.scanList.length === 0) return;

    this.scanList.forEach(entry => {
      window.tradeComp.acquiredItems.push({
        name: entry.name,
        marketValue: entry.marketValue || 0,
        type: entry.type,
        gradingCompany: entry.gradingCompany,
        grade: entry.grade,
        condition: entry.condition || '',
        certNumber: entry.certNumber || '',
        catalogCardId: entry.catalogCardId || ''
      });
    });

    window.app.showToast(`Added ${this.scanList.length} card${this.scanList.length === 1 ? '' : 's'} to Trade Studio's incoming list`);
    this.scanList = [];
    this.closeScannerModal();
    window.tradeComp.renderTradePage();
    window.app.switchTab('trade');
  }
}

window.scanner = new PokAddictsScanner();
