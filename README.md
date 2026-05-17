# Nima Stock Tracker

A Render-ready React + Express stock dashboard that is built around a shared server cache instead of live browser-side provider fetches.

## What Changed

This app now treats each data type according to how often it really changes:

- **Quotes** come from Twelve Data and refresh about once per minute.
- **Market Cap** comes from FMP and refreshes on a daily cache window.
- **EPS** comes from Twelve Data earnings and refreshes slowly in a throttled background queue.

The browser only requests one cached payload from `/api/stocks`. It no longer tries to fetch quote, Market Cap, and EPS data directly in sequence.

## Why This Architecture Works Better

- It respects your **55 Twelve Data credits per minute** limit.
- Quotes stay fresh without spending credits on fundamentals every page load.
- EPS warming is gradual, so the app no longer blows through the limit on cold start.
- The last good payload is persisted in **Render Key Value**, so a Render spin-down does not erase the cache.

## Cache Strategy

- **Hot cache**: Render Key Value via `RENDER_KEY_VALUE_URL`
- **Local fallback**: `.stock-cache.json`
- **Shared payload**: the server merges quotes, Market Cap, and EPS into one response for the frontend

This app does **not** use a Google Doc or Google Sheet as the primary cache. Those are a poor fit for high-frequency server reads/writes and concurrent refreshes. Render Key Value is the correct primary cache for this deployment.

## Provider Layout

- **Twelve Data**: quotes and EPS earnings history
- **FMP**: batch Market Cap

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
- `FMP_API_KEY`
- `RENDER_KEY_VALUE_URL`

## Optional Environment Variables

- `TWELVE_DATA_QUOTE_CACHE_SECONDS`
  - Default: `60`
  - How long quotes stay fresh before the server refreshes them.
- `FMP_MARKET_CAP_CACHE_SECONDS`
  - Default: `86400`
  - How long Market Cap stays fresh before the server refreshes it.
- `TWELVE_DATA_EPS_CACHE_SECONDS`
  - Default: `604800`
  - How long EPS stays fresh before the background queue revisits it.
- `TWELVE_DATA_EPS_BATCH_SIZE`
  - Default: `1`
  - How many symbols the background EPS queue refreshes per minute.
- `BACKGROUND_REFRESH_INTERVAL_SECONDS`
  - Default: `60`
  - How often the server wakes up its background refresh loop.

## How The App Refreshes

1. The first request returns a staged placeholder payload immediately if the cache is cold.
2. Quotes warm first in the background.
3. Market Cap refreshes only when missing or stale.
4. EPS refreshes in a slow queue, one symbol at a time by default.
5. The frontend polls the cached payload frequently so the page fills itself in as each cache stage completes.

This keeps the page responsive while still allowing the fundamentals cache to fill in over time.

## Render Deploy

This repo includes `render.yaml` for:

- the Node web service
- a Render Key Value instance named `nima-stock-tracker-cache`

The web service receives `RENDER_KEY_VALUE_URL` automatically from that Key Value service.

## Troubleshooting

Open `/api/stocks` on the deployed Render URL.

- If quotes are missing, confirm `TWELVE_DATA_API_KEY`.
- If Market Cap is missing, confirm `FMP_API_KEY`.
- If the app says EPS is still warming, that is expected on a cold cache. The server will keep filling it in automatically.
- If Render Key Value is unavailable, confirm `RENDER_KEY_VALUE_URL` is populated from the Key Value service.
