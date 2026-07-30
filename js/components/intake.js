/* ==========================================================================
   PokAddicts - Rapid Intake & Bulk Lot Splitter View Component
   ========================================================================== */

class IntakeComponent {
  constructor() {
    this.intakeMode = null; // 'single' | 'multiple'
    this.intakeType = null; // 'raw' | 'slab' | 'sealed'
    this.rawMultipleMode = null; // 'normal' | 'binder' (only used for multiple+raw)
    this.multiItemsSavedCount = 0;
    this.lastIntakeSetName = '';
    this.intakeSource = 'normal'; // 'normal' | 'buyback' - buyback means cash paid to reacquire a card from a customer at a tradeshow
    this.intakeBuybackEventTag = '';
    this.selectedSealedProductType = null;
    this.pendingSealedCost = '';
    this.pendingSealedMarket = '';
    this.pendingSealedSelling = '';
    this.pendingSealedQty = '';
    this.selectedCatalogCardId = null;
    this.selectedTierBinderName = '';
    this.selectedTierId = '';
  }

  renderIntakePage() {
    const container = document.getElementById('intake-page');
    if (!container) return;

    if (!this.intakeMode) {
      container.innerHTML = this.renderModeSelector();
      return;
    }

    if (!this.intakeType) {
      container.innerHTML = this.renderTypeSelector();
      return;
    }

    // Multiple raw singles has an extra fork: loose singles (repeat the
    // standard form) or into a binder's price-tier pool. Sealed always
    // gets the set + product-type picker, regardless of single/multiple.
    // Everything else (single raw/slab, multiple slab) uses the standard
    // named-item form.
    if (this.intakeMode === 'multiple' && this.intakeType === 'raw') {
      if (!this.rawMultipleMode) {
        container.innerHTML = this.renderRawMultipleModeSelector();
        return;
      }
      if (this.rawMultipleMode === 'binder') {
        container.innerHTML = this.renderBinderTierIntake();
        return;
      }
      container.innerHTML = this.renderStandardItemForm();
      this.attachCardSearch();
    } else if (this.intakeType === 'sealed') {
      container.innerHTML = this.renderSealedItemForm();
    } else {
      container.innerHTML = this.renderStandardItemForm();
      this.attachCardSearch();
    }
  }

  attachCardSearch() {
    window.cardSearchUI.attach(
      { inputId: 'intake-name', dropdownId: 'intake-name-dropdown', previewId: 'intake-name-preview' },
      (card) => {
        document.getElementById('intake-name').value = card.name;
        const setInput = document.getElementById('intake-set');
        if (setInput && card.set) setInput.value = card.set;
        const marketInput = document.getElementById('intake-market');
        if (marketInput && card.marketValue > 0) marketInput.value = card.marketValue.toFixed(2);
        // Selling price follows this fresh pick too, unless the user had
        // already deliberately typed their own number in this session.
        const sellingInput = document.getElementById('intake-selling-price');
        if (sellingInput && card.marketValue > 0 && !sellingInput.dataset.userEdited) {
          sellingInput.value = card.marketValue.toFixed(2);
        }
        this.selectedCatalogCardId = card.catalogCardId;
      }
    );
  }

