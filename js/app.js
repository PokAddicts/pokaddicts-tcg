/* ==========================================================================
   PokAddicts - Main Application Coordinator & Tab Router
   ========================================================================== */

class PokAddictsApp {
  constructor() {
    this.currentTab = 'inventory';
    this.init();
  }

  init() {
    document.addEventListener('DOMContentLoaded', async () => {
      this.setupEventListeners();

      await window.db.ready;

      const loadingOverlay = document.getElementById('app-loading-overlay');
      if (loadingOverlay) loadingOverlay.remove();

      this.updateHeaderTeamBadge();
      this.renderAllPages();

      // First time on this device: no team name set yet, so prompt for one.
      if (!window.db.settings.teamMember) {
        this.openNameSetupModal();
      }

      // Listen for team real-time sync events
      window.syncManager.onSync((msg) => {
        this.showToast(`⚡ ${msg.sender || 'Teammate'} ${msg.label || msg.type.replace(/_/g, ' ').toLowerCase()}`);
        this.renderAllPages();
      });

      // Best-effort daily market price refresh - runs in the background,
      // does not block startup.
      window.db.refreshInventoryPricesIfDue();

      // Kick off (or resume) the shared card catalog sync in the
      // background - paced under PokeWallet's rate limit, so a full
      // multi-language import can take a while and resumes automatically
      // (across sessions, and across devices once Supabase is configured).
      window.cardCatalog.ready.then(() => {
        const state = window.cardCatalog.getSyncState();
        if (state.status !== 'complete') {
          window.cardCatalog.syncCatalog((progress) => {
            if (progress.status === 'complete') {
              this.showToast(`✓ Card catalog synced (${progress.totalCards.toLocaleString()} cards) - search is ready!`);
            }
          });
        }
      });

      // Best-effort daily FX rate refresh (USD/EUR -> SGD) for converting
      // PokeWallet prices - runs in the background, does not block startup.
      window.fxRates.ensureFreshRates();
    });
  }

  setupEventListeners() {
    // Navigation items
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab) this.switchTab(tab);
      });
    });

    // Scanner FAB
    const fabScan = document.getElementById('fab-scan');
    if (fabScan) {
      fabScan.addEventListener('click', () => {
        window.scanner.openScannerModal();
      });
    }
  }

  switchTab(tabName) {
    this.currentTab = tabName;

    // Update bottom nav active status
    document.querySelectorAll('.nav-item').forEach(btn => {
      if (btn.dataset.tab === tabName) btn.classList.add('active');
      else btn.classList.remove('active');
    });

    // Update page visibility
    document.querySelectorAll('.tab-page').forEach(page => {
      if (page.id === `${tabName}-page`) page.classList.add('active');
      else page.classList.remove('active');
    });

    // Re-render target page content
    if (tabName === 'inventory') window.inventoryComp.renderInventoryPage();
    if (tabName === 'intake') window.intakeComp.renderIntakePage();
    if (tabName === 'trade') window.tradeComp.renderTradePage();
    if (tabName === 'pos') window.posComp.renderPOSPage();
    if (tabName === 'analytics') window.analyticsComp.renderAnalyticsPage();

    // Scroll to top of main content area
    const mainContent = document.querySelector('main.content-area');
    if (mainContent) mainContent.scrollTop = 0;
  }

  renderAllPages() {
    window.inventoryComp.renderInventoryPage();
    window.intakeComp.renderIntakePage();
    window.tradeComp.renderTradePage();
    window.posComp.renderPOSPage();
    window.analyticsComp.renderAnalyticsPage();
  }

  updateHeaderTeamBadge() {
    const badge = document.getElementById('team-member-badge');
    if (badge) {
      badge.innerHTML = `
        <span class="status-dot"></span>
        <span>${window.db.settings.teamMember || 'Set Your Name'}</span>
      `;
    }
  }

  openNameSetupModal() {
    const modal = document.getElementById('name-modal');
    if (!modal) return;

    document.getElementById('name-setup-input').value = window.db.settings.teamMember || '';

    modal.classList.add('active');
  }

  closeNameSetupModal() {
    // Force a name to be set on first run - don't allow dismissing blank.
    if (!window.db.settings.teamMember) return;
    document.getElementById('name-modal')?.classList.remove('active');
  }

  handleNameSetupSubmit(e) {
    e.preventDefault();

    const name = document.getElementById('name-setup-input').value.trim();
    if (!name) return;

    window.db.settings.teamMember = name;
    window.db.saveSettings();

    this.updateHeaderTeamBadge();
    document.getElementById('name-modal')?.classList.remove('active');
    this.showToast(`Welcome, ${name}!`);
    this.renderAllPages();
  }

  showToast(message) {
    const toast = document.getElementById('app-toast');
    if (!toast) return;

    toast.innerText = message;
    toast.classList.add('show');

    setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }

  // Shared "Create Binder" modal - used from the Inventory page's Binders
  // panel and from Intake's binder-tier picker. onCreated(binder) fires
  // right after a successful create so the caller can refresh/select it.
  openCreateBinderModal(onCreated) {
    const modal = document.getElementById('binder-modal');
    const input = document.getElementById('binder-modal-name-input');
    if (!modal || !input) return;

    input.value = '';
    this._binderModalCallback = onCreated || null;
    modal.classList.add('active');
  }

  handleCreateBinderSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('binder-modal-name-input');
    const name = input.value.trim();
    if (!name) return;

    const binder = window.db.addBinder(name);

    document.getElementById('binder-modal')?.classList.remove('active');
    this.showToast(`Created binder "${binder.name}"`);

    if (this._binderModalCallback) {
      this._binderModalCallback(binder);
      this._binderModalCallback = null;
    }
  }

  // Shared "Create Event" modal - used from POS, Trade Studio, and
  // Analytics. onCreated(event) fires right after a successful create so
  // the caller can refresh/select it.
  openCreateEventModal(onCreated) {
    const modal = document.getElementById('event-modal');
    const input = document.getElementById('event-modal-name-input');
    if (!modal || !input) return;

    input.value = '';
    this._eventModalCallback = onCreated || null;
    modal.classList.add('active');
  }

  handleCreateEventSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('event-modal-name-input');
    const name = input.value.trim();
    if (!name) return;

    const evt = window.db.addEvent(name);

    document.getElementById('event-modal')?.classList.remove('active');
    this.showToast(`Created event "${evt.name}"`);

    if (this._eventModalCallback) {
      this._eventModalCallback(evt);
      this._eventModalCallback = null;
    }
  }
}

window.app = new PokAddictsApp();
