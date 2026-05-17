import { useCallback, useEffect, useMemo, useState } from 'react'
import { DatabaseZap, RefreshCcw, Server, TrendingUp } from 'lucide-react'
import './App.css'

type StockQuote = {
  symbol: string
  name: string
  eps: number | null
  marketCap: number | null
  currentPrice: number | null
  week52Low: number | null
  week52High: number | null
  positionPercent: number | null
  distanceFromHighPercent: number | null
  exchange: string | null
}

type FreshnessStatus = {
  updatedAt: string | null
  updatedLabel: string | null
  stale: boolean
  missingCount: number
}

type EpsFreshnessStatus = FreshnessStatus & {
  batchSize: number
  nextSymbols: string[]
}

type StocksPayload = {
  updatedAt: string | null
  updatedLabel: string | null
  source: string | null
  warning: string | null
  stale: boolean
  statusHeadline: string
  statusDetail: string | null
  freshness: {
    quotes: FreshnessStatus
    marketCap: FreshnessStatus
    eps: EpsFreshnessStatus
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

function sortByHighProximity(stocks: StockQuote[]) {
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

function formatFreshnessLabel(label: string, freshness: FreshnessStatus | EpsFreshnessStatus) {
  if (freshness.updatedLabel) {
    return `${label}: ${freshness.updatedLabel}${freshness.stale ? ' (refreshing)' : ''}`
  }

  return `${label}: warming cache`
}

function App() {
  const [payload, setPayload] = useState<StocksPayload | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stocks = useMemo(() => sortByHighProximity(payload?.stocks ?? []), [payload])

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

  useEffect(() => {
    loadStocks()

    const refreshTimer = setInterval(() => {
      void loadStocks()
    }, 60000)

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

  return (
    <main>
      <header className="page-header">
        <div className="header-inner">
          <div>
            <p className="eyebrow">Server-Managed Stock Cache</p>
            <h1>52-Week Stock Position</h1>
            <p className="updated-at">
              {payload?.updatedLabel ? `Latest quote refresh: ${payload.updatedLabel}` : 'Loading market data...'}
            </p>
            <p className="status-message">
              {payload?.statusHeadline ?? 'Loading live stock prices into the shared cache.'}
            </p>
            {payload?.statusDetail ? <p className="status-detail">{payload.statusDetail}</p> : null}
            {payload?.warning ? <p className="warning-text">{payload.warning}</p> : null}
            {error ? <p className="warning-text">{error}</p> : null}
          </div>

          <button
            className="refresh-button"
            type="button"
            onClick={() => void loadStocks({ refresh: true })}
            disabled={isRefreshing}
          >
            <RefreshCcw size={18} className={isRefreshing ? 'spin' : undefined} />
            {isRefreshing ? 'Refreshing' : 'Refresh Quotes'}
          </button>
        </div>
      </header>

      <section className="page-shell" aria-label="Stock dashboard">
        <div className="status-strip">
          <span>
            <Server size={16} />
            {payload?.source ?? 'Shared cache warming on the server'}
          </span>
          <span className={payload?.freshness.quotes.stale ? 'status-pill stale' : 'status-pill'}>
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
        </div>

        {payload?.freshness.eps.nextSymbols.length ? (
          <p className="queue-text">
            Next EPS refresh batch: {payload.freshness.eps.nextSymbols.join(', ')}. The server refreshes up to{' '}
            {payload.freshness.eps.batchSize} symbol{payload.freshness.eps.batchSize === 1 ? '' : 's'} per minute.
          </p>
        ) : null}

        <section className="table-shell" aria-label="52-week stock position table">
          <div className="table-grid table-head" role="row">
            <span>Stock</span>
            <span>EPS</span>
            <span>Market Cap</span>
            <span>52-Week Position</span>
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
                  {stock.exchange ? <small>{stock.exchange}</small> : null}
                </div>
                <div className="number-cell">{formatEps(stock.eps)}</div>
                <div className="number-cell">{formatMarketCap(stock.marketCap)}</div>
                <div className="slider-cell">
                  <div className={hasSlider ? 'slider-track' : 'slider-track slider-disabled'}>
                    <span className="slider-fill" style={{ width: `${percent}%` }} />
                    <span className="slider-thumb" style={{ left: `${percent}%` }} />
                  </div>
                  <div className="slider-scale">
                    <span>{formatCurrency(stock.week52Low)}</span>
                    <strong>{formatCurrency(stock.currentPrice)}</strong>
                    <span>{formatCurrency(stock.week52High)}</span>
                  </div>
                  <p className="distance-label">{highDistance}</p>
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
