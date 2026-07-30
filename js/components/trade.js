/* ==========================================================================
   PokAddicts - Tradeshow Trade-In Studio Component
   ========================================================================== */

class TradeComponent {
  constructor() {
    this.givenItems = []; // [{ itemId, quantity }] - quantity matters for binder tiers
    this.acquiredItems = [];
    this.cashDifference = 0; // derived: weTopUp - customerTopUp. + means dealer paid cash out, - means dealer received cash
    this.weTopUp = 0;
    this.customerTopUp = 0;

    // "Add Card Received" modal wizard state
    this.acquiredItemType = null; // 'raw' | 'slab' | 'sealed'
    this.selectedAcquiredSealedType = null;
    this.pendingAcquiredSetName = '';
    this.selectedCatalogCardId = null;

    // Trade-quantity modal state (partial give from a binder tier)
    this.pendingTradeQtyItemId = null;
  }

  renderTradePage() {
    const container = document.getElementById('trade-page');
    if (!container) return;

    // Calculate given items metrics
    let givenTotalCost = 0;
    let givenTotalMkt = 0;
    const givenItemsList = this.givenItems.map(g => {
      const item = window.db.getItemById(g.itemId);
      if (!item) return null;
      return { ...item, tradeQuantity: g.quantity || 1 };
    }).filter(Boolean);

    givenItemsList.forEach(i => {
      givenTotalCost += i.costBasis * i.tradeQuantity;
      givenTotalMkt += i.marketValue * i.tradeQuantity;
    });

    // Acquired items metrics
    const acquiredTotalMkt = this.acquiredItems.reduce((acc, i) => acc + (parseFloat(i.marketValue) || 0), 0);

    // Effective Acquired Cost = Given Cost + Cash Paid Out
    const effectiveTotalCost = givenTotalCost + this.cashDifference;

    container.innerHTML = `
      <div class="panel-header" style="margin-bottom: 12px;">
        <h2 style="font-size: 1.2rem; font-weight: 800;">🔄 Trade</h2>
        <span class="badge badge-raw">Cost Basis Allocator</span>
      </div>

      <p style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 14px;">
        Build card-for-card trades. The app transfers your cost basis to newly acquired cards automatically!
      </p>

      <div class="trade-split">
        <!-- Dealer Giving Column -->
        <div class="trade-column">
          <div class="trade-col-title">📤 YOU GIVE (OUT)</div>
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 8px;">
            Cost Basis: <strong style="color: var(--accent-gold);">$${givenTotalCost.toFixed(2)}</strong>
            &nbsp;•&nbsp;
            Mkt Est: <strong style="color: var(--accent-cyan);">$${givenTotalMkt.toFixed(2)}</strong>
          </div>

          ${givenItemsList.length === 0 ? `
            <div style="font-size: 0.75rem; color: var(--text-muted); padding: 10px; text-align: center;">No items selected. Tap 'Trade' on any inventory item.</div>
          ` : givenItemsList.map(item => `
            <div class="trade-item-pill">
              <span>
                ${item.name}${item.tradeQuantity > 1 ? ` <span style="color: var(--text-secondary);">(x${item.tradeQuantity})</span>` : ''}
                <div style="font-size: 0.7rem; color: var(--text-muted);">Cost: $${(item.costBasis * item.tradeQuantity).toFixed(2)} • Mkt: $${(item.marketValue * item.tradeQuantity).toFixed(2)}</div>
              </span>
              <span style="color: var(--accent-red); cursor: pointer;" onclick="window.tradeComp.removeFromGiven('${item.id}')">✕</span>
            </div>
          `).join('')}

          <button class="btn btn-secondary btn-sm" style="margin-top: 8px; width: 100%;" onclick="window.app.switchTab('inventory')">
            + Pick from Inventory
          </button>
        </div>

        <!-- Dealer Receiving Column -->
        <div class="trade-column">
          <div class="trade-col-title">📥 YOU GET (IN)</div>
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 8px;">
            Total Mkt Est: <strong style="color: var(--accent-cyan);">$${acquiredTotalMkt.toFixed(2)}</strong>
          </div>

          ${this.acquiredItems.length === 0 ? `
            <div style="font-size: 0.75rem; color: var(--text-muted); padding: 10px; text-align: center;">Add incoming cards below.</div>
          ` : this.acquiredItems.map((item, idx) => `
            <div class="trade-item-pill">
              <span>${item.name} ($${item.marketValue})</span>
              <span style="color: var(--accent-red); cursor: pointer;" onclick="window.tradeComp.removeAcquiredItem(${idx})">✕</span>
            </div>
          `).join('')}

          <button class="btn btn-outline-gold btn-sm" style="margin-top: 8px; width: 100%;" onclick="window.tradeComp.openAddAcquiredModal()">
            + Add Card Received
          </button>
        </div>
      </div>

      <!-- Cash Top-Up & Trade Calculations Panel -->
      <div class="card-panel glow-gold">
        <div class="panel-title" style="margin-bottom: 10px;">💵 Cash Adjustment & Settlement</div>

        <div class="form-group">
          <label class="form-label">Cash Adjustment ($)</label>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div>
              <div style="font-size: 0.72rem; color: var(--text-secondary); margin-bottom: 4px;">We Top Up</div>
              <input type="number" id="cash-we-topup-input" class="form-control" placeholder="0.00" value="${this.weTopUp || ''}" oninput="window.tradeComp.updateCashDiff()">
            </div>
            <div>
              <div style="font-size: 0.72rem; color: var(--text-secondary); margin-bottom: 4px;">Customer Tops Up</div>
              <input type="number" id="cash-customer-topup-input" class="form-control" placeholder="0.00" value="${this.customerTopUp || ''}" oninput="window.tradeComp.updateCashDiff()">
            </div>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Tradeshow / Event</label>
          <div style="display: flex; gap: 8px;">
            <select id="trade-event-tag" class="form-control">
              ${window.db.getEventTags().map(tag => `<option value="${tag}" ${tag === (window.db.settings.currentEventTag || 'Normal Sale') ? 'selected' : ''}>${tag}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-cyan btn-sm" onclick="window.tradeComp.openCreateEventModal()">+ New</button>
          </div>
        </div>

        <button class="btn btn-green" onclick="window.tradeComp.executeTradeTransaction()">
          🤝 Execute Trade
        </button>

        <div class="kpi-grid" style="margin-top: 12px;">
          <div class="kpi-card">
            <div class="kpi-label">Calculated Cost Investment</div>
            <div class="kpi-value" style="color: var(--accent-gold);">$${effectiveTotalCost.toFixed(2)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Incoming Items Count</div>
            <div class="kpi-value">${this.acquiredItems.length} Cards</div>
          </div>
        </div>
      </div>
    `;
  }

  openCreateEventModal() {
    window.app.openCreateEventModal((evt) => {
      const select = document.getElementById('trade-event-tag');
      if (select) {
        select.innerHTML = window.db.getEventTags().map(tag => `<option value="${tag}">${tag}</option>`).join('');
        select.value = evt.name;
      }
    });
  }

  // Called from the "🔄 Trade" button on an inventory item card. For any
  // item with more than 1 in stock (binder tier, or a bulk sealed lot)
  // opens a quantity picker so a trade doesn't have to take the whole pool.
  addToTrade(itemId) {
    const item = window.db.getItemById(itemId);
    if (!item) return;

    if ((item.quantity || 1) > 1) {
      this.openTradeQtyModal(item);
      return;
    }

    this.setGivenItemQuantity(itemId, 1);
    window.app.showToast('Item added to Trade Out list!');
    window.app.switchTab('trade');
  }

  setGivenItemQuantity(itemId, qty) {
    const existing = this.givenItems.find(g => g.itemId === itemId);
    if (existing) {
      existing.quantity = qty;
    } else {
      this.givenItems.push({ itemId, quantity: qty });
    }
  }

  openTradeQtyModal(item) {
    const modal = document.getElementById('trade-qty-modal');
    if (!modal) return;

    this.pendingTradeQtyItemId = item.id;

    document.getElementById('trade-qty-modal-title').innerText = `"${item.name}"`;
    document.getElementById('trade-qty-modal-sub').innerText = `${item.quantity} available`;

    const qtyInput = document.getElementById('trade-qty-input');
    qtyInput.value = 1;
    qtyInput.max = item.quantity;

    modal.classList.add('active');
  }

  handleTradeQtySubmit(e) {
    e.preventDefault();
    const itemId = this.pendingTradeQtyItemId;
    if (!itemId) return;

    const item = window.db.getItemById(itemId);
    const qtyInput = document.getElementById('trade-qty-input');
    let qty = parseInt(qtyInput.value, 10) || 1;
    qty = Math.max(1, Math.min(qty, item?.quantity || qty));

    this.setGivenItemQuantity(itemId, qty);

    document.getElementById('trade-qty-modal')?.classList.remove('active');
    window.app.showToast('Item added to Trade Out list!');
    window.app.switchTab('trade');

    this.pendingTradeQtyItemId = null;
  }

  removeFromGiven(itemId) {
    this.givenItems = this.givenItems.filter(g => g.itemId !== itemId);
    this.renderTradePage();
  }

  // --- Add Card Received modal: type selector, then matching form ---

  openAddAcquiredModal() {
    const modal = document.getElementById('acquired-item-modal');
    if (!modal) return;

    this.acquiredItemType = null;
    this.selectedAcquiredSealedType = null;
    this.pendingAcquiredSetName = '';

    this.renderAcquiredModalBody();
    modal.classList.add('active');
  }

  renderAcquiredModalBody() {
    const body = document.getElementById('acquired-item-modal-body');
    if (!body) return;

    if (!this.acquiredItemType) {
      body.innerHTML = this.renderAcquiredTypeSelector();
      return;
    }

    if (this.acquiredItemType === 'sealed') {
      body.innerHTML = this.renderAcquiredSealedForm();
    } else {
      body.innerHTML = this.renderAcquiredStandardForm();
      this.attachCardSearch();
    }
  }

  attachCardSearch() {
    this.selectedCatalogCardId = null;
    window.cardSearchUI.attach(
      { inputId: 'acquired-name', dropdownId: 'acquired-name-dropdown', previewId: 'acquired-name-preview' },
      (card) => {
        document.getElementById('acquired-name').value = card.name;
        const marketInput = document.getElementById('acquired-market');
        if (marketInput && card.marketValue > 0) marketInput.value = card.marketValue.toFixed(2);
        // Selling price follows this fresh pick too, unless the user had
        // already deliberately typed their own number in this session.
        const sellingInput = document.getElementById('acquired-selling-price');
        if (sellingInput && card.marketValue > 0 && !sellingInput.dataset.userEdited) {
          sellingInput.value = card.marketValue.toFixed(2);
        }
        this.selectedCatalogCardId = card.catalogCardId;
      }
    );
  }

  renderAcquiredTypeSelector() {
    return `
      <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 14px;">What type of item are you receiving?</p>
      <div class="preset-grid" style="grid-template-columns: 1fr;">
        <div class="preset-card" onclick="window.tradeComp.setAcquiredItemType('raw')">
          <div class="preset-title">✨ Raw Single</div>
          <div class="preset-sub">Ungraded individual card</div>
        </div>
        <div class="preset-card" onclick="window.tradeComp.setAcquiredItemType('slab')">
          <div class="preset-title">🏆 Graded Slab</div>
          <div class="preset-sub">PSA / CGC / BGS certified card</div>
        </div>
        <div class="preset-card" onclick="window.tradeComp.setAcquiredItemType('sealed')">
          <div class="preset-title">📦 Sealed Product</div>
          <div class="preset-sub">Booster box, ETB, sealed pack, etc.</div>
        </div>
      </div>
    `;
  }

  renderAcquiredBreadcrumb() {
    const labels = { raw: '✨ Raw Single', slab: '🏆 Graded Slab', sealed: '📦 Sealed Product' };
    return `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 0.8rem; color: var(--text-secondary);">
        <span>${labels[this.acquiredItemType] || ''}</span>
        <span style="color: var(--accent-cyan); cursor: pointer; font-weight: 700;" onclick="window.tradeComp.setAcquiredItemType(null)">↺ Change Type</span>
      </div>
    `;
  }

  setAcquiredItemType(type) {
    this.acquiredItemType = type;
    this.selectedAcquiredSealedType = null;
    this.renderAcquiredModalBody();
  }

  renderAcquiredStandardForm() {
    const isSlab = this.acquiredItemType === 'slab';

    return `
      ${this.renderAcquiredBreadcrumb()}
      <form onsubmit="window.tradeComp.handleAddAcquiredSubmit(event)">
        ${window.cardCatalog.renderStatusLineHTML()}
        <div class="form-group card-search-wrap">
          <label class="form-label">Card Name</label>
          <input type="text" id="acquired-name" class="form-control" placeholder="Start typing to search the catalog..." required autocomplete="off">
          <div id="acquired-name-dropdown" class="card-search-dropdown"></div>
        </div>
        <div id="acquired-name-preview" class="card-search-preview"></div>

        ${isSlab ? `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label class="form-label">Grading Company</label>
            <select id="acquired-grading-company" class="form-control">
              ${window.POKEMON_DB.gradingCompanies.map(c => `<option value="${c}">${c}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Grade</label>
            <select id="acquired-slab-grade" class="form-control">
              ${window.POKEMON_DB.slabGrades.map(g => `<option value="${g}">${g}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Cert # (Optional)</label>
          <input type="text" id="acquired-cert" class="form-control" placeholder="Cert / Serial #">
        </div>
        ` : `
        <div class="form-group">
          <label class="form-label">Condition</label>
          <select id="acquired-condition" class="form-control">
            ${window.POKEMON_DB.rawConditions.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        `}

        <div class="form-group">
          <label class="form-label">Estimated Market Value ($)</label>
          <input type="number" id="acquired-market" class="form-control" placeholder="0.00" step="0.01" required oninput="window.tradeComp.syncSellingPriceDefault('acquired-market', 'acquired-selling-price')">
        </div>

        <div class="form-group">
          <label class="form-label">Your Selling Price ($)</label>
          <input type="number" id="acquired-selling-price" class="form-control" placeholder="0.00" step="0.01" oninput="this.dataset.userEdited = '1'">
          <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">This is what POS will use when you sell it - defaults to Market Value, but override it for vintage cards where the live estimate may be off.</div>
        </div>

        <button type="submit" class="btn btn-primary">+ Add to Trade (Incoming)</button>
      </form>
    `;
  }

  // Keeps "Your Selling Price" following Market Value until the user has
  // actually typed their own number into the selling-price field.
  syncSellingPriceDefault(marketInputId, sellingInputId) {
    const sellingInput = document.getElementById(sellingInputId);
    if (sellingInput && !sellingInput.dataset.userEdited) {
      const marketInput = document.getElementById(marketInputId);
      sellingInput.value = marketInput ? marketInput.value : '';
    }
  }

  renderAcquiredSealedForm() {
    const selectedType = this.selectedAcquiredSealedType;

    return `
      ${this.renderAcquiredBreadcrumb()}
      <div class="form-group">
        <label class="form-label">Set Name</label>
        <input type="text" id="acquired-sealed-set" class="form-control" placeholder="e.g. Ascended Heroes" list="pokemon-sets-datalist-trade" value="${this.pendingAcquiredSetName || ''}">
        <datalist id="pokemon-sets-datalist-trade">
          ${window.POKEMON_DB.sets.map(s => `<option value="${s}"></option>`).join('')}
        </datalist>
      </div>

      <div class="form-group">
        <label class="form-label">Product Type</label>
        <div class="preset-grid" style="grid-template-columns: 1fr 1fr;">
          ${window.POKEMON_DB.sealedProductTypes.map(pt => `
            <div class="preset-card ${selectedType === pt ? 'selected' : ''}" style="padding: 12px; text-align: center;" onclick="window.tradeComp.selectAcquiredSealedType('${pt.replace(/'/g, "\\'")}')">
              <div class="preset-title" style="font-size: 0.82rem;">${pt}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <form onsubmit="window.tradeComp.handleAddAcquiredSubmit(event)">
        <div class="form-group">
          <label class="form-label">Estimated Market Value ($)</label>
          <input type="number" id="acquired-market" class="form-control" placeholder="0.00" step="0.01" required oninput="window.tradeComp.syncSellingPriceDefault('acquired-market', 'acquired-selling-price')">
        </div>
        <div class="form-group">
          <label class="form-label">Your Selling Price ($)</label>
          <input type="number" id="acquired-selling-price" class="form-control" placeholder="0.00" step="0.01" oninput="this.dataset.userEdited = '1'">
        </div>
        <button type="submit" class="btn btn-primary" ${selectedType ? '' : 'disabled'}>+ Add to Trade (Incoming)</button>
        ${!selectedType ? `<div style="font-size: 0.75rem; color: var(--accent-red); margin-top: 6px; text-align: center;">Select a product type above first.</div>` : ''}
      </form>
    `;
  }

  selectAcquiredSealedType(productType) {
    const setVal = document.getElementById('acquired-sealed-set')?.value;
    if (setVal !== undefined) this.pendingAcquiredSetName = setVal;

    this.selectedAcquiredSealedType = productType;
    this.renderAcquiredModalBody();
  }

  handleAddAcquiredSubmit(e) {
    e.preventDefault();

    if (this.acquiredItemType === 'sealed') {
      if (!this.selectedAcquiredSealedType) return;

      const setName = document.getElementById('acquired-sealed-set').value.trim();
      const mkt = parseFloat(document.getElementById('acquired-market').value) || 0;
      const sellingPrice = parseFloat(document.getElementById('acquired-selling-price').value) || mkt;
      const productType = this.selectedAcquiredSealedType;
      const name = setName ? `${setName} - ${productType}` : productType;

      this.acquiredItems.push({ name, marketValue: mkt, askingPrice: sellingPrice, type: 'sealed', gradingCompany: 'Sealed', grade: 'Sealed Product' });
    } else {
      const name = document.getElementById('acquired-name').value.trim();
      const mkt = parseFloat(document.getElementById('acquired-market').value) || 0;
      const sellingPrice = parseFloat(document.getElementById('acquired-selling-price').value) || mkt;

      if (this.acquiredItemType === 'slab') {
        const gradingCompany = document.getElementById('acquired-grading-company').value;
        const grade = document.getElementById('acquired-slab-grade').value;
        const cert = document.getElementById('acquired-cert').value.trim();
        this.acquiredItems.push({ name, marketValue: mkt, askingPrice: sellingPrice, type: 'slab', gradingCompany, grade, certNumber: cert, catalogCardId: this.selectedCatalogCardId || '' });
      } else {
        const condition = document.getElementById('acquired-condition').value;
        this.acquiredItems.push({ name, marketValue: mkt, askingPrice: sellingPrice, type: 'raw', gradingCompany: 'Raw', grade: condition, condition, catalogCardId: this.selectedCatalogCardId || '' });
      }
    }

    this.selectedCatalogCardId = null;
    document.getElementById('acquired-item-modal')?.classList.remove('active');
    window.app.showToast(`Added to incoming trade items`);
    this.renderTradePage();
  }

  removeAcquiredItem(index) {
    this.acquiredItems.splice(index, 1);
    this.renderTradePage();
  }

  updateCashDiff() {
    this.weTopUp = parseFloat(document.getElementById('cash-we-topup-input')?.value) || 0;
    this.customerTopUp = parseFloat(document.getElementById('cash-customer-topup-input')?.value) || 0;
    this.cashDifference = this.weTopUp - this.customerTopUp;

    // Re-render calculations without losing input focus
    const effCostElem = document.querySelector('.kpi-value[style*="color: var(--accent-gold)"]');
    if (effCostElem) {
      let givenTotalCost = 0;
      this.givenItems.forEach(g => {
        const item = window.db.getItemById(g.itemId);
        if (item) givenTotalCost += item.costBasis * (g.quantity || 1);
      });
      const eff = givenTotalCost + this.cashDifference;
      effCostElem.innerText = `$${eff.toFixed(2)}`;
    }
  }

  executeTradeTransaction() {
    if (this.givenItems.length === 0 && this.acquiredItems.length === 0) {
      alert('Trade must contain at least 1 item given or 1 item acquired!');
      return;
    }

    const eventTag = document.getElementById('trade-event-tag')?.value || null;

    const result = window.db.executeTrade({
      givenItems: this.givenItems,
      acquiredItems: this.acquiredItems,
      cashDifference: this.cashDifference,
      eventTag
    });

    window.syncManager.broadcast('TRADE_EXECUTED', result.tradeRecord);

    window.app.showToast('Trade successfully recorded & cost basis allocated!');
    this.givenItems = [];
    this.acquiredItems = [];
    this.cashDifference = 0;
    this.weTopUp = 0;
    this.customerTopUp = 0;

    window.app.renderAllPages();
    window.app.switchTab('inventory');
  }
}

window.tradeComp = new TradeComponent();
