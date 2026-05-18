import 'dotenv/config'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createClient } from 'redis'
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
    60,
  ) * 1000
const marketCapCacheTtlMs =
  parsePositiveInt(
    process.env.FMP_MARKET_CAP_CACHE_SECONDS || process.env.TWELVE_DATA_FUNDAMENTALS_CACHE_SECONDS,
    86400,
  ) * 1000
const marketCapPartialRetryMs =
  parsePositiveInt(process.env.FMP_MARKET_CAP_PARTIAL_RETRY_SECONDS, 900) * 1000
const marketCapFailureRetryMs =
  parsePositiveInt(process.env.FMP_MARKET_CAP_FAILURE_RETRY_SECONDS, 3600) * 1000
const marketCapRateLimitRetryMs =
  parsePositiveInt(process.env.FMP_MARKET_CAP_RATE_LIMIT_RETRY_SECONDS, 43200) * 1000
const epsCacheTtlMs = parsePositiveInt(process.env.TWELVE_DATA_EPS_CACHE_SECONDS, 604800) * 1000
const backgroundRefreshIntervalMs =
  parsePositiveInt(process.env.BACKGROUND_REFRESH_INTERVAL_SECONDS, 60) * 1000
const epsBatchSize = parsePositiveInt(process.env.TWELVE_DATA_EPS_BATCH_SIZE, 1)
const marketCapProfileBatchSize = parsePositiveInt(process.env.FMP_MARKET_CAP_PROFILE_BATCH_SIZE, 2)

let keyValueClient = null
let keyValueConnectPromise = null
let keyValueDisabled = false

let stateCache = null
let backgroundRefreshPromise = null
let backgroundRefreshStarted = false
let backgroundRefreshTimer = null

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

function formatIsoLabel(value) {
  if (!value) {
    return null
  }

  const parsedDate = new Date(value)
  if (Number.isNaN(parsedDate.getTime())) {
    return null
  }

  return formatDisplayTimestamp(parsedDate)
}

function getTwelveDataApiKey() {
  return process.env.TWELVE_DATA_API_KEY || process.env.TWELVE_DATA_KEY || null
}

function getFmpApiKey() {
  return (
    process.env.FMP_API_KEY ||
    process.env.FINANCIAL_MODELING_PREP_API_KEY ||
    process.env.FINANCIALMODELINGPREP_API_KEY ||
    null
  )
}

