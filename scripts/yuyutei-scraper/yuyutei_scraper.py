#!/usr/bin/env python3
"""
PokAddicts - Yuyu-tei sell-price scraper (run locally, NOT on Supabase)

Yuyu-tei (yuyu-tei.jp), a real Japanese TCG shop chain, blocks Supabase's
Edge Function IP range outright (confirmed: a direct fetch from a Supabase
function gets HTTP 403), but does NOT block ordinary residential ISP
connections. This script is meant to run on your own computer, on your own
home internet connection, and just writes results into the same `cards`
table every other price source already uses - the app itself doesn't know
or care that this data came from a local script instead of a cron.

It fetches Yuyu-tei's sell (retail) listing page for each mapped Pokemon
set in one request per set (all cards in a set are on one page - no
per-card requests needed), parses the plain server-rendered HTML (no JS
rendering required - confirmed directly, the data is right there in the
markup), and upserts `yuyutei_price_sgd` / `yuyutei_updated_at` onto any
existing card row that matches by (set_id, card_number). It does NOT
create new card rows - Yuyu-tei is a supplementary price overlay on cards
TCGdex/PokeWallet/SnkrDunk already know about, same relationship those
sources have to each other.

Setup:
    pip install requests beautifulsoup4

Usage:
    python yuyutei_scraper.py

Set mapping (set_mapping.json, alongside this script) was built by
matching Yuyu-tei's own "収録弾" (included sets) checkbox list against
TCGdex's Japanese set catalog - 129 of Yuyu-tei's 260 listed sets matched
cleanly (the other 131 are mostly pre-2013 Black & White era product and
single-preconstructed starter/structure decks that TCGdex's own Japanese
catalog doesn't carry either, so there's nothing in our own `cards` table
to attach a price to for those anyway).
"""

import json
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

SUPABASE_URL = "https://pdhjrifvfnrhsebhvyvk.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_nvKflzLJTUeCTqt_C76_ZQ_uNpwtOfP"

YUYUTEI_BASE_URL = "https://yuyu-tei.jp/sell/poc/s"
# Yuyu-tei's own robots.txt sets Crawl-delay:1 for the bots it names
# explicitly - this script isn't one of those, but the same courtesy
# applies: one request per set page (not per card), paced well under any
# real rate limit, for ~129 total requests per full run.
REQUEST_DELAY_SECONDS = 2.0

SCRIPT_DIR = Path(__file__).parent
SET_MAPPING_PATH = SCRIPT_DIR / "set_mapping.json"


def load_set_mapping():
    with open(SET_MAPPING_PATH, "r", encoding="utf-8") as f:
        entries = json.load(f)
    return [(e["yuyuCode"], e["setId"]) for e in entries]


def get_jpy_to_sgd_rate():
    try:
        res = requests.get("https://api.frankfurter.dev/v1/latest?from=JPY&to=SGD", timeout=15)
        res.raise_for_status()
        rate = res.json()["rates"]["SGD"]
        print(f"JPY->SGD rate: {rate}")
        return rate
    except Exception as err:
        print(f"Failed to fetch live FX rate, using fallback (0.0088): {err}")
        return 0.0088


def parse_set_page(html):
    """Returns a list of {card_number, price_jpy} for every card-product
    block on a Yuyu-tei sell-listing page. Sold-out cards still have a
    real listed price (Yuyu-tei's "would sell for" price even with zero
    stock) so those are kept too - a shop's asking price, not a live
    order availability check."""
    soup = BeautifulSoup(html, "html.parser")
    results = []
    for product in soup.select(".card-product"):
        number_el = product.select_one("span.d-block.border.border-dark")
        price_el = product.select_one("strong.d-block.text-end")
        if not number_el or not price_el:
            continue
        card_number = number_el.get_text(strip=True)
        price_text = price_el.get_text(strip=True)
        price_match = re.search(r"([\d,]+)\s*円", price_text)
        if not card_number or not price_match:
            continue
        price_jpy = int(price_match.group(1).replace(",", ""))
        results.append({"card_number": card_number, "price_jpy": price_jpy})
    return results


def fetch_set(yuyu_code):
    url = f"{YUYUTEI_BASE_URL}/{yuyu_code}"
    res = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    res.raise_for_status()
    return parse_set_page(res.text)


