# Nima Stock Tracker

A Render-ready React and Express app that displays a configurable stock dashboard using Financial Modeling Prep data.

## Features

- Reads stock symbols from `stocks.json`
- Fetches FMP quote data server-side with `FMP_API_KEY`
- Shows stock ticker, stock name, EPS, market cap, current price, 52-week low, and 52-week high
- Sorts stocks from closest to farthest from their 52-week high
- Uses a 52-week price-position slider inspired by the reference NVIDIA stock slider app

## Local Run

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000/`.

For local live data, create a `.env` file from `.env.example` and set `FMP_API_KEY`.

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

- `FMP_API_KEY`: your Financial Modeling Prep API key

Optional:

- `FMP_CACHE_TTL_SECONDS`: in-memory quote cache TTL. Default is `300`.

## Troubleshooting Live Data

Open `/api/stocks` on the deployed Render URL.

- If you see `Missing FMP_API_KEY`, add `FMP_API_KEY` in Render under Environment.
- If you see an FMP access error, confirm the key is valid and has access to quote endpoints.
- The server first tries `FMP v3 quote`, then falls back to `FMP stable batch quote`.
