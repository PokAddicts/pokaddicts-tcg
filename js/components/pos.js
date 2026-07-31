/* ==========================================================================
   PokAddicts - Tradeshow Quick POS Register Component
   ========================================================================== */

class POSComponent {
  constructor() {
    this.activeItemForSale = null;
  }

  renderPOSPage() {
    const container = document.getElementById('pos-page');
    if (!container) return;

    const inStockItems = window.db.getInventory({ status: 'in_stock' });

    container.innerHTML = `
      <div class="panel-header" style="margin-bottom: 14px;">
        <h2 style="font-size: 1.2rem; font-weight: 800;">⚡ Tradeshow Quick Register</h2>
        <span class="badge badge-instock">1-Tap POS</span>
      </div>

      <p style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 12px;">
        Select an in-stock card to record a sale immediately at the booth.
      </p>

      <div class="inventory-list">
        ${inStockItems.length === 0 ? `
          <div style="text-align: center; padding: 30px; color: var(--text-muted);">
            No items in stock to sell.
          </div>
        ` : inStockItems.map(item => {
          const unitPrice = (item.askingPrice && item.askingPrice > 0) ? item.askingPrice : item.marketValue;
          const hasMultipleQty = (item.quantity || 1) > 1;
          return `
          <div class="item-card" onclick="window.posComp.openQuickSaleModal('${item.id}')" style="cursor: pointer;">
            <div class="item-icon-box">${item.type === 'slab' ? '🏆' : (item.type === 'sealed' ? '📦' : (item.type === 'binder_tier' ? '🗂️' : '✨'))}</div>
            <div class="item-details">
              <div class="item-name">${item.name}${hasMultipleQty ? ` <span style="color: var(--text-secondary); font-weight: 600;">x${item.quantity}</span>` : ''}</div>
              <div class="item-meta">
                <span class="badge badge-slab">${item.type === 'binder_tier' ? (item.binderName || 'Binder') : (item.type === 'slab' ? `${item.gradingCompany} ${window.formatSlabGradeShort(item.grade)}` : (item.grade ? window.formatConditionAbbreviation(item.grade) : item.type))}</span>
                <span>Cost: <strong>$${item.costBasis.toFixed(2)}${hasMultipleQty ? '/ea' : ''}</strong></span>
              </div>
            </div>
            <div class="item-pricing">
              <div class="item-market" style="color: var(--accent-gold);">$${unitPrice.toFixed(2)}${hasMultipleQty ? '/ea' : ''}</div>
              <div style="font-size: 0.72rem; color: var(--accent-green); font-weight: 700; margin-top: 2px;">⚡ Tap to Sell</div>
            </div>
          </div>
        `;
        }).join('')}
      </div>
    `;
  }

