/* ==========================================================================
   PokAddicts - Analytics & Accounting Dashboard Component
   ========================================================================== */

class AnalyticsComponent {
  constructor() {
    this.eventFilter = 'all';
    this.eventSort = 'recent'; // 'recent' | 'profit' | 'revenue'
  }

  setEventFilter(tag) {
    this.eventFilter = tag;
    this.renderAnalyticsPage();
  }

  setEventSort(mode) {
    this.eventSort = mode;
    this.renderAnalyticsPage();
  }

  openCreateEventModal() {
    window.app.openCreateEventModal((evt) => {
      this.eventFilter = evt.name;
      this.renderAnalyticsPage();
    });
  }

  loadDemoData() {
    if (!confirm('Add a set of realistic demo binders, events, inventory, buybacks, sales & trades so you can test the app? Safe to run again later, but re-running will add more (not replace).')) return;

    window.db.seedDemoData();
    window.syncManager.broadcast('DEMO_DATA_LOADED');
    window.app.showToast('🧪 Demo data loaded - explore Inventory, Trade, POS & Analytics');
    window.app.renderAllPages();
  }

  openEditExpensesModal(eventId, eventName, currentExpenses) {
    const modal = document.getElementById('event-expenses-modal');
    const input = document.getElementById('event-expenses-input');
    const sub = document.getElementById('event-expenses-modal-sub');
    if (!modal || !input) return;

    input.value = currentExpenses || '';
    if (sub) sub.textContent = `${eventName} - booth fee, travel, table rental, etc.`;
    this._expensesModalEventId = eventId;
    modal.classList.add('active');
  }

  handleExpensesSubmit(e) {
    e.preventDefault();
    if (!this._expensesModalEventId) return;

    const input = document.getElementById('event-expenses-input');
    const expenses = parseFloat(input.value) || 0;
    window.db.updateEventExpenses(this._expensesModalEventId, expenses);

    document.getElementById('event-expenses-modal')?.classList.remove('active');
    this._expensesModalEventId = null;
    window.app.showToast('Expenses updated');
    this.renderAnalyticsPage();
  }

