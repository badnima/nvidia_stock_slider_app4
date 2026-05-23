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
      process.env.GOOGLE_SHEETS_CACHE_TTL_SECONDS,
    60,
  ) * 1000
const fundamentalsCacheTtlMs =
  parsePositiveInt(
    process.env.GOOGLE_SHEETS_SNAPSHOT_CACHE_SECONDS ||
      process.env.GOOGLE_SHEET_SNAPSHOT_CACHE_SECONDS ||
      process.env.TWELVE_DATA_FUNDAMENTALS_CACHE_SECONDS,
    900,
  ) * 1000
const fundamentalsPartialRetryMs =
  parsePositiveInt(process.env.GOOGLE_SHEETS_PARTIAL_RETRY_SECONDS, 900) * 1000
const fundamentalsFailureRetryMs =
  parsePositiveInt(process.env.GOOGLE_SHEETS_FAILURE_RETRY_SECONDS, 3600) * 1000
const backgroundRefreshIntervalMs =
  parsePositiveInt(process.env.BACKGROUND_REFRESH_INTERVAL_SECONDS, 120) * 1000

let keyValueClient = null
let keyValueConnectPromise = null
let keyValueDisabled = false

let stateCache = null
let backgroundRefreshPromise = null
let backgroundRefreshStarted = false
let backgroundRefreshTimer = null

app.use(express.json())

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

    if (
      !normalized ||
      normalized === '--' ||
      normalized.startsWith('#') ||
      normalized.toUpperCase() === 'N/A'
    ) {
      return null
    }

    const suffixMatch = normalized.match(/^(-?[\d.]+)\s*([KMBT])$/i)
    if (suffixMatch) {
      const base = Number(suffixMatch[1])
      const multiplier = {
        K: 1e3,
        M: 1e6,
        B: 1e9,
        T: 1e12,
      }[suffixMatch[2].toUpperCase()]

      if (Number.isFinite(base) && multiplier) {
        return base * multiplier
      }
    }

    const parsed = Number(normalized.replaceAll('$', '').replaceAll('%', ''))
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

function normalizeSymbolValue(value) {
  const normalized = readString(value)?.toUpperCase()

  if (!normalized) {
    return null
  }

  if (normalized.includes(':')) {
    return normalized.split(':').at(-1) || null
  }

  return normalized
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

function getGoogleSheetsSnapshotUrl() {
  return (
    process.env.GOOGLE_SHEETS_SNAPSHOT_URL ||
    process.env.GOOGLE_SHEET_SNAPSHOT_URL ||
    process.env.GOOGLE_SHEET_URL ||
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
    version: 5,
    symbolsKey: buildSymbolsKey(symbols),
    symbols,
    quotesBySymbol: {},
    fundamentalsBySymbol: {},
    settings: {
      quoteRefreshEnabled: true,
    },
    jobs: {
      quotes: createJobStatus(),
      fundamentals: createJobStatus(),
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
  nextState.settings.quoteRefreshEnabled =
    typeof parsed.settings?.quoteRefreshEnabled === 'boolean'
      ? parsed.settings.quoteRefreshEnabled
      : typeof parsed.quoteRefreshEnabled === 'boolean'
        ? parsed.quoteRefreshEnabled
        : true
  nextState.jobs = {
    quotes: createJobStatus(parsed.jobs?.quotes),
    fundamentals: createJobStatus(parsed.jobs?.fundamentals || parsed.jobs?.marketCap || parsed.jobs?.eps),
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
    beta: null,
    betaFetchedAt: null,
    marketCap: null,
    marketCapFetchedAt: null,
    eps: null,
    epsFetchedAt: null,
    peRatio: null,
    peRatioFetchedAt: null,
  }

  state.fundamentalsBySymbol[symbol] = nextFundamental
  return nextFundamental
}

function hasAnyQuoteData(state, symbols) {
  return symbols.some((symbol) => state.quotesBySymbol[symbol])
}

function hasAnyFundamentalSnapshotData(state, symbols) {
  return symbols.some((symbol) => {
    const cached = state.fundamentalsBySymbol[symbol]
    return (
      numberOrNull(cached?.beta) !== null ||
      numberOrNull(cached?.marketCap) !== null ||
      numberOrNull(cached?.eps) !== null ||
      numberOrNull(cached?.peRatio) !== null
    )
  })
}

function isQuoteRefreshEnabled(state) {
  return state?.settings?.quoteRefreshEnabled !== false
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
    fundamentals?.marketCap,
    quote?.market_capitalization,
    quote?.marketCap,
  )
  const eps = firstNumber(
    fundamentals?.eps,
    quote?.eps,
    quote?.eps_ttm,
    quote?.trailing_eps,
  )
  const beta = firstNumber(
    fundamentals?.beta,
    quote?.beta,
  )
  const name =
    readString(quote?.name) ||
    readString(quote?.companyName) ||
    readString(fundamentals?.name) ||
    symbol
  const computedPeRatio =
    typeof currentPrice === 'number' && typeof eps === 'number' && eps > 0 ? currentPrice / eps : null
  const providerPeRatio = firstNumber(
    fundamentals?.peRatio,
    quote?.pe,
    quote?.pe_ratio,
    quote?.price_earnings_ratio,
  )
  const peRatio =
    providerPeRatio ??
    computedPeRatio

  const normalized = {
    symbol,
    name,
    beta,
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

function parseCsv(text) {
  const rows = []
  let currentRow = []
  let currentCell = ''
  let inQuotes = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const nextChar = text[index + 1]

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentCell)
      currentCell = ''
      continue
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        index += 1
      }

      currentRow.push(currentCell)
      rows.push(currentRow)
      currentRow = []
      currentCell = ''
      continue
    }

    currentCell += char
  }

  if (currentCell.length || currentRow.length) {
    currentRow.push(currentCell)
    rows.push(currentRow)
  }

  return rows.filter((row) => row.some((cell) => readString(cell) !== null))
}

