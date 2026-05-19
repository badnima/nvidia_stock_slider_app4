# Nima Stock Tracker

A Render-ready React + Express stock dashboard that is built around a shared server cache instead of live browser-side provider fetches.

## What Changed

This app now treats each data type according to how often it really changes:

- **Quotes** come from Twelve Data and refresh about once per minute.
- **Market Cap, EPS, and P/E** come from a published Google Sheet snapshot and refresh on a server cache window.

The browser only requests one cached payload from `/api/stocks`. The server merges live Twelve Data quotes with the latest cached Google Sheet fundamentals snapshot.

## Why This Architecture Works Better

- It respects your **55 Twelve Data credits per minute** limit.
- Quotes stay fresh without spending Twelve Data credits on fundamentals every page load.
- Market Cap, EPS, and P/E are no longer blocked by the free FMP tier running out.
- The last good payload is persisted in **Render Key Value**, so a Render spin-down does not erase the cache.

## Cache Strategy

- **Hot cache**: Render Key Value via `RENDER_KEY_VALUE_URL`
- **Local fallback**: `.stock-cache.json`
- **Shared payload**: the server merges quotes plus Google Sheet snapshot fundamentals into one response for the frontend

Render Key Value remains the primary runtime cache. The Google Sheet is the fundamentals source of truth, not the hot cache.

## Provider Layout

- **Twelve Data**: `currentPrice`, `week52High`, `week52Low`
- **Google Sheet snapshot**: `marketCap`, `eps`, `pe`

## Local Run

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000/`.

For local live data, create a `.env` file from `.env.example`.

## Required Environment Variables

- `TWELVE_DATA_API_KEY`
- `GOOGLE_SHEETS_SNAPSHOT_URL`
- `RENDER_KEY_VALUE_URL`

## Optional Environment Variables

- `TWELVE_DATA_QUOTE_CACHE_SECONDS`
  - Default: `60`
  - How long quotes stay fresh before the server refreshes them.
- `GOOGLE_SHEETS_SNAPSHOT_CACHE_SECONDS`
  - Default: `900`
  - How long the Google Sheet snapshot stays fresh before the server refetches it.
- `GOOGLE_SHEETS_PARTIAL_RETRY_SECONDS`
  - Default: `900`
  - How long the server waits before retrying a snapshot that still has blanks.
- `GOOGLE_SHEETS_FAILURE_RETRY_SECONDS`
  - Default: `3600`
  - How long the server waits before retrying a failed snapshot fetch.
- `BACKGROUND_REFRESH_INTERVAL_SECONDS`
  - Default: `60`
  - How often the server wakes up its background refresh loop.

## Google Sheet Snapshot Format

Point `GOOGLE_SHEETS_SNAPSHOT_URL` at a published CSV or JSON endpoint that contains one row per symbol.

Required column:
- `symbol`

Supported fundamentals columns:
- `marketCap`
- `eps`
- `pe`

Optional columns:
- `name`
- `exchange`

Example CSV:

```csv
symbol,marketCap,eps,pe
NVDA,3298000000000,1.62,137.17
MSFT,3124000000000,16.19,26.05
ASML,577000000000,30.04,48.92
```

Example JSON:

```json
{
  "updatedAt": "2026-05-19T15:45:00.000Z",
  "rows": [
    { "symbol": "NVDA", "marketCap": 3298000000000, "eps": 1.62, "pe": 137.17 }
  ]
}
```

## How The App Refreshes

1. The first request returns a staged placeholder payload immediately if the cache is cold.
2. Quotes warm first in the background.
3. The Google Sheet snapshot refreshes only when missing or stale.
4. The frontend polls the cached payload frequently so the page fills itself in as each cache stage completes.

This keeps the page responsive while still allowing the fundamentals cache to fill in over time.

## Render Deploy

This repo includes `render.yaml` for:

- the Node web service
- a Render Key Value instance named `nima-stock-tracker-cache`

The web service receives `RENDER_KEY_VALUE_URL` automatically from that Key Value service.

## Troubleshooting

Open `/api/stocks` on the deployed Render URL.

- If quotes are missing, confirm `TWELVE_DATA_API_KEY`.
- If Market Cap, EPS, or P/E are missing, confirm `GOOGLE_SHEETS_SNAPSHOT_URL` and make sure the snapshot endpoint is public and returning values.
- If Render Key Value is unavailable, confirm `RENDER_KEY_VALUE_URL` is populated from the Key Value service.
