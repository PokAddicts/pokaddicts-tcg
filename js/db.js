/* ==========================================================================
   PokAddicts - Data Layer
   Local-first cache (localStorage) backed by Supabase for cross-device
   booth-room sync. Every mutating method below updates the in-memory
   array + localStorage cache immediately (so the UI never waits on the
   network), then fires an async upsert/delete to Supabase in the
   background. Other devices in the same room receive the change via the
   realtime subscription set up in sync.js.
   ========================================================================== */

const DB_KEY_INVENTORY = 'pokaddicts_inventory_v1';
const DB_KEY_SALES = 'pokaddicts_sales_v1';
const DB_KEY_TRADES = 'pokaddicts_trades_v1';
const DB_KEY_SETTINGS = 'pokaddicts_settings_v1';
const DB_KEY_BINDERS = 'pokaddicts_binders_v1';
const DB_KEY_EVENTS = 'pokaddicts_events_v1';
const DB_KEY_BUYBACKS = 'pokaddicts_buybacks_v1';

// --- Row <-> App object mapping (Supabase uses snake_case columns) ---

function itemFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    set: row.set_name || '',
    type: row.type || 'raw',
    gradingCompany: row.grading_company || '',
    grade: row.grade || '',
    certNumber: row.cert_number || '',
    condition: row.condition || '',
    costBasis: Number(row.cost_basis) || 0,
    marketValue: Number(row.market_value) || 0,
    askingPrice: Number(row.asking_price) || 0,
    quantity: Number(row.quantity) || 1,
    binderName: row.binder_name || '',
    catalogCardId: row.catalog_card_id || '',
    status: row.status || 'in_stock',
    acquiredDate: row.acquired_date || '',
    acquiredBy: row.acquired_by || '',
    intakeSource: row.intake_source || 'normal',
    eventTag: row.event_tag || '',
    notes: row.notes || ''
  };
}

function itemToRow(item, roomCode) {
  return {
    id: item.id,
    room_code: roomCode,
    name: item.name,
    set_name: item.set,
    type: item.type,
    grading_company: item.gradingCompany,
    grade: item.grade,
    cert_number: item.certNumber,
    condition: item.condition,
    cost_basis: item.costBasis,
    market_value: item.marketValue,
    asking_price: item.askingPrice || 0,
    quantity: item.quantity,
    binder_name: item.binderName || null,
    catalog_card_id: item.catalogCardId || null,
    status: item.status,
    acquired_date: item.acquiredDate || null,
    acquired_by: item.acquiredBy,
    intake_source: item.intakeSource || 'normal',
    event_tag: item.eventTag || null,
    notes: item.notes
  };
}

function saleFromRow(row) {
  return {
    id: row.id,
    itemId: row.item_id,
    itemName: row.item_name,
    set: row.set_name || '',
    type: row.type || '',
    grade: row.grade || '',
    salePrice: Number(row.sale_price) || 0,
    costBasis: Number(row.cost_basis) || 0,
    profit: Number(row.profit) || 0,
    marginPercent: Number(row.margin_percent) || 0,
    paymentMethod: row.payment_method || 'Cash',
    soldBy: row.sold_by || '',
    eventTag: row.event_tag || 'Normal Sale',
    quantitySold: Number(row.quantity_sold) || 1,
    date: row.date
  };
}

function saleToRow(sale, roomCode) {
  return {
    id: sale.id,
    room_code: roomCode,
    item_id: sale.itemId,
    item_name: sale.itemName,
    set_name: sale.set,
    type: sale.type,
    grade: sale.grade,
    sale_price: sale.salePrice,
    cost_basis: sale.costBasis,
    profit: sale.profit,
    margin_percent: sale.marginPercent,
    payment_method: sale.paymentMethod,
    sold_by: sale.soldBy,
    event_tag: sale.eventTag || 'Normal Sale',
    quantity_sold: sale.quantitySold || 1,
    date: sale.date
  };
}

function tradeFromRow(row) {
  return {
    id: row.id,
    date: row.date,
    givenItems: row.given_items || [],
    givenCostBasis: Number(row.given_cost_basis) || 0,
    cashDifference: Number(row.cash_difference) || 0,
    totalAcquiredCost: Number(row.total_acquired_cost) || 0,
    totalAcquiredMarketValue: Number(row.total_acquired_market_value) || 0,
    acquiredItems: row.acquired_items || [],
    handledBy: row.handled_by || '',
    eventTag: row.event_tag || 'Normal Sale'
  };
}

function tradeToRow(trade, roomCode) {
  return {
    id: trade.id,
    room_code: roomCode,
    date: trade.date,
    given_items: trade.givenItems,
    given_cost_basis: trade.givenCostBasis,
    cash_difference: trade.cashDifference,
    total_acquired_cost: trade.totalAcquiredCost,
    total_acquired_market_value: trade.totalAcquiredMarketValue || 0,
    acquired_items: trade.acquiredItems,
    handled_by: trade.handledBy,
    event_tag: trade.eventTag || 'Normal Sale'
  };
}

function binderFromRow(row) {
  return { id: row.id, name: row.name };
}

function binderToRow(binder, roomCode) {
  return { id: binder.id, room_code: roomCode, name: binder.name };
}

function eventFromRow(row) {
  return { id: row.id, name: row.name, expenses: row.expenses || 0 };
}

function eventToRow(evt, roomCode) {
  return { id: evt.id, room_code: roomCode, name: evt.name, expenses: evt.expenses || 0 };
}

