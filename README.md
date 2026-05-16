# Nima Stock Tracker

A Render-ready React and Express app that displays a configurable stock dashboard using Twelve Data for quotes and earnings plus FMP for cached market caps, with Render Key Value for durable cache storage.

## Features

- Reads stock symbols from `stocks.json`
- Fetches live quote data from Twelve Data server-side with `TWELVE_DATA_API_KEY`
- Fetches Market Cap from FMP batch market cap with `FMP_API_KEY`
- Persists the last good cache payload in Render Key Value with `RENDER_KEY_VALUE_URL`
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

For local live data, create a `.env` file from `.env.example` and set `TWELVE_DATA_API_KEY`, `FMP_API_KEY`, and optionally `RENDER_KEY_VALUE_URL`.

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
- `FMP_API_KEY`: your Financial Modeling Prep API key for Market Cap
- `RENDER_KEY_VALUE_URL`: the internal connection string for your Render Key Value instance

Optional:

- `TWELVE_DATA_QUOTE_CACHE_SECONDS`: quote payload cache TTL. Default is `300`
- `TWELVE_DATA_EARNINGS_REFRESH_LIMIT`: number of symbols to backfill from `/earnings` per refresh. Default is `1`
- `FMP_MARKET_CAP_CACHE_SECONDS`: Market Cap cache TTL. Default is `86400`

## How The Provider Calls Work

- Quotes are fetched from Twelve Data `/quote`
- The server requests all configured symbols in one quote batch query
- Market cap is filled from FMP batch market cap once per cache window
- EPS is filled from the latest reported value from Twelve Data `/earnings`
- The merged cache is persisted in Render Key Value so it survives instance spin-downs
- Market cap is cached daily and EPS is cached after it is first retrieved, so normal refreshes stay cheap

This means the first warm-up after deploy may cost more API calls than later refreshes, but regular usage stays much cheaper.

## Troubleshooting Live Data

Open `/api/stocks` on the deployed Render URL.

- If you see `Missing TWELVE_DATA_API_KEY`, add `TWELVE_DATA_API_KEY` in Render under Environment.
- If you see a Twelve Data `429` error, the app is being rate-limited by the provider. Wait for the per-minute quota window to reset and try again.
- If you see a Twelve Data `401` or `403` error, confirm the key is valid and has access to quote and earnings endpoints.
- If you see an FMP error for Market Cap, confirm `FMP_API_KEY` is present and has access to the market cap endpoints.
- If Render Key Value is unavailable, confirm `RENDER_KEY_VALUE_URL` points to your Key Value instance's internal connection string.
- If a live refresh fails after at least one successful load, the server will fall back to the last cached payload from Render Key Value, then to `.stock-cache.json` if needed.