function getKeyValueUrl() {
  return (
    process.env.RENDER_KEY_VALUE_URL ||
    process.env.REDIS_URL ||
    process.env.KEY_VALUE_URL ||
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

function buildSymbolsKey(symbols) {
  return symbols.join(',')
}

function cacheStorageKey(symbolsKey) {
  return `nima-stock-tracker:state:${symbolsKey}`
}

function createJobStatus(extra = {}) {
  return {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    ...extra,
  }
}

function createEmptyState(symbols) {
  return {
    version: 2,
    symbolsKey: buildSymbolsKey(symbols),
    symbols,
    quotesBySymbol: {},
    fundamentalsBySymbol: {},
    jobs: {
      quotes: createJobStatus(),
      marketCap: createJobStatus(),
      eps: createJobStatus({
        nextSymbolIndex: 0,
        lastProcessedSymbols: [],
      }),
    },
  }
}

function pickSymbolsObjectEntries(source, symbols) {
  if (!source || typeof source !== 'object') {
    return {}
  }

  return Object.fromEntries(
    symbols
      .map((symbol) => [symbol, source[symbol]])
      .filter(([, value]) => value && typeof value === 'object'),
  )
}

function parsePersistedState(parsed, symbols) {
  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const symbolsKey = buildSymbolsKey(symbols)
  const parsedSymbolsKey = readString(parsed.symbolsKey)

  if (parsedSymbolsKey && parsedSymbolsKey !== symbolsKey) {
    return null
  }

  const nextState = createEmptyState(symbols)

  nextState.quotesBySymbol = pickSymbolsObjectEntries(parsed.quotesBySymbol, symbols)
  nextState.fundamentalsBySymbol = pickSymbolsObjectEntries(parsed.fundamentalsBySymbol, symbols)
  nextState.jobs = {
    quotes: createJobStatus(parsed.jobs?.quotes),
    marketCap: createJobStatus(parsed.jobs?.marketCap),
    eps: createJobStatus({
      nextSymbolIndex: numberOrNull(parsed.jobs?.eps?.nextSymbolIndex) || 0,
      lastProcessedSymbols: Array.isArray(parsed.jobs?.eps?.lastProcessedSymbols)
        ? parsed.jobs.eps.lastProcessedSymbols.filter(Boolean)
        : [],
      lastAttemptAt: parsed.jobs?.eps?.lastAttemptAt || null,
      lastSuccessAt: parsed.jobs?.eps?.lastSuccessAt || null,
      lastError: parsed.jobs?.eps?.lastError || null,
    }),
  }

  return nextState
}

async function getKeyValueClient() {
  const url = getKeyValueUrl()

  if (!url || keyValueDisabled) {
    return null
  }

  if (keyValueClient?.isReady) {
    return keyValueClient
  }

  if (keyValueConnectPromise) {
    return keyValueConnectPromise
  }

  const client = createClient({
    url,
    socket: {
      reconnectStrategy: false,
    },
  })

  client.on('error', (error) => {
    console.warn('Render Key Value client error:', error)
  })

  keyValueConnectPromise = client
    .connect()
    .then(() => {
      keyValueClient = client
      return client
    })
    .catch((error) => {
      keyValueDisabled = true
      keyValueClient = null
      console.warn('Failed to connect to Render Key Value, falling back to local cache:', error)
      return null
    })
    .finally(() => {
      keyValueConnectPromise = null
    })

  return keyValueConnectPromise
}

async function readPersistedState(symbols) {
  const symbolsKey = buildSymbolsKey(symbols)
  const client = await getKeyValueClient()

  if (client) {
    try {
      const cached = await client.get(cacheStorageKey(symbolsKey))

      if (cached) {
        const parsed = parsePersistedState(JSON.parse(cached), symbols)
        if (parsed) {
          return parsed
        }
      }
    } catch (error) {
      console.warn('Failed to read persisted cache from Render Key Value:', error)
    }
  }

  try {
    const rawCache = await fs.readFile(cacheFile, 'utf8')
    return parsePersistedState(JSON.parse(rawCache), symbols)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    console.warn('Failed to read persisted stock cache:', error)
    return null
  }
}

async function writePersistedState(state) {
  const persistedRecord = {
    ...state,
    persistedAt: new Date().toISOString(),
  }

  const client = await getKeyValueClient()

  if (client) {
    try {
      await client.set(cacheStorageKey(state.symbolsKey), JSON.stringify(persistedRecord))
    } catch (error) {
      console.warn('Failed to write persisted cache to Render Key Value:', error)
    }
  }

  try {
    await fs.writeFile(cacheFile, JSON.stringify(persistedRecord, null, 2), 'utf8')
  } catch (error) {
    console.warn('Failed to write persisted stock cache:', error)
  }
}

async function ensureState(symbols) {
  const symbolsKey = buildSymbolsKey(symbols)

  if (stateCache && stateCache.symbolsKey === symbolsKey) {
    return stateCache
  }

  const persistedState = await readPersistedState(symbols)
  stateCache = persistedState || createEmptyState(symbols)
  return stateCache
}

function getOrCreateFundamental(state, symbol) {
  const cached = state.fundamentalsBySymbol[symbol]

  if (cached && typeof cached === 'object') {
    return cached
  }

  const nextFundamental = {
    symbol,
    name: null,
    exchange: null,
    marketCap: null,
    marketCapFetchedAt: null,
    eps: null,
    epsFetchedAt: null,
  }

  state.fundamentalsBySymbol[symbol] = nextFundamental
  return nextFundamental
}

function hasAnyQuoteData(state, symbols) {
  return symbols.some((symbol) => state.quotesBySymbol[symbol])
}

function hasAnyMarketCapData(state, symbols) {
  return symbols.some((symbol) => numberOrNull(state.fundamentalsBySymbol[symbol]?.marketCap) !== null)
}

function isFresh(timestamp, ttlMs, nowMs = Date.now()) {
  const parsed = timestamp ? new Date(timestamp).getTime() : Number.NaN
  return Number.isFinite(parsed) && nowMs - parsed < ttlMs
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

function extractLatestReportedEps(earningsPayload) {
  if (!Array.isArray(earningsPayload?.earnings)) {
    return null
  }

  const datedEarnings = earningsPayload.earnings
    .map((entry) => ({
      actual: numberOrNull(entry?.eps_actual),
      date: readString(entry?.date),
    }))
    .filter((entry) => entry.actual !== null && entry.date)
    .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime())

  const selectedQuarterlyEarnings = []

  for (const entry of datedEarnings) {
    const entryTime = new Date(entry.date).getTime()

    if (!Number.isFinite(entryTime)) {
      continue
    }

    const isDistinctQuarter = selectedQuarterlyEarnings.every(
      (selected) => Math.abs(entryTime - selected.time) >= 45 * 24 * 60 * 60 * 1000,
    )

    if (!isDistinctQuarter) {
      continue
    }

    selectedQuarterlyEarnings.push({
      time: entryTime,
      actual: entry.actual,
    })

    if (selectedQuarterlyEarnings.length === 4) {
      break
    }
  }

  if (selectedQuarterlyEarnings.length === 4) {
    return selectedQuarterlyEarnings.reduce((sum, entry) => sum + entry.actual, 0)
  }

  return datedEarnings[0]?.actual ?? null
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
  const computedPeRatio =
    typeof currentPrice === 'number' && typeof eps === 'number' && eps > 0 ? currentPrice / eps : null
  const providerPeRatio = firstNumber(quote?.pe, quote?.pe_ratio, quote?.price_earnings_ratio)
  const peRatio =
    providerPeRatio ??
    computedPeRatio

  const normalized = {
    symbol,
    name,
    eps,
    peRatio,
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

function fmpErrorMessage(body, fallback) {
  if (!body || typeof body !== 'object') {
    return fallback
  }

  return (
    readString(body['Error Message']) ||
    readString(body.message) ||
    readString(body.error) ||
    readString(body.Information) ||
    fallback
  )
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

async function fetchFmpJson(url, label) {
  const response = await fetch(url, {
    headers: {
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
    throw new Error(`${label} returned ${response.status}: ${fmpErrorMessage(body, bodyText.slice(0, 160))}`)
  }

  if (!Array.isArray(body) && (!body || typeof body !== 'object')) {
    throw new Error(`${label} rejected the request: ${fmpErrorMessage(body, 'unexpected response')}`)
  }

  return body
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

async function fetchEarnings(symbol, apiKey) {
  const url = new URL('https://api.twelvedata.com/earnings')
  url.searchParams.set('symbol', symbol)

  return fetchTwelveDataJson(url, apiKey, `Twelve Data earnings ${symbol}`)
}

function extractBatchMarketCaps(symbols, body) {
  const bySymbol = new Map()

  const pushMarketCap = (candidate, fallbackSymbol = null) => {
    if (!candidate || typeof candidate !== 'object') {
      return
    }

    const nested = candidate.data && typeof candidate.data === 'object' ? candidate.data : candidate
    const symbol =
      readString(nested?.symbol)?.toUpperCase() ||
      readString(fallbackSymbol)?.toUpperCase() ||
      null
    const marketCap = firstNumber(
      nested?.marketCap,
      nested?.market_cap,
      nested?.marketCapitalization,
      nested?.marketCapInUsd,
      nested?.marketCapUsd,
      nested?.mktCap,
      nested?.capitalization,
      nested?.value,
    )

    if (!symbol || marketCap === null || !symbols.includes(symbol)) {
      return
    }

    bySymbol.set(symbol, marketCap)
  }

  if (Array.isArray(body)) {
    for (const row of body) {
      pushMarketCap(row)
    }

    return bySymbol
  }

  if (!body || typeof body !== 'object') {
    return bySymbol
  }

  if (body.status === 'ok' && body.data) {
    return extractBatchMarketCaps(symbols, body.data)
  }

  pushMarketCap(body)

  for (const [key, value] of Object.entries(body)) {
    if (key === 'status' || key === 'code' || key === 'message' || key === 'Error Message') {
      continue
    }

    const fallbackSymbol = symbols.includes(key.toUpperCase()) ? key : null
    pushMarketCap(value, fallbackSymbol)
  }

  return bySymbol
}

async function fetchBatchMarketCaps(symbols, apiKey) {
  if (!symbols.length) {
    return new Map()
  }

  const url = new URL('https://financialmodelingprep.com/stable/market-capitalization-batch')
  url.searchParams.set('symbols', symbols.join(','))
  url.searchParams.set('apikey', apiKey)

  const body = await fetchFmpJson(url, `FMP batch market cap (${symbols.length} symbols)`)
  return extractBatchMarketCaps(symbols, body)
}

function extractProfileMarketCap(body) {
  const rows = Array.isArray(body) ? body : [body]

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue
    }

    const nested = row.data && typeof row.data === 'object' ? row.data : row
    const profile =
      Array.isArray(nested.profile) && nested.profile.length
        ? nested.profile[0]
        : nested.profile && typeof nested.profile === 'object'
          ? nested.profile
          : nested
    const marketCap = firstNumber(
      profile?.marketCap,
      profile?.market_cap,
      profile?.marketCapitalization,
      profile?.marketCapInUsd,
      profile?.marketCapUsd,
      profile?.mktCap,
    )

    if (marketCap === null) {
      continue
    }

    return {
      marketCap,
      name: readString(profile?.companyName) || readString(profile?.name),
      exchange: readString(profile?.exchangeShortName) || readString(profile?.exchange),
    }
  }

  return {
    marketCap: null,
    name: null,
    exchange: null,
  }
}

async function fetchProfileMarketCap(symbol, apiKey) {
  const url = new URL('https://financialmodelingprep.com/stable/profile')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('apikey', apiKey)

  const body = await fetchFmpJson(url, `FMP profile ${symbol}`)
  return extractProfileMarketCap(body)
}

function quoteNeedsRefresh(state, nowMs, force = false) {
  if (force) {
    return true
  }

  return !isFresh(state.jobs.quotes.lastSuccessAt, quoteCacheTtlMs, nowMs)
}

function marketCapNeedsRefresh(state, symbols, nowMs, force = false) {
  if (force) {
    return true
  }

  const hasMissingMarketCap = symbols.some((symbol) => {
    const fundamental = state.fundamentalsBySymbol[symbol]
    return numberOrNull(fundamental?.marketCap) === null
  })

  if (hasMissingMarketCap) {
    const retryWindowMs = marketCapRetryWindowMs(state.jobs.marketCap.lastError)
    return !isFresh(state.jobs.marketCap.lastAttemptAt, retryWindowMs, nowMs)
  }

  return !isFresh(state.jobs.marketCap.lastSuccessAt, marketCapCacheTtlMs, nowMs)
}

function marketCapRetryWindowMs(lastError) {
  const message = readString(lastError)

  if (!message) {
    return marketCapPartialRetryMs
  }

  if (message.includes('429') || message.includes('API credits') || message.includes('Limit Reach')) {
    return marketCapRateLimitRetryMs
  }

  if (message.includes('still do not have market cap data cached')) {
    return marketCapPartialRetryMs
  }

  return marketCapFailureRetryMs
}

function epsNeedsRefresh(fundamental, nowMs) {
  if (!fundamental) {
    return true
  }

  if (numberOrNull(fundamental.eps) === null) {
    return true
  }

  return !isFresh(fundamental.epsFetchedAt, epsCacheTtlMs, nowMs)
}

function pickNextEpsSymbols(state, symbols, nowMs, limit) {
  if (!symbols.length || limit <= 0) {
    return []
  }

  const startIndex = Math.min(state.jobs.eps.nextSymbolIndex || 0, symbols.length - 1)
  const selected = []
  let lastVisitedIndex = startIndex

  for (let offset = 0; offset < symbols.length && selected.length < limit; offset += 1) {
    const currentIndex = (startIndex + offset) % symbols.length
    const symbol = symbols[currentIndex]
    const fundamental = state.fundamentalsBySymbol[symbol]

    lastVisitedIndex = currentIndex

    if (epsNeedsRefresh(fundamental, nowMs)) {
      selected.push(symbol)
    }
  }

  state.jobs.eps.nextSymbolIndex = symbols.length ? (lastVisitedIndex + 1) % symbols.length : 0
  return selected
}

function summarizeBackgroundFailure(label, errorMessage) {
  const message = readString(errorMessage)

  if (!message) {
    return null
  }

  if (message.includes('Missing TWELVE_DATA_API_KEY')) {
    return `${label} refresh needs TWELVE_DATA_API_KEY on Render.`
  }

  if (message.includes('Missing FMP_API_KEY')) {
    return `${label} refresh needs FMP_API_KEY on Render.`
  }

  if (message.includes('429') || message.includes('API credits')) {
    return `${label} refresh hit a provider rate limit and will retry automatically.`
  }

  if (message.includes('401') || message.includes('403')) {
    return `${label} refresh was rejected by the provider. Check your API plan and permissions.`
  }

  if (message.includes('still do not have market cap data cached')) {
    return `${label} refresh is still warming the remaining symbols in the background.`
  }

  if (message.includes('returned no usable market cap values')) {
    return `${label} refresh returned no usable values. The server will retry automatically.`
  }

  return `${label} refresh failed and will retry automatically.`
}

async function refreshQuotes(state, symbols, { force = false } = {}) {
  const nowMs = Date.now()

  if (!quoteNeedsRefresh(state, nowMs, force)) {
    return false
  }

  state.jobs.quotes.lastAttemptAt = new Date(nowMs).toISOString()

  const apiKey = getTwelveDataApiKey()
  if (!apiKey) {
    state.jobs.quotes.lastError = 'Missing TWELVE_DATA_API_KEY'
    return true
  }

  try {
    const quotesBySymbol = await fetchBatchQuotes(symbols, apiKey)

    if (!quotesBySymbol.size) {
      throw new Error('No Twelve Data quotes were returned.')
    }

    for (const symbol of symbols) {
      const nextQuote = quotesBySymbol.get(symbol)

      if (!nextQuote) {
        continue
      }

      state.quotesBySymbol[symbol] = nextQuote

      const fundamental = getOrCreateFundamental(state, symbol)
      fundamental.name = readString(nextQuote.name) || fundamental.name
      fundamental.exchange =
        readString(nextQuote.exchange) ||
        readString(nextQuote.mic_code) ||
        fundamental.exchange

      const quotedMarketCap = firstNumber(
        nextQuote.market_capitalization,
        nextQuote.marketCap,
        nextQuote.market_cap,
      )

      if (quotedMarketCap !== null) {
        fundamental.marketCap = quotedMarketCap
        fundamental.marketCapFetchedAt = new Date().toISOString()
      }
    }

    state.jobs.quotes.lastSuccessAt = new Date().toISOString()
    state.jobs.quotes.lastError = null
    return true
  } catch (error) {
    state.jobs.quotes.lastError = error instanceof Error ? error.message : 'Unknown quote refresh error'
    return true
  }
}

async function refreshMarketCaps(state, symbols, { force = false } = {}) {
  const nowMs = Date.now()

  if (!marketCapNeedsRefresh(state, symbols, nowMs, force)) {
    return false
  }

  state.jobs.marketCap.lastAttemptAt = new Date(nowMs).toISOString()

  const apiKey = getFmpApiKey()
  if (!apiKey) {
    state.jobs.marketCap.lastError = 'Missing FMP_API_KEY'
    return true
  }

  try {
    const marketCapsBySymbol = await fetchBatchMarketCaps(symbols, apiKey)
    const fetchedAt = new Date().toISOString()
    const fallbackErrors = []
    const fallbackSymbols = symbols
      .filter((symbol) => marketCapsBySymbol.get(symbol) === undefined)
      .slice(0, marketCapProfileBatchSize)

    for (const symbol of fallbackSymbols) {
      try {
        const profileData = await fetchProfileMarketCap(symbol, apiKey)

        if (profileData.marketCap === null) {
          continue
        }

        marketCapsBySymbol.set(symbol, profileData.marketCap)

        const fundamental = getOrCreateFundamental(state, symbol)
        fundamental.name = profileData.name || fundamental.name
        fundamental.exchange = profileData.exchange || fundamental.exchange
      } catch (error) {
        fallbackErrors.push(
          `${symbol}: ${error instanceof Error ? error.message : 'Unknown FMP profile refresh error'}`,
        )
      }
    }

    if (!marketCapsBySymbol.size) {
      throw new Error('FMP batch market cap returned no usable market cap values.')
    }

    for (const symbol of symbols) {
      const fundamental = getOrCreateFundamental(state, symbol)
      const nextMarketCap = marketCapsBySymbol.get(symbol)

      if (nextMarketCap !== undefined) {
        fundamental.marketCap = nextMarketCap
        fundamental.marketCapFetchedAt = fetchedAt
      }
    }

    const remainingMissingCount = symbols.filter(
      (symbol) => numberOrNull(state.fundamentalsBySymbol[symbol]?.marketCap) === null,
    ).length

    state.jobs.marketCap.lastSuccessAt = fetchedAt
    state.jobs.marketCap.lastError = fallbackErrors[0]
      ? `${fallbackErrors.length} FMP profile market cap requests failed (${fallbackErrors
          .slice(0, 2)
          .join('; ')}).`
      : remainingMissingCount > 0
        ? `${remainingMissingCount} configured symbols still do not have market cap data cached from FMP yet.`
        : null
    return true
  } catch (error) {
    state.jobs.marketCap.lastError =
      error instanceof Error ? error.message : 'Unknown market cap refresh error'
    return true
  }
}

async function refreshEpsBatch(state, symbols) {
  const nowMs = Date.now()
  const symbolsToRefresh = pickNextEpsSymbols(state, symbols, nowMs, epsBatchSize)

  if (!symbolsToRefresh.length) {
    return false
  }

  state.jobs.eps.lastAttemptAt = new Date(nowMs).toISOString()
  state.jobs.eps.lastProcessedSymbols = symbolsToRefresh

  const apiKey = getTwelveDataApiKey()
  if (!apiKey) {
    state.jobs.eps.lastError = 'Missing TWELVE_DATA_API_KEY'
    return true
  }

  let hadSuccess = false
  let rateLimited = false
  const failedSymbols = []

  for (const symbol of symbolsToRefresh) {
    try {
      const eps = extractLatestReportedEps(await fetchEarnings(symbol, apiKey))
      const fundamental = getOrCreateFundamental(state, symbol)

      fundamental.eps = eps
      fundamental.epsFetchedAt = new Date().toISOString()
      hadSuccess = true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown EPS refresh error'
      failedSymbols.push(`${symbol}: ${message}`)

      if (message.includes('429') || message.includes('API credits')) {
        rateLimited = true
        break
      }
    }
  }

  if (hadSuccess) {
    state.jobs.eps.lastSuccessAt = new Date().toISOString()
  }

  state.jobs.eps.lastError = failedSymbols.length
    ? rateLimited
      ? `Rate limited while refreshing EPS (${failedSymbols[0]}).`
      : `Failed to refresh EPS for ${failedSymbols.join('; ')}`
    : null

  return true
}

function buildStatusCopy({
  hasQuotes,
  quoteFresh,
  missingMarketCapCount,
  missingEpsCount,
  missingPeRatioCount,
  stockCount,
}) {
  if (!hasQuotes) {
    return {
      headline: 'Fetching live data. This page will build itself out in stages as fresh data arrives.',
      detail: `Stage 1 loads stock prices for ${stockCount} symbols. Market Cap, EPS, and P/E will fill in from the shared cache after quotes arrive.`,
    }
  }

  if (!quoteFresh) {
    return {
      headline: 'Showing cached values while fresh stock prices are loading.',
      detail: 'The server refreshes quotes in the background and the page will keep filling in without needing full reload logic.',
    }
  }

  if (missingMarketCapCount > 0) {
    return {
      headline: 'Stock prices are current. The page is now filling in Market Cap data.',
      detail: 'This app intentionally loads in stages to stay inside the Twelve Data minute limit. EPS and P/E begin after the Market Cap cache warms.',
    }
  }

  if (missingEpsCount > 0) {
    return {
      headline: 'Stock prices and Market Cap are current. EPS and P/E are still filling in.',
      detail: `EPS refresh is throttled to ${epsBatchSize} symbol${epsBatchSize === 1 ? '' : 's'} per minute so the app stays inside your Twelve Data limit.`,
    }
  }

  if (missingPeRatioCount > 0) {
    return {
      headline: 'Stock prices, Market Cap, and EPS are current. P/E ratios are still settling.',
      detail: 'P/E ratios are recalculated from the newest prices and cached EPS as soon as both values are available for each stock.',
    }
  }

  return {
    headline: 'All data is current.',
    detail: 'Quotes refresh about once per minute, Market Cap refreshes daily, and EPS plus P/E stay cached until the next fundamentals refresh window.',
  }
}

function buildWarningText({
  state,
}) {
  const warnings = []

  const quoteWarning = summarizeBackgroundFailure('Quote', state.jobs.quotes.lastError)
  const marketCapWarning = summarizeBackgroundFailure('Market Cap', state.jobs.marketCap.lastError)
  const epsWarning = summarizeBackgroundFailure('EPS', state.jobs.eps.lastError)

  if (quoteWarning) {
    warnings.push(quoteWarning)
  }

  if (marketCapWarning) {
    warnings.push(marketCapWarning)
  }

  if (epsWarning) {
    warnings.push(epsWarning)
  }

  return warnings.join(' ') || null
}

function buildStocksPayload(state, symbols) {
  const nowMs = Date.now()
  const stocks = symbols.map((symbol) =>
    normalizeQuote(
      symbol,
      state.quotesBySymbol[symbol] || null,
      state.fundamentalsBySymbol[symbol] || null,
    ),
  )

  const missingQuoteCount = stocks.filter((stock) => stock.currentPrice === null).length
  const missingMarketCapCount = stocks.filter((stock) => stock.marketCap === null).length
  const missingEpsCount = stocks.filter((stock) => stock.eps === null).length
  const missingPeRatioCount = stocks.filter((stock) => stock.peRatio === null).length

  const quoteFresh = isFresh(state.jobs.quotes.lastSuccessAt, quoteCacheTtlMs + backgroundRefreshIntervalMs, nowMs)
  const marketCapFresh =
    missingMarketCapCount === 0 &&
    isFresh(state.jobs.marketCap.lastSuccessAt, marketCapCacheTtlMs, nowMs)
  const peRatioFresh = quoteFresh && missingPeRatioCount === 0
  const nextEpsSymbols = pickNextEpsSymbols(
    {
      jobs: {
        eps: {
          nextSymbolIndex: state.jobs.eps.nextSymbolIndex,
        },
      },
      fundamentalsBySymbol: state.fundamentalsBySymbol,
    },
    symbols,
    nowMs,
    Math.min(3, symbols.length),
  )
  const statusCopy = buildStatusCopy({
    hasQuotes: hasAnyQuoteData(state, symbols),
    quoteFresh,
    missingMarketCapCount,
    missingEpsCount,
    missingPeRatioCount,
    stockCount: symbols.length,
  })
  const buildStage =
    missingQuoteCount === symbols.length
      ? 'quotes'
      : missingMarketCapCount > 0
        ? 'market-cap'
        : missingEpsCount > 0
          ? 'eps'
          : missingPeRatioCount > 0
            ? 'eps'
          : 'complete'

  return {
    updatedAt: state.jobs.quotes.lastSuccessAt || state.jobs.marketCap.lastSuccessAt || null,
    updatedLabel: formatIsoLabel(state.jobs.quotes.lastSuccessAt || state.jobs.marketCap.lastSuccessAt),
    source: 'Render Key Value cache backed by Twelve Data quotes, FMP Market Cap, and a throttled Twelve Data EPS queue',
    warning: buildWarningText({
      state,
    }),
    stale: !quoteFresh,
    buildStage,
    isBuilding: buildStage !== 'complete',
    readyCounts: {
      quotes: symbols.length - missingQuoteCount,
      marketCap: symbols.length - missingMarketCapCount,
      eps: symbols.length - missingEpsCount,
      peRatio: symbols.length - missingPeRatioCount,
      total: symbols.length,
    },
    statusHeadline: statusCopy.headline,
    statusDetail: statusCopy.detail,
    freshness: {
      quotes: {
        updatedAt: state.jobs.quotes.lastSuccessAt,
        updatedLabel: formatIsoLabel(state.jobs.quotes.lastSuccessAt),
        stale: !quoteFresh,
        missingCount: missingQuoteCount,
      },
      marketCap: {
        updatedAt: state.jobs.marketCap.lastSuccessAt,
        updatedLabel: formatIsoLabel(state.jobs.marketCap.lastSuccessAt),
        stale: !marketCapFresh,
        missingCount: missingMarketCapCount,
      },
      eps: {
        updatedAt: state.jobs.eps.lastSuccessAt,
        updatedLabel: formatIsoLabel(state.jobs.eps.lastSuccessAt),
        stale: missingEpsCount > 0,
        missingCount: missingEpsCount,
        batchSize: epsBatchSize,
        nextSymbols: nextEpsSymbols,
      },
      peRatio: {
        updatedAt: state.jobs.quotes.lastSuccessAt || state.jobs.eps.lastSuccessAt,
        updatedLabel: formatIsoLabel(state.jobs.quotes.lastSuccessAt || state.jobs.eps.lastSuccessAt),
        stale: !peRatioFresh,
        missingCount: missingPeRatioCount,
      },
    },
    stocks: sortByHighProximity(stocks),
  }
}

function buildErrorHint(error) {
  const message = error instanceof Error ? error.message : String(error || '')

  if (message.includes('Missing TWELVE_DATA_API_KEY')) {
    return 'TWELVE_DATA_API_KEY is missing on Render. Add it under the web service Environment settings and redeploy.'
  }

  if (message.includes('Missing FMP_API_KEY')) {
    return 'FMP_API_KEY is missing on Render. Add it under the web service Environment settings and redeploy.'
  }

  if (message.includes('429') || message.includes('API credits')) {
    return 'The provider rate-limited a refresh. The server will keep retrying in the background while serving the last good cache.'
  }

  if (message.includes('401') || message.includes('403')) {
    return 'One of the provider keys was rejected. Verify that the Render environment variables are correct and that the plan includes the endpoints this app uses.'
  }

  if (message.includes('Key Value')) {
    return 'Render Key Value is unavailable. Verify that RENDER_KEY_VALUE_URL is set and points to your Render Key Value instance.'
  }

  return 'Check that the provider keys are configured on Render and try again.'
}

async function runBackgroundRefreshCycle({
  forceQuotes = false,
  forceMarketCap = false,
  allowEps = true,
} = {}) {
  if (backgroundRefreshPromise) {
    return backgroundRefreshPromise
  }

  backgroundRefreshPromise = (async () => {
    const symbols = await readConfiguredSymbols()
    const state = await ensureState(symbols)
    const hadQuotes = hasAnyQuoteData(state, symbols)
    const hadMarketCap = hasAnyMarketCapData(state, symbols)

    await refreshQuotes(state, symbols, { force: forceQuotes })

    if (!hadQuotes && hasAnyQuoteData(state, symbols)) {
      await writePersistedState(state)
      return buildStocksPayload(state, symbols)
    }

    await refreshMarketCaps(state, symbols, { force: forceMarketCap })

    if (!hadMarketCap && hasAnyMarketCapData(state, symbols)) {
      await writePersistedState(state)
      return buildStocksPayload(state, symbols)
    }

    if (allowEps) {
      await refreshEpsBatch(state, symbols)
    }

    await writePersistedState(state)
    return buildStocksPayload(state, symbols)
  })()

  try {
    return await backgroundRefreshPromise
  } finally {
    backgroundRefreshPromise = null
  }
}

function startBackgroundRefreshLoop() {
  if (backgroundRefreshStarted) {
    return
  }

  backgroundRefreshStarted = true

  const triggerRefresh = () => {
    void runBackgroundRefreshCycle().catch((error) => {
      console.error('Background stock refresh failed:', error)
    })
  }

  triggerRefresh()

  backgroundRefreshTimer = setInterval(triggerRefresh, backgroundRefreshIntervalMs)
  backgroundRefreshTimer.unref?.()
}

async function getStocksPayload({ forceRefresh = false } = {}) {
  const symbols = await readConfiguredSymbols()
  const state = await ensureState(symbols)

  startBackgroundRefreshLoop()
  const queueRefresh = (options) => {
    void runBackgroundRefreshCycle(options).catch((error) => {
      console.error('Background stock refresh failed:', error)
    })
  }

  if (!hasAnyQuoteData(state, symbols)) {
    queueRefresh({
      forceQuotes: true,
      forceMarketCap: false,
      allowEps: false,
    })

    return buildStocksPayload(state, symbols)
  }

  const nowMs = Date.now()

  if (forceRefresh) {
    queueRefresh({
      forceQuotes: true,
      forceMarketCap: false,
      allowEps: false,
    })

    return buildStocksPayload(state, symbols)
  }

  if (quoteNeedsRefresh(state, nowMs) || marketCapNeedsRefresh(state, symbols, nowMs)) {
    queueRefresh({
      forceQuotes: quoteNeedsRefresh(state, nowMs),
      forceMarketCap: marketCapNeedsRefresh(state, symbols, nowMs),
      allowEps: false,
    })
  } else if (symbols.some((symbol) => epsNeedsRefresh(state.fundamentalsBySymbol[symbol], nowMs))) {
    queueRefresh({
      allowEps: true,
    })
  }

  return buildStocksPayload(state, symbols)
}

app.use(express.static(distDir))

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/stocks', async (req, res) => {
  try {
    const payload = await getStocksPayload({
      forceRefresh: req.query.refresh === 'true',
    })

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
  startBackgroundRefreshLoop()
})
