# Yuyu-tei sell-price scraper

Fetches Yuyu-tei's (real Japanese TCG shop) retail sell prices for Pokemon
cards and writes them into the same Supabase `cards` table the app already
reads from - onto existing rows only, matched by set + card number. Doesn't
create new cards.

**Must run on your own computer, on your normal home internet connection.**
Yuyu-tei blocks Supabase's server IP range outright (confirmed: direct
403), but does not block ordinary residential connections. It cannot run
as a cloud/VPS cron for the same reason - most cloud providers' IP ranges
get the same treatment.

## Setup

1. Install Python 3 if you don't have it: https://www.python.org/downloads/
2. Open a terminal in this folder and install the two dependencies:
   ```
   pip install requests beautifulsoup4
   ```

## Run

```
python yuyutei_scraper.py
```

It scrapes 129 Pokemon sets (one request per set, ~2 seconds apart out of
courtesy to their server - takes roughly 4-5 minutes total) and prints
progress as it goes. Safe to re-run any time; it just overwrites the
cached price with whatever's current.

## Notes

- `set_mapping.json` maps Yuyu-tei's own set codes to this app's set IDs.
  It covers 129 of Yuyu-tei's 260 listed Pokemon sets - the other 131 are
  mostly pre-2013 Black & White era product and single-preconstructed
  starter decks that aren't in this app's catalog either, so there's
  nothing to attach a price to for those regardless.
- If Yuyu-tei ever changes their page markup, the scrape will start
  returning 0 cards per set (not crash) - check the printed per-set counts
  if prices stop updating.
