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
  const rawValue =
    value && typeof value === 'object' && 'raw' in value
      ? value.raw
      : value
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
    low: numberOrNull(match[1].replaceAll(',', '')),
    high: numberOrNull(match[2].replaceAll(',', '')),
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
  const range = parseRange(quote?.range)
  const currentPrice = firstNumber(
    quote?.price,
    quote?.currentPrice,
    quote?.lastPrice,
    quote?.regularMarketPrice,
  )
  const week52Low = firstNumber(
    quote?.yearLow,
    quote?.week52Low,
    quote?.low52Week,
    quote?.fiftyTwoWeekLow,
    range.low,
  )
  const week52High = firstNumber(
    quote?.yearHigh,
    quote?.week52High,
    quote?.high52Week,
    quote?.fiftyTwoWeekHigh,
    range.high,
  )
  const marketCap = firstNumber(quote?.marketCap, quote?.market_cap, quote?.mktCap)
  const eps = firstNumber(
    quote?.eps,
    quote?.epsTTM,
    quote?.epsTrailingTwelveMonths,
    quote?.trailingEps,
  )
  const name =
    readString(quote?.name) ||
    readString(quote?.companyName) ||
    readString(quote?.shortName) ||
    readString(quote?.longName) ||
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
      readString(quote?.exchangeShortName) ||
      readString(quote?.fullExchangeName),
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

function quoteForSymbol(symbol, quotes) {
  return (
    quotes.find((quote) => readString(quote?.symbol)?.toUpperCase() === symbol) ||
    quotes[0] ||
    null
  )
}

async function fetchStableQuote(symbol, apiKey) {
  const url = new URL('https://financialmodelingprep.com/stable/quote')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('apikey', apiKey)

  const quotes = await fetchFmpJson(url, apiKey, `FMP stable quote ${symbol}`)
  const quote = quoteForSymbol(symbol, quotes)

  if (!quote) {
    throw new Error('FMP stable quote returned no records')
  }

  return quote
}

async function fetchStableMetrics(symbol, apiKey) {
  const url = new URL('https://financialmodelingprep.com/stable/key-metrics-ttm')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('apikey', apiKey)

  const metrics = await fetchFmpJson(url, apiKey, `FMP stable key metrics TTM ${symbol}`)

  return quoteForSymbol(symbol, metrics)
}

async function fetchStableProfile(symbol, apiKey) {
  const url = new URL('https://financialmodelingprep.com/stable/profile')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('apikey', apiKey)

  const profiles = await fetchFmpJson(url, apiKey, `FMP stable profile ${symbol}`)
  const profile = quoteForSymbol(symbol, profiles)

  if (!profile) {
    throw new Error('FMP stable profile returned no records')
  }

  return profile
}

async function fetchYahooQuotes(symbols) {
  if (!symbols.length) {
    return []
  }

  const url = new URL('https://query1.finance.yahoo.com/v7/finance/quote')
  url.searchParams.set('symbols', symbols.join(','))

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'nima-stock-tracker/1.0',
    },
  })
  const bodyText = await response.text()

  if (!response.ok) {
    throw new Error(`Yahoo Finance returned ${response.status}: ${bodyText.slice(0, 160)}`)
  }

  let body = null
  try {
    body = JSON.parse(bodyText)
  } catch {
    throw new Error(`Yahoo Finance returned non-JSON data: ${bodyText.slice(0, 160)}`)
  }

  const quotes = body?.quoteResponse?.result

  if (!Array.isArray(quotes)) {
    const message = readString(body?.quoteResponse?.error?.description) || 'unexpected response'
    throw new Error(`Yahoo Finance rejected the request: ${message}`)
  }

  return quotes
}

