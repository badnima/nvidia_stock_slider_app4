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
const cacheFile = path.join(__dirname, '.stock-cache.json')
const quoteCacheTtlMs =
  parsePositiveInt(
    process.env.TWELVE_DATA_QUOTE_CACHE_SECONDS ||
      process.env.TWELVE_DATA_CACHE_TTL_SECONDS ||
      process.env.FMP_CACHE_TTL_SECONDS,
    300,
  ) * 1000
const fundamentalsCacheTtlMs =
  parsePositiveInt(process.env.TWELVE_DATA_FUNDAMENTALS_CACHE_SECONDS, 86400) * 1000
const statsConcurrency = parsePositiveInt(process.env.TWELVE_DATA_STATS_CONCURRENCY, 4)

let stockCache = {
  symbolsKey: '',
  expiresAt: 0,
  fetchedAt: 0,
  payload: null,
}

let fundamentalsCache = {
  symbolsKey: '',
  fetchedAt: 0,
  bySymbol: new Map(),
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function numberOrNull(value) {
  const rawValue =
    value && typeof value === 'object' && 'raw' in value
      ? value.raw
      : value

  if (rawValue === null || rawValue === undefined) {
    return null
  }

  if (typeof rawValue === 'string') {
    const normalized = rawValue.trim().replaceAll(',', '')

    if (!normalized || normalized === '--' || normalized.toUpperCase() === 'N/A') {
      return null
    }

    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }

  const parsed = Number(rawValue)
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

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

async function readPersistedCache() {
  try {
    const rawCache = await fs.readFile(cacheFile, 'utf8')
    const parsed = JSON.parse(rawCache)

    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const persistedPayload =
      parsed.payload && Array.isArray(parsed.payload.stocks) ? parsed.payload : null
    const persistedFundamentals =
      parsed.fundamentalsBySymbol && typeof parsed.fundamentalsBySymbol === 'object'
        ? new Map(
            Object.entries(parsed.fundamentalsBySymbol).filter(
              ([symbol, value]) => symbol && value && typeof value === 'object',
            ),
          )
        : new Map()

    return {
      symbolsKey: readString(parsed.symbolsKey) || '',
      payload: persistedPayload,
      persistedAt: readString(parsed.persistedAt),
      fundamentalsFetchedAt: numberOrNull(parsed.fundamentalsFetchedAt) || 0,
      fundamentalsBySymbol: persistedFundamentals,
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    console.warn('Failed to read persisted stock cache:', error)
    return null
  }
}

async function writePersistedCache(symbolsKey, payload, bySymbol, fundamentalsFetchedAt) {
  try {
    await fs.writeFile(
      cacheFile,
      JSON.stringify(
        {
          symbolsKey,
          persistedAt: new Date().toISOString(),
          fundamentalsFetchedAt,
          fundamentalsBySymbol: mapToObject(bySymbol),
          payload,
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch (error) {
    console.warn('Failed to write persisted stock cache:', error)
  }
}

function buildStalePayload(payload, detail) {
  return {
    ...payload,
    cached: true,
    stale: true,
    warning: [payload.warning, detail].filter(Boolean).join(' ') || null,
  }
}

function buildErrorHint(error) {
  const message = error instanceof Error ? error.message : String(error || '')

  if (message.includes('Missing TWELVE_DATA_API_KEY')) {
    return 'TWELVE_DATA_API_KEY is missing on Render. Add it under the web service Environment settings and redeploy.'
  }

  if (message.includes('429') || message.includes('Too Many Requests')) {
    return 'Twelve Data rate-limited this app. Your plan allows a limited number of requests per minute, so wait briefly before refreshing again.'
  }

  if (message.includes('401') || message.includes('403')) {
    return 'Twelve Data rejected the request. Verify that TWELVE_DATA_API_KEY on Render is valid and has access to quote and statistics endpoints.'
  }

  return 'Check that TWELVE_DATA_API_KEY is set on Render and that the key has access to Twelve Data quote endpoints.'
}

function parseRange(value) {
  const range = readString(value)
  if (!range) {
    return {
      low: null,
      high: null,
    }
  }

  const match = range.match(/([\d.,]+)\s*-\s*([\d.,]+)/)
  if (!match) {
    return {
      low: null,
      high: null,
    }
  }

  return {
    low: numberOrNull(match[1]),
    high: numberOrNull(match[2]),
  }
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
  return process.env.TWELVE_DATA_API_KEY || process.env.TWELVE_DATA_KEY || null
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

function normalizeFundamentals(statsPayload) {
  const statistics = statsPayload?.statistics || statsPayload
  const valuations = statistics?.valuations_metrics || statistics?.valuations || statistics
  const financials = statistics?.financials || {}
  const incomeStatement = financials?.income_statement || statistics?.income_statement || {}
  const earningsPerShare = statistics?.earnings_per_share || {}

  return {
    symbol:
      readString(statsPayload?.meta?.symbol) ||
      readString(statsPayload?.symbol) ||
      null,
    name:
      readString(statsPayload?.meta?.name) ||
      readString(statsPayload?.name) ||
      null,
    exchange:
      readString(statsPayload?.meta?.exchange) ||
      readString(statsPayload?.exchange) ||
      null,
    marketCap: firstNumber(
      valuations?.market_capitalization,
      statistics?.market_capitalization,
      statsPayload?.market_capitalization,
    ),
    eps: firstNumber(
      incomeStatement?.diluted_eps_ttm,
      incomeStatement?.eps_ttm,
      earningsPerShare?.diluted_eps,
      earningsPerShare?.basic_eps,
      statistics?.diluted_eps_ttm,
      statsPayload?.diluted_eps_ttm,
    ),
  }
}

function normalizeQuote(symbol, quote, fundamentals) {
  const quoteRange = parseRange(quote?.fifty_two_week?.range || quote?.range)
  const currentPrice = firstNumber(
    quote?.price,
    quote?.close,
    quote?.last,
    quote?.last_price,
    quote?.extended_price,
  )
  const week52Low = firstNumber(
    quote?.fifty_two_week?.low,
    quote?.fifty_two_week?.low_price,
    quote?.yearLow,
    quote?.week52Low,
    quoteRange.low,
  )
  const week52High = firstNumber(
    quote?.fifty_two_week?.high,
    quote?.fifty_two_week?.high_price,
    quote?.yearHigh,
    quote?.week52High,
    quoteRange.high,
  )
  const marketCap = firstNumber(
    quote?.market_capitalization,
    quote?.marketCap,
    fundamentals?.marketCap,
  )
  const eps = firstNumber(
    quote?.eps,
    quote?.eps_ttm,
    quote?.trailing_eps,
    fundamentals?.eps,
  )
  const name =
    readString(quote?.name) ||
    readString(quote?.companyName) ||
    readString(fundamentals?.name) ||
    symbol

  const normalized = {
    symbol,
    name,
    eps,
    marketCap,
    currentPrice,
    week52Low,
    week52High,
    exchange:
      readString(quote?.exchange) ||
      readString(quote?.mic_code) ||
      readString(fundamentals?.exchange),
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

function twelveDataErrorMessage(body, fallback) {
  if (!body || typeof body !== 'object') {
    return fallback
  }

  return readString(body.message) || readString(body.status) || fallback
}

async function fetchTwelveDataJson(url, apiKey, label) {
  const response = await fetch(url, {
    headers: {
      Authorization: `apikey ${apiKey}`,
      'user-agent': 'nima-stock-tracker/1.0',
      accept: 'application/json',
    },
  })
  const bodyText = await response.text()

  let body = null
  try {
    body = bodyText ? JSON.parse(bodyText) : null
  } catch {
    throw new Error(`${label} returned non-JSON data: ${bodyText.slice(0, 160)}`)
  }

  if (!response.ok) {
    throw new Error(
      `${label} returned ${response.status}: ${twelveDataErrorMessage(body, bodyText.slice(0, 160))}`,
    )
  }

  if (body?.status === 'error') {
    throw new Error(
      `${label} returned ${body.code || 'error'}: ${twelveDataErrorMessage(body, 'unexpected response')}`,
    )
  }

  return body
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, limit), items.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex
        nextIndex += 1
        results[currentIndex] = await mapper(items[currentIndex], currentIndex)
      }
    }),
  )

  return results
}

function summarizeFailures(label, failures) {
  if (!failures.length) {
    return null
  }

  const examples = failures
    .slice(0, 2)
    .map((failure) => `${failure.symbol}: ${failure.error}`)
    .join('; ')

  return `${failures.length} ${label} request${failures.length === 1 ? '' : 's'} failed (${examples}).`
}

function extractBatchQuotes(symbols, body) {
  const quotesBySymbol = new Map()

  const pushQuote = (candidate, fallbackSymbol = null) => {
    if (!candidate || typeof candidate !== 'object') {
      return
    }

    const nested = candidate.data && typeof candidate.data === 'object' ? candidate.data : candidate
    const symbol =
      readString(nested?.symbol)?.toUpperCase() ||
      readString(fallbackSymbol)?.toUpperCase() ||
      null

    if (!symbol) {
      return
    }

    quotesBySymbol.set(symbol, {
      ...nested,
      symbol,
    })
  }

  if (Array.isArray(body)) {
    for (const quote of body) {
      pushQuote(quote)
    }

    return quotesBySymbol
  }

  if (!body || typeof body !== 'object') {
    return quotesBySymbol
  }

  if (body.status === 'ok' && body.data) {
    return extractBatchQuotes(symbols, body.data)
  }

  for (const [key, value] of Object.entries(body)) {
    if (key === 'status' || key === 'code' || key === 'message') {
      continue
    }

    const fallbackSymbol = symbols.includes(key.toUpperCase()) ? key : null
    pushQuote(value, fallbackSymbol)
  }

  return quotesBySymbol
}

async function fetchBatchQuotes(symbols, apiKey) {
  if (!symbols.length) {
    return new Map()
  }

  const url = new URL('https://api.twelvedata.com/quote')
  url.searchParams.set('symbol', symbols.join(','))

  const body = await fetchTwelveDataJson(url, apiKey, `Twelve Data quote batch (${symbols.length} symbols)`)
  return extractBatchQuotes(symbols, body)
}

async function fetchStatistics(symbol, apiKey) {
  const url = new URL('https://api.twelvedata.com/statistics')
  url.searchParams.set('symbol', symbol)

  return fetchTwelveDataJson(url, apiKey, `Twelve Data statistics ${symbol}`)
}

function loadPersistedCachesIfNeeded(symbolsKey, persistedCache) {
  if (!persistedCache || persistedCache.symbolsKey !== symbolsKey) {
    return
  }

  if (!stockCache.payload && persistedCache.payload) {
    stockCache = {
      symbolsKey,
      expiresAt: 0,
      fetchedAt: 0,
      payload: persistedCache.payload,
    }
  }

  if (!fundamentalsCache.bySymbol.size && persistedCache.fundamentalsBySymbol.size) {
    fundamentalsCache = {
      symbolsKey,
      fetchedAt: persistedCache.fundamentalsFetchedAt || 0,
      bySymbol: persistedCache.fundamentalsBySymbol,
    }
  }
}

async function fetchTwelveDataStocks(symbols) {
  const apiKey = getApiKey()
  const now = new Date()

  if (!apiKey) {
    return {
      updatedAt: now.toISOString(),
      updatedLabel: formatDisplayTimestamp(now),
      source: null,
      warning: 'Missing TWELVE_DATA_API_KEY. Add it as an environment variable on Render.',
      stocks: symbols.map((symbol) => normalizeQuote(symbol, null, null)),
    }
  }

  const quotesBySymbol = await fetchBatchQuotes(symbols, apiKey)

  if (!quotesBySymbol.size) {
    throw new Error('No Twelve Data quotes were returned.')
  }

  const nowMs = now.getTime()
  const needFundamentalsRefresh =
    fundamentalsCache.symbolsKey !== symbols.join(',') ||
    !fundamentalsCache.bySymbol.size ||
    nowMs - fundamentalsCache.fetchedAt >= fundamentalsCacheTtlMs

  const symbolsMissingFundamentals = symbols.filter((symbol) => {
    const cached = fundamentalsCache.bySymbol.get(symbol)
    return !cached || (cached.eps === null && cached.marketCap === null)
  })

  const symbolsForStatistics = needFundamentalsRefresh ? symbols : symbolsMissingFundamentals
  const statisticsFailures = []
  const nextFundamentalsBySymbol =
    fundamentalsCache.symbolsKey === symbols.join(',')
      ? new Map(fundamentalsCache.bySymbol)
      : new Map()

  if (symbolsForStatistics.length) {
    const statisticResults = await mapWithConcurrency(
      symbolsForStatistics,
      statsConcurrency,
      async (symbol) => {
        try {
          return {
            symbol,
            fundamentals: normalizeFundamentals(await fetchStatistics(symbol, apiKey)),
            error: null,
          }
        } catch (error) {
          return {
            symbol,
            fundamentals: null,
            error: error instanceof Error ? error.message : 'Unknown Twelve Data statistics error',
          }
        }
      },
    )

    for (const result of statisticResults) {
      if (result.fundamentals) {
        nextFundamentalsBySymbol.set(result.symbol, result.fundamentals)
      } else if (result.error) {
        statisticsFailures.push({
          symbol: result.symbol,
          error: result.error,
        })
      }
    }

    if (statisticResults.some((result) => result.fundamentals)) {
      fundamentalsCache = {
        symbolsKey: symbols.join(','),
        fetchedAt: nowMs,
        bySymbol: nextFundamentalsBySymbol,
      }
    }
  }

  const stocks = symbols.map((symbol) =>
    normalizeQuote(symbol, quotesBySymbol.get(symbol) || null, nextFundamentalsBySymbol.get(symbol) || null),
  )

  const missingQuoteSymbols = symbols.filter((symbol) => !quotesBySymbol.has(symbol))
  const incompleteSymbols = stocks
    .filter(
      (stock) =>
        stock.currentPrice === null || stock.week52Low === null || stock.week52High === null,
    )
    .map((stock) => stock.symbol)

  const warning = [
    missingQuoteSymbols.length
      ? `${missingQuoteSymbols.length} configured symbol${
          missingQuoteSymbols.length === 1 ? '' : 's'
        } did not return a Twelve Data quote: ${missingQuoteSymbols.slice(0, 8).join(', ')}${
          missingQuoteSymbols.length > 8 ? ', ...' : ''
        }.`
      : null,
    summarizeFailures('Twelve Data statistics', statisticsFailures),
    incompleteSymbols.length
      ? `${incompleteSymbols.length} configured symbol${
          incompleteSymbols.length === 1 ? '' : 's'
        } did not return complete quote data: ${incompleteSymbols.slice(0, 8).join(', ')}${
          incompleteSymbols.length > 8 ? ', ...' : ''
        }.`
      : null,
  ]
    .filter(Boolean)
    .join(' ')

  return {
    updatedAt: now.toISOString(),
    updatedLabel: formatDisplayTimestamp(now),
    source: 'Twelve Data quote + statistics',
    warning: warning || null,
    stocks: sortByHighProximity(stocks),
  }
}

async function buildStocksPayload({ force = false } = {}) {
  const symbols = await readConfiguredSymbols()
  const symbolsKey = symbols.join(',')
  const now = Date.now()
  const persistedCache = await readPersistedCache()

  loadPersistedCachesIfNeeded(symbolsKey, persistedCache)

  if (!force && stockCache.payload && stockCache.symbolsKey === symbolsKey && stockCache.expiresAt > now) {
    return {
      ...stockCache.payload,
      cached: true,
      stale: false,
    }
  }

  try {
    const payload = await fetchTwelveDataStocks(symbols)
    stockCache = {
      symbolsKey,
      expiresAt: now + quoteCacheTtlMs,
      fetchedAt: now,
      payload,
    }

    await writePersistedCache(
      symbolsKey,
      payload,
      fundamentalsCache.bySymbol,
      fundamentalsCache.fetchedAt,
    )

    return {
      ...payload,
      cached: false,
      stale: false,
    }
  } catch (error) {
    const fallbackDetail = `Showing cached stock data because the live refresh failed: ${
      error instanceof Error ? error.message : 'Unknown stock data error.'
    }`
    const fallbackPayload =
      stockCache.payload && stockCache.symbolsKey === symbolsKey
        ? stockCache.payload
        : persistedCache?.symbolsKey === symbolsKey
          ? persistedCache.payload
          : null

    if (fallbackPayload) {
      stockCache = {
        symbolsKey,
        expiresAt: now + quoteCacheTtlMs,
        fetchedAt: now,
        payload: fallbackPayload,
      }

      return buildStalePayload(fallbackPayload, fallbackDetail)
    }

    throw error
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
      hint: buildErrorHint(error),
    })
  }
})

app.use((_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

app.listen(port, () => {
  console.log(`Nima Stock Tracker listening on port ${port}`)
})