  openQuickSaleModal(itemId) {
    const item = window.db.getItemById(itemId);
    if (!item) return;

    this.activeItemForSale = item;

    const modal = document.getElementById('pos-modal');
    const body = document.getElementById('pos-modal-body');

    if (!modal || !body) return;

    const isBinderTier = item.type === 'binder_tier';
    const qtyAvailable = item.quantity || 1;
    // Any item with more than 1 in stock (binder tier, or a bulk sealed
    // lot) can be sold off partially - not just binder tiers.
    const hasMultipleQty = qtyAvailable > 1;
    const defaultQty = 1;
    // Prefills from the selling price set at intake, not the raw market
    // estimate - lets vintage cards (where the live estimate can be off)
    // sell at the price you actually intended.
    const unitPrice = (item.askingPrice && item.askingPrice > 0) ? item.askingPrice : item.marketValue;
    const defaultTotal = unitPrice * defaultQty;

    body.innerHTML = `
      <div style="text-align: center; margin-bottom: 14px;">
        <span class="badge badge-slab" style="margin-bottom: 6px;">${item.type.replace('_', ' ').toUpperCase()}${item.type === 'slab' ? ` • ${item.gradingCompany} ${window.formatSlabGradeShort(item.grade)}` : (item.grade ? ` • ${window.formatConditionAbbreviation(item.grade)}` : '')}</span>
        <h3 style="font-size: 1.2rem; font-weight: 800; color: var(--text-primary);">${item.name}</h3>
        <p style="font-size: 0.82rem; color: var(--text-secondary); margin-top: 2px;">${isBinderTier ? (item.binderName || 'Binder') : (item.set || '')}</p>
      </div>

      <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: 12px; margin-bottom: 14px;">
        <div style="display: flex; justify-content: space-between; font-size: 0.85rem; margin-bottom: 6px;">
          <span style="color: var(--text-secondary);">Cost Basis${hasMultipleQty ? ' (per unit)' : ''}:</span>
          <strong style="color: var(--text-primary); font-family: 'JetBrains Mono', monospace;">$${item.costBasis.toFixed(2)}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.85rem; margin-bottom: 6px;">
          <span style="color: var(--text-secondary);">Market Value Est${hasMultipleQty ? ' (per unit)' : ''}:</span>
          <strong style="color: var(--text-primary); font-family: 'JetBrains Mono', monospace;">$${item.marketValue.toFixed(2)}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.85rem;${hasMultipleQty ? ' margin-bottom: 6px;' : ''}">
          <span style="color: var(--text-secondary);">Your Selling Price${hasMultipleQty ? ' (per unit)' : ''}:</span>
          <strong style="color: var(--accent-gold); font-family: 'JetBrains Mono', monospace;">$${unitPrice.toFixed(2)}</strong>
        </div>
        ${hasMultipleQty ? `
        <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
          <span style="color: var(--text-secondary);">Qty Remaining:</span>
          <strong style="color: var(--accent-cyan); font-family: 'JetBrains Mono', monospace;">${qtyAvailable}</strong>
        </div>
        ` : ''}
      </div>

      <form onsubmit="window.posComp.handlePOSSubmit(event)">
        ${hasMultipleQty ? `
        <div class="form-group">
          <label class="form-label">Quantity Sold (of ${qtyAvailable} left)</label>
          <input type="number" id="pos-sale-qty" class="form-control" value="${defaultQty}" min="1" max="${qtyAvailable}" step="1" required
            oninput="window.posComp.handleQtyChange(this.value, ${item.costBasis}, ${unitPrice}, ${qtyAvailable})">
        </div>
        ` : ''}

        <div class="form-group">
          <label class="form-label">${hasMultipleQty ? 'Total Sale Price for this Quantity ($)' : 'Agreed Sale Price ($)'}</label>
          <input type="number" id="pos-sale-price" class="form-control" placeholder="0.00" value="${(hasMultipleQty ? defaultTotal : unitPrice).toFixed(2)}" step="0.01" required
            oninput="window.posComp.updateProfitCalc(this.value, ${item.costBasis}, ${hasMultipleQty ? "document.getElementById('pos-sale-qty').value" : 1})">
          ${hasMultipleQty ? `<div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">Selling a few together for less than list? Just type the total you actually received.</div>` : ''}
        </div>

        <!-- Real-time Profit Preview Box -->
        <div class="kpi-grid" style="margin-bottom: 14px;">
          <div class="kpi-card" style="background: rgba(0, 230, 118, 0.08); border-color: rgba(0, 230, 118, 0.3);">
            <div class="kpi-label">Realized Profit</div>
            <div class="kpi-value" id="pos-profit-preview" style="color: var(--accent-green);">$${(defaultTotal - item.costBasis * defaultQty).toFixed(2)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Profit Margin %</div>
            <div class="kpi-value" id="pos-margin-preview" style="color: var(--accent-cyan);">${defaultTotal > 0 ? (((defaultTotal - item.costBasis * defaultQty) / defaultTotal) * 100).toFixed(0) : 100}%</div>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Payment Method</label>
          <select id="pos-payment-method" class="form-control">
            <option value="Cash" selected>💵 Cash</option>
            <option value="PayNow">📱 PayNow</option>
            <option value="Card">💳 Card</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Tradeshow / Event</label>
          <div style="display: flex; gap: 8px;">
            <select id="pos-event-tag" class="form-control">
              ${window.db.getEventTags().map(tag => `<option value="${tag}" ${tag === (window.db.settings.currentEventTag || 'Normal Sale') ? 'selected' : ''}>${tag}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-cyan btn-sm" onclick="window.posComp.openCreateEventModal()">+ New</button>
          </div>
          <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">
            Sticks as the default for your next sale - change it when you switch shows.
          </div>
        </div>

        <button type="submit" class="btn btn-green">
          ✓ Complete Sale & Record Profit
        </button>
      </form>
    `;

    modal.classList.add('active');
  }

  openCreateEventModal() {
    window.app.openCreateEventModal((evt) => {
      const select = document.getElementById('pos-event-tag');
      if (select) {
        select.innerHTML = window.db.getEventTags().map(tag => `<option value="${tag}">${tag}</option>`).join('');
        select.value = evt.name;
      }
    });
  }

  updateProfitCalc(salePriceVal, unitCostBasis, quantity = 1) {
    const qty = parseFloat(quantity) || 1;
    const salePrice = parseFloat(salePriceVal) || 0;
    const cost = unitCostBasis * qty;
    const profit = salePrice - cost;
    const margin = salePrice > 0 ? (profit / salePrice) * 100 : 0;

    const profitElem = document.getElementById('pos-profit-preview');
    const marginElem = document.getElementById('pos-margin-preview');

    if (profitElem) {
      profitElem.innerText = `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`;
      profitElem.style.color = profit >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    }

    if (marginElem) {
      marginElem.innerText = `${margin.toFixed(0)}%`;
    }
  }

  // Binder tier only: bumping quantity re-suggests a total price (qty x
  // per-card market value), which the user can still edit down for a discount.
  handleQtyChange(qtyVal, unitCost, unitMarket, maxQty) {
    let qty = parseInt(qtyVal, 10) || 1;
    if (qty < 1) qty = 1;
    if (qty > maxQty) qty = maxQty;

    const qtyInput = document.getElementById('pos-sale-qty');
    if (qtyInput && parseInt(qtyInput.value, 10) !== qty) qtyInput.value = qty;

    const priceInput = document.getElementById('pos-sale-price');
    if (priceInput) priceInput.value = (unitMarket * qty).toFixed(2);

    this.updateProfitCalc(unitMarket * qty, unitCost, qty);
  }

  handlePOSSubmit(e) {
    e.preventDefault();
    if (!this.activeItemForSale) return;

    const salePrice = parseFloat(document.getElementById('pos-sale-price').value) || 0;
    const paymentMethod = document.getElementById('pos-payment-method').value;
    const eventTag = document.getElementById('pos-event-tag').value.trim();
    const qtyInput = document.getElementById('pos-sale-qty');
    const quantitySold = qtyInput ? (parseInt(qtyInput.value, 10) || 1) : 1;

    const saleRecord = window.db.recordSale(this.activeItemForSale.id, salePrice, paymentMethod, eventTag, quantitySold);

    window.syncManager.broadcast('SALE_RECORDED', saleRecord);

    document.getElementById('pos-modal')?.classList.remove('active');

    window.app.showToast(`Sold ${quantitySold > 1 ? quantitySold + 'x ' : ''}${saleRecord.itemName} for $${salePrice.toFixed(2)} (+ $${saleRecord.profit.toFixed(2)} Profit)!`);
    this.activeItemForSale = null;

    window.app.renderAllPages();
    window.app.switchTab('analytics');
  }
}

window.posComp = new POSComponent();
