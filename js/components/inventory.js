/* ==========================================================================
   PokAddicts - Inventory Management View Component
   ========================================================================== */

class InventoryComponent {
  constructor() {
    this.currentFilter = 'all';
    this.currentStatus = 'in_stock';
    this.searchQuery = '';
    this.viewingBinderName = null;
  }

  renderInventoryPage() {
    const container = document.getElementById('inventory-page');
    if (!container) return;

    if (this.viewingBinderName) {
      container.innerHTML = this.renderBinderDetailView();
      return;
    }

    const metrics = window.db.getMetrics();

    container.innerHTML = `
      <!-- KPI Portfolio Summary Banner -->
      <div class="kpi-grid">
        <div class="kpi-card glow-gold">
          <div class="kpi-label">Portfolio Cost</div>
          <div class="kpi-value">$${metrics.totalCostBasis.toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Current Mkt Value</div>
          <div class="kpi-value" style="color: var(--accent-cyan);">$${metrics.totalMarketValue.toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
        </div>
      </div>

      <div style="display: flex; justify-content: flex-end; margin-bottom: 10px;">
        <button class="btn btn-cyan btn-sm" onclick="window.inventoryComp.openCreateBinderModal()">+ New Binder</button>
      </div>

      ${this.renderFilterChipsBar()}

      <!-- Search & Status Toggle Bar -->
      <div style="display: flex; gap: 8px; margin-bottom: 12px;">
        <div style="position: relative; flex: 1;">
          <input type="text" id="inventory-search-input" class="form-control" style="padding-right: 36px;" placeholder="🔍 Search card, set, cert #..." value="${this.searchQuery}" oninput="window.inventoryComp.handleSearch(this.value)" autocomplete="off">
          <span id="inventory-search-clear" style="position: absolute; right: 12px; top: 50%; transform: translateY(-50%); cursor: pointer; color: var(--text-muted); font-weight: 700; font-size: 1rem; display: ${this.searchQuery ? 'block' : 'none'};" onclick="window.inventoryComp.clearSearch()">✕</span>
        </div>
        <select class="form-control" style="width: 140px;" onchange="window.inventoryComp.setStatus(this.value)">
          <option value="in_stock" ${this.currentStatus === 'in_stock' ? 'selected' : ''}>In Stock</option>
          <option value="sold" ${this.currentStatus === 'sold' ? 'selected' : ''}>Sold</option>
          <option value="traded_out" ${this.currentStatus === 'traded_out' ? 'selected' : ''}>Traded Out</option>
        </select>
      </div>

      <!-- Item List Container -->
      <div class="inventory-list">
        ${this.renderItemListInner()}
      </div>
    `;
  }

  // Builds just the item-list contents (binder groups + flat items) so
  // search-as-you-type can refresh ONLY this container, leaving the
  // search input itself untouched - replacing its innerHTML on every
  // keystroke would destroy and recreate the input, losing focus.
  renderItemListInner() {
    const flatItems = window.db.getInventory({
      type: this.currentFilter,
      status: this.currentStatus,
      query: this.searchQuery
    }).filter(i => !i.binderName);

    const showBinderGroups = this.currentFilter === 'all' && this.currentStatus === 'in_stock' && !this.searchQuery;
    const binderGroups = showBinderGroups ? window.db.getBinderMetrics() : [];

    return `
      ${binderGroups.map(b => this.renderBinderGroupCard(b)).join('')}
      ${flatItems.length === 0 && binderGroups.length === 0 ? `
        <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
          <div style="font-size: 2rem; margin-bottom: 8px;">📭</div>
          <div>No inventory items found.</div>
          <div style="font-size: 0.8rem; margin-top: 4px;">Tap <strong>Scan</strong> or <strong>Intake</strong> below to add cards.</div>
        </div>
      ` : flatItems.map(item => this.renderItemCard(item)).join('')}
    `;
  }

