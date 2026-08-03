-- PokAddicts booth sync schema.
-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New Query -> Run).

create table if not exists inventory (
  id text primary key,
  room_code text not null,
  name text not null,
  set_name text,
  type text not null default 'raw',
  grading_company text,
  grade text,
  cert_number text,
  condition text,
  cost_basis numeric not null default 0, -- per-unit cost (matters for binder_tier rows where quantity > 1)
  market_value numeric not null default 0, -- per-unit estimated resale value
  asking_price numeric not null default 0, -- per-unit price you actually intend to sell at; defaults to market_value but can diverge (e.g. vintage cards where the live market estimate is unreliable) - this is what POS prefills, not market_value
  quantity integer not null default 1, -- remaining count; binder_tier rows start > 1 and count down as cards sell/trade out
  binder_name text, -- which binder this tier belongs to (null for normal single-card/slab/sealed items)
  catalog_card_id text, -- PokeWallet card id, set when added via card search - enables the daily price refresh
  status text not null default 'in_stock',
  acquired_date date,
  acquired_by text,
  intake_source text not null default 'normal', -- 'normal' | 'buyback' - cash paid to a customer to buy back a card at a tradeshow, tracked separately from your own restocking
  event_tag text, -- which tradeshow this buyback happened at (only set when intake_source = 'buyback')
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists inventory_room_code_idx on inventory(room_code);

-- If you already ran this schema before binder-tier tracking / card catalog
-- search was added, run just these lines against your existing database
-- instead:
-- alter table inventory add column if not exists quantity integer not null default 1;
-- alter table inventory add column if not exists binder_name text;
-- alter table inventory add column if not exists catalog_card_id text;

-- If you already ran this schema before the separate "selling price" field
-- was added, run just this against your existing database instead:
-- alter table inventory add column if not exists asking_price numeric not null default 0;

-- If you already ran this schema before buyback tracking was added, run
-- just this against your existing database instead:
-- alter table inventory add column if not exists intake_source text not null default 'normal';
-- alter table inventory add column if not exists event_tag text;

create table if not exists sales (
  id text primary key,
  room_code text not null,
  item_id text,
  item_name text,
  set_name text,
  type text,
  grade text,
  sale_price numeric not null default 0,
  cost_basis numeric not null default 0,
  profit numeric not null default 0,
  margin_percent numeric,
  payment_method text,
  sold_by text,
  event_tag text not null default 'Normal Sale',
  quantity_sold integer not null default 1, -- >1 for a bundled/discounted binder-tier sale (sale_price is the TOTAL for this quantity)
  date timestamptz not null default now()
);
create index if not exists sales_room_code_idx on sales(room_code);

-- If you already ran this schema before event tagging / binder tiers were
-- added, run these lines against your existing database instead of the
-- create table above:
-- alter table sales add column if not exists event_tag text not null default 'Normal Sale';
-- alter table sales add column if not exists quantity_sold integer not null default 1;

create table if not exists trades (
  id text primary key,
  room_code text not null,
  date timestamptz not null default now(),
  given_items jsonb,
  given_cost_basis numeric,
  cash_difference numeric,
  total_acquired_cost numeric,
  total_acquired_market_value numeric not null default 0, -- snapshot of received items' market value, for unrealized profit
  acquired_items jsonb,
  handled_by text,
  event_tag text not null default 'Normal Sale'
);
create index if not exists trades_room_code_idx on trades(room_code);

-- If you already ran this schema before trade event tagging / unrealized
-- profit tracking was added, run these lines against your existing
-- database instead:
-- alter table trades add column if not exists event_tag text not null default 'Normal Sale';
-- alter table trades add column if not exists total_acquired_market_value numeric not null default 0;

-- Buyback ledger: one immutable row per "bought this card/tier back from a
-- customer" action, recorded separately from the mutable inventory table
-- (which gets restocked/resold over time) so per-tradeshow buyback spend
-- stays accurate even after the item it created is later topped up again,
-- partially sold, etc.
create table if not exists buybacks (
  id text primary key,
  room_code text not null,
  item_id text,
  item_name text,
  quantity integer not null default 1,
  cost_basis numeric not null default 0, -- per-unit price actually paid for this batch
  total_cost numeric not null default 0,
  event_tag text not null default 'Normal Sale',
  date timestamptz not null default now()
);
create index if not exists buybacks_room_code_idx on buybacks(room_code);

-- If you already ran this schema before buyback tracking was added, run
-- just this against your existing database instead of the create table
-- above:
-- create table if not exists buybacks (id text primary key, room_code text not null, item_id text, item_name text, quantity integer not null default 1, cost_basis numeric not null default 0, total_cost numeric not null default 0, event_tag text not null default 'Normal Sale', date timestamptz not null default now());
-- create index if not exists buybacks_room_code_idx on buybacks(room_code);
-- alter publication supabase_realtime add table buybacks;
-- alter table buybacks enable row level security;
-- create policy "anon full access buybacks" on buybacks for all using (true) with check (true);

-- Binders are named up-front (e.g. "Jap AR Binder") so they can be picked
-- from a dropdown during binder-tier intake, and browsed on the Inventory
-- page even before any singles have been added to them.
create table if not exists binders (
  id text primary key,
  room_code text not null,
  name text not null,
  created_at timestamptz not null default now()
);
create index if not exists binders_room_code_idx on binders(room_code);

-- If you already ran this schema before named binders were added, run just
-- this against your existing database instead of the create table above:
-- create table if not exists binders (id text primary key, room_code text not null, name text not null, created_at timestamptz not null default now());
-- alter publication supabase_realtime add table binders;
-- alter table binders enable row level security;
-- create policy "anon full access binders" on binders for all using (true) with check (true);

-- Events are named up-front (e.g. "SCCS Tradeshow") so they can be picked
-- from a dropdown when recording a sale or trade, and browsed individually
-- on the Analytics tab, same pattern as binders above.
create table if not exists events (
  id text primary key,
  room_code text not null,
  name text not null,
  expenses numeric not null default 0, -- booth fee + travel + table rental etc., one lump sum, netted against profit for that show
  created_at timestamptz not null default now()
);
create index if not exists events_room_code_idx on events(room_code);

-- If you already ran this schema before named events were added, run just
-- this against your existing database instead of the create table above:
-- create table if not exists events (id text primary key, room_code text not null, name text not null, created_at timestamptz not null default now());
-- alter publication supabase_realtime add table events;
-- alter table events enable row level security;
-- create policy "anon full access events" on events for all using (true) with check (true);

-- If you already ran this schema before tradeshow expense tracking was
-- added, run just this against your existing database instead:
-- alter table events add column if not exists expenses numeric not null default 0;

-- Shared Pokemon card catalog (name/set/number/language) used to power
-- Intake/Trade card search. NOT scoped by room_code, unlike everything
-- else above - this is universal reference data (the same "Charizard ex
-- #199" is the same row no matter which booth is asking), so every room
-- shares one copy instead of each re-fetching it from the catalog source
-- (TCGdex - migrated from PokeWallet, which needed a rate-limited API key;
-- TCGdex is free/keyless with no meaningful rate limit).
create table if not exists cards (
  id text primary key,
  name text not null,
  set_name text,
  set_id text,
  card_number text,
  language text,
  image text, -- TCGdex base image URL (append /low.webp or /high.png etc. - see js/tcgdex-client.js)
  low_quality boolean not null default false, -- flagged once a device confirms this entry has neither an image nor a price - sinks to the bottom of search instead of cluttering results
  market_value_sgd numeric, -- cached SGD price, refreshed daily by the refresh-catalog-prices Edge Function (English cards only)
  price_source text, -- e.g. "TCGPlayer (USD->SGD)" - same display label used elsewhere
  price_updated_at timestamptz, -- null = never refreshed yet; search falls back to a live lookup if this is missing or stale
  pokewallet_variants jsonb, -- cached array of {label, price, source} - PokeWallet's TCGPlayer/CardMarket pricing for Japanese cards (see js/pokewallet-client.js), populated LAZILY on first live lookup (not a bulk cron - PokeWallet's 100/hour rate limit makes bulk-caching the whole ~8,159-card Japanese catalog impractical, see js/card-catalog.js's cachePokeWalletPricePermanently). null = never looked up yet
  pokewallet_updated_at timestamptz, -- null = never cached yet; a stale/missing value falls back to a live lookup, whose result then gets cached for next time
  cached_image_url text, -- permanent Supabase Storage URL (card-images bucket), populated by the cache-card-images Edge Function. null = not attempted yet; '' = attempted, no image found anywhere (won't be retried); a real URL = instant read, skips the live TCGdex/PokeWallet race entirely. Unlike price, an image never changes once printed, so this is never refreshed/expired.
  snkrdunk_id text, -- SnkrDunk's own trading-card id, resolved once via a name search and cached so later refreshes skip straight to the price lookup (see refresh-snkrdunk-prices). null = not attempted yet; '' = searched, no match found (retried on its next turn in the refresh queue, since unlike images a future listing could still appear)
  snkrdunk_conditions jsonb, -- cached array of {label, price, source, graded} - one entry per individual condition SnkrDunk prices (raw A/B/C/D, or graded PSA/ARS/etc - see js/snkrdunk-client.js), refreshed every ~12h by the refresh-snkrdunk-prices Edge Function (Japanese cards only). SnkrDunk's own "All" price (cheapest listing across every condition, confirmed directly against their site) is just the minimum of these, not a separately cached value - see SnkrDunkClient.buildDisplayList()
  snkrdunk_updated_at timestamptz, -- null = never refreshed yet; search falls back to a live lookup if this is missing or stale
  yuyutei_price_sgd numeric, -- Yuyu-tei's own JPY retail sell price, converted to SGD - a real Japanese shop chain's asking price, distinct from SnkrDunk (peer marketplace) and PokeWallet (TCGPlayer/CardMarket aggregate). Written by a LOCAL script (scripts/yuyutei-scraper.py) run on the user's own machine, not a Supabase cron - Yuyu-tei blocks Supabase's Edge Function IP range outright (403), but not residential ISP IPs, so this can only run from a real home connection. null = never scraped yet
  yuyutei_updated_at timestamptz, -- null = never scraped yet
  created_at timestamptz not null default now()
);
create index if not exists cards_name_idx on cards(name);
create index if not exists cards_price_refresh_idx on cards(language, price_updated_at); -- lets the refresh job cheaply find the oldest-refreshed English cards
create index if not exists cards_image_cache_idx on cards(language, cached_image_url); -- lets the cache-card-images job cheaply find not-yet-cached cards, split by language (English has no rate limit, Japanese does via PokeWallet)
create index if not exists cards_snkrdunk_refresh_idx on cards(language, snkrdunk_updated_at); -- lets the SnkrDunk refresh job cheaply find the oldest-refreshed Japanese cards
create index if not exists cards_yuyutei_idx on cards(language, yuyutei_updated_at); -- lets the local Yuyu-tei scraper cheaply find the oldest-refreshed cards

-- If you already ran this schema before the TCGdex migration, run just
-- this against your existing database instead:
-- alter table cards add column if not exists image text;

-- If you already ran this schema before daily catalog price caching was
-- added, run just this against your existing database instead:
-- alter table cards add column if not exists market_value_sgd numeric;
-- alter table cards add column if not exists price_source text;
-- alter table cards add column if not exists price_updated_at timestamptz;
-- create index if not exists cards_price_refresh_idx on cards(language, price_updated_at);

-- If you already ran this schema before PokeWallet price caching was
-- added, run just this against your existing database instead:
-- alter table cards add column if not exists pokewallet_variants jsonb;
-- alter table cards add column if not exists pokewallet_updated_at timestamptz;

-- If you already ran this schema before permanent image caching was added,
-- run just this against your existing database instead:
-- alter table cards add column if not exists cached_image_url text;
-- create index if not exists cards_image_cache_idx on cards(language, cached_image_url);

-- If you already ran this schema before SnkrDunk price caching was added,
-- run just this against your existing database instead:
-- alter table cards add column if not exists snkrdunk_id text;
-- alter table cards add column if not exists snkrdunk_conditions jsonb;
-- alter table cards add column if not exists snkrdunk_updated_at timestamptz;
-- create index if not exists cards_snkrdunk_refresh_idx on cards(language, snkrdunk_updated_at);

-- Single shared row tracking the bulk-import job's progress (which set/
-- page it's up to), so if multiple phones have the app open, they resume
-- the same job instead of each re-fetching everything from scratch.
create table if not exists catalog_sync_state (
  id text primary key default 'main',
  sets jsonb,
  set_index integer not null default 0,
  page integer not null default 1,
  total_cards integer not null default 0,
  status text not null default 'not_started',
  updated_at timestamptz not null default now()
);

-- If you already ran this schema before the shared card catalog was
-- added, run just this against your existing database instead of the two
-- create table statements above:
-- create table if not exists cards (id text primary key, name text not null, set_name text, set_id text, card_number text, language text, created_at timestamptz not null default now());
-- create index if not exists cards_name_idx on cards(name);
-- create table if not exists catalog_sync_state (id text primary key default 'main', sets jsonb, set_index integer not null default 0, page integer not null default 1, total_cards integer not null default 0, status text not null default 'not_started', updated_at timestamptz not null default now());
-- alter table cards enable row level security;
-- alter table catalog_sync_state enable row level security;
-- create policy "anon full access cards" on cards for all using (true) with check (true);
-- create policy "anon full access catalog_sync_state" on catalog_sync_state for all using (true) with check (true);

-- If you already ran this schema before low-quality-entry flagging was
-- added, run just this against your existing database instead:
-- alter table cards add column if not exists low_quality boolean not null default false;

-- Enable realtime updates so all phones in a room see live changes.
-- (cards/catalog_sync_state are deliberately excluded - they're bulk-
-- synced/pulled directly rather than needing live per-row updates.)
-- Wrapped so re-running this whole file is always safe, even after tables
-- were already added to the publication in an earlier run.
do $$
declare
  tbl text;
begin
  foreach tbl in array array['inventory', 'sales', 'trades', 'binders', 'events', 'buybacks'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = tbl
    ) then
      execute format('alter publication supabase_realtime add table %I', tbl);
    end if;
  end loop;
end $$;

-- No login system (per product decision: simple name-picker, no accounts),
-- so RLS is left open to the anon key rather than scoped per-user.
-- Note: anyone who has the anon key (visible in the app's JS) and knows a
-- room code can read/write that room's rows. Fine for a personal/small-team
-- tradeshow tool; revisit if this ever needs real per-room security.
alter table inventory enable row level security;
alter table sales enable row level security;
alter table trades enable row level security;
alter table binders enable row level security;
alter table events enable row level security;
alter table cards enable row level security;
alter table catalog_sync_state enable row level security;
alter table buybacks enable row level security;

-- drop-then-create so this whole file is always safe to paste and re-run
-- (Postgres has no "create policy if not exists").
drop policy if exists "anon full access inventory" on inventory;
drop policy if exists "anon full access sales" on sales;
drop policy if exists "anon full access trades" on trades;
drop policy if exists "anon full access binders" on binders;
drop policy if exists "anon full access events" on events;
drop policy if exists "anon full access cards" on cards;
drop policy if exists "anon full access catalog_sync_state" on catalog_sync_state;
drop policy if exists "anon full access buybacks" on buybacks;

create policy "anon full access inventory" on inventory for all using (true) with check (true);
create policy "anon full access sales" on sales for all using (true) with check (true);
create policy "anon full access trades" on trades for all using (true) with check (true);
create policy "anon full access binders" on binders for all using (true) with check (true);
create policy "anon full access events" on events for all using (true) with check (true);
create policy "anon full access cards" on cards for all using (true) with check (true);
create policy "anon full access catalog_sync_state" on catalog_sync_state for all using (true) with check (true);
create policy "anon full access buybacks" on buybacks for all using (true) with check (true);
