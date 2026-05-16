# Nima Stock Tracker

A Render-ready React and Express app that displays a configurable stock dashboard using Twelve Data.

## Features

- Reads stock symbols from `stocks.json`
- Fetches live quote data from Twelve Data server-side with `TWELVE_DATA_API_KEY`
- Shows stock ticker, stock name, EPS, market cap, current price, 52-week low, and 52-week high
- Sorts stocks from closest to farthest from their 52-week high
- Uses a persisted fallback cache so the app can still render if a live provider request fails
- Caches fundamentals longer than quotes so normal refreshes stay well under provider limits

## Local Run

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000/`.

For local live data, create a `.env` file from `.env.example` and set `TWELVE_DATA_API_KEY`.

## Configure Stocks

Edit `stocks.json` and update the `stocks` array:

```json
{
  "stocks": ["NVDA", "MSFT", "AMZN"]
}
```

Duplicate symbols are ignored by the server so each stock displays once.

## Render Deploy

This repo includes `render.yaml` for a Node web service.

Set this Render environment variable:

- `TWELVE_DATA_API_KEY`: your Twelve Data API key

Optional:

- `TWELVE_DATA_QUOTE_CACHE_SECONDS`: quote payload cache TTL. Default is `300`
- `TWELVE_DATA_FUNDAMENTALS_CACHE_SECONDS`: EPS and market-cap cache TTL. Default is `86400`
- `TWELVE_DATA_STATS_CONCURRENCY`: number of Twelve Data statistics requests to run at once when warming the fundamentals cache. Default is `4`

## How The Provider Calls Work

- Quotes are fetched from Twelve Data `/quote`
- The server requests all configured symbols in one quote batch query
- EPS and market cap are filled from Twelve Data `/statistics`
- Fundamentals are cached much longer than quotes so a normal refresh only needs the quote batch call

This means the first warm-up after deploy may cost more API calls than later refreshes, but regular usage stays much cheaper.

## Troubleshooting Live Data

Open `/api/stocks` on the deployed Render URL.

- If you see `Missing TWELVE_DATA_API_KEY`, add `TWELVE_DATA_API_KEY` in Render under Environment.
- If you see a Twelve Data `429` error, the app is being rate-limited by the provider. Wait for the per-minute quota window to reset and try again.
- If you see a Twelve Data `401` or `403` error, confirm the key is valid and has access to quote and statistics endpoints.
- If a live refresh fails after at least one successful load, the server will fall back to the last cached payload from `.stock-cache.json`.