  // Top sellers only makes sense once you're looking at one specific
  // tradeshow - shown above the Sales Ledger whenever a single event is
  // selected, so you can see what actually moved at that show.
  renderTopSellersPanel() {
    const topSellers = window.db.getTopSellersForEvent(this.eventFilter, 5);
    return `
      <div class="card-panel">
        <div class="panel-title" style="margin-bottom: 12px;">🏆 Top Sellers - ${this.eventFilter}</div>
        ${topSellers.length === 0 ? `
          <div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 12px;">No sales logged for this tradeshow yet.</div>
        ` : `
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${topSellers.map((s, idx) => `
              <div style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-surface-elevated); padding: 8px 10px; border-radius: 8px; font-size: 0.82rem;">
                <span>${idx + 1}. <strong style="color: var(--text-primary);">${s.itemName}</strong>${s.quantitySold > 1 ? ` <span style="color: var(--text-secondary);">x${s.quantitySold}</span>` : ''}</span>
                <span style="font-family: 'JetBrains Mono', monospace; font-weight: 700; color: var(--accent-cyan);">$${s.totalRevenue.toFixed(2)}</span>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;
  }

  renderAnalyticsPage() {
    const container = document.getElementById('analytics-page');
    if (!container) return;

    const metrics = window.db.getMetrics();
    let eventMetrics = window.db.getEventMetrics();
    if (this.eventSort === 'profit') {
      eventMetrics = [...eventMetrics].sort((a, b) => b.netProfit - a.netProfit);
    } else if (this.eventSort === 'revenue') {
      eventMetrics = [...eventMetrics].sort((a, b) => b.totalRevenue - a.totalRevenue);
    }
    const sales = this.eventFilter === 'all'
      ? window.db.sales
      : window.db.sales.filter(s => (s.eventTag || 'Normal Sale') === this.eventFilter);
    const trades = this.eventFilter === 'all'
      ? window.db.trades
      : window.db.trades.filter(t => (t.eventTag || 'Normal Sale') === this.eventFilter);

    // Number trades #1, #2... within their own event, chronologically -
    // independent of the current filter/sort so the number stays stable.
    const eventTradeNumbers = new Map();
    const eventCounters = {};
    [...window.db.trades]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .forEach(t => {
        const tag = t.eventTag || 'Normal Sale';
        eventCounters[tag] = (eventCounters[tag] || 0) + 1;
        eventTradeNumbers.set(t.id, eventCounters[tag]);
      });

    container.innerHTML = `
      <div class="panel-header" style="margin-bottom: 14px;">
        <h2 style="font-size: 1.2rem; font-weight: 800;">📊 Tradeshow Accounting Dashboard</h2>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-secondary btn-sm" onclick="window.analyticsComp.loadDemoData()">
            🧪 Load Demo Data
          </button>
          <button class="btn btn-outline-gold btn-sm" onclick="window.db.exportInventoryCSV()">
            📥 Export CSV
          </button>
        </div>
      </div>

      <!-- Financial Metrics Summary Grid -->
      <div class="kpi-grid">
        <div class="kpi-card glow-gold">
          <div class="kpi-label">Realized Profit</div>
          <div class="kpi-value" style="color: var(--accent-green);">$${metrics.totalRealizedProfit.toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
          <div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 4px;">Margin: ${metrics.overallMargin}%</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">Gross Revenue</div>
          <div class="kpi-value" style="color: var(--accent-cyan);">$${metrics.totalRevenue.toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
          <div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 4px;">Total Sales: ${sales.length}</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">Inventory Cost Basis</div>
          <div class="kpi-value">$${metrics.totalCostBasis.toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
          <div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 4px;">${metrics.totalItemsCount} Active Items</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">Unrealized Capital Gain</div>
          <div class="kpi-value" style="color: var(--accent-gold);">$${metrics.unrealizedGain.toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
          <div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 4px;">Portfolio Mkt: $${metrics.totalMarketValue.toFixed(2)}</div>
        </div>
      </div>

      <!-- Tradeshow / Event Performance Panel -->
      <div class="card-panel">
        <div class="panel-header" style="margin-bottom: 12px;">
          <div class="panel-title">🎪 Tradeshow Performance</div>
          <button class="btn btn-cyan btn-sm" onclick="window.analyticsComp.openCreateEventModal()">+ New Event</button>
        </div>

        ${eventMetrics.length === 0 ? `
          <div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 16px;">No tradeshows yet. Create one (e.g. "SCCS Tradeshow") to start tagging sales and trades to it from the POS Register or Trade.</div>
        ` : `
          <div style="display: flex; gap: 6px; margin-bottom: 10px;">
            <button class="btn btn-sm ${this.eventSort === 'recent' ? 'btn-cyan' : 'btn-secondary'}" onclick="window.analyticsComp.setEventSort('recent')">Recent</button>
            <button class="btn btn-sm ${this.eventSort === 'profit' ? 'btn-cyan' : 'btn-secondary'}" onclick="window.analyticsComp.setEventSort('profit')">Net Profit</button>
            <button class="btn btn-sm ${this.eventSort === 'revenue' ? 'btn-cyan' : 'btn-secondary'}" onclick="window.analyticsComp.setEventSort('revenue')">Revenue</button>
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${eventMetrics.map(ev => {
              const hasActivity = ev.salesCount > 0 || ev.tradesCount > 0 || ev.buybackCount > 0;
              const dateRange = hasActivity
                ? `${new Date(ev.firstActivityDate).toLocaleDateString()} - ${new Date(ev.lastActivityDate).toLocaleDateString()}`
                : 'No activity yet';
              return `
              <div class="trade-item-pill" style="padding: 10px; cursor: pointer; ${this.eventFilter === ev.eventTag ? 'border-color: var(--accent-gold);' : ''}" onclick="window.analyticsComp.setEventFilter('${ev.eventTag.replace(/'/g, "\\'")}')">
                <div>
                  <strong style="color: var(--text-primary);">${ev.eventTag}</strong>
                  <div style="font-size: 0.72rem; color: var(--text-secondary);">
                    ${ev.salesCount} sale${ev.salesCount === 1 ? '' : 's'} • ${ev.tradesCount} trade${ev.tradesCount === 1 ? '' : 's'} • ${dateRange}
                  </div>
                  ${ev.buybackCount > 0 ? `
                    <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 2px;">
                      🔄 Buyback Spend: $${ev.totalBuybackCost.toFixed(2)} (${ev.buybackCount} card${ev.buybackCount === 1 ? '' : 's'})
                    </div>
                  ` : ''}
                  ${ev.eventId ? `
                    <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 2px;">
                      💸 Expenses: $${ev.expenses.toFixed(2)}
                      <span style="color: var(--accent-cyan); cursor: pointer; font-weight: 700;" onclick="event.stopPropagation(); window.analyticsComp.openEditExpensesModal('${ev.eventId}', '${ev.eventTag.replace(/'/g, "\\'")}', ${ev.expenses})">✏️ Edit</span>
                    </div>
                  ` : ''}
                </div>
                <div style="text-align: right;">
                  <div style="font-family: 'JetBrains Mono', monospace; font-weight: 800; color: var(--accent-cyan);">$${ev.totalRevenue.toFixed(2)}</div>
                  <div style="font-size: 0.75rem; font-weight: 700; color: var(--accent-green);">
                    + $${ev.totalProfit.toFixed(2)} (${ev.marginPercent}%)
                  </div>
                  ${ev.eventId ? `
                    <div style="font-size: 0.75rem; font-weight: 800; color: ${ev.netProfit >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}; margin-top: 2px;">
                      Net: ${ev.netProfit >= 0 ? '+' : ''}$${ev.netProfit.toFixed(2)}${ev.roiPercent !== null ? ` (${ev.roiPercent}% ROI)` : ''}
                    </div>
                  ` : ''}
                </div>
              </div>
            `;
            }).join('')}
          </div>
        `}
      </div>

      ${this.eventFilter !== 'all' ? this.renderTopSellersPanel() : ''}

      <!-- Sales Log Table -->
      <div class="card-panel">
        <div class="panel-header" style="margin-bottom: 12px;">
          <div class="panel-title">🧾 Sales Ledger ${this.eventFilter !== 'all' ? `- ${this.eventFilter}` : ''}</div>
          ${this.eventFilter !== 'all' ? `<button class="btn btn-secondary btn-sm" onclick="window.analyticsComp.setEventFilter('all')">Show All</button>` : ''}
        </div>

        ${sales.length === 0 ? `
          <div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 20px;">No sales logged yet. Use the POS Register tab to record sales.</div>
        ` : `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${sales.map(s => `
              <div class="trade-item-pill" style="padding: 10px;">
                <div>
                  <strong style="color: var(--text-primary);">${s.itemName}</strong>
                  <div style="font-size: 0.75rem; color: var(--text-secondary);">
                    Method: <strong>${s.paymentMethod || 'Cash'}</strong> • By: ${s.soldBy || 'Staff'}
                  </div>
                  <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 2px;">🎪 ${s.eventTag || 'Normal Sale'}</div>
                </div>
                <div style="text-align: right;">
                  <div style="font-family: 'JetBrains Mono', monospace; font-weight: 800; color: var(--accent-cyan);">$${s.salePrice.toFixed(2)}</div>
                  <div style="font-size: 0.75rem; font-weight: 700; color: var(--accent-green);">
                    + $${s.profit.toFixed(2)} (${s.marginPercent}%)
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>

      <!-- Trade Ledger Table -->
      <div class="card-panel">
        <div class="panel-title" style="margin-bottom: 12px;">🔄 Trades Ledger ${this.eventFilter !== 'all' ? `- ${this.eventFilter}` : ''}</div>

        ${trades.length === 0 ? `
          <div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 16px;">No trades logged yet. Use Trade to execute card-for-card trades.</div>
        ` : `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${trades.map(t => {
              const marketValue = t.totalAcquiredMarketValue || 0;
              const hasMarketValue = t.totalAcquiredMarketValue !== undefined && t.totalAcquiredMarketValue !== null;
              const unrealizedProfit = marketValue - (t.totalAcquiredCost || 0);
              const unrealizedMargin = marketValue > 0 ? (unrealizedProfit / marketValue) * 100 : 0;

              return `
              <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: 10px; font-size: 0.8rem;">
                <div style="display: flex; justify-content: space-between; font-weight: 700; margin-bottom: 4px;">
                  <span>Trade #${eventTradeNumbers.get(t.id) || '?'}</span>
                  <span style="color: var(--accent-gold);">${new Date(t.date).toLocaleDateString()}</span>
                </div>
                <div style="display: flex; justify-content: space-between; gap: 8px; color: var(--text-secondary); margin-bottom: 2px;">
                  <span>Out: <strong style="color: var(--text-primary);">${t.givenItems.join(', ') || 'Cash only'}</strong></span>
                  <span style="white-space: nowrap;">Cost: <strong style="color: var(--text-primary);">$${(t.givenCostBasis || 0).toFixed(2)}</strong></span>
                </div>
                <div style="display: flex; justify-content: space-between; gap: 8px; color: var(--text-secondary); margin-bottom: 4px;">
                  <span>In: <strong style="color: var(--text-primary);">${t.acquiredItems.join(', ') || 'Cash only'}</strong></span>
                  <span style="white-space: nowrap;">Mkt: <strong style="color: var(--accent-cyan);">${hasMarketValue ? '$' + marketValue.toFixed(2) : 'N/A'}</strong></span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-size: 0.72rem; color: var(--text-muted);">🎪 ${t.eventTag || 'Normal Sale'}</span>
                  ${hasMarketValue ? `
                    <span style="font-size: 0.75rem; font-weight: 700; color: ${unrealizedProfit >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'};">
                      ${unrealizedProfit >= 0 ? '+' : ''}$${unrealizedProfit.toFixed(2)} unrealized (${unrealizedMargin.toFixed(0)}%)
                    </span>
                  ` : ''}
                </div>
              </div>
            `;
            }).join('')}
          </div>
        `}
      </div>
    `;
  }
}

window.analyticsComp = new AnalyticsComponent();