function normalizeSnapshotHeader(header) {
  return (readString(header) || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function extractSnapshotRecord(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return null
  }

  const symbol = normalizeSymbolValue(candidate.symbol || candidate.ticker || candidate.stock || candidate.googleTicker)

  if (!symbol) {
    return null
  }

  return {
    symbol,
    beta: firstNumber(
      candidate.beta,
      candidate.beta5y,
      candidate.fiveYearBeta,
      candidate.fiveyearbeta,
    ),
    marketCap: firstNumber(
      candidate.marketCap,
      candidate.marketcap,
      candidate.market_cap,
      candidate.marketCapitalization,
    ),
    eps: firstNumber(candidate.eps, candidate.epsttm, candidate.eps_ttm),
    peRatio: firstNumber(
      candidate.pe,
      candidate.peratio,
      candidate.pe_ratio,
      candidate.priceearningsratio,
      candidate.price_earnings_ratio,
    ),
    name: readString(candidate.name) || readString(candidate.companyName),
    exchange: readString(candidate.exchange) || readString(candidate.exchangeShortName),
  }
}

function extractSnapshotPayloadFromCsv(text) {
  const rows = parseCsv(text)

  if (!rows.length) {
    return {
      updatedAt: null,
      rowsBySymbol: new Map(),
    }
  }

  const [headerRow, ...valueRows] = rows
  const headers = headerRow.map((header) => normalizeSnapshotHeader(header))
  const symbolIndex = headers.findIndex((header) => ['symbol', 'ticker', 'stock', 'googleticker'].includes(header))

  if (symbolIndex === -1) {
    throw new Error('Google Sheet snapshot CSV is missing a symbol column.')
  }

  const rowsBySymbol = new Map()

  for (const row of valueRows) {
    const candidate = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null]))
    const record = extractSnapshotRecord(candidate)

    if (!record) {
      continue
    }

    rowsBySymbol.set(record.symbol, record)
  }

  return {
    updatedAt: null,
    rowsBySymbol,
  }
}

function extractSnapshotPayloadFromJson(body) {
  const rowsBySymbol = new Map()
  const rawRows =
    Array.isArray(body)
      ? body
      : Array.isArray(body?.rows)
        ? body.rows
        : Array.isArray(body?.stocks)
          ? body.stocks
          : Array.isArray(body?.data)
            ? body.data
            : []

  for (const row of rawRows) {
    const record = extractSnapshotRecord(row)

    if (!record) {
      continue
    }

    rowsBySymbol.set(record.symbol, record)
  }

  return {
    updatedAt:
      readString(body?.updatedAt) ||
      readString(body?.snapshotAt) ||
      readString(body?.generatedAt) ||
      readString(body?.lastUpdatedAt) ||
      null,
    rowsBySymbol,
  }
}