function buybackFromRow(row) {
  return {
    id: row.id,
    itemId: row.item_id || '',
    itemName: row.item_name || '',
    quantity: Number(row.quantity) || 1,
    costBasis: Number(row.cost_basis) || 0,
    totalCost: Number(row.total_cost) || 0,
    eventTag: row.event_tag || 'Normal Sale',
    date: row.date
  };
}

function buybackToRow(b, roomCode) {
  return {
    id: b.id,
    room_code: roomCode,
    item_id: b.itemId || null,
    item_name: b.itemName,
    quantity: b.quantity,
    cost_basis: b.costBasis,
    total_cost: b.totalCost,
    event_tag: b.eventTag,
    date: b.date
  };
}

class PokAddictsDB {
  constructor() {
    this.inventory = [];
    this.sales = [];
    this.trades = [];
    this.binders = [];
    this.events = [];
    this.buybacks = [];
    this.settings = {
      roomCode: 'POKADDICTS-MAIN',
      teamMember: '',
      currencySymbol: '$',
      currentEventTag: 'Normal Sale',
      lastPriceRefreshDate: null
    };

    this._recentLocalWrites = new Set();

    this.loadSettingsFromLocal();
    this.ready = this.init();
  }

  // Marks a row id as "just written by this device" for a few seconds, so
  // the realtime echo of our own write doesn't trigger a duplicate
  // toast/re-render (see sync.js handleRemoteChange).
  markLocalWrite(id) {
    this._recentLocalWrites.add(id);
    setTimeout(() => this._recentLocalWrites.delete(id), 8000);
  }

  isRecentLocalWrite(id) {
    return this._recentLocalWrites.has(id);
  }

  get remote() {
    return window.supabaseClient;
  }

  loadSettingsFromLocal() {
    const rawSettings = localStorage.getItem(DB_KEY_SETTINGS);
    if (rawSettings) this.settings = { ...this.settings, ...JSON.parse(rawSettings) };
  }

  async init() {
    if (this.remote) {
      await this.loadFromRemote();
    } else {
      this.loadFromLocalCache();
    }
  }

  async loadFromRemote() {
    const room = this.settings.roomCode;
    try {
      const [invRes, saleRes, tradeRes, binderRes, eventRes, buybackRes] = await Promise.all([
        this.remote.from('inventory').select('*').eq('room_code', room).order('created_at', { ascending: false }),
        this.remote.from('sales').select('*').eq('room_code', room).order('date', { ascending: false }),
        this.remote.from('trades').select('*').eq('room_code', room).order('date', { ascending: false }),
        this.remote.from('binders').select('*').eq('room_code', room).order('created_at', { ascending: false }),
        this.remote.from('events').select('*').eq('room_code', room).order('created_at', { ascending: false }),
        this.remote.from('buybacks').select('*').eq('room_code', room).order('date', { ascending: false })
      ]);

      if (invRes.error) throw invRes.error;
      if (saleRes.error) throw saleRes.error;
      if (tradeRes.error) throw tradeRes.error;
      if (binderRes.error) throw binderRes.error;
      if (eventRes.error) throw eventRes.error;
      if (buybackRes.error) throw buybackRes.error;

      this.inventory = (invRes.data || []).map(itemFromRow);
      this.sales = (saleRes.data || []).map(saleFromRow);
      this.trades = (tradeRes.data || []).map(tradeFromRow);
      this.binders = (binderRes.data || []).map(binderFromRow);
      this.events = (eventRes.data || []).map(eventFromRow);
      this.buybacks = (buybackRes.data || []).map(buybackFromRow);

      this.cacheLocally();
    } catch (err) {
      console.error('Supabase load failed, falling back to local cache:', err);
      window.app?.showToast('⚠️ Could not reach server - showing cached data');
      this.loadFromLocalCache();
    }
  }

  loadFromLocalCache() {
    const rawInv = localStorage.getItem(DB_KEY_INVENTORY);
    const rawSales = localStorage.getItem(DB_KEY_SALES);
    const rawTrades = localStorage.getItem(DB_KEY_TRADES);
    const rawBinders = localStorage.getItem(DB_KEY_BINDERS);
    const rawEvents = localStorage.getItem(DB_KEY_EVENTS);
    const rawBuybacks = localStorage.getItem(DB_KEY_BUYBACKS);

    if (rawInv) {
      this.inventory = JSON.parse(rawInv);
    } else if (!this.remote) {
      // Only seed demo cards in pure local/offline mode - a fresh Supabase
      // room should start genuinely empty.
      this.seedInitialInventory();
    } else {
      this.inventory = [];
    }

    this.sales = rawSales ? JSON.parse(rawSales) : [];
    this.trades = rawTrades ? JSON.parse(rawTrades) : [];
    this.binders = rawBinders ? JSON.parse(rawBinders) : [];
    this.events = rawEvents ? JSON.parse(rawEvents) : [];
    this.buybacks = rawBuybacks ? JSON.parse(rawBuybacks) : [];
  }

