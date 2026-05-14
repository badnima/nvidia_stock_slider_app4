import 'dotenv/config'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = process.env.PORT || 3000

const stocksFile = path.join(__dirname, 'stocks.json')
const distDir = path.join(__dirname, 'dist')
const cacheTtlMs = parsePositiveInt(process.env.FMP_CACHE_TTL_SECONDS, 300) * 1000

let stockCache = {
  symbolsKey: '',
  expiresAt: 0,
  payload: null,
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function numberOrNull(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = numberOrNull(value)
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function formatDisplayTimestamp(date) {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  }).format(date)
}

function getApiKey() {
  return (
    process.env.FMP_API_KEY ||
    process.env.FINANCIAL_MODELING_PREP_API_KEY ||
    process.env.FINANCIALMODELINGPREP_API_KEY ||
    null
  )
}

async function readConfiguredSymbols() {
  const rawConfig = await fs.readFile(stocksFile, 'utf8')
  const config = JSON.parse(rawConfig)
  const rawStocks = Array.isArray(config) ? config : config.stocks

  if (!Array.isArray(rawStocks)) {
    throw new Error('stocks.json must contain an array or a { "stocks": [] } object.')
  }

  const seen = new Set()

  return rawStocks
    .map((stock) => (typeof stock === 'string' ? stock : stock?.symbol))
    .filter(Boolean)
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => {
      if (!symbol || seen.has(symbol)) {
        return false
      }

      seen.add(symbol)
      return true
    })
}

function positionPercent(stock) {
  if (
    typeof stock.currentPrice !== 'number' ||
    typeof stock.week52Low !== 'number' ||
    typeof stock.week52High !== 'number' ||
    stock.week52High <= stock.week52Low
  ) {
    return null
  }

  return ((stock.currentPrice - stock.week52Low) / (stock.week52High - stock.week52Low)) * 100
}

function normalizeQuote(symbol, quote) {
  const currentPrice = firstNumber(quote?.price, quote?.currentPrice, quote?.lastPrice)
  const week52Low = firstNumber(
    quote?.yearLow,
    quote?.week52Low,
    quote?.low52Week,
    quote?.fiftyTwoWeekLow,
  )
  const week52High = firstNumber(
    quote?.yearHigh,
    quote?.week52High,
    quote?.high52Week,
    quote?.fiftyTwoWeekHigh,
  )
  const marketCap = firstNumber(quote?.marketCap, quote?.market_cap)
  const eps = firstNumber(quote?.eps, quote?.epsTTM)
  const name = readString(quote?.name) || readString(quote?.companyName) || symbol

  const normalized = {
    symbol,
    name,
    eps,
    marketCap,
    currentPrice,
    week52Low,
    week52High,
    exchange: readString(quote?.exchange) || readString(quote?.exchangeShortName),
  }

  const percent = positionPercent(normalized)

  return {
    ...normalized,
    positionPercent: percent,
    distanceFromHighPercent:
      typeof currentPrice === 'number' && typeof week52High === 'number' && week52High > 0
        ? ((week52High - currentPrice) / week52High) * 100
        : null,
  }
}

function sortByHighProximity(stocks) {
  return [...stocks].sort((left, right) => {
    const leftPosition = typeof left.positionPercent === 'number' ? left.positionPercent : -Infinity
    const rightPosition =
      typeof right.positionPercent === 'number' ? right.positionPercent : -Infinity

    if (rightPosition !== leftPosition) {
      return rightPosition - leftPosition
    }

    return left.symbol.localeCompare(right.symbol)
  })
}

function fmpErrorMessage(body, fallback) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return (
      readString(body['Error Message']) ||
      readString(body.message) ||
      readString(body.error) ||
      readString(body.Information) ||
      fallback
    )
  }

  return fallback
}

