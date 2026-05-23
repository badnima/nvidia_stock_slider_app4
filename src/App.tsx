import { useCallback, useEffect, useMemo, useState } from 'react'
import { DatabaseZap, RefreshCcw, Server, TrendingUp } from 'lucide-react'
import './App.css'

type SortMetric = 'positionPercent' | 'eps' | 'peRatio' | 'marketCap'

type StockQuote = {
  symbol: string
  name: string
  eps: number | null
  peRatio: number | null
  marketCap: number | null
  currentPrice: number | null
  week52Low: number | null
  week52High: number | null
  positionPercent: number | null
  distanceFromHighPercent: number | null
}

type FreshnessStatus = {
  updatedAt: string | null
  updatedLabel: string | null
  stale: boolean
  missingCount: number
  paused?: boolean
}

type StocksPayload = {
  quoteRefreshEnabled: boolean
  updatedAt: string | null
  updatedLabel: string | null
  source: string | null
  warning: string | null
  stale: boolean
  buildStage?: 'quotes' | 'fundamentals' | 'complete'
  isBuilding?: boolean
  readyCounts?: {
    quotes: number
    marketCap: number
    eps: number
    peRatio: number
    total: number
  }
  statusHeadline: string
  statusDetail: string | null
  freshness: {
    quotes: FreshnessStatus
    marketCap: FreshnessStatus
    eps: FreshnessStatus
    peRatio: FreshnessStatus
  }
  stocks: StockQuote[]
}

type ApiErrorPayload = {
  error?: string
  detail?: string
  hint?: string
}

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

const compactCurrencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
})

function formatCurrency(value: number | null) {
  return typeof value === 'number' ? currencyFormatter.format(value) : 'N/A'
}

function formatMarketCap(value: number | null) {
  return typeof value === 'number' ? compactCurrencyFormatter.format(value) : 'N/A'
}

function formatEps(value: number | null) {
  return typeof value === 'number' ? value.toFixed(2) : 'N/A'
}

function formatPeRatio(value: number | null) {
  return typeof value === 'number' ? value.toFixed(2) : 'N/A'
}

function renderPendingValue(value: number | null, formatter: (value: number | null) => string, pendingLabel: string) {
  if (typeof value === 'number') {
    return formatter(value)
  }

  return <span className="pending-chip">{pendingLabel}</span>
}

function formatCompanyLabel(stock: StockQuote) {
  const normalizedName = stock.name.trim()

  if (!normalizedName || normalizedName.toUpperCase() === stock.symbol) {
    return stock.symbol
  }

  return `${normalizedName} (${stock.symbol})`
}

function clampPercent(value: number | null) {
  if (typeof value !== 'number') {
    return 0
  }

  return Math.min(100, Math.max(0, value))
}

function sortStocks(stocks: StockQuote[], sortMetric: SortMetric) {
  return [...stocks].sort((left, right) => {
    const leftValue = typeof left[sortMetric] === 'number' ? left[sortMetric] : -Infinity
    const rightValue = typeof right[sortMetric] === 'number' ? right[sortMetric] : -Infinity

    if (rightValue !== leftValue) {
      return rightValue - leftValue
    }

    return left.symbol.localeCompare(right.symbol)
  })
}

function formatSortMetricLabel(sortMetric: SortMetric) {
  switch (sortMetric) {
    case 'eps':
      return 'EPS'
    case 'peRatio':
      return 'P/E'
    case 'marketCap':
      return 'Market Cap'
    case 'positionPercent':
    default:
      return '52-Week Position'
  }
}

function formatFreshnessLabel(label: string, freshness: FreshnessStatus) {
  if (freshness.updatedLabel) {
    if (freshness.paused) {
      return `${label}: ${freshness.updatedLabel} (paused)`
    }

    return `${label}: ${freshness.updatedLabel}${freshness.stale ? ' (refreshing)' : ''}`
  }

  if (freshness.paused) {
    return `${label}: paused`
  }

  return `${label}: warming cache`
}

