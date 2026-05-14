import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCcw, Server, TrendingUp } from 'lucide-react'
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

type StocksPayload = {
  updatedAt: string | null
  updatedLabel: string | null
  warning: string | null
  cached: boolean
  stocks: StockQuote[]
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

function App() {
  const [payload, setPayload] = useState<StocksPayload | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const stocks = useMemo(() => sortByHighProximity(payload?.stocks ?? []), [payload])

  const loadStocks = useCallback(async ({ refresh = false } = {}) => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/stocks${refresh ? '?refresh=true' : ''}`, {
        cache: 'no-store',
      })
      const nextPayload = (await response.json()) as StocksPayload | { error?: string }

      if (!response.ok) {
        throw new Error('error' in nextPayload ? nextPayload.error : 'Unable to load stock data.')
      }

      setPayload(nextPayload as StocksPayload)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load stock data.')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStocks()
  }, [loadStocks])

  return (
    <main>
      <header className="page-header">
        <div className="header-inner">
          <div>
            <p className="eyebrow">FMP Market View</p>
            <h1>52-Week Stock Position</h1>
            <p className="updated-at">
              {payload?.updatedLabel ? `Latest refresh: ${payload.updatedLabel}` : 'Loading market data...'}
              {payload?.cached ? ' · cached' : ''}
            </p>
            {payload?.warning ? <p className="warning-text">{payload.warning}</p> : null}
          </div>

          <button
            className="refresh-button"
            type="button"
            onClick={() => loadStocks({ refresh: true })}
            disabled={isLoading}
          >
            <RefreshCcw size={18} className={isLoading ? 'spin' : undefined} />
            {isLoading ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </header>

      <section className="page-shell" aria-label="Stock dashboard">
        <div className="status-strip">
          <span>
            <Server size={16} />
            FMP data loaded server-side
          </span>
          <span>
            <TrendingUp size={16} />
            Sorted closest to 52-week high
          </span>
        </div>

        <section className="table-shell" aria-label="52-week stock position table">
          <div className="table-grid table-head" role="row">
            <span>Stock Ticker</span>
            <span>Stock Name</span>
            <span>EPS</span>
            <span>Market Cap</span>
            <span>52-Week Position</span>
          </div>

          {isLoading && !payload ? (
            <div className="message-row">Loading latest stock data...</div>
          ) : null}

          {error ? <div className="message-row error-row">{error}</div> : null}

          {!isLoading && !error && stocks.length === 0 ? (
            <div className="message-row">No stocks are configured.</div>
          ) : null}

          {!error
            ? stocks.map((stock) => {
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
                    <div className="ticker-cell">
                      <strong>{stock.symbol}</strong>
                      {stock.exchange ? <small>{stock.exchange}</small> : null}
                    </div>
                    <div className="company-cell">{stock.name}</div>
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
              })
            : null}
        </section>
      </section>
    </main>
  )
}

export default App