async function fetchGoogleSheetsSnapshot(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'nima-stock-tracker/1.0',
      accept: 'application/json,text/csv,text/plain,*/*',
    },
  })
  const bodyText = await response.text()

  if (!response.ok) {
    throw new Error(`Google Sheet snapshot returned ${response.status}: ${bodyText.slice(0, 160)}`)
  }

  const trimmed = bodyText.trim()
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let body = null

    try {
      body = trimmed ? JSON.parse(trimmed) : null
    } catch {
      throw new Error(`Google Sheet snapshot returned invalid JSON: ${trimmed.slice(0, 160)}`)
    }

    return extractSnapshotPayloadFromJson(body)
  }

  return extractSnapshotPayloadFromCsv(bodyText)
}

function quoteNeedsRefresh(state, nowMs, force = false) {
  if (!isQuoteRefreshEnabled(state)) {
    return false
  }

  if (force) {
    return true
  }

  return !isFresh(state.jobs.quotes.lastSuccessAt, quoteCacheTtlMs, nowMs)
}

function fundamentalsNeedRefresh(state, symbols, nowMs, force = false) {
  if (force) {
    return true
  }

  const hasMissingFundamentals = symbols.some((symbol) => {
    const fundamental = state.fundamentalsBySymbol[symbol]
    return (
      numberOrNull(fundamental?.beta) === null ||
      numberOrNull(fundamental?.marketCap) === null ||
      numberOrNull(fundamental?.eps) === null ||
      numberOrNull(fundamental?.peRatio) === null
    )
  })

  if (hasMissingFundamentals) {
    const retryWindowMs = fundamentalsRetryWindowMs(state.jobs.fundamentals.lastError)
    return !isFresh(state.jobs.fundamentals.lastAttemptAt, retryWindowMs, nowMs)
  }

  return !isFresh(state.jobs.fundamentals.lastSuccessAt, fundamentalsCacheTtlMs, nowMs)
}

function fundamentalsRetryWindowMs(lastError) {
  const message = readString(lastError)

  if (!message) {
    return fundamentalsPartialRetryMs
  }

  if (message.includes('still do not have snapshot values cached')) {
    return fundamentalsPartialRetryMs
  }

  if (message.includes('401') || message.includes('403')) {
    return fundamentalsFailureRetryMs
  }

  return fundamentalsFailureRetryMs
}

function summarizeBackgroundFailure(label, errorMessage) {
  const message = readString(errorMessage)

  if (!message) {
    return null
  }

  if (message.includes('Missing TWELVE_DATA_API_KEY')) {
    return `${label} refresh needs TWELVE_DATA_API_KEY on Render.`
  }

  if (message.includes('Missing GOOGLE_SHEETS_SNAPSHOT_URL')) {
    return `${label} refresh needs GOOGLE_SHEETS_SNAPSHOT_URL on Render.`
  }

  if (message.includes('401') || message.includes('403')) {
    return `${label} refresh was rejected. Check that the Google Sheet snapshot is published and accessible from Render.`
  }

  if (message.includes('still do not have snapshot values cached')) {
    return `${label} refresh is still warming the remaining symbols in the background.`
  }

  if (message.includes('returned no usable snapshot rows')) {
    return `${label} refresh returned no usable values. The server will retry automatically.`
  }

  return `${label} refresh failed and will retry automatically.`
}

async function refreshQuotes(state, symbols, { force = false } = {}) {
  if (!isQuoteRefreshEnabled(state)) {
    return false
  }

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
    }

    state.jobs.quotes.lastSuccessAt = new Date().toISOString()
    state.jobs.quotes.lastError = null
    return true
  } catch (error) {
    state.jobs.quotes.lastError = error instanceof Error ? error.message : 'Unknown quote refresh error'
    return true
  }
}