  seedInitialInventory() {
    this.inventory = [
      {
        id: 'item-1',
        name: 'Charizard ex #199 SIR',
        set: 'Scarlet & Violet: 151',
        type: 'slab',
        gradingCompany: 'PSA',
        grade: '10 GEM MT',
        certNumber: '78912345',
        condition: 'GEM MT',
        costBasis: 150.00,
        marketValue: 215.00,
        status: 'in_stock',
        acquiredDate: '2026-07-20',
        acquiredBy: 'H.C (Owner)',
        notes: 'Acquired at Dallas Card Show'
      },
      {
        id: 'item-2',
        name: 'Umbreon VMAX Alt Art #215',
        set: 'Evolving Skies',
        type: 'slab',
        gradingCompany: 'PSA',
        grade: '10 GEM MT',
        certNumber: '65498712',
        condition: 'GEM MT',
        costBasis: 600.00,
        marketValue: 950.00,
        status: 'in_stock',
        acquiredDate: '2026-07-22',
        acquiredBy: 'Alex (Team)',
        notes: 'Grail card'
      },
      {
        id: 'item-3',
        name: 'Gengar VMAX Alt Art #271',
        set: 'Fusion Strike',
        type: 'raw',
        gradingCompany: 'Raw',
        grade: 'NM',
        certNumber: '',
        condition: 'Near Mint',
        costBasis: 180.00,
        marketValue: 240.00,
        status: 'in_stock',
        acquiredDate: '2026-07-25',
        acquiredBy: 'H.C (Owner)',
        notes: 'Raw NM trade-in'
      },
      {
        id: 'item-4',
        name: 'Evolving Skies Booster Box',
        set: 'Evolving Skies',
        type: 'sealed',
        gradingCompany: 'Sealed',
        grade: 'Sealed Product',
        certNumber: 'BOX-EVO-01',
        condition: 'New',
        costBasis: 380.00,
        marketValue: 720.00,
        status: 'in_stock',
        acquiredDate: '2026-06-10',
        acquiredBy: 'H.C (Owner)',
        notes: 'Purchased 2022 case hold'
      },
      {
        id: 'item-5',
        name: 'Pikachu Van Gogh Grey Felt Hat',
        set: 'SVP Promo',
        type: 'slab',
        gradingCompany: 'CGC',
        grade: '9.5 MINT+',
        certNumber: '54321678',
        condition: 'MINT+',
        costBasis: 70.00,
        marketValue: 165.00,
        status: 'in_stock',
        acquiredDate: '2026-07-24',
        acquiredBy: 'Alex (Team)',
        notes: 'Self-submitted slab'
      }
    ];

    this.sales = [
      {
        id: 'sale-101',
        itemId: 'item-sold-demo',
        itemName: 'Blastoise ex #200 SIR',
        salePrice: 95.00,
        costBasis: 50.00,
        profit: 45.00,
        marginPercent: 47.37,
        paymentMethod: 'Cash',
        soldBy: 'H.C (Owner)',
        eventTag: 'Normal Sale',
        date: '2026-07-27T14:30:00.000Z'
      }
    ];

    this.cacheLocally();
  }

  cacheLocally() {
    localStorage.setItem(DB_KEY_INVENTORY, JSON.stringify(this.inventory));
    localStorage.setItem(DB_KEY_SALES, JSON.stringify(this.sales));
    localStorage.setItem(DB_KEY_TRADES, JSON.stringify(this.trades));
    localStorage.setItem(DB_KEY_BINDERS, JSON.stringify(this.binders));
    localStorage.setItem(DB_KEY_EVENTS, JSON.stringify(this.events));
    localStorage.setItem(DB_KEY_BUYBACKS, JSON.stringify(this.buybacks));
  }

  saveSettings() {
    localStorage.setItem(DB_KEY_SETTINGS, JSON.stringify(this.settings));
  }

  // --- Background persistence to Supabase (fire-and-forget) ---

  pushInventoryUpsert(item) {
    if (!this.remote) return;
    this.markLocalWrite(item.id);
    this.remote.from('inventory').upsert(itemToRow(item, this.settings.roomCode))
      .then(({ error }) => { if (error) this.warnSyncFailure(error); });
  }

  pushInventoryDelete(id) {
    if (!this.remote) return;
    this.markLocalWrite(id);
    this.remote.from('inventory').delete().eq('id', id)
      .then(({ error }) => { if (error) this.warnSyncFailure(error); });
  }

  pushSaleInsert(sale) {
    if (!this.remote) return;
    this.markLocalWrite(sale.id);
    this.remote.from('sales').insert(saleToRow(sale, this.settings.roomCode))
      .then(({ error }) => { if (error) this.warnSyncFailure(error); });
  }

  pushTradeInsert(trade) {
    if (!this.remote) return;
    this.markLocalWrite(trade.id);
    this.remote.from('trades').insert(tradeToRow(trade, this.settings.roomCode))
      .then(({ error }) => { if (error) this.warnSyncFailure(error); });
  }

  pushBinderUpsert(binder) {
    if (!this.remote) return;
    this.markLocalWrite(binder.id);
    this.remote.from('binders').upsert(binderToRow(binder, this.settings.roomCode))
      .then(({ error }) => { if (error) this.warnSyncFailure(error); });
  }

  pushEventUpsert(evt) {
    if (!this.remote) return;
    this.markLocalWrite(evt.id);
    this.remote.from('events').upsert(eventToRow(evt, this.settings.roomCode))
      .then(({ error }) => { if (error) this.warnSyncFailure(error); });
  }

  pushBuybackInsert(buyback) {
    if (!this.remote) return;
    this.markLocalWrite(buyback.id);
    this.remote.from('buybacks').insert(buybackToRow(buyback, this.settings.roomCode))
      .then(({ error }) => { if (error) this.warnSyncFailure(error); });
  }

  warnSyncFailure(error) {
    console.error('Supabase sync failed (change saved locally only):', error);
    window.app?.showToast('⚠️ Sync failed - change saved locally only');
  }

  // --- Realtime merge helpers (called from sync.js on incoming events) ---

  mergeRemoteInventoryChange(eventType, row) {
    if (eventType === 'DELETE') {
      this.inventory = this.inventory.filter(i => i.id !== row.id);
    } else {
      const item = itemFromRow(row);
      const idx = this.inventory.findIndex(i => i.id === item.id);
      if (idx !== -1) this.inventory[idx] = item;
      else this.inventory.unshift(item);
    }
    this.cacheLocally();
  }