def push_updates(updates):
    """Bulk-upserts {id, yuyutei_price_sgd, yuyutei_updated_at} rows via
    PostgREST's merge-duplicates upsert - only touches rows whose id
    already exists (see cards' primary key), never creates new ones,
    since an id that doesn't exist just gets silently upserted as a
    bare new row missing every other required field otherwise. Filtering
    to known ids happens by the caller only ever building this list from
    a Supabase SELECT in the first place - see match_and_update()."""
    if not updates:
        return 0
    url = f"{SUPABASE_URL}/rest/v1/cards"
    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    BATCH_SIZE = 200
    total = 0
    for i in range(0, len(updates), BATCH_SIZE):
        batch = updates[i : i + BATCH_SIZE]
        res = requests.post(url, headers=headers, json=batch, timeout=30)
        if not res.ok:
            print(f"  Supabase upsert failed ({res.status_code}): {res.text[:300]}")
            continue
        total += len(batch)
    return total


def match_and_update(set_id, scraped_cards, fx_rate):
    """Looks up which of this set's scraped card_numbers actually exist in
    our own catalog (only language='ja', this set_id), then builds the
    upsert payload for just those matches. A card_number Yuyu-tei has that
    we don't (e.g. a print TCGdex hasn't synced yet) is silently skipped -
    there's no row to attach a price to."""
    if not scraped_cards:
        return 0

    select_url = f"{SUPABASE_URL}/rest/v1/cards"
    params = {
        "select": "id,card_number,name",
        "language": "eq.ja",
        "set_id": f"eq.{set_id}",
    }
    res = requests.get(
        select_url,
        headers={"apikey": SUPABASE_ANON_KEY},
        params=params,
        timeout=30,
    )
    if not res.ok:
        print(f"  Failed to read existing rows for {set_id}: {res.status_code}")
        return 0

    # PostgREST's merge-duplicates upsert still validates the full row
    # against NOT NULL constraints (like `name`) even though every id here
    # is confirmed to already exist and this is really just an UPDATE via
    # ON CONFLICT - a real, confirmed bug: sending only
    # {id, yuyutei_price_sgd, yuyutei_updated_at} failed on every single
    # row with "null value in column name violates not-null constraint".
    # Echoing back the already-known name satisfies that without actually
    # changing it.
    existing = {row["card_number"]: row for row in res.json()}
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())

    # Some sets (e.g. M2a) list more than one physical print (normal vs.
    # parallel/1st-edition, etc.) under the SAME printed card_number, but
    # our own catalog only has ONE row per number - a real, confirmed bug:
    # sending multiple {id: same_id, ...} entries in one upsert batch made
    # Postgres reject the whole batch ("ON CONFLICT DO UPDATE command
    # cannot affect row a second time"). Deduping to the single cheapest
    # listing per card_number before building the update list fixes this,
    # and is also the more useful number anyway - the same "cheapest
    # available" convention SnkrDunk's own "All" price already uses.
    cheapest_by_number = {}
    for card in scraped_cards:
        current = cheapest_by_number.get(card["card_number"])
        if current is None or card["price_jpy"] < current["price_jpy"]:
            cheapest_by_number[card["card_number"]] = card

    updates = []
    for card in cheapest_by_number.values():
        row = existing.get(card["card_number"])
        if not row:
            continue
        updates.append(
            {
                "id": row["id"],
                "name": row["name"],
                "yuyutei_price_sgd": round(card["price_jpy"] * fx_rate, 4),
                "yuyutei_updated_at": now,
            }
        )

    print(f"  ({len(existing)} existing rows in our catalog for {set_id}, {len(updates)} matched by card number)")
    return push_updates(updates)


def main():
    mapping = load_set_mapping()
    fx_rate = get_jpy_to_sgd_rate()

    print(f"Scraping {len(mapping)} Yuyu-tei sets...\n")
    total_scraped = 0
    total_updated = 0
    failed = []

    for i, (yuyu_code, set_id) in enumerate(mapping, 1):
        try:
            cards = fetch_set(yuyu_code)
            updated = match_and_update(set_id, cards, fx_rate)
            total_scraped += len(cards)
            total_updated += updated
            print(f"[{i}/{len(mapping)}] {yuyu_code} -> {set_id}: {len(cards)} scraped, {updated} matched+updated")
        except Exception as err:
            failed.append(yuyu_code)
            print(f"[{i}/{len(mapping)}] {yuyu_code} -> {set_id}: FAILED ({err})")

        time.sleep(REQUEST_DELAY_SECONDS)

    print(f"\nDone. {total_scraped} cards scraped across {len(mapping)} sets, {total_updated} rows updated.")
    if failed:
        print(f"{len(failed)} sets failed: {', '.join(failed)}")


if __name__ == "__main__":
    sys.exit(main())