async function refreshFundamentalsSnapshot(state, symbols, { force = false } = {}) {
  const nowMs = Date.now()

  if (!fundamentalsNeedRefresh(state, symbols, nowMs, force)) {
    return false
  }

  state.jobs.fundamentals.lastAttemptAt = new Date(nowMs).toISOString()

  const snapshotUrl = getGoogleSheetsSnapshotUrl()
  if (!snapshotUrl) {
    state.jobs.fundamentals.lastError = 'Missing GOOGLE_SHEETS_SNAPSHOT_URL'
    return true
  }

  try {
    const snapshot = await fetchGoogleSheetsSnapshot(snapshotUrl)
    const fetchedAt = snapshot.updatedAt || new Date().toISOString()

    if (!snapshot.rowsBySymbol.size) {
      throw new Error('Google Sheet snapshot returned no usable snapshot rows.')
    }

    for (const symbol of symbols) {
      const fundamental = getOrCreateFundamental(state, symbol)
      const snapshotRow = snapshot.rowsBySymbol.get(symbol)

      if (snapshotRow) {
        if (snapshotRow.marketCap !== null) {
          fundamental.marketCap = snapshotRow.marketCap
        }
        if (snapshotRow.beta !== null) {
          fundamental.beta = snapshotRow.beta
        }
        if (snapshotRow.eps !== null) {
          fundamental.eps = snapshotRow.eps
        }
        if (snapshotRow.peRatio !== null) {
          fundamental.peRatio = snapshotRow.peRatio
        }
        fundamental.name = snapshotRow.name || fundamental.name
        fundamental.exchange = snapshotRow.exchange || fundamental.exchange
        fundamental.betaFetchedAt = fetchedAt
        fundamental.marketCapFetchedAt = fetchedAt
        fundamental.epsFetchedAt = fetchedAt
        fundamental.peRatioFetchedAt = fetchedAt
      }
    }

    const remainingMissingValueCount = symbols.filter((symbol) => {
      const cached = state.fundamentalsBySymbol[symbol]
      return (
        numberOrNull(cached?.beta) === null ||
        numberOrNull(cached?.marketCap) === null ||
        numberOrNull(cached?.eps) === null ||
        numberOrNull(cached?.peRatio) === null
      )
    }).length

    state.jobs.fundamentals.lastSuccessAt = fetchedAt
    state.jobs.fundamentals.lastError =
      remainingMissingValueCount > 0
        ? `${remainingMissingValueCount} configured symbols still do not have snapshot values cached.`
        : null
    return true
  } catch (error) {
    state.jobs.fundamentals.lastError =
      error instanceof Error ? error.message : 'Unknown Google Sheet snapshot refresh error'
    return true
  }
}

function getFundamentalsUpdatedAt(state) {
  return state.jobs.fundamentals.lastSuccessAt || null
}

function buildStatusCopy({
  hasQuotes,
  quoteFresh,
  quoteRefreshEnabled,
  missingBetaCount,
  missingMarketCapCount,
  missingEpsCount,
  missingPeRatioCount,
  stockCount,
  fundamentalsLoaded,
}) {
  if (!quoteRefreshEnabled) {
    if (!hasQuotes) {
      return {
        headline: 'Live quote refresh is paused.',
        detail:
          'No new Twelve Data requests will be sent until you turn quote refresh back on. Google Sheet fundamentals can still warm in the background.',
      }
    }

    return {
      headline: 'Live quote refresh is paused.',
      detail:
        'Cached quote data remains visible, and no new Twelve Data requests will be sent until you turn quote refresh back on.',
    }
  }

  if (!hasQuotes) {
    return {
      headline: 'Fetching live data. This page will build itself out in stages as fresh data arrives.',
      detail: `Stage 1 loads stock prices for ${stockCount} symbols. Market Cap, EPS, and P/E fill in after the Google Sheet snapshot is merged on the server.`,
    }
  }

  if (!quoteFresh) {
    return {
      headline: 'Showing cached values while fresh stock prices are loading.',
      detail: 'The server refreshes quotes in the background and the page will keep filling in without needing full reload logic.',
    }
  }

  if (!fundamentalsLoaded) {
    return {
      headline: 'Stock prices are current. The page is now merging the Google Sheet snapshot.',
      detail: 'Market Cap, EPS, P/E, and Beta come from your published Google Sheet snapshot while price data stays live from Twelve Data.',
    }
  }

  if (missingBetaCount > 0 || missingMarketCapCount > 0 || missingEpsCount > 0 || missingPeRatioCount > 0) {
    return {
      headline: 'Quotes are current. Some Google Sheet snapshot values are still blank.',
      detail: 'The app will keep serving the last good fundamentals cache while your Google Sheet snapshot fills in any missing Beta, Market Cap, EPS, or P/E values.',
    }
  }

  return {
    headline: 'All data is current.',
    detail: 'Quotes refresh about once per minute, and Beta, Market Cap, EPS, plus P/E come from the latest Google Sheet snapshot cached on the server.',
  }
}