async function fetchFmpJson(url, apiKey, label) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'nima-stock-tracker/1.0',
    },
  })
  const bodyText = await response.text()
  const safeBodyText = bodyText.replaceAll(apiKey, '[redacted]')

  let body = null
  try {
    body = bodyText ? JSON.parse(bodyText) : null
  } catch {
    throw new Error(`${label} returned non-JSON data: ${safeBodyText.slice(0, 160)}`)
  }

  if (!response.ok) {
    throw new Error(
      `${label} returned ${response.status}: ${fmpErrorMessage(body, safeBodyText.slice(0, 160))}`,
    )
  }

  if (!Array.isArray(body)) {
    throw new Error(`${label} rejected the request: ${fmpErrorMessage(body, 'unexpected response')}`)
  }

  return body
}

async function fetchQuotesFromFmp(symbols, apiKey) {
  const legacyQuoteUrl = new URL(
    `https://financialmodelingprep.com/api/v3/quote/${symbols.join(',')}`,
  )
  legacyQuoteUrl.searchParams.set('apikey', apiKey)

  const stableBatchUrl = new URL('https://financialmodelingprep.com/stable/batch-quote')
  stableBatchUrl.searchParams.set('symbols', symbols.join(','))
  stableBatchUrl.searchParams.set('apikey', apiKey)

  const attempts = [
    ['FMP v3 quote', legacyQuoteUrl],
    ['FMP stable batch quote', stableBatchUrl],
  ]
  const failures = []

  for (const [label, url] of attempts) {
    try {
      const quotes = await fetchFmpJson(url, apiKey, label)

      return {
        quotes,
        source: label,
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `${label} failed`)
    }
  }

  throw new Error(`FMP quote requests failed. ${failures.join(' | ')}`)
}

async function fetchFmpQuotes(symbols) {
  const apiKey = getApiKey()
  const now = new Date()

  if (!apiKey) {
    return {
      updatedAt: now.toISOString(),
      updatedLabel: formatDisplayTimestamp(now),
      source: null,
      warning: 'Missing FMP_API_KEY. Add it as an environment variable on Render.',
      stocks: symbols.map((symbol) => normalizeQuote(symbol, null)),
    }
  }

  const { quotes, source } = await fetchQuotesFromFmp(symbols, apiKey)

  const quoteBySymbol = new Map(
    quotes
      .filter((quote) => readString(quote?.symbol))
      .map((quote) => [quote.symbol.trim().toUpperCase(), quote]),
  )

  const stocks = symbols.map((symbol) => normalizeQuote(symbol, quoteBySymbol.get(symbol)))

  return {
    updatedAt: now.toISOString(),
    updatedLabel: formatDisplayTimestamp(now),
    source,
    warning: stocks.some((stock) => stock.currentPrice === null)
      ? 'Some configured symbols did not return complete FMP quote data.'
      : null,
    stocks: sortByHighProximity(stocks),
  }
}

async function buildStocksPayload({ force = false } = {}) {
  const symbols = await readConfiguredSymbols()
  const symbolsKey = symbols.join(',')
  const now = Date.now()

  if (!force && stockCache.payload && stockCache.symbolsKey === symbolsKey && stockCache.expiresAt > now) {
    return {
      ...stockCache.payload,
      cached: true,
    }
  }

  const payload = await fetchFmpQuotes(symbols)
  stockCache = {
    symbolsKey,
    expiresAt: now + cacheTtlMs,
    payload,
  }

  return {
    ...payload,
    cached: false,
  }
}

app.use(express.static(distDir))

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/stocks', async (req, res) => {
  try {
    const payload = await buildStocksPayload({ force: req.query.refresh === 'true' })
    res.set('Cache-Control', 'no-store')
    res.json(payload)
  } catch (error) {
    console.error('Failed to load stock data:', error)
    res.status(502).json({
      error: 'Unable to load stock data right now.',
      detail: error instanceof Error ? error.message : 'Unknown stock data error.',
      hint: 'Check that FMP_API_KEY is set on Render and that the key has access to FMP quote endpoints.',
    })
  }
})

app.use((_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

app.listen(port, () => {
  console.log(`Nima Stock Tracker listening on port ${port}`)
})