function App() {
  const [payload, setPayload] = useState<StocksPayload | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isUpdatingQuoteRefresh, setIsUpdatingQuoteRefresh] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortMetric, setSortMetric] = useState<SortMetric>('positionPercent')

  const stocks = useMemo(() => sortStocks(payload?.stocks ?? [], sortMetric), [payload, sortMetric])

  const loadStocks = useCallback(async ({ refresh = false } = {}) => {
    if (refresh) {
      setIsRefreshing(true)
    } else {
      setIsLoading(true)
    }

    setError(null)

    try {
      const response = await fetch(refresh ? '/api/stocks?refresh=true' : '/api/stocks', {
        cache: 'no-store',
      })
      const nextPayload = (await response.json()) as StocksPayload | ApiErrorPayload

      if (!response.ok) {
        const apiError = nextPayload as ApiErrorPayload
        throw new Error([apiError.error, apiError.hint].filter(Boolean).join(' '))
      }

      setPayload(nextPayload as StocksPayload)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load stock data.')
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [])

  const updateQuoteRefresh = useCallback(async (enabled: boolean) => {
    setIsUpdatingQuoteRefresh(true)
    setError(null)

    try {
      const response = await fetch('/api/quote-refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled }),
      })
      const nextPayload = (await response.json()) as StocksPayload | ApiErrorPayload

      if (!response.ok) {
        const apiError = nextPayload as ApiErrorPayload
        throw new Error([apiError.error, apiError.hint].filter(Boolean).join(' '))
      }

      setPayload(nextPayload as StocksPayload)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update quote refresh.')
    } finally {
      setIsUpdatingQuoteRefresh(false)
    }
  }, [])

  useEffect(() => {
    loadStocks()

    const refreshTimer = setInterval(() => {
      void loadStocks()
    }, 15000)

    return () => {
      clearInterval(refreshTimer)
    }
  }, [loadStocks])

  const quoteSummary = payload ? formatFreshnessLabel('Quotes', payload.freshness.quotes) : 'Quotes: warming cache'
  const marketCapSummary = payload
    ? payload.freshness.marketCap.missingCount > 0
      ? `Market Cap: ${payload.stocks.length - payload.freshness.marketCap.missingCount}/${payload.stocks.length} ready`
      : formatFreshnessLabel('Market Cap', payload.freshness.marketCap)
    : 'Market Cap: warming cache'
  const epsSummary = payload
    ? payload.freshness.eps.missingCount > 0
      ? `EPS: ${payload.stocks.length - payload.freshness.eps.missingCount}/${payload.stocks.length} ready`
      : formatFreshnessLabel('EPS', payload.freshness.eps)
    : 'EPS: warming cache'
  const peRatioSummary = payload
    ? payload.freshness.peRatio.missingCount > 0
      ? `P/E: ${payload.stocks.length - payload.freshness.peRatio.missingCount}/${payload.stocks.length} ready`
      : formatFreshnessLabel('P/E', payload.freshness.peRatio)
    : 'P/E: warming cache'
  const stageSummary = payload?.readyCounts
    ? `${payload.readyCounts.quotes}/${payload.readyCounts.total} prices · ${payload.readyCounts.marketCap}/${payload.readyCounts.total} Market Cap · ${payload.readyCounts.eps}/${payload.readyCounts.total} EPS · ${payload.readyCounts.peRatio}/${payload.readyCounts.total} P/E`
    : 'Building live data in stages'
  const sortSummary = `Sorted high to low by ${formatSortMetricLabel(sortMetric)}`
  const quoteRefreshEnabled = payload?.quoteRefreshEnabled ?? true

  const sortableColumns: Array<{ key: SortMetric; label: string }> = [
    { key: 'eps', label: 'EPS' },
    { key: 'peRatio', label: 'P/E' },
    { key: 'marketCap', label: 'Market Cap' },
    { key: 'positionPercent', label: '52-Week Position' },
  ]

  return (
    <main>
      <header className="page-header">
        <div className="header-inner">
          <div>
            <p className="eyebrow">Server-Managed Stock Cache</p>
            <h1>Nima&apos;s Stock Tracker</h1>
            <p className="updated-at">
              {payload?.updatedLabel ? `Latest quote refresh: ${payload.updatedLabel}` : 'Loading market data...'}
            </p>
            <p className="status-message">
              {payload?.statusHeadline ?? 'Loading live stock prices into the shared cache.'}
            </p>
            {payload?.statusDetail ? <p className="status-detail">{payload.statusDetail}</p> : null}
            <p className="stage-detail">{stageSummary}</p>
            <p className="sort-detail">{sortSummary}</p>
            {payload?.warning ? <p className="warning-text">{payload.warning}</p> : null}
            {error ? <p className="warning-text">{error}</p> : null}
          </div>

          <div className="header-actions">
            <button
              className="refresh-button"
              type="button"
              onClick={() => void loadStocks({ refresh: true })}
              disabled={isRefreshing || isUpdatingQuoteRefresh || !quoteRefreshEnabled}
            >
              <RefreshCcw size={18} className={isRefreshing ? 'spin' : undefined} />
              {quoteRefreshEnabled ? (isRefreshing ? 'Refreshing' : 'Refresh Quotes') : 'Quotes Paused'}
            </button>

            <label className="toggle-control">
              <span className="toggle-copy">
                <span className="toggle-title">Live Quote Refresh</span>
                <span className="toggle-subtitle">
                  {quoteRefreshEnabled ? 'On: Twelve Data requests are enabled.' : 'Off: Twelve Data requests are paused.'}
                </span>
              </span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={quoteRefreshEnabled}
                  onChange={(event) => {
                    void updateQuoteRefresh(event.target.checked)
                  }}
                  disabled={isUpdatingQuoteRefresh}
                  aria-label="Toggle live quote refresh"
                />
                <span className="toggle-slider" aria-hidden="true" />
              </span>
            </label>
          </div>
        </div>
      </header>

      <section className="page-shell" aria-label="Stock dashboard">
        <div className="status-strip">
          <span>
            <Server size={16} />
            {payload?.source ?? 'Shared cache warming on the server'}
          </span>
          <span
            className={
              payload?.freshness.quotes.paused
                ? 'status-pill paused'
                : payload?.freshness.quotes.stale
                  ? 'status-pill stale'
                  : 'status-pill'
            }
          >
            <TrendingUp size={16} />
            {quoteSummary}
          </span>
          <span className={payload?.freshness.marketCap.missingCount ? 'status-pill stale' : 'status-pill'}>
            <DatabaseZap size={16} />
            {marketCapSummary}
          </span>
          <span className={payload?.freshness.eps.missingCount ? 'status-pill stale' : 'status-pill'}>
            <DatabaseZap size={16} />
            {epsSummary}
          </span>
          <span className={payload?.freshness.peRatio.missingCount ? 'status-pill stale' : 'status-pill'}>
            <TrendingUp size={16} />
            {peRatioSummary}
          </span>
        </div>

        {payload?.isBuilding ? (
          <div className="build-banner" role="status" aria-live="polite">
            <strong>Fetching information in stages.</strong>
            <span>
              The page loads stock prices first, then merges Market Cap, EPS, and P/E from the Google Sheet snapshot.
            </span>
          </div>
        ) : null}

        <div className="sort-controls" aria-label="Sort stocks by metric">
          <span className="sort-controls-label">Sort high to low:</span>
          {sortableColumns.map((column) => (
            <button
              key={column.key}
              type="button"
              className={sortMetric === column.key ? 'sort-chip active' : 'sort-chip'}
              onClick={() => setSortMetric(column.key)}
            >
              {column.label}
            </button>
          ))}
        </div>

        <section className="table-shell" aria-label="52-week stock position table">
          <div className="table-grid table-head" role="row">
            <span>Stock</span>
            {sortableColumns.map((column) => (
              <button
                key={column.key}
                type="button"
                className={sortMetric === column.key ? 'header-sort active' : 'header-sort'}
                onClick={() => setSortMetric(column.key)}
                aria-pressed={sortMetric === column.key}
              >
                {column.label}
                <span className="header-sort-arrow" aria-hidden="true">
                  {sortMetric === column.key ? '↓' : ''}
                </span>
              </button>
            ))}
          </div>

          {isLoading && !payload ? (
            <div className="message-row">Loading latest stock data...</div>
          ) : null}

          {!isLoading && !payload && !error ? (
            <div className="message-row">No cached stock payload is available yet.</div>
          ) : null}

          {stocks.map((stock) => {
            const percent = clampPercent(stock.positionPercent)
            const hasSlider =
              typeof stock.currentPrice === 'number' &&
              typeof stock.week52Low === 'number' &&
              typeof stock.week52High === 'number' &&
              stock.week52High > stock.week52Low
            const highDistance =
              typeof stock.distanceFromHighPercent === 'number'
                ? `${Math.max(0, stock.distanceFromHighPercent).toFixed(1)}% below high`
                : 'Position unavailable'

            return (
              <article className="table-grid stock-row" key={stock.symbol}>
                <div className="company-cell">
                  <strong>{formatCompanyLabel(stock)}</strong>
                </div>
                <div className="number-cell">
                  {renderPendingValue(
                    stock.eps,
                    formatEps,
                    payload?.buildStage === 'quotes' ? 'Queued' : 'Fetching',
                  )}
                </div>
                <div className="number-cell">
                  {payload?.isBuilding && stock.peRatio === null
                    ? <span className="pending-chip">{payload?.buildStage === 'quotes' ? 'Queued' : 'Fetching'}</span>
                    : formatPeRatio(stock.peRatio)}
                </div>
                <div className="number-cell">
                  {renderPendingValue(
                    stock.marketCap,
                    formatMarketCap,
                    payload?.buildStage === 'quotes' ? 'Queued' : 'Fetching',
                  )}
                </div>
                <div className="slider-cell">
                  <div className={hasSlider ? 'slider-track' : 'slider-track slider-disabled'}>
                    <span className="slider-fill" style={{ width: `${percent}%` }} />
                    <span className="slider-thumb" style={{ left: `${percent}%` }} />
                  </div>
                  {hasSlider ? (
                    <>
                      <div className="slider-scale">
                        <span>{formatCurrency(stock.week52Low)}</span>
                        <strong>{formatCurrency(stock.currentPrice)}</strong>
                        <span>{formatCurrency(stock.week52High)}</span>
                      </div>
                      <p className="distance-label">{highDistance}</p>
                    </>
                  ) : (
                    <p className="distance-label pending-label">Fetching latest quote range...</p>
                  )}
                </div>
              </article>
            )
          })}
        </section>
      </section>
    </main>
  )
}

export default App
