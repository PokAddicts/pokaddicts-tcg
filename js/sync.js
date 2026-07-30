/* ==========================================================================
   PokAddicts - Multi-User Real-time Booth Synchronization Manager
   ========================================================================== */

class PokAddictsSync {
  constructor() {
    this.channel = null;
    this.localChannel = null;
    this.listeners = [];
    this.init();
  }

  init() {
    if (window.supabaseClient) {
      this.subscribeToRoom(window.db.settings.roomCode);
    } else {
      this.initLocalFallback();
    }
  }

  // --- Real cross-device sync via Supabase Realtime ---

  subscribeToRoom(roomCode) {
    if (!window.supabaseClient) return;

    if (this.channel) {
      window.supabaseClient.removeChannel(this.channel);
      this.channel = null;
    }

    this.channel = window.supabaseClient
      .channel(`room-${roomCode}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory', filter: `room_code=eq.${roomCode}` },
        (payload) => this.handleRemoteChange('inventory', payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales', filter: `room_code=eq.${roomCode}` },
        (payload) => this.handleRemoteChange('sales', payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trades', filter: `room_code=eq.${roomCode}` },
        (payload) => this.handleRemoteChange('trades', payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'binders', filter: `room_code=eq.${roomCode}` },
        (payload) => this.handleRemoteChange('binders', payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `room_code=eq.${roomCode}` },
        (payload) => this.handleRemoteChange('events', payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'buybacks', filter: `room_code=eq.${roomCode}` },
        (payload) => this.handleRemoteChange('buybacks', payload))
      .subscribe();
  }

  handleRemoteChange(table, payload) {
    const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
    if (!row || !row.id) return;

    // If this row was just written by this same device, skip the toast/
    // re-render - the local action already updated the UI.
    const isOwnRecentWrite = window.db.isRecentLocalWrite(row.id);

    if (table === 'inventory') window.db.mergeRemoteInventoryChange(payload.eventType, row);
    if (table === 'sales') window.db.mergeRemoteSaleChange(payload.eventType, row);
    if (table === 'trades') window.db.mergeRemoteTradeChange(payload.eventType, row);
    if (table === 'binders') window.db.mergeRemoteBinderChange(payload.eventType, row);
    if (table === 'events') window.db.mergeRemoteEventChange(payload.eventType, row);
    if (table === 'buybacks') window.db.mergeRemoteBuybackChange(payload.eventType, row);

    if (isOwnRecentWrite) return;

    const labels = { inventory: 'updated inventory', sales: 'recorded a sale', trades: 'executed a trade', binders: 'added a binder', events: 'added a tradeshow event', buybacks: 'recorded a buyback' };
    this.notifyListeners({ type: 'REMOTE_CHANGE', sender: 'A teammate', label: labels[table] || 'made a change' });
  }

  // --- Local-only fallback (no Supabase configured yet): sync across
  // browser tabs on the SAME device only, via BroadcastChannel/localStorage ---

  initLocalFallback() {
    if ('BroadcastChannel' in window) {
      this.localChannel = new BroadcastChannel('pokaddicts_booth_sync_channel');
      this.localChannel.onmessage = (event) => this.handleLocalMessage(event.data);
    }

    window.addEventListener('storage', (e) => {
      if (e.key === 'pokaddicts_inventory_v1' || e.key === 'pokaddicts_sales_v1' || e.key === 'pokaddicts_binders_v1' || e.key === 'pokaddicts_events_v1' || e.key === 'pokaddicts_buybacks_v1') {
        window.db.loadFromLocalCache();
        this.notifyListeners({ type: 'DATA_REFRESH', label: 'data refreshed' });
      }
    });
  }

  handleLocalMessage(msg) {
    if (!msg || msg.roomCode !== window.db.settings.roomCode) return;
    window.db.loadFromLocalCache();
    this.notifyListeners({ type: msg.type, sender: msg.sender, label: (msg.type || '').replace(/_/g, ' ').toLowerCase() });
  }

  // Kept so existing call sites (pos.js/intake.js/trade.js) keep working
  // unchanged. With Supabase configured, real sync happens automatically
  // via the realtime subscription above, so this is only load-bearing in
  // local-only mode.
  broadcast(actionType, payload = {}) {
    if (this.localChannel) {
      this.localChannel.postMessage({
        type: actionType,
        roomCode: window.db.settings.roomCode,
        sender: window.db.settings.teamMember,
        timestamp: Date.now(),
        payload
      });
    }
  }

  onSync(callback) {
    this.listeners.push(callback);
  }

  notifyListeners(msg) {
    this.listeners.forEach(cb => cb(msg));
  }
}

window.syncManager = new PokAddictsSync();
