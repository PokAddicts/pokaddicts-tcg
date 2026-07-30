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
   view don't get misidentified. CardSight AI then identifies that photo
   (see js/cardsight-client.js) for a rough name/number guess and a
   best-effort raw-vs-slab tag. CardSight's own top guess is often
   slightly off (wrong number, near-miss name), so rather than trust it
   directly, that guess seeds a real PokeWallet catalog search (the same
   ranking logic used by the live search-as-you-type widget elsewhere in
   the app) - the actual card usually still surfaces in the top few
   ranked results even when CardSight's guess isn't exact, giving you
   several candidates to pick from instead of one likely-wrong answer.
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
    this.pendingIsSlab = false; // whether CardSight's original detection looked like a graded slab
    this.pendingSlabSuggestion = null; // the confirmed card being filled in as a slab (grading/cost/market)
    this.pendingVariantChoice = null; // { name, set, catalogCardId, variants } - awaiting a Normal/Holo/Reverse Holo pick
  }

  // --- Modal lifecycle ---

  openScannerModal() {
    const modal = document.getElementById('scanner-modal');
    if (modal) modal.classList.add('active');

    this.scanList = [];
    this.pendingSuggestions = [];
    this.suggestionsExpanded = false;
    this.pendingIsSlab = false;
    this.pendingSlabSuggestion = null;
    this.pendingVariantChoice = null;
    this.view = 'capture';

    this.renderScanWorkspace();
    this.startCamera();
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

  // Plain icon capture button - hidden while reviewing a suggestion,
  // variant choice, or slab form so it doesn't compete for attention.
  renderCaptureControlsHTML() {
    if (this.view === 'suggestions' || this.view === 'slabDetails' || this.view === 'variantPick') return '';

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

  // Fetches and caches thumbnails for chips that don't have one yet.
  async loadScannedChipThumbnails() {
    for (const entry of this.scanList) {
      if (entry.imageUrl || !entry.catalogCardId || !window.pokeWalletClient?.configured) continue;
      try {
        const url = await window.pokeWalletClient.getImageBlobUrl(entry.catalogCardId, 'low');
        if (!url) continue;
        entry.imageUrl = url;
        const el = document.getElementById(`scan-chip-thumb-${entry.tempId}`);
        if (el) el.innerHTML = `<img src="${url}" alt="${entry.name}">`;
      } catch (err) {
        console.warn('Chip thumbnail fetch failed:', err);
      }
    }
  }

  // Fetches the card image for whichever result is currently the
  // collapsed top-match card, matching PriceCharting's result-card look.
  async loadPendingThumbnail() {
    if (this.view !== 'suggestions' || this.suggestionsExpanded) return;
    const top = this.pendingSuggestions[0];
    if (!top || !top.catalogCardId || !window.pokeWalletClient?.configured) return;

    try {
      const url = await window.pokeWalletClient.getImageBlobUrl(top.catalogCardId, 'low');
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

      // CardSight recognizes English cards well but Japanese ones less
      // reliably. Running a quick on-device OCR pass in parallel - just
      // to detect Japanese text and pull a card number, both far more
      // reliable than trying to read the full name - gives Japanese cards
      // a second, independent chance at a correct guess.
      const [detections, ocrHint] = await Promise.all([
        window.cardSightClient.identifyCards(blob).catch(err => {
          console.error('Card identification failed:', err);
          return [];
        }),
        this.quickOcrHint(canvas)
      ]);

      let primary = detections[0] || null;
      if (!primary && ocrHint?.translatedName) {
        primary = { name: ocrHint.translatedName, number: ocrHint.number, set: '', isSlab: false };
      }

      if (!primary) {
        this.pendingSuggestions = [];
        this.view = 'capture';
        window.app.showToast('⚠️ Could not identify this card - search manually above.');
      } else {
        this.pendingSuggestions = await this.buildCandidateList(primary, ocrHint);
        this.pendingIsSlab = primary.isSlab;
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

  // On-device OCR (Tesseract.js) used only for two narrow, reliable
  // signals - not full name-reading (which foil/glare/stylized fonts make
  // unreliable): whether the visible text is Japanese, and the printed
  // card number (plain digits, easy to read regardless of language). If a
  // known Japanese species name is found in the OCR text, its English
  // name is included too.
  async quickOcrHint(canvas) {
    if (typeof Tesseract === 'undefined') return null;
    try {
      const { data } = await Tesseract.recognize(canvas, 'eng+jpn');
      const text = data.text || '';
      const hasJapanese = /[぀-ヿ一-鿿]/.test(text);
      const numberMatch = text.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
      const number = numberMatch ? numberMatch[1] : '';
      const translatedName = hasJapanese ? this.translateJapaneseName(text) : null;
      return { hasJapanese, number, translatedName };
    } catch (err) {
      console.warn('OCR hint failed:', err);
      return null;
    }
  }

  // CardSight's guess seeds a real PokeWallet catalog search (local cache
  // first, live search fallback) - the correct card usually surfaces
  // among the top ranked results even if the guess wasn't exact, giving
  // several real candidates instead of one possibly-wrong answer. The raw
  // CardSight guess is kept as a fallback option too, in case the actual
  // card isn't in the PokeWallet catalog yet.
  async buildCandidateList(primary, ocrHint) {
    const query = [primary.name, primary.number].filter(Boolean).join(' ').trim();
    let matches = window.cardCatalog ? window.cardCatalog.searchLocal(query, 8) : [];

    if (matches.length < 5 && window.pokeWalletClient?.configured) {
      try {
        const res = await window.pokeWalletClient.searchCards(query, { limit: 8 });
        const liveCards = (res.results || []).map(r => window.cardSearchUI.normalizeLiveSearchResult(r));
        await window.cardCatalog.cacheLiveResults(liveCards);
        const merged = [...matches];
        liveCards.forEach(lc => { if (!merged.some(m => m.id === lc.id)) merged.push(lc); });
        matches = window.cardCatalog.rankCards(merged, query);
      } catch (err) {
        console.warn('PokeWallet live search fallback failed:', err);
      }
    }

    const candidates = matches.slice(0, 5).map(m => ({
      name: m.name, set: m.set, number: m.number, catalogCardId: m.id, source: 'pokewallet'
    }));

    if (candidates.length === 0 || candidates[0].name.toLowerCase() !== (primary.name || '').toLowerCase()) {
      candidates.push({ name: primary.name, set: primary.set, number: primary.number, catalogCardId: '', source: 'cardsight' });
    }

    // OCR detected Japanese text matching a known species, different from
    // CardSight's own guess - search for that too and surface it first,
    // giving the likely-correct card a real shot even when CardSight
    // misreads a Japanese print.
    if (ocrHint?.translatedName && ocrHint.translatedName.toLowerCase() !== (primary.name || '').toLowerCase()) {
      const jpQuery = [ocrHint.translatedName, ocrHint.number || primary.number].filter(Boolean).join(' ').trim();
      let jpMatches = window.cardCatalog ? window.cardCatalog.searchLocal(jpQuery, 3) : [];

      if (jpMatches.length === 0 && window.pokeWalletClient?.configured) {
        try {
          const res = await window.pokeWalletClient.searchCards(jpQuery, { limit: 3 });
          const liveCards = (res.results || []).map(r => window.cardSearchUI.normalizeLiveSearchResult(r));
          await window.cardCatalog.cacheLiveResults(liveCards);
          jpMatches = window.cardCatalog.rankCards(liveCards, jpQuery);
        } catch (err) {
          console.warn('OCR-assisted Japanese search failed:', err);
        }
      }

      jpMatches.slice(0, 2).forEach(m => {
        if (!candidates.some(c => c.catalogCardId === m.id)) {
          candidates.unshift({ name: m.name, set: m.set, number: m.number, catalogCardId: m.id, source: 'ocr-japanese' });
        }
      });
    }

    return candidates;
  }

  sourceLabel(source) {
    if (source === 'cardsight') return ' • AI guess, unverified';
    if (source === 'ocr-japanese') return ' • matched from Japanese text';
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
    document.getElementById('scanner-search-name')?.focus();
  }

  confirmSuggestion(idx) {
    const suggestion = this.pendingSuggestions[idx];
    if (!suggestion) return;

    const isSlab = this.pendingIsSlab;
    this.pendingSuggestions = [];
    this.suggestionsExpanded = false;
    this.pendingIsSlab = false;

    if (isSlab) {
      this.pendingSlabSuggestion = { name: suggestion.name, set: suggestion.set, isSlab: true, grade: '', gradingCompany: '', certNumber: '' };
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
    const translatedTo = hasJapanese ? this.translateJapaneseName(suggestion.name) : null;
    const finalName = translatedTo || suggestion.name;

    let catalogCardId = suggestion.catalogCardId || '';
    let setName = suggestion.set || '';

    if (!catalogCardId) {
      window.app.showToast(`Looking up price for ${finalName}...`);
      const match = await this.resolvePokeWalletMatch(finalName, suggestion.number);
      if (match) {
        catalogCardId = match.id;
        setName = match.set || setName;
      }
    }

    if (!catalogCardId) {
      this.addRawToScanList(finalName, setName, '', 0);
      window.app.showToast(`Added ${finalName} to scan list (${this.scanList.length}) - no price found, edit manually`);
      this.renderDynamicSectionOnly();
      return;
    }

    let variants = [];
    try {
      const detail = await window.pokeWalletClient.getCard(catalogCardId);
      variants = window.pokeWalletClient.extractAllVariantsSGD(detail);
    } catch (err) {
      console.warn('PokeWallet price fetch failed:', err);
    }

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

  // Finds a PokeWallet catalog match for a confirmed card name (+ optional
  // number) - local cache first, live search fallback.
  async resolvePokeWalletMatch(name, number) {
    const query = [name, number].filter(Boolean).join(' ').trim();
    if (!query) return null;

    let matches = window.cardCatalog ? window.cardCatalog.searchLocal(query, 5) : [];

    if (matches.length === 0 && window.pokeWalletClient?.configured) {
      try {
        const res = await window.pokeWalletClient.searchCards(query, { limit: 5 });
        const liveCards = (res.results || []).map(r => window.cardSearchUI.normalizeLiveSearchResult(r));
        await window.cardCatalog.cacheLiveResults(liveCards);
        matches = window.cardCatalog.rankCards(liveCards, query);
      } catch (err) {
        console.warn('PokeWallet live search fallback failed:', err);
      }
    }

    return matches[0] || null;
  }

  // Looks for a known Japanese species name as a substring of the given
  // text and returns the matching official English name. Covers Gen 1-7 -
  // a species not in the table (e.g. very recent Gen 8/9 prints) falls
  // back to using the raw text as-is.
  translateJapaneseName(text) {
    if (!window.POKEMON_JP_NAMES) return null;

    let bestMatch = null;
    for (const jpName in window.POKEMON_JP_NAMES) {
      if (text.includes(jpName) && (!bestMatch || jpName.length > bestMatch.length)) {
        bestMatch = jpName;
      }
    }
    return bestMatch ? window.POKEMON_JP_NAMES[bestMatch] : null;
  }

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
    const cost = parseFloat(document.getElementById('scan-cert-cost')?.value) || 0;
    const market = parseFloat(document.getElementById('scan-cert-market')?.value) || 0;

    const hasJapanese = /[぀-ヿ一-鿿]/.test(s.name);
    const translatedTo = hasJapanese ? this.translateJapaneseName(s.name) : null;
    const finalName = translatedTo || s.name;

    this.scanList.push({
      tempId: 'scan-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      name: finalName,
      set: s.set || '',
      type: 'slab',
      gradingCompany: company,
      grade: gradeVal === '10' ? '10 GEM MT' : gradeVal,
      certNumber: s.certNumber || '',
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