  // Normal Intake vs Buyback toggle, shared by the standard and sealed
  // forms. Toggling swaps visibility via direct DOM updates rather than a
  // full renderIntakePage() re-render, so it doesn't wipe out whatever the
  // user has already typed into the rest of the form.
  renderIntakeSourceToggle() {
    return `
      <div class="form-group">
        <label class="form-label">Intake Type</label>
        <div class="preset-grid" style="grid-template-columns: 1fr 1fr;">
          <div class="preset-card ${this.intakeSource === 'normal' ? 'selected' : ''}" id="intake-source-normal" style="padding: 10px; text-align: center;" onclick="window.intakeComp.setIntakeSource('normal')">
            <div class="preset-title" style="font-size: 0.82rem;">📥 Normal Intake</div>
          </div>
          <div class="preset-card ${this.intakeSource === 'buyback' ? 'selected' : ''}" id="intake-source-buyback" style="padding: 10px; text-align: center;" onclick="window.intakeComp.setIntakeSource('buyback')">
            <div class="preset-title" style="font-size: 0.82rem;">🔄 Buyback</div>
          </div>
        </div>
      </div>
      <div id="intake-buyback-event-section" class="form-group" style="display: ${this.intakeSource === 'buyback' ? 'block' : 'none'};">
        <label class="form-label">Tradeshow / Event</label>
        <div style="display: flex; gap: 8px;">
          <select id="intake-buyback-event" class="form-control">
            ${window.db.getEventTags().map(tag => `<option value="${tag}" ${tag === (this.intakeBuybackEventTag || window.db.settings.currentEventTag || 'Normal Sale') ? 'selected' : ''}>${tag}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-cyan btn-sm" onclick="window.intakeComp.openCreateEventModalForBuyback()">+ New</button>
        </div>
        <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">Which show you bought this back at - lets you see buyback spend per tradeshow in Analytics.</div>
      </div>
    `;
  }

  setIntakeSource(source) {
    this.intakeSource = source;

    document.getElementById('intake-source-normal')?.classList.toggle('selected', source === 'normal');
    document.getElementById('intake-source-buyback')?.classList.toggle('selected', source === 'buyback');

    const eventSection = document.getElementById('intake-buyback-event-section');
    if (eventSection) eventSection.style.display = source === 'buyback' ? 'block' : 'none';
  }

  openCreateEventModalForBuyback() {
    window.app.openCreateEventModal((evt) => {
      const select = document.getElementById('intake-buyback-event');
      if (select) {
        select.innerHTML = window.db.getEventTags().map(tag => `<option value="${tag}">${tag}</option>`).join('');
        select.value = evt.name;
      }
      this.intakeBuybackEventTag = evt.name;
    });
  }

  // --- Step 1: how many items ---

  renderModeSelector() {
    return `
      <div class="panel-header" style="margin-bottom: 12px;">
        <h2 style="font-size: 1.2rem; font-weight: 800;">➕ Card Intake</h2>
      </div>
      <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 16px;">
        Are you adding one item, or several at once?
      </p>
      <div class="preset-grid">
        <div class="preset-card" style="text-align: center; padding: 22px 12px;" onclick="window.intakeComp.setIntakeMode('single')">
          <div style="font-size: 1.8rem; margin-bottom: 6px;">🔍</div>
          <div class="preset-title">Single Item</div>
          <div class="preset-sub">One specific card or product</div>
        </div>
        <div class="preset-card" style="text-align: center; padding: 22px 12px;" onclick="window.intakeComp.setIntakeMode('multiple')">
          <div style="font-size: 1.8rem; margin-bottom: 6px;">📚</div>
          <div class="preset-title">Multiple Items</div>
          <div class="preset-sub">A lot, binder, or several at once</div>
        </div>
      </div>
    `;
  }

  // --- Step 2: what type of product ---

  renderTypeSelector() {
    return `
      <div class="panel-header" style="margin-bottom: 4px;">
        <h2 style="font-size: 1.2rem; font-weight: 800;">➕ ${this.intakeMode === 'single' ? 'Single Item' : 'Multiple Items'} Intake</h2>
        <span style="color: var(--accent-cyan); cursor: pointer; font-size: 0.8rem; font-weight: 700;" onclick="window.intakeComp.goBack()">← Back</span>
      </div>
      <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 16px;">
        What type of product?
      </p>
      <div class="preset-grid" style="grid-template-columns: 1fr;">
        <div class="preset-card" onclick="window.intakeComp.setIntakeType('raw')">
          <div class="preset-title">✨ Raw Singles</div>
          <div class="preset-sub">${this.intakeMode === 'multiple' ? 'Loose singles, or into a binder price-tier pool' : 'Ungraded individual card'}</div>
        </div>
        <div class="preset-card" onclick="window.intakeComp.setIntakeType('slab')">
          <div class="preset-title">🏆 Graded Slab</div>
          <div class="preset-sub">PSA / CGC / BGS certified card</div>
        </div>
        <div class="preset-card" onclick="window.intakeComp.setIntakeType('sealed')">
          <div class="preset-title">📦 Sealed Product</div>
          <div class="preset-sub">Booster box, ETB, sealed pack, etc.</div>
        </div>
      </div>
    `;
  }

  // --- Step 2.5 (multiple + raw only): loose singles, or into a binder ---

  renderRawMultipleModeSelector() {
    return `
      <div class="panel-header" style="margin-bottom: 4px;">
        <h2 style="font-size: 1.2rem; font-weight: 800;">➕ Multiple Raw Singles Intake</h2>
        <span style="color: var(--accent-cyan); cursor: pointer; font-size: 0.8rem; font-weight: 700;" onclick="window.intakeComp.goBack()">← Back</span>
      </div>
      <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 16px;">
        Are these loose singles, or going into a binder?
      </p>
      <div class="preset-grid" style="grid-template-columns: 1fr;">
        <div class="preset-card" onclick="window.intakeComp.setRawMultipleMode('normal')">
          <div class="preset-title">✨ Normal Raw Singles</div>
          <div class="preset-sub">Add several individual cards one after another, each with its own details</div>
        </div>
        <div class="preset-card" onclick="window.intakeComp.setRawMultipleMode('binder')">
          <div class="preset-title">🗂️ Into a Binder</div>
          <div class="preset-sub">Add to (or create) a price-tier pool inside one of your binders</div>
        </div>
      </div>
    `;
  }

  setRawMultipleMode(mode) {
    this.rawMultipleMode = mode;
    this.multiItemsSavedCount = 0;
    this.selectedTierBinderName = '';
    this.selectedTierId = '';
    this.renderIntakePage();
  }

  renderRawMultipleModeBreadcrumb() {
    const label = this.rawMultipleMode === 'binder' ? '🗂️ Into a Binder' : '✨ Normal Raw Singles';
    return `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 0.78rem; color: var(--text-secondary);">
        <span>${label}</span>
        <span style="color: var(--accent-cyan); cursor: pointer; font-weight: 700;" onclick="window.intakeComp.goBack()">← Back</span>
      </div>
    `;
  }

  // showBack: suppressed when a more specific breadcrumb (e.g. the raw
  // normal/binder fork) is also on screen and already owns the one "←
  // Back" link - showing two stacked back links that do the same thing
  // was confusing.
  renderSelectionBreadcrumb(showBack = true) {
    const modeLabel = this.intakeMode === 'single' ? 'Single Item' : 'Multiple Items';
    const typeLabel = { raw: '✨ Raw Singles', slab: '🏆 Graded Slab', sealed: '📦 Sealed Product' }[this.intakeType] || '';
    return `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; font-size: 0.8rem; color: var(--text-secondary);">
        <span>${modeLabel} • ${typeLabel}</span>
        ${showBack ? `<span style="color: var(--accent-cyan); cursor: pointer; font-weight: 700;" onclick="window.intakeComp.goBack()">← Back</span>` : ''}
      </div>
    `;
  }

  renderSessionCounterBanner() {
    if (this.intakeMode !== 'multiple' || this.multiItemsSavedCount === 0) return '';
    return `
      <div style="background: rgba(0,230,118,0.1); border: 1px solid rgba(0,230,118,0.3); border-radius: 12px; padding: 10px 14px; margin-bottom: 12px; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center;">
        <span>✅ ${this.multiItemsSavedCount} item${this.multiItemsSavedCount === 1 ? '' : 's'} added this session</span>
        <button class="btn btn-green btn-sm" onclick="window.app.switchTab('inventory')">Done</button>
      </div>
    `;
  }

  setIntakeMode(mode) {
    this.intakeMode = mode;
    this.intakeType = null;
    this.rawMultipleMode = null;
    this.multiItemsSavedCount = 0;
    this.lastIntakeSetName = '';
    this.selectedSealedProductType = null;
    this.pendingSealedCost = '';
    this.pendingSealedMarket = '';
    this.pendingSealedSelling = '';
    this.pendingSealedQty = '';
    this.intakeSource = 'normal';
    this.intakeBuybackEventTag = '';
    this.selectedCatalogCardId = null;
    this.selectedTierBinderName = '';
    this.selectedTierId = '';
    this.renderIntakePage();
  }

  setIntakeType(type) {
    this.intakeType = type;
    this.rawMultipleMode = null;
    this.selectedSealedProductType = null;
    this.selectedCatalogCardId = null;
    this.selectedTierBinderName = '';
    this.selectedTierId = '';
    this.renderIntakePage();
  }

  resetIntakeSelection() {
    this.intakeMode = null;
    this.intakeType = null;
    this.rawMultipleMode = null;
    this.multiItemsSavedCount = 0;
    this.lastIntakeSetName = '';
    this.selectedSealedProductType = null;
    this.pendingSealedCost = '';
    this.pendingSealedMarket = '';
    this.pendingSealedSelling = '';
    this.pendingSealedQty = '';
    this.intakeSource = 'normal';
    this.intakeBuybackEventTag = '';
    this.selectedCatalogCardId = null;
    this.selectedTierBinderName = '';
    this.selectedTierId = '';
    this.renderIntakePage();
  }

  // Single-step back, contextual to whichever screen you're on - unlike
  // resetIntakeSelection() (a full jump to step 1), this only undoes the
  // most recent choice.
  goBack() {
    if (this.intakeType) {
      const onRawMultipleSubForm = this.intakeMode === 'multiple' && this.intakeType === 'raw' && this.rawMultipleMode;
      if (onRawMultipleSubForm) {
        // On the normal-singles or binder-tier form -> back to that fork.
        this.rawMultipleMode = null;
        this.multiItemsSavedCount = 0;
        this.selectedTierBinderName = '';
        this.selectedTierId = '';
        this.renderIntakePage();
        return;
      }
      // On any other entry form (single item, multiple slab, sealed, or
      // the raw normal/binder fork itself) -> back to the type selector.
      this.intakeType = null;
      this.rawMultipleMode = null;
      this.multiItemsSavedCount = 0;
      this.selectedSealedProductType = null;
      this.selectedCatalogCardId = null;
      this.selectedTierBinderName = '';
      this.selectedTierId = '';
      this.renderIntakePage();
      return;
    }
    // On the type selector -> back to the mode selector.
    this.intakeMode = null;
    this.renderIntakePage();
  }

  // --- Standard named-item form: single raw/slab, multiple slab, or
  // multiple raw when NOT going into a binder ---

  renderStandardItemForm() {
    const typeLabels = { raw: 'Raw Single', slab: 'Graded Slab' };
    const isMultiple = this.intakeMode === 'multiple';
    const isSlab = this.intakeType === 'slab';
    const isRawMultiple = this.intakeType === 'raw' && isMultiple;

    return `
      <div class="panel-header" style="margin-bottom: 4px;">
        <h2 style="font-size: 1.2rem; font-weight: 800;">➕ ${isMultiple ? 'Multiple' : 'Single'} ${typeLabels[this.intakeType]} Intake</h2>
      </div>
      ${this.renderSelectionBreadcrumb(!isRawMultiple)}
      ${isRawMultiple ? this.renderRawMultipleModeBreadcrumb() : ''}
      ${this.renderSessionCounterBanner()}

      <div class="card-panel">
        <form id="single-intake-form" onsubmit="window.intakeComp.handleStandardItemSubmit(event)">
          ${this.renderIntakeSourceToggle()}

          ${window.cardCatalog.renderStatusLineHTML()}
          <div class="form-group card-search-wrap">
            <label class="form-label">Card Name</label>
            <input type="text" id="intake-name" class="form-control" placeholder="Start typing to search the catalog..." required autocomplete="off">
            <div id="intake-name-dropdown" class="card-search-dropdown"></div>
          </div>
          <div id="intake-name-preview" class="card-search-preview"></div>

          <div class="form-group">
            <label class="form-label">Set Name</label>
            <input type="text" id="intake-set" class="form-control" placeholder="e.g. 151" list="pokemon-sets-datalist" value="${this.lastIntakeSetName || ''}">
            <datalist id="pokemon-sets-datalist">
              ${window.POKEMON_DB.sets.map(s => `<option value="${s}"></option>`).join('')}
            </datalist>
          </div>

          ${this.intakeType === 'raw' ? `
          <div class="form-group">
            <label class="form-label">Binder (Optional)</label>
            <div style="display: flex; gap: 8px;">
              <select id="intake-binder-select" class="form-control">
                <option value="">No Binder (loose single)</option>
                ${window.db.binders.map(b => `<option value="${b.name}">${b.name}</option>`).join('')}
              </select>
              <button type="button" class="btn btn-cyan btn-sm" onclick="window.intakeComp.openCreateBinderModalForStandardForm()">+ New</button>
            </div>
          </div>
          ` : ''}

          ${isSlab ? `
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div class="form-group">
              <label class="form-label">Grading Company</label>
              <select id="intake-grading-company" class="form-control">
                ${window.POKEMON_DB.gradingCompanies.map(c => `<option value="${c}">${c}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Grade</label>
              <select id="intake-slab-grade" class="form-control">
                ${window.POKEMON_DB.slabGrades.map(g => `<option value="${g}">${g}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Cert # (Optional)</label>
            <input type="text" id="intake-cert" class="form-control" placeholder="Cert / Serial #">
          </div>
          ` : `
          <div class="form-group">
            <label class="form-label">Condition</label>
            <select id="intake-condition" class="form-control">
              ${window.POKEMON_DB.rawConditions.map(c => `<option value="${c}">${c}</option>`).join('')}
            </select>
          </div>
          `}

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div class="form-group">
              <label class="form-label">Purchase Cost ($)</label>
              <input type="number" id="intake-cost" class="form-control" placeholder="0.00" step="0.01" required>
            </div>
            <div class="form-group">
              <label class="form-label">Market Value ($)</label>
              <input type="number" id="intake-market" class="form-control" placeholder="0.00" step="0.01" oninput="window.intakeComp.syncSellingPriceDefault('intake-market', 'intake-selling-price')">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Your Selling Price ($)</label>
            <input type="number" id="intake-selling-price" class="form-control" placeholder="0.00" step="0.01" oninput="this.dataset.userEdited = '1'">
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">This is what POS will use when you sell it - defaults to Market Value, but override it for vintage cards where the live estimate may be off.</div>
          </div>

          <button type="submit" class="btn btn-primary" style="margin-top: 8px;">
            ${isMultiple ? '+ Save & Add Next Item' : `+ Save ${typeLabels[this.intakeType]} to Inventory`}
          </button>
        </form>
      </div>
    `;
  }

  // Keeps "Your Selling Price" following Market Value until the user has
  // actually typed their own number into the selling-price field - once
  // they touch it, their value is left alone even if market value changes
  // again (e.g. a card-search re-selection).
  syncSellingPriceDefault(marketInputId, sellingInputId) {
    const sellingInput = document.getElementById(sellingInputId);
    if (sellingInput && !sellingInput.dataset.userEdited) {
      const marketInput = document.getElementById(marketInputId);
      sellingInput.value = marketInput ? marketInput.value : '';
    }
  }

  handleStandardItemSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('intake-name').value;
    const set = document.getElementById('intake-set').value;
    const type = this.intakeType || 'raw';
    const cost = parseFloat(document.getElementById('intake-cost').value) || 0;
    const market = parseFloat(document.getElementById('intake-market').value) || cost;
    const sellingPrice = parseFloat(document.getElementById('intake-selling-price').value) || market;
    const binderSelect = document.getElementById('intake-binder-select');
    const binderName = binderSelect ? binderSelect.value : '';
    const buybackEventSelect = document.getElementById('intake-buyback-event');
    if (this.intakeSource === 'buyback' && buybackEventSelect) this.intakeBuybackEventTag = buybackEventSelect.value;

    let gradingCompany, grade, condition, cert;
    if (type === 'slab') {
      gradingCompany = document.getElementById('intake-grading-company').value;
      grade = document.getElementById('intake-slab-grade').value;
      condition = '';
      cert = document.getElementById('intake-cert').value;
    } else {
      condition = document.getElementById('intake-condition').value;
      gradingCompany = 'Raw';
      grade = condition;
      cert = '';
    }

    const newItem = window.db.addItem({
      name, set, type, grade, gradingCompany, condition, certNumber: cert, costBasis: cost, marketValue: market, askingPrice: sellingPrice, binderName,
      catalogCardId: this.selectedCatalogCardId || '',
      intakeSource: this.intakeSource,
      eventTag: this.intakeBuybackEventTag
    });

    window.syncManager.broadcast('ITEM_ADDED', newItem);
    window.app.showToast(this.intakeSource === 'buyback'
      ? `Bought back ${name} ($${cost.toFixed(2)}) @ ${newItem.eventTag}`
      : `Added ${name} ($${cost.toFixed(2)})`);
    window.app.renderAllPages();
    this.lastIntakeSetName = set;
    this.selectedCatalogCardId = null;

    if (this.intakeMode === 'multiple') {
      this.multiItemsSavedCount += 1;
      this.renderIntakePage();
    } else {
      window.app.switchTab('inventory');
    }
  }

  openCreateBinderModalForStandardForm() {
    window.app.openCreateBinderModal((binder) => {
      this.renderIntakePage();
      const select = document.getElementById('intake-binder-select');
      if (select) select.value = binder.name;
    });
  }

  // --- Sealed Product form: set name + tap-to-pick product type (no card
  // name / grading company / cert - sealed product doesn't need them) ---

  renderSealedItemForm() {
    const isMultiple = this.intakeMode === 'multiple';
    const selectedType = this.selectedSealedProductType;

    return `
      <div class="panel-header" style="margin-bottom: 4px;">
        <h2 style="font-size: 1.2rem; font-weight: 800;">➕ ${isMultiple ? 'Multiple' : 'Single'} Sealed Product Intake</h2>
      </div>
      ${this.renderSelectionBreadcrumb()}
      ${this.renderSessionCounterBanner()}

      <div class="card-panel">
        ${this.renderIntakeSourceToggle()}

        <div class="form-group">
          <label class="form-label">Set Name</label>
          <input type="text" id="sealed-set-input" class="form-control" placeholder="e.g. Ascended Heroes" list="pokemon-sets-datalist" value="${this.lastIntakeSetName || ''}">
          <datalist id="pokemon-sets-datalist">
            ${window.POKEMON_DB.sets.map(s => `<option value="${s}"></option>`).join('')}
          </datalist>
        </div>

        <div class="form-group">
          <label class="form-label">Product Type</label>
          <div class="preset-grid" style="grid-template-columns: 1fr 1fr;">
            ${window.POKEMON_DB.sealedProductTypes.map(pt => `
              <div class="preset-card ${selectedType === pt ? 'selected' : ''}" style="padding: 12px; text-align: center;" onclick="window.intakeComp.selectSealedProductType('${pt.replace(/'/g, "\\'")}')">
                <div class="preset-title" style="font-size: 0.82rem;">${pt}</div>
              </div>
            `).join('')}
          </div>
        </div>

        <form onsubmit="window.intakeComp.handleSealedItemSubmit(event)">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div class="form-group">
              <label class="form-label">Purchase Cost ($/ea)</label>
              <input type="number" id="sealed-cost-input" class="form-control" placeholder="0.00" step="0.01" value="${this.pendingSealedCost || ''}" required>
            </div>
            <div class="form-group">
              <label class="form-label">Market Value ($/ea)</label>
              <input type="number" id="sealed-market-input" class="form-control" placeholder="0.00" step="0.01" value="${this.pendingSealedMarket || ''}">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Your Selling Price ($/ea)</label>
            <input type="number" id="sealed-selling-input" class="form-control" placeholder="0.00" step="0.01" value="${this.pendingSealedSelling || ''}">
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">This is what POS will use when you sell it - defaults to Market Value if left blank.</div>
          </div>

          <div class="form-group">
            <label class="form-label">Quantity</label>
            <input type="number" id="sealed-qty-input" class="form-control" placeholder="1" step="1" min="1" value="${this.pendingSealedQty || '1'}">
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">How many identical units (e.g. 150 packs) - costs/prices above are per unit. You'll be able to sell them off individually or in batches later.</div>
          </div>

          <button type="submit" class="btn btn-primary" style="margin-top: 8px;" ${selectedType ? '' : 'disabled'}>
            ${isMultiple ? '+ Save & Add Next Product' : '+ Save Sealed Product to Inventory'}
          </button>
          ${!selectedType ? `<div style="font-size: 0.75rem; color: var(--accent-red); margin-top: 6px; text-align: center;">Select a product type above first.</div>` : ''}
        </form>
      </div>
    `;
  }

  selectSealedProductType(productType) {
    const setVal = document.getElementById('sealed-set-input')?.value;
    const costVal = document.getElementById('sealed-cost-input')?.value;
    const marketVal = document.getElementById('sealed-market-input')?.value;
    const sellingVal = document.getElementById('sealed-selling-input')?.value;
    const qtyVal = document.getElementById('sealed-qty-input')?.value;
    const buybackEventVal = document.getElementById('intake-buyback-event')?.value;
    if (setVal !== undefined) this.lastIntakeSetName = setVal;
    if (costVal) this.pendingSealedCost = costVal;
    if (marketVal) this.pendingSealedMarket = marketVal;
    if (sellingVal) this.pendingSealedSelling = sellingVal;
    if (qtyVal) this.pendingSealedQty = qtyVal;
    if (this.intakeSource === 'buyback' && buybackEventVal) this.intakeBuybackEventTag = buybackEventVal;

    this.selectedSealedProductType = productType;
    this.renderIntakePage();
  }

  handleSealedItemSubmit(e) {
    e.preventDefault();
    if (!this.selectedSealedProductType) return;

    const setName = document.getElementById('sealed-set-input').value.trim();
    const cost = parseFloat(document.getElementById('sealed-cost-input').value) || 0;
    const market = parseFloat(document.getElementById('sealed-market-input').value) || cost;
    const sellingPrice = parseFloat(document.getElementById('sealed-selling-input').value) || market;
    const qty = parseInt(document.getElementById('sealed-qty-input').value, 10) || 1;
    const buybackEventSelect = document.getElementById('intake-buyback-event');
    if (this.intakeSource === 'buyback' && buybackEventSelect) this.intakeBuybackEventTag = buybackEventSelect.value;
    const productType = this.selectedSealedProductType;
    const name = setName ? `${setName} - ${productType}` : productType;

    const newItem = window.db.addItem({
      name,
      set: setName || 'Sealed Product',
      type: 'sealed',
      gradingCompany: 'Sealed',
      grade: 'Sealed Product',
      costBasis: cost,
      marketValue: market,
      askingPrice: sellingPrice,
      quantity: qty,
      intakeSource: this.intakeSource,
      eventTag: this.intakeBuybackEventTag
    });

    window.syncManager.broadcast('ITEM_ADDED', newItem);
    window.app.showToast(this.intakeSource === 'buyback'
      ? `Bought back ${qty > 1 ? `${qty}x ` : ''}${name} ($${cost.toFixed(2)}${qty > 1 ? '/ea' : ''}) @ ${newItem.eventTag}`
      : `Added ${qty > 1 ? `${qty}x ` : ''}${name} ($${cost.toFixed(2)}${qty > 1 ? '/ea' : ''})`);
    window.app.renderAllPages();

    this.lastIntakeSetName = setName;
    this.pendingSealedCost = '';
    this.pendingSealedMarket = '';
    this.pendingSealedSelling = '';
    this.pendingSealedQty = '';

    if (this.intakeMode === 'multiple') {
      this.multiItemsSavedCount += 1;
      this.selectedSealedProductType = null;
      this.renderIntakePage();
    } else {
      window.app.switchTab('inventory');
    }
  }

  // --- Multiple Raw Singles into a Binder: pick a binder, pick an
  // existing price tier (or create a new one), enter quantity to add ---

  getTiersForBinder(binderName) {
    if (!binderName) return [];
    return window.db.inventory.filter(i => i.type === 'binder_tier' && i.binderName === binderName && i.status === 'in_stock');
  }

  renderBinderTierIntake() {
    const binders = window.db.binders;
    if (!this.selectedTierBinderName && binders.length > 0) this.selectedTierBinderName = binders[0].name;
    const existingTiers = this.getTiersForBinder(this.selectedTierBinderName);
    const isCreatingNewTier = !this.selectedTierId;

    return `
      <div class="panel-header" style="margin-bottom: 4px;">
        <h2 style="font-size: 1.2rem; font-weight: 800;">🗂️ Binder Tier Intake</h2>
      </div>
      ${this.renderSelectionBreadcrumb(false)}
      ${this.renderRawMultipleModeBreadcrumb()}
      ${this.renderSessionCounterBanner()}

      <div class="card-panel glow-gold">
        <p style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 12px;">
          Add straight into an existing price tier (just a quantity), or create a new one - e.g. "$1-$5" x 80 cards.
        </p>

        ${this.renderIntakeSourceToggle()}

        <div class="form-group">
          <label class="form-label">Binder</label>
          <div style="display: flex; gap: 8px;">
            <select id="binder-select-input" class="form-control" onchange="window.intakeComp.handleBinderSelectChange(this.value)">
              ${binders.length === 0
                ? `<option value="">No binders yet - create one</option>`
                : binders.map(b => `<option value="${b.name}" ${b.name === this.selectedTierBinderName ? 'selected' : ''}>${b.name}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-cyan btn-sm" onclick="window.intakeComp.openCreateBinderModal()">+ New</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Price Tier</label>
          <select id="tier-select-input" class="form-control" onchange="window.intakeComp.handleTierSelectChange(this.value)">
            <option value="">+ Create New Tier</option>
            ${existingTiers.map(t => `<option value="${t.id}" ${t.id === this.selectedTierId ? 'selected' : ''}>${t.name} (${t.quantity} left @ $${t.costBasis.toFixed(2)}/ea)</option>`).join('')}
          </select>
        </div>

        ${isCreatingNewTier ? `
        <div class="form-group">
          <label class="form-label">New Tier Label</label>
          <input type="text" id="new-tier-label-input" class="form-control" placeholder="e.g. $1-$5">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label class="form-label">Cost/card ($)</label>
            <input type="number" id="new-tier-cost-input" class="form-control" placeholder="0.00" step="0.01">
          </div>
          <div class="form-group">
            <label class="form-label">Resale/card ($)</label>
            <input type="number" id="new-tier-resale-input" class="form-control" placeholder="0.00" step="0.01">
          </div>
        </div>
        ` : `
        <div class="form-group">
          <label class="form-label">Cost/card for this batch ($)</label>
          <input type="number" id="existing-tier-cost-input" class="form-control" placeholder="Leave blank to keep current cost" step="0.01">
          <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">Bought this batch at a different price (e.g. a buyback)? Enter it here - it'll be weighted-averaged into the tier's existing cost.</div>
        </div>
        `}

        <div class="form-group">
          <label class="form-label">Quantity to Add</label>
          <input type="number" id="tier-qty-input" class="form-control" placeholder="e.g. 20" step="1" min="1">
        </div>

        <button class="btn btn-green" onclick="window.intakeComp.commitBinderTierEntry()">
          🚀 Add to Binder
        </button>
      </div>
    `;
  }

  handleBinderSelectChange(binderName) {
    this.selectedTierBinderName = binderName;
    this.selectedTierId = '';
    this.renderIntakePage();
  }

  handleTierSelectChange(tierId) {
    this.selectedTierId = tierId;
    this.renderIntakePage();
  }

  openCreateBinderModal() {
    window.app.openCreateBinderModal((binder) => {
      this.selectedTierBinderName = binder.name;
      this.selectedTierId = '';
      this.renderIntakePage();
    });
  }

  commitBinderTierEntry() {
    const binderName = document.getElementById('binder-select-input')?.value;
    const tierId = document.getElementById('tier-select-input')?.value;
    const qty = parseInt(document.getElementById('tier-qty-input')?.value, 10) || 0;
    const buybackEventSelect = document.getElementById('intake-buyback-event');
    if (this.intakeSource === 'buyback' && buybackEventSelect) this.intakeBuybackEventTag = buybackEventSelect.value;

    if (!binderName) { alert('Create or select a binder first.'); return; }
    if (qty <= 0) { alert('Enter a quantity to add.'); return; }

    if (tierId) {
      const existing = window.db.getItemById(tierId);
      if (!existing) { alert('That tier could not be found - please pick again.'); return; }

      const batchCostVal = document.getElementById('existing-tier-cost-input')?.value;
      const batchCost = batchCostVal === '' || batchCostVal === undefined ? undefined : parseFloat(batchCostVal);

      const updated = window.db.restockItem(tierId, qty, batchCost, {
        intakeSource: this.intakeSource,
        eventTag: this.intakeBuybackEventTag
      });

      window.app.showToast(this.intakeSource === 'buyback'
        ? `Bought back ${qty} into "${existing.name}" in ${binderName} @ ${updated.eventTag}`
        : `Added ${qty} more to "${existing.name}" in ${binderName}`);
    } else {
      const label = document.getElementById('new-tier-label-input')?.value.trim();
      const cost = parseFloat(document.getElementById('new-tier-cost-input')?.value) || 0;
      const resale = parseFloat(document.getElementById('new-tier-resale-input')?.value) || cost;

      if (!label) { alert('Enter a label for the new tier (e.g. "$1-$5").'); return; }

      const newTier = window.db.addItem({
        name: label,
        set: 'Binder Singles',
        type: 'binder_tier',
        binderName,
        quantity: qty,
        costBasis: cost,
        marketValue: resale,
        notes: `Binder tier intake: ${binderName}`,
        intakeSource: this.intakeSource,
        eventTag: this.intakeBuybackEventTag
      });
      this.selectedTierId = newTier.id;
      window.app.showToast(this.intakeSource === 'buyback'
        ? `Bought back new tier "${label}" (x${qty}) into ${binderName} @ ${newTier.eventTag}`
        : `Added new tier "${label}" (x${qty}) to ${binderName}`);
    }

    window.app.renderAllPages();
    this.multiItemsSavedCount += 1;
    this.renderIntakePage();
  }
}

window.intakeComp = new IntakeComponent();