  mergeRemoteSaleChange(eventType, row) {
    if (eventType === 'DELETE') {
      this.sales = this.sales.filter(s => s.id !== row.id);
    } else {
      const sale = saleFromRow(row);
      const idx = this.sales.findIndex(s => s.id === sale.id);
      if (idx !== -1) this.sales[idx] = sale;
      else this.sales.unshift(sale);
    }
    this.cacheLocally();
  }

  mergeRemoteTradeChange(eventType, row) {
    if (eventType === 'DELETE') {
      this.trades = this.trades.filter(t => t.id !== row.id);
    } else {
      const trade = tradeFromRow(row);
      const idx = this.trades.findIndex(t => t.id === trade.id);
      if (idx !== -1) this.trades[idx] = trade;
      else this.trades.unshift(trade);
    }
    this.cacheLocally();
  }

  mergeRemoteBinderChange(eventType, row) {
    if (eventType === 'DELETE') {
      this.binders = this.binders.filter(b => b.id !== row.id);
    } else {
      const binder = binderFromRow(row);
      const idx = this.binders.findIndex(b => b.id === binder.id);
      if (idx !== -1) this.binders[idx] = binder;
      else this.binders.push(binder);
    }
    this.cacheLocally();
  }

  mergeRemoteEventChange(eventType, row) {
    if (eventType === 'DELETE') {
      this.events = this.events.filter(e => e.id !== row.id);
    } else {
      const evt = eventFromRow(row);
      const idx = this.events.findIndex(e => e.id === evt.id);
      if (idx !== -1) this.events[idx] = evt;
      else this.events.push(evt);
    }
    this.cacheLocally();
  }

  mergeRemoteBuybackChange(eventType, row) {
    if (eventType === 'DELETE') {
      this.buybacks = this.buybacks.filter(b => b.id !== row.id);
    } else {
      const buyback = buybackFromRow(row);
      const idx = this.buybacks.findIndex(b => b.id === buyback.id);
      if (idx !== -1) this.buybacks[idx] = buyback;
      else this.buybacks.unshift(buyback);
    }
    this.cacheLocally();
  }

  // --- Binders ---