  // Shared filter chip bar for both the flat list and a binder's drill-down
  // view - lets you jump straight into any binder without going back
  // through "All Items" first, same as tapping Slabs/Raw/Sealed.
  renderFilterChipsBar() {
    const metrics = window.db.getMetrics();
    const binders = window.db.binders;

    return `
      <div class="filter-scroll">
        <button class="filter-chip ${!this.viewingBinderName && this.currentFilter === 'all' ? 'active' : ''}" onclick="window.inventoryComp.setFilter('all')">All Items (${metrics.totalItemsCount})</button>
        <button class="filter-chip ${!this.viewingBinderName && this.currentFilter === 'slab' ? 'active' : ''}" onclick="window.inventoryComp.setFilter('slab')">🏆 Slabs</button>
        <button class="filter-chip ${!this.viewingBinderName && this.currentFilter === 'raw' ? 'active' : ''}" onclick="window.inventoryComp.setFilter('raw')">✨ Raw Cards</button>
        <button class="filter-chip ${!this.viewingBinderName && this.currentFilter === 'sealed' ? 'active' : ''}" onclick="window.inventoryComp.setFilter('sealed')">📦 Sealed</button>
        ${binders.map(b => `
          <button class="filter-chip ${this.viewingBinderName === b.name ? 'active' : ''}" onclick="window.inventoryComp.viewBinder('${b.name.replace(/'/g, "\\'")}')">🗂️ ${b.name}</button>
        `).join('')}
      </div>
    `;
  }

  renderBinderGroupCard(b) {
    return `
      <div class="item-card" style="cursor: pointer;" onclick="window.inventoryComp.viewBinder('${b.binderName.replace(/'/g, "\\'")}')">
        <div class="item-icon-box">🗂️</div>
        <div class="item-details">
          <div class="item-name">${b.binderName}</div>
          <div class="item-meta">
            <span class="badge badge-raw">Binder</span>
            <span>${b.itemCount} item${b.itemCount === 1 ? '' : 's'} • ${b.totalQuantity} cards</span>
          </div>
        </div>
        <div class="item-pricing">
          <div class="item-market">$${b.totalMarketValue.toFixed(2)}</div>
          <div class="item-margin" style="color: var(--text-secondary);">Cost: $${b.totalCostValue.toFixed(2)}</div>
        </div>
      </div>
    `;
  }

  viewBinder(name) {
    this.viewingBinderName = name;
    this.renderInventoryPage();
  }

  exitBinderView() {
    this.viewingBinderName = null;
    this.renderInventoryPage();
  }

  renderBinderDetailView() {
    const items = window.db.getInventory({ binderName: this.viewingBinderName, status: this.currentStatus });

    const totalQty = items.reduce((sum, i) => sum + (i.quantity || 1), 0);
    const totalCost = items.reduce((sum, i) => sum + i.costBasis * (i.quantity || 1), 0);
    const totalValue = items.reduce((sum, i) => sum + i.marketValue * (i.quantity || 1), 0);

    return `
      <div class="panel-header" style="margin-bottom: 12px;">
        <h2 style="font-size: 1.2rem; font-weight: 800;">🗂️ ${this.viewingBinderName}</h2>
        <span style="color: var(--accent-cyan); cursor: pointer; font-size: 0.85rem; font-weight: 700;" onclick="window.inventoryComp.exitBinderView()">← Back</span>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card glow-gold">
          <div class="kpi-label">Binder Cost</div>
          <div class="kpi-value">$${totalCost.toFixed(2)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Binder Value</div>
          <div class="kpi-value" style="color: var(--accent-cyan);">$${totalValue.toFixed(2)}</div>
          <div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 4px;">${totalQty} cards total</div>
        </div>
      </div>

      <div style="display: flex; justify-content: flex-end; margin-bottom: 10px;">
        <button class="btn btn-cyan btn-sm" onclick="window.inventoryComp.openAddTierModal()">+ Add Price Tier</button>
      </div>

      ${this.renderFilterChipsBar()}

      <div style="display: flex; gap: 8px; margin-bottom: 12px;">
        <select class="form-control" style="width: 160px;" onchange="window.inventoryComp.setStatus(this.value)">
          <option value="in_stock" ${this.currentStatus === 'in_stock' ? 'selected' : ''}>In Stock</option>
          <option value="sold" ${this.currentStatus === 'sold' ? 'selected' : ''}>Sold</option>
          <option value="traded_out" ${this.currentStatus === 'traded_out' ? 'selected' : ''}>Traded Out</option>
        </select>
      </div>

      <div class="inventory-list">
        ${items.length === 0 ? `
          <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
            <div style="font-size: 2rem; margin-bottom: 8px;">🗂️</div>
            <div>Nothing here yet.</div>
            <div style="font-size: 0.8rem; margin-top: 4px;">Add singles or price tiers under "${this.viewingBinderName}" from the Intake tab.</div>
          </div>
        ` : items.map(item => this.renderItemCard(item)).join('')}
      </div>
    `;
  }

  openCreateBinderModal() {
    window.app.openCreateBinderModal(() => this.renderInventoryPage());
  }

  openAddTierModal() {
    const modal = document.getElementById('add-tier-modal');
    if (!modal) return;
    modal.querySelector('form')?.reset();
    modal.classList.add('active');
  }

  handleAddTierSubmit(e) {
    e.preventDefault();
    const label = document.getElementById('add-tier-label-input').value.trim();
    const quantity = parseInt(document.getElementById('add-tier-qty-input').value, 10) || 0;
    const cost = parseFloat(document.getElementById('add-tier-cost-input').value) || 0;
    const resale = parseFloat(document.getElementById('add-tier-resale-input').value) || cost;

    if (!label || quantity <= 0) { alert('Enter a tier label and quantity.'); return; }

    window.db.addItem({
      name: label,
      set: 'Binder Singles',
      type: 'binder_tier',
      binderName: this.viewingBinderName,
      quantity,
      costBasis: cost,
      marketValue: resale,
      notes: `Added from binder view: ${this.viewingBinderName}`
    });

    document.getElementById('add-tier-modal')?.classList.remove('active');
    window.app.showToast(`Added tier "${label}" to ${this.viewingBinderName}`);
    this.renderInventoryPage();
  }

  renderItemCard(item) {
    const isSlab = item.type === 'slab';
    const isSealed = item.type === 'sealed';
    const isBinderTier = item.type === 'binder_tier';
    const qty = item.quantity || 1;
    const hasMultipleQty = qty > 1;
    const margin = item.marketValue - item.costBasis;
    const marginPct = item.costBasis > 0 ? (margin / item.costBasis) * 100 : 0;

    let badgeClass = 'badge-raw';
    if (isSlab) badgeClass = 'badge-slab';
    if (isSealed) badgeClass = 'badge-sealed';

    let icon = '✨';
    if (isSlab) icon = '🏆';
    if (isSealed) icon = '📦';
    if (isBinderTier) icon = '🗂️';

    return `
      <div class="item-card">
        <div class="item-icon-box">${icon}</div>
        <div class="item-details">
          <div class="item-name">${item.name}${hasMultipleQty ? ` <span style="color: var(--text-secondary); font-weight: 600;">x${qty}</span>` : ''}</div>
          <div class="item-meta">
            <span class="badge ${badgeClass}">${isBinderTier ? 'Price Tier' : (isSlab ? `${item.gradingCompany} ${item.grade}` : (item.grade || item.type))}</span>
            <span>${item.set || ''}</span>
          </div>
          <div class="item-meta" style="margin-top: 4px;">
            <span>Cost: <strong>$${item.costBasis.toFixed(2)}${hasMultipleQty ? '/ea' : ''}</strong></span>
            ${hasMultipleQty ? `<span>• Total Cost: $${(item.costBasis * qty).toFixed(2)}</span>` : ''}
            ${item.certNumber ? `<span>• Cert #${item.certNumber}</span>` : ''}
          </div>

          ${item.status === 'in_stock' ? `
            <div class="item-actions">
              <button class="btn btn-green btn-sm" onclick="window.posComp.openQuickSaleModal('${item.id}')">
                ⚡ Sell
              </button>
              <button class="btn btn-secondary btn-sm" onclick="window.tradeComp.addToTrade('${item.id}')">
                🔄 Trade
              </button>
              <button class="btn btn-secondary btn-sm" onclick="window.inventoryComp.openRestockModal('${item.id}')">
                📥 Restock
              </button>
              <button class="btn btn-secondary btn-sm" style="color: var(--accent-red);" onclick="window.inventoryComp.deleteItem('${item.id}')">
                🗑️
              </button>
            </div>
          ` : `
            <div class="badge ${item.status === 'sold' ? 'badge-sold' : 'badge-traded'}" style="margin-top: 6px;">
              ${item.status === 'sold' ? '✓ SOLD' : '⇄ TRADED OUT'}
            </div>
          `}
        </div>

        <div class="item-pricing">
          <div class="item-market">$${item.marketValue.toFixed(2)}${hasMultipleQty ? '/ea' : ''}</div>
          <div class="item-margin ${margin >= 0 ? 'margin-positive' : 'margin-negative'}">
            ${margin >= 0 ? '+' : ''}$${margin.toFixed(2)} (${marginPct.toFixed(0)}%)
          </div>
        </div>
      </div>
    `;
  }

  setFilter(type) {
    this.currentFilter = type;
    this.viewingBinderName = null;
    this.renderInventoryPage();
  }

  setStatus(status) {
    this.currentStatus = status;
    this.renderInventoryPage();
  }

  handleSearch(val) {
    this.searchQuery = val;

    const listEl = document.querySelector('#inventory-page .inventory-list');
    if (!listEl) { this.renderInventoryPage(); return; }
    listEl.innerHTML = this.renderItemListInner();

    const clearBtn = document.getElementById('inventory-search-clear');
    if (clearBtn) clearBtn.style.display = val ? 'block' : 'none';
  }

  clearSearch() {
    this.searchQuery = '';

    const input = document.getElementById('inventory-search-input');
    if (input) input.value = '';

    const listEl = document.querySelector('#inventory-page .inventory-list');
    if (listEl) listEl.innerHTML = this.renderItemListInner();

    const clearBtn = document.getElementById('inventory-search-clear');
    if (clearBtn) clearBtn.style.display = 'none';

    if (input) input.focus();
  }

  deleteItem(id) {
    if (confirm('Delete this card from inventory?')) {
      window.db.deleteItem(id);
      window.app.showToast('Item deleted');
      this.renderInventoryPage();
    }
  }

  openRestockModal(itemId) {
    const item = window.db.getItemById(itemId);
    if (!item) return;

    const modal = document.getElementById('restock-modal');
    const sub = document.getElementById('restock-modal-sub');
    const qtyInput = document.getElementById('restock-qty-input');
    const costInput = document.getElementById('restock-cost-input');
    if (!modal) return;

    this._restockItemId = itemId;
    if (sub) sub.textContent = `"${item.name}" - currently ${item.quantity || 1} in stock @ $${item.costBasis.toFixed(2)}/ea`;
    if (qtyInput) qtyInput.value = 1;
    if (costInput) costInput.value = '';

    modal.classList.add('active');
  }

  handleRestockSubmit(e) {
    e.preventDefault();
    if (!this._restockItemId) return;

    const qty = parseInt(document.getElementById('restock-qty-input').value, 10) || 0;
    const costVal = document.getElementById('restock-cost-input').value;
    const cost = costVal === '' ? undefined : parseFloat(costVal);

    if (qty <= 0) { alert('Enter a quantity to add.'); return; }

    const updated = window.db.restockItem(this._restockItemId, qty, cost);
    if (!updated) { alert('Could not restock that item - please try again.'); return; }

    document.getElementById('restock-modal')?.classList.remove('active');
    window.app.showToast(`Restocked +${qty} ${updated.name} (now ${updated.quantity} @ $${updated.costBasis.toFixed(2)}/ea)`);
    this._restockItemId = null;

    window.app.renderAllPages();
  }
}

window.inventoryComp = new InventoryComponent();