function buildWarningText({
  state,
}) {
  const warnings = []

  const quoteWarning = isQuoteRefreshEnabled(state)
    ? summarizeBackgroundFailure('Quote', state.jobs.quotes.lastError)
    : null
  const fundamentalsWarning = summarizeBackgroundFailure('Google Sheet snapshot', state.jobs.fundamentals.lastError)

  if (quoteWarning) {
    warnings.push(quoteWarning)
  }

  if (fundamentalsWarning) {
    warnings.push(fundamentalsWarning)
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
  const missingBetaCount = stocks.filter((stock) => stock.beta === null).length
  const missingMarketCapCount = stocks.filter((stock) => stock.marketCap === null).length
  const missingEpsCount = stocks.filter((stock) => stock.eps === null).length
  const missingPeRatioCount = stocks.filter((stock) => stock.peRatio === null).length

  const quoteRefreshEnabled = isQuoteRefreshEnabled(state)
  const quoteFresh = quoteRefreshEnabled
    ? isFresh(state.jobs.quotes.lastSuccessAt, quoteCacheTtlMs + backgroundRefreshIntervalMs, nowMs)
    : Boolean(state.jobs.quotes.lastSuccessAt)
  const fundamentalsUpdatedAt = getFundamentalsUpdatedAt(state)
  const fundamentalsLoaded = Boolean(fundamentalsUpdatedAt)
  const fundamentalsFresh =
    fundamentalsLoaded &&
    isFresh(fundamentalsUpdatedAt, fundamentalsCacheTtlMs + backgroundRefreshIntervalMs, nowMs)
  const betaFresh = fundamentalsFresh && missingBetaCount === 0
  const marketCapFresh = fundamentalsFresh && missingMarketCapCount === 0
  const epsFresh = fundamentalsFresh && missingEpsCount === 0
  const peRatioFresh = fundamentalsFresh && missingPeRatioCount === 0
  const statusCopy = buildStatusCopy({
    hasQuotes: hasAnyQuoteData(state, symbols),
    quoteFresh,
    quoteRefreshEnabled,
    missingBetaCount,
    missingMarketCapCount,
    missingEpsCount,
    missingPeRatioCount,
    stockCount: symbols.length,
    fundamentalsLoaded,
  })
  const buildStage =
    missingQuoteCount === symbols.length
      ? 'quotes'
      : fundamentalsLoaded
        ? 'complete'
        : 'fundamentals'

  return {
    quoteRefreshEnabled,
    updatedAt: state.jobs.quotes.lastSuccessAt || fundamentalsUpdatedAt || null,
    updatedLabel: formatIsoLabel(state.jobs.quotes.lastSuccessAt || fundamentalsUpdatedAt),
    source: 'Render Key Value cache backed by Twelve Data quotes and a Google Sheet fundamentals snapshot',
    warning: buildWarningText({
      state,
    }),
    stale: quoteRefreshEnabled ? !quoteFresh : false,
    buildStage,
    isBuilding: buildStage !== 'complete',
    readyCounts: {
      quotes: symbols.length - missingQuoteCount,
      beta: symbols.length - missingBetaCount,
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
        stale: quoteRefreshEnabled ? !quoteFresh : false,
        paused: !quoteRefreshEnabled,
        missingCount: missingQuoteCount,
      },
      marketCap: {
        updatedAt: fundamentalsUpdatedAt,
        updatedLabel: formatIsoLabel(fundamentalsUpdatedAt),
        stale: !marketCapFresh,
        missingCount: missingMarketCapCount,
      },
      beta: {
        updatedAt: fundamentalsUpdatedAt,
        updatedLabel: formatIsoLabel(fundamentalsUpdatedAt),
        stale: !betaFresh,
        missingCount: missingBetaCount,
      },
      eps: {
        updatedAt: fundamentalsUpdatedAt,
        updatedLabel: formatIsoLabel(fundamentalsUpdatedAt),
        stale: !epsFresh,
        missingCount: missingEpsCount,
      },
      peRatio: {
        updatedAt: fundamentalsUpdatedAt,
        updatedLabel: formatIsoLabel(fundamentalsUpdatedAt),
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

  if (message.includes('Missing GOOGLE_SHEETS_SNAPSHOT_URL')) {
    return 'GOOGLE_SHEETS_SNAPSHOT_URL is missing on Render. Point it to your published Google Sheet snapshot and redeploy.'
  }

  if (message.includes('401') || message.includes('403')) {
    return 'The Google Sheet snapshot was rejected. Verify that the snapshot is public or otherwise reachable from Render.'
  }

  if (message.includes('Key Value')) {
    return 'Render Key Value is unavailable. Verify that RENDER_KEY_VALUE_URL is set and points to your Render Key Value instance.'
  }

  return 'Check that the provider keys are configured on Render and try again.'
}

async function runBackgroundRefreshCycle({
  forceQuotes = false,
  forceFundamentals = false,
} = {}) {
  if (backgroundRefreshPromise) {
    return backgroundRefreshPromise
  }

  backgroundRefreshPromise = (async () => {
    const symbols = await readConfiguredSymbols()
    const state = await ensureState(symbols)
    const hadQuotes = hasAnyQuoteData(state, symbols)
    const hadFundamentals = hasAnyFundamentalSnapshotData(state, symbols)

    await refreshQuotes(state, symbols, { force: forceQuotes })

    if (!hadQuotes && hasAnyQuoteData(state, symbols)) {
      await writePersistedState(state)
      return buildStocksPayload(state, symbols)
    }

    await refreshFundamentalsSnapshot(state, symbols, { force: forceFundamentals })

    if (!hadFundamentals && hasAnyFundamentalSnapshotData(state, symbols)) {
      await writePersistedState(state)
      return buildStocksPayload(state, symbols)
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
  const quoteRefreshEnabled = isQuoteRefreshEnabled(state)

  startBackgroundRefreshLoop()
  const queueRefresh = (options) => {
    void runBackgroundRefreshCycle(options).catch((error) => {
      console.error('Background stock refresh failed:', error)
    })
  }

  if (!hasAnyQuoteData(state, symbols)) {
    queueRefresh({
      forceQuotes: quoteRefreshEnabled,
      forceFundamentals: true,
    })

    return buildStocksPayload(state, symbols)
  }

  const nowMs = Date.now()

  if (forceRefresh) {
    queueRefresh({
      forceQuotes: quoteRefreshEnabled,
      forceFundamentals: false,
    })

    return buildStocksPayload(state, symbols)
  }

  if (quoteNeedsRefresh(state, nowMs) || fundamentalsNeedRefresh(state, symbols, nowMs)) {
    queueRefresh({
      forceQuotes: quoteNeedsRefresh(state, nowMs),
      forceFundamentals: fundamentalsNeedRefresh(state, symbols, nowMs),
    })
  }

  return buildStocksPayload(state, symbols)
}

async function setQuoteRefreshEnabled(enabled) {
  const symbols = await readConfiguredSymbols()
  const state = await ensureState(symbols)

  state.settings.quoteRefreshEnabled = enabled

  if (!enabled) {
    state.jobs.quotes.lastError = null
    await writePersistedState(state)
    return buildStocksPayload(state, symbols)
  }

  state.jobs.quotes.lastError = null
  await writePersistedState(state)
  return runBackgroundRefreshCycle({
    forceQuotes: true,
    forceFundamentals: false,
  })
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

app.post('/api/quote-refresh', async (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({
        error: 'Quote refresh setting is invalid.',
        detail: 'Send { "enabled": true } or { "enabled": false }.',
      })
      return
    }

    const payload = await setQuoteRefreshEnabled(req.body.enabled)
    res.set('Cache-Control', 'no-store')
    res.json(payload)
  } catch (error) {
    console.error('Failed to update quote refresh setting:', error)
    res.status(502).json({
      error: 'Unable to update quote refresh right now.',
      detail: error instanceof Error ? error.message : 'Unknown quote refresh setting error.',
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