  addBinder(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;

    const existing = this.binders.find(b => b.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;

    const newBinder = { id: 'binder-' + Date.now() + '-' + Math.floor(Math.random() * 1000), name: trimmed };
    this.binders.push(newBinder);
    this.cacheLocally();
    this.pushBinderUpsert(newBinder);
    return newBinder;
  }

  // --- Events (Tradeshows) ---

  addEvent(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;

    const existing = this.events.find(e => e.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;

    const newEvent = { id: 'event-' + Date.now() + '-' + Math.floor(Math.random() * 1000), name: trimmed, expenses: 0 };
    this.events.push(newEvent);
    this.cacheLocally();
    this.pushEventUpsert(newEvent);
    return newEvent;
  }

  // Booth fee + travel + table rental etc., entered as one lump sum per
  // tradeshow - netted against gross profit in getEventMetrics() so
  // "profitable" tradeshows actually account for the cost of attending.
  updateEventExpenses(eventId, expenses) {
    const evt = this.events.find(e => e.id === eventId);
    if (!evt) return null;

    evt.expenses = parseFloat(expenses) || 0;
    this.cacheLocally();
    this.pushEventUpsert(evt);
    return evt;
  }

  // Per-binder rollup for the Inventory page: includes binders with zero
  // items yet (freshly created) as well as any legacy binder names found
  // only on inventory items. Counts BOTH price-tier pools and individually
  // tracked singles that have been assigned to a binder.
  getBinderMetrics() {
    const groups = {};

    this.binders.forEach(b => {
      groups[b.name] = { binderName: b.name, itemCount: 0, totalQuantity: 0, totalCostValue: 0, totalMarketValue: 0 };
    });

    this.inventory.forEach(item => {
      if (!item.binderName || item.status !== 'in_stock') return;
      if (!groups[item.binderName]) {
        groups[item.binderName] = { binderName: item.binderName, itemCount: 0, totalQuantity: 0, totalCostValue: 0, totalMarketValue: 0 };
      }
      const g = groups[item.binderName];
      const qty = item.quantity || 1;
      g.itemCount += 1;
      g.totalQuantity += qty;
      g.totalCostValue += item.costBasis * qty;
      g.totalMarketValue += item.marketValue * qty;
    });

    return Object.values(groups).sort((a, b) => a.binderName.localeCompare(b.binderName));
  }

  // --- CRUD Operations ---

  getInventory(filters = {}) {
    let list = [...this.inventory];
    if (filters.status) {
      list = list.filter(i => i.status === filters.status);
    }
    if (filters.type && filters.type !== 'all') {
      list = list.filter(i => i.type === filters.type);
    }
    if (filters.binderName) {
      list = list.filter(i => i.binderName === filters.binderName);
    }
    if (filters.query) {
      const q = filters.query.toLowerCase();
      list = list.filter(i =>
        i.name.toLowerCase().includes(q) ||
        i.set.toLowerCase().includes(q) ||
        (i.certNumber && i.certNumber.toLowerCase().includes(q))
      );
    }
    return list;
  }

  getItemById(id) {
    return this.inventory.find(i => i.id === id);
  }

  addItem(item) {
    const newItem = {
      id: 'item-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      name: item.name || 'Unnamed Card',
      set: item.set || 'Unknown Set',
      type: item.type || 'raw',
      gradingCompany: item.gradingCompany || (item.type === 'slab' ? 'PSA' : 'Raw'),
      grade: item.grade || (item.type === 'slab' ? '10 GEM MT' : 'NM'),
      certNumber: item.certNumber || '',
      condition: item.condition || 'Near Mint',
      costBasis: parseFloat(item.costBasis) || 0.00,
      marketValue: parseFloat(item.marketValue) || parseFloat(item.costBasis) || 0.00,
      // What you actually intend to sell it for (what POS prefills) -
      // defaults to market value if left blank, but can diverge for
      // vintage cards where the live market estimate may be unreliable.
      askingPrice: parseFloat(item.askingPrice) || parseFloat(item.marketValue) || parseFloat(item.costBasis) || 0.00,
      quantity: parseInt(item.quantity, 10) || 1,
      binderName: item.binderName || '',
      catalogCardId: item.catalogCardId || '',
      status: 'in_stock',
      acquiredDate: new Date().toISOString().split('T')[0],
      acquiredBy: this.settings.teamMember,
      // 'buyback' = cash paid to a customer at a tradeshow to reacquire a
      // card - the item itself just carries this as informational context
      // (how it originated); the actual per-tradeshow spend accounting
      // lives in the separate buybacks ledger below, since this row can be
      // restocked/resold repeatedly afterward and would otherwise become
      // an inaccurate running total.
      intakeSource: item.intakeSource === 'buyback' ? 'buyback' : 'normal',
      eventTag: item.intakeSource === 'buyback' ? this.resolveEventTag(item.eventTag) : '',
      notes: item.notes || ''
    };

    this.inventory.unshift(newItem);
    this.cacheLocally();
    this.pushInventoryUpsert(newItem);

    if (newItem.intakeSource === 'buyback') {
      this.recordBuyback({
        itemId: newItem.id,
        itemName: newItem.name,
        quantity: newItem.quantity,
        costBasis: newItem.costBasis,
        eventTag: newItem.eventTag
      });
    }

    return newItem;
  }

  updateItem(id, updates) {
    const idx = this.inventory.findIndex(i => i.id === id);
    if (idx !== -1) {
      this.inventory[idx] = { ...this.inventory[idx], ...updates };
      this.cacheLocally();
      this.pushInventoryUpsert(this.inventory[idx]);
      return this.inventory[idx];
    }
    return null;
  }

  deleteItem(id) {
    this.inventory = this.inventory.filter(i => i.id !== id);
    this.cacheLocally();
    this.pushInventoryDelete(id);
  }

  // Adds more units of an existing item (bought at a possibly different
  // price - e.g. the same set restocked weeks later at a new market
  // price). Rather than creating a near-duplicate row, this blends the new
  // batch into the existing cost basis via weighted average - the
  // standard costing approach for fungible/bulk stock where you can't
  // tell which physical unit later sells. addCost is per-unit; if omitted,
  // the existing cost basis is just carried forward unchanged.
  // Pass { intakeSource: 'buyback', eventTag } when this top-up is a
  // customer buyback (e.g. adding cards into an existing binder price
  // tier) so it's logged to the buybacks ledger for tradeshow accounting.
  restockItem(itemId, addQty, addCost, { intakeSource, eventTag } = {}) {
    const item = this.getItemById(itemId);
    if (!item) return null;

    const qty = parseInt(addQty, 10) || 0;
    if (qty <= 0) return null;

    const existingQty = item.quantity || 1;
    const existingCost = item.costBasis || 0;
    const newCost = parseFloat(addCost);
    const batchCost = isNaN(newCost) ? existingCost : newCost;
    const blendedCost = ((existingQty * existingCost) + (qty * batchCost)) / (existingQty + qty);

    const updated = this.updateItem(itemId, {
      quantity: existingQty + qty,
      costBasis: parseFloat(blendedCost.toFixed(2))
    });

    if (intakeSource === 'buyback' && updated) {
      this.recordBuyback({
        itemId: updated.id,
        itemName: updated.name,
        quantity: qty,
        costBasis: batchCost,
        eventTag: this.resolveEventTag(eventTag)
      });
    }

    return updated;
  }

  // One immutable ledger row per buyback action (creating a new item/tier
  // as a buyback, or topping up an existing one as one) - kept separate
  // from the mutable inventory table so per-tradeshow buyback spend stays
  // accurate even as the item itself gets restocked/resold afterward.
  recordBuyback({ itemId = '', itemName, quantity, costBasis, eventTag }) {
    const qty = parseInt(quantity, 10) || 1;
    const cost = parseFloat(costBasis) || 0;

    const buyback = {
      id: 'buyback-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      itemId,
      itemName: itemName || 'Unknown Item',
      quantity: qty,
      costBasis: cost,
      totalCost: parseFloat((cost * qty).toFixed(2)),
      eventTag: this.resolveEventTag(eventTag),
      date: new Date().toISOString()
    };

    this.buybacks.unshift(buyback);
    this.cacheLocally();
    this.pushBuybackInsert(buyback);
    return buyback;
  }

  // --- POS Quick Sale ---

  // salePrice is the TOTAL received for quantitySold units (so a bundled/
  // discounted sale of several binder cards is just one entry: e.g. 3
  // cards for $8 instead of their $10 combined list price). For normal
  // single items quantitySold stays 1 and this behaves as before.
  recordSale(itemId, salePrice, paymentMethod = 'Cash', eventTag = null, quantitySold = 1) {
    const item = this.getItemById(itemId);
    if (!item) return null;

    const qty = Math.max(1, Math.min(parseInt(quantitySold, 10) || 1, item.quantity || 1));
    const price = parseFloat(salePrice);
    const cost = item.costBasis * qty;
    const profit = price - cost;
    const margin = price > 0 ? (profit / price) * 100 : 0;

    const resolvedEventTag = this.resolveEventTag(eventTag);

    const saleRecord = {
      id: 'sale-' + Date.now(),
      itemId: item.id,
      itemName: item.name,
      set: item.set,
      type: item.type,
      grade: item.grade,
      salePrice: price,
      costBasis: cost,
      profit: profit,
      marginPercent: parseFloat(margin.toFixed(2)),
      paymentMethod: paymentMethod,
      soldBy: this.settings.teamMember,
      eventTag: resolvedEventTag,
      quantitySold: qty,
      date: new Date().toISOString()
    };

    // Deduct the sold quantity; only mark fully "sold" once the pool is depleted.
    const remaining = (item.quantity || 1) - qty;
    this.updateItem(itemId, {
      quantity: Math.max(0, remaining),
      status: remaining > 0 ? 'in_stock' : 'sold'
    });

    this.sales.unshift(saleRecord);
    this.cacheLocally();
    this.pushSaleInsert(saleRecord);

    return saleRecord;
  }

  // Resolves the event tag to use for a sale/trade, and - if it's a new
  // tag - remembers it as this device's default so the next sale/trade
  // stays tagged to the same tradeshow without re-selecting it.
  resolveEventTag(eventTag) {
    const resolved = (eventTag && eventTag.trim()) || this.settings.currentEventTag || 'Normal Sale';
    if (resolved !== this.settings.currentEventTag) {
      this.settings.currentEventTag = resolved;
      this.saveSettings();
    }
    return resolved;
  }

  // --- Trade Execution Engine ---

  // givenItems is [{ itemId, quantity }] - quantity lets a binder tier give
  // away only part of its remaining pool instead of the whole thing.
  executeTrade({ givenItems, acquiredItems, cashDifference, eventTag = null }) {
    // cashDifference > 0 means dealer PAID cash out to customer
    // cashDifference < 0 means dealer RECEIVED cash top-up from customer
    const cashDiffNum = parseFloat(cashDifference) || 0;
    const resolvedEventTag = this.resolveEventTag(eventTag);

    // Calculate total cost basis of given items
    let totalGivenCostBasis = 0;
    const givenItemsSummary = [];

    givenItems.forEach(({ itemId, quantity }) => {
      const item = this.getItemById(itemId);
      if (!item) return;

      const qtyToGive = Math.max(1, Math.min(parseInt(quantity, 10) || 1, item.quantity || 1));
      totalGivenCostBasis += item.costBasis * qtyToGive;
      givenItemsSummary.push(`${item.name}${qtyToGive > 1 ? ` x${qtyToGive}` : ''} (${item.grade || item.type})`);

      // Deduct the given quantity; only mark fully "traded_out" once the pool is depleted.
      const remaining = (item.quantity || 1) - qtyToGive;
      this.updateItem(itemId, {
        quantity: Math.max(0, remaining),
        status: remaining > 0 ? 'in_stock' : 'traded_out'
      });
    });

    // Effective total cost invested into acquired items
    const totalEffectiveCost = totalGivenCostBasis + cashDiffNum;

    // Calculate total market value of acquired items for weighted cost allocation
    const totalAcquiredMktValue = acquiredItems.reduce((acc, curr) => acc + (parseFloat(curr.marketValue) || 0), 0);

    const newlyAcquiredItems = [];

    acquiredItems.forEach(acq => {
      const mkt = parseFloat(acq.marketValue) || 1;
      let allocatedCost = 0;
      if (totalAcquiredMktValue > 0) {
        allocatedCost = (mkt / totalAcquiredMktValue) * totalEffectiveCost;
      } else {
        allocatedCost = totalEffectiveCost / acquiredItems.length;
      }

      if (allocatedCost < 0) allocatedCost = 0; // Safeguard

      const added = this.addItem({
        ...acq,
        costBasis: parseFloat(allocatedCost.toFixed(2)),
        notes: `Acquired in Trade #${Date.now().toString().slice(-4)}`
      });

      newlyAcquiredItems.push(added);
    });

    // Log trade in trade ledger
    const tradeRecord = {
      id: 'trade-' + Date.now(),
      date: new Date().toISOString(),
      givenItems: givenItemsSummary,
      givenCostBasis: totalGivenCostBasis,
      cashDifference: cashDiffNum,
      totalAcquiredCost: totalEffectiveCost,
      totalAcquiredMarketValue: totalAcquiredMktValue,
      acquiredItems: newlyAcquiredItems.map(i => i.name),
      handledBy: this.settings.teamMember,
      eventTag: resolvedEventTag
    };

    this.trades.unshift(tradeRecord);
    this.cacheLocally();
    this.pushTradeInsert(tradeRecord);

    return { tradeRecord, newlyAcquiredItems };
  }

  // --- Metrics Analytics ---

  getMetrics() {
    const inStock = this.inventory.filter(i => i.status === 'in_stock');

    // costBasis/marketValue are per-unit - weight by quantity so binder
    // tiers (quantity > 1) count their full remaining pool, not just 1 card.
    const totalCostBasis = inStock.reduce((sum, item) => sum + item.costBasis * (item.quantity || 1), 0);
    const totalMarketValue = inStock.reduce((sum, item) => sum + item.marketValue * (item.quantity || 1), 0);
    const unrealizedGain = totalMarketValue - totalCostBasis;

    const totalRealizedProfit = this.sales.reduce((sum, sale) => sum + sale.profit, 0);
    const totalRevenue = this.sales.reduce((sum, sale) => sum + sale.salePrice, 0);
    const overallMargin = totalRevenue > 0 ? (totalRealizedProfit / totalRevenue) * 100 : 0;

    return {
      totalItemsCount: inStock.length,
      totalCostBasis,
      totalMarketValue,
      unrealizedGain,
      totalRealizedProfit,
      totalRevenue,
      overallMargin: parseFloat(overallMargin.toFixed(1))
    };
  }

  // --- Tradeshow / Event Tagging ---

  // Names of created events (newest first), plus any legacy tags found only
  // on sales/trades, always including "Normal Sale" for non-tradeshow activity.
  getEventTags() {
    const eventNames = this.events.map(e => e.name).reverse();

    const legacyTags = new Set();
    this.sales.forEach(s => legacyTags.add(s.eventTag || 'Normal Sale'));
    this.trades.forEach(t => legacyTags.add(t.eventTag || 'Normal Sale'));
    this.buybacks.forEach(b => legacyTags.add(b.eventTag || 'Normal Sale'));

    const tags = [...eventNames];
    legacyTags.forEach(tag => { if (!tags.includes(tag)) tags.push(tag); });

    if (!tags.includes('Normal Sale')) tags.unshift('Normal Sale');
    if (!tags.includes(this.settings.currentEventTag)) tags.unshift(this.settings.currentEventTag);

    return tags;
  }

  // Aggregated performance per tradeshow/event tag, combining both sales
  // and trades. Includes events with zero activity yet (freshly created)
  // so a new tradeshow shows up immediately, ready to use.
  getEventMetrics() {
    const groups = {};

    this.events.forEach(e => {
      groups[e.name] = {
        eventTag: e.name, eventId: e.id, expenses: e.expenses || 0,
        salesCount: 0, totalRevenue: 0, totalProfit: 0,
        tradesCount: 0, totalTradeCost: 0,
        buybackCount: 0, totalBuybackCost: 0,
        firstActivityDate: null, lastActivityDate: null
      };
    });

    const touch = (tag, date) => {
      if (!groups[tag]) {
        // Legacy tag with no matching created Event row (e.g. "Normal
        // Sale") - no id, so expenses can't be tracked/edited for it.
        groups[tag] = {
          eventTag: tag, eventId: null, expenses: 0,
          salesCount: 0, totalRevenue: 0, totalProfit: 0,
          tradesCount: 0, totalTradeCost: 0,
          buybackCount: 0, totalBuybackCost: 0,
          firstActivityDate: null, lastActivityDate: null
        };
      }
      const g = groups[tag];
      if (!g.firstActivityDate || new Date(date) < new Date(g.firstActivityDate)) g.firstActivityDate = date;
      if (!g.lastActivityDate || new Date(date) > new Date(g.lastActivityDate)) g.lastActivityDate = date;
      return g;
    };

    this.sales.forEach(s => {
      const g = touch(s.eventTag || 'Normal Sale', s.date);
      g.salesCount += 1;
      g.totalRevenue += s.salePrice;
      g.totalProfit += s.profit;
    });

    this.trades.forEach(t => {
      const g = touch(t.eventTag || 'Normal Sale', t.date);
      g.tradesCount += 1;
      g.totalTradeCost += t.givenCostBasis || 0;
    });

    // Cash paid out to customers to buy back cards at a tradeshow - a
    // separate spend metric from booth expenses (this money becomes
    // resellable inventory, not a sunk cost), so it's tracked but not
    // netted into totalProfit/netProfit below. Sourced from the immutable
    // buybacks ledger (not the mutable inventory table) so the total stays
    // accurate even after the item it created is later restocked or sold.
    this.buybacks.forEach(b => {
      const g = touch(b.eventTag || 'Normal Sale', b.date);
      g.buybackCount += 1;
      g.totalBuybackCost += b.totalCost;
    });

    return Object.values(groups)
      .map(g => ({
        ...g,
        marginPercent: g.totalRevenue > 0 ? parseFloat(((g.totalProfit / g.totalRevenue) * 100).toFixed(1)) : 0,
        // Net profit accounts for booth fee/travel/table rental, unlike
        // totalProfit above which only nets card cost basis - a show can
        // look profitable on totalProfit alone while losing money once
        // the cost of attending is included.
        netProfit: g.totalProfit - (g.expenses || 0),
        roiPercent: g.expenses > 0 ? parseFloat((((g.totalProfit - g.expenses) / g.expenses) * 100).toFixed(1)) : null
      }))
      // Events with no activity yet (null date) sort to the top - they're
      // freshly created and likely the one you're about to use.
      .sort((a, b) => new Date(b.lastActivityDate || 8640000000000000) - new Date(a.lastActivityDate || 8640000000000000));
  }

  // Top items by revenue for a single tradeshow - lets you see what
  // actually sold well at a given show, to inform what to bring next time.
  getTopSellersForEvent(eventTag, limit = 5) {
    const groups = {};

    this.sales
      .filter(s => (s.eventTag || 'Normal Sale') === eventTag)
      .forEach(s => {
        const key = s.itemName || 'Unknown Item';
        if (!groups[key]) groups[key] = { itemName: key, quantitySold: 0, totalRevenue: 0, totalProfit: 0 };
        const g = groups[key];
        g.quantitySold += s.quantitySold || 1;
        g.totalRevenue += s.salePrice;
        g.totalProfit += s.profit;
      });

    return Object.values(groups)
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, limit);
  }

  // --- Daily Market Price Refresh ---

  // Once per calendar day (best-effort), refreshes marketValue for every
  // in-stock item that was added via the card catalog search, so listed
  // prices stay current without manual re-entry. Paced with a delay
  // between requests to stay well under the PokeWallet free-tier rate
  // limit even if run alongside catalog sync.
  async refreshInventoryPricesIfDue() {
    if (!window.pokeWalletClient?.configured) return;

    const today = new Date().toISOString().split('T')[0];
    if (this.settings.lastPriceRefreshDate === today) return;

    // Mark as done for today up front, so a failed/interrupted run
    // doesn't retry in a loop on every page load - it'll just try again
    // tomorrow.
    this.settings.lastPriceRefreshDate = today;
    this.saveSettings();

    const itemsToRefresh = this.inventory.filter(i => i.status === 'in_stock' && i.catalogCardId);
    if (itemsToRefresh.length === 0) return;

    let updatedCount = 0;
    for (const item of itemsToRefresh) {
      try {
        const { price } = await window.cardCatalog.fetchLivePrice(item.catalogCardId);
        if (price > 0 && price !== item.marketValue) {
          this.updateItem(item.id, { marketValue: price });
          updatedCount += 1;
        }
      } catch (err) {
        console.warn(`Daily price refresh failed for "${item.name}":`, err);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    if (updatedCount > 0) {
      window.app?.showToast(`📈 Updated market prices for ${updatedCount} card${updatedCount === 1 ? '' : 's'}`);
      window.app?.renderAllPages();
    }
  }

  // --- CSV Export Tool ---

  exportInventoryCSV() {
    const headers = ['ID', 'Name', 'Set', 'Type', 'Grading Firm', 'Grade', 'Cert #', 'Cost Basis ($/ea)', 'Market Value ($/ea)', 'Qty', 'Binder', 'Status', 'Acquired Date', 'Acquired By'];
    const rows = this.inventory.map(i => [
      i.id,
      `"${i.name.replace(/"/g, '""')}"`,
      `"${i.set.replace(/"/g, '""')}"`,
      i.type,
      i.gradingCompany,
      i.grade,
      i.certNumber || '',
      i.costBasis.toFixed(2),
      i.marketValue.toFixed(2),
      i.quantity || 1,
      `"${(i.binderName || '').replace(/"/g, '""')}"`,
      i.status,
      i.acquiredDate,
      i.acquiredBy
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `PokAddicts_Inventory_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // --- Demo Data (for trying out features) ---

  // Populates a realistic dataset through the same public methods real
  // usage goes through (addItem, recordSale, executeTrade, etc.), so it
  // exercises actual app logic rather than hand-crafting rows. Safe to run
  // more than once - addBinder/addEvent dedupe by name, but items/sales/
  // trades/buybacks are always added fresh, so repeated runs will pile up
  // extra inventory (acceptable for a "load some test data" tool).
  seedDemoData() {
    const binderA = this.addBinder('Bulk Rares Binder');
    const binderB = this.addBinder('Jap AR Binder');

    const eventA = this.addEvent('Sample Tradeshow');
    const eventB = this.addEvent('Sample Comic Con');
    this.updateEventExpenses(eventA.id, 60);

    // Normal intake - raw, slab, sealed (with quantity)
    const charizard = this.addItem({
      name: 'Charizard ex #199 SIR', set: 'Scarlet & Violet: 151', type: 'slab',
      gradingCompany: 'PSA', grade: '10 GEM MT', certNumber: '78912345',
      costBasis: 150, marketValue: 215, askingPrice: 210
    });

    const gengar = this.addItem({
      name: 'Gengar VMAX Alt Art #271', set: 'Fusion Strike', type: 'raw',
      condition: 'Near Mint', costBasis: 180, marketValue: 240, askingPrice: 235
    });

    this.addItem({
      name: 'Evolving Skies Booster Box', set: 'Evolving Skies', type: 'sealed',
      costBasis: 380, marketValue: 720, askingPrice: 700, quantity: 5
    });

    // Buyback intake - a slab bought back from a customer at the Sample Tradeshow
    this.addItem({
      name: 'Umbreon VMAX Alt Art #215', set: 'Evolving Skies', type: 'slab',
      gradingCompany: 'PSA', grade: '10 GEM MT', certNumber: '65498712',
      costBasis: 520, marketValue: 950, askingPrice: 900,
      intakeSource: 'buyback', eventTag: eventA.name
    });

    // Binder tier - created normally, then topped up via a buyback at a
    // different per-card cost (exercises the weighted-average blending).
    const tier = this.addItem({
      name: '$1-$5 Tier', set: 'Binder Singles', type: 'binder_tier',
      binderName: binderA.name, quantity: 80, costBasis: 2, marketValue: 4,
      notes: `Binder tier intake: ${binderA.name}`
    });
    this.restockItem(tier.id, 30, 3.5, { intakeSource: 'buyback', eventTag: eventA.name });

    this.addItem({
      name: 'Jap AR Tier', set: 'Binder Singles', type: 'binder_tier',
      binderName: binderB.name, quantity: 40, costBasis: 3, marketValue: 6,
      notes: `Binder tier intake: ${binderB.name}`
    });

    // A completed sale, tagged to the Sample Tradeshow
    this.recordSale(charizard.id, 220, 'Cash', eventA.name, 1);

    // A trade, tagged to the other event
    this.executeTrade({
      givenItems: [{ itemId: gengar.id, quantity: 1 }],
      acquiredItems: [{ name: 'Pikachu ex #238', marketValue: 260, type: 'raw', gradingCompany: 'Raw', grade: 'NM', condition: 'Near Mint' }],
      cashDifference: 20,
      eventTag: eventB.name
    });
  }
}

window.db = new PokAddictsDB();