async function fetchQuotesFromFmp(symbols, apiKey) {
  const concurrency = parsePositiveInt(process.env.FMP_CONCURRENCY, 4)
  const quoteResults = await mapWithConcurrency(symbols, concurrency, async (symbol) => {
    try {
      return {
        symbol,
        quote: await fetchStableQuote(symbol, apiKey),
        error: null,
      }
    } catch (error) {
      return {
        symbol,
        quote: null,
        error: error instanceof Error ? error.message : 'Unknown FMP quote error',
      }
    }
  })

  const quoteFailures = quoteResults.filter((result) => result.error)
  const successfulQuotes = quoteResults
    .filter((result) => result.quote)
    .map(({ symbol, quote }) => ({
      symbol,
      quote,
      source: 'FMP',
    }))
  const profileSymbols = quoteFailures.map((result) => result.symbol)
  let profileFailures = []
  let profileQuotes = []

  if (profileSymbols.length) {
    const profileResults = await mapWithConcurrency(profileSymbols, concurrency, async (symbol) => {
      try {
        return {
          symbol,
          quote: await fetchStableProfile(symbol, apiKey),
          error: null,
        }
      } catch (error) {
        return {
          symbol,
          quote: null,
          error: error instanceof Error ? error.message : 'Unknown FMP profile error',
        }
      }
    })

    profileFailures = profileResults.filter((result) => result.error)
    profileQuotes = profileResults
      .filter((result) => result.quote)
      .map(({ symbol, quote }) => ({
        symbol,
        quote,
        source: 'FMP profile',
      }))
  }

  const profileResolvedSymbols = new Set(profileQuotes.map((result) => result.symbol))
  const fallbackSymbols = quoteFailures
    .map((result) => result.symbol)
    .filter((symbol) => !profileResolvedSymbols.has(symbol))
  const fallbackFailures = []
  let fallbackQuotes = []

  if (fallbackSymbols.length) {
    try {
      const yahooQuotes = await fetchYahooQuotes(fallbackSymbols)
      const yahooQuoteBySymbol = new Map(
        yahooQuotes
          .filter((quote) => readString(quote?.symbol))
          .map((quote) => [quote.symbol.trim().toUpperCase(), quote]),
      )

      fallbackQuotes = fallbackSymbols
        .map((symbol) => ({
          symbol,
          quote: yahooQuoteBySymbol.get(symbol) || null,
          source: 'Yahoo Finance',
        }))
        .filter((result) => result.quote)

      const fallbackQuoteSymbols = new Set(fallbackQuotes.map((result) => result.symbol))

      for (const symbol of fallbackSymbols) {
        if (!fallbackQuoteSymbols.has(symbol)) {
          fallbackFailures.push({
            symbol,
            error: 'Yahoo Finance returned no quote record',
          })
        }
      }
    } catch (error) {
      for (const symbol of fallbackSymbols) {
        fallbackFailures.push({
          symbol,
          error: error instanceof Error ? error.message : 'Unknown Yahoo Finance fallback error',
        })
      }
    }
  }

  const allSuccessfulQuotes = [...successfulQuotes, ...profileQuotes, ...fallbackQuotes]

  if (!allSuccessfulQuotes.length) {
    throw new Error(
      `No quote provider returned data. ${summarizeFailures('FMP quote', quoteFailures)} ${
        summarizeFailures('FMP profile', profileFailures) || ''
      } ${
        summarizeFailures('Yahoo fallback', fallbackFailures) || ''
      }`,
    )
  }

  const symbolsNeedingEps = allSuccessfulQuotes
    .filter((result) => firstNumber(result.quote?.eps, result.quote?.epsTTM) === null)
    .filter((result) => result.source === 'FMP')
    .map((result) => result.symbol)
  const metricsBySymbol = new Map()
  let metricsFailures = []

  if (symbolsNeedingEps.length) {
    const metricResults = await mapWithConcurrency(symbolsNeedingEps, concurrency, async (symbol) => {
      try {
        return {
          symbol,
          metrics: await fetchStableMetrics(symbol, apiKey),
          error: null,
        }
      } catch (error) {
        return {
          symbol,
          metrics: null,
          error: error instanceof Error ? error.message : 'Unknown FMP metrics error',
        }
      }
    })

    for (const result of metricResults) {
      if (result.metrics) {
        metricsBySymbol.set(result.symbol, result.metrics)
      }
    }

    metricsFailures = metricResults.filter((result) => result.error)
  }

  const quotes = allSuccessfulQuotes.map(({ symbol, quote }) => {
    const metrics = metricsBySymbol.get(symbol)
    const eps = firstNumber(
      quote?.eps,
      quote?.epsTTM,
      quote?.epsTrailingTwelveMonths,
      quote?.trailingEps,
      metrics?.netIncomePerShareTTM,
      metrics?.epsTTM,
      metrics?.eps,
    )

    return {
      ...quote,
      symbol,
      eps,
    }
  })
  const fmpSuccessCount = successfulQuotes.length
  const profileSuccessCount = profileQuotes.length
  const fallbackSuccessCount = fallbackQuotes.length
  const profileMessage =
    profileSuccessCount > 0
      ? `${profileSuccessCount} symbol${
          profileSuccessCount === 1 ? '' : 's'
        } were blocked by FMP quote and filled with FMP profile data.`
      : null
  const fallbackMessage =
    fallbackSuccessCount > 0
      ? `${fallbackSuccessCount} symbol${
          fallbackSuccessCount === 1 ? '' : 's'
        } were blocked by FMP and filled with Yahoo Finance fallback.`
      : null
  const fallbackResolvedSymbols = new Set(fallbackQuotes.map((result) => result.symbol))
  const unresolvedFmpFailures = quoteFailures.filter(
    (failure) =>
      !profileResolvedSymbols.has(failure.symbol) && !fallbackResolvedSymbols.has(failure.symbol),
  )
  const unresolvedProfileFailures = profileFailures.filter(
    (failure) => !fallbackResolvedSymbols.has(failure.symbol),
  )

  const warning = [
    profileMessage,
    fallbackMessage,
    summarizeFailures('FMP quote', unresolvedFmpFailures),
    summarizeFailures('FMP profile', unresolvedProfileFailures),
    summarizeFailures('Yahoo fallback', fallbackFailures),
    summarizeFailures('EPS metrics', metricsFailures),
  ]
    .filter(Boolean)
    .join(' ')

  return {
    quotes,
    source:
      [
        fmpSuccessCount ? 'FMP stable quote' : null,
        profileSuccessCount ? 'FMP stable profile' : null,
        fallbackSuccessCount ? 'Yahoo fallback' : null,
      ]
        .filter(Boolean)
        .join(' + ') || 'FMP stable quote',
    warning: warning || null,
  }
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

  const { quotes, source, warning: fetchWarning } = await fetchQuotesFromFmp(symbols, apiKey)

  const quoteBySymbol = new Map(
    quotes
      .filter((quote) => readString(quote?.symbol))
      .map((quote) => [quote.symbol.trim().toUpperCase(), quote]),
  )

  const stocks = symbols.map((symbol) => normalizeQuote(symbol, quoteBySymbol.get(symbol)))
  const incompleteSymbols = stocks
    .filter((stock) => stock.currentPrice === null)
    .map((stock) => stock.symbol)
  const incompleteWarning = incompleteSymbols.length
    ? `${incompleteSymbols.length} configured symbol${
        incompleteSymbols.length === 1 ? '' : 's'
      } did not return complete quote data: ${incompleteSymbols.slice(0, 8).join(', ')}${
        incompleteSymbols.length > 8 ? ', ...' : ''
      }.`
    : null

  return {
    updatedAt: now.toISOString(),
    updatedLabel: formatDisplayTimestamp(now),
    source,
    warning: [fetchWarning, incompleteWarning].filter(Boolean).join(' ') || null,
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
