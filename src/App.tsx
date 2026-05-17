import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCcw, Server, TrendingUp } from 'lucide-react'
import './App.css'

type LoadStage = 'quotes' | 'market-cap' | 'eps' | 'all'

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
  source: string | null
  warning: string | null
  cached: boolean
  dataStage?: string | null
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
  const [statusMessage, setStatusMessage] = useState('Loading live stock prices...')
  const timeoutRefs = useRef<Array<ReturnType<typeof setTimeout>>>([])

  const stocks = useMemo(() => sortByHighProximity(payload?.stocks ?? []), [payload])

  const clearScheduledRefreshes = useCallback(() => {
    for (const timeoutId of timeoutRefs.current) {
      clearTimeout(timeoutId)
    }

    timeoutRefs.current = []
  }, [])

  const loadStocks = useCallback(async ({ refresh = false, stage = 'all' as LoadStage } = {}) => {
    setIsLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()

      if (refresh) {
        params.set('refresh', 'true')
      }

      params.set('stage', stage)

      const response = await fetch(`/api/stocks?${params.toString()}`, {
        cache: 'no-store',
      })
      const nextPayload = (await response.json()) as StocksPayload | ApiErrorPayload

      if (!response.ok) {
        const apiError = nextPayload as ApiErrorPayload
        throw new Error([apiError.error, apiError.hint].filter(Boolean).join(' '))
      }

      const resolvedPayload = nextPayload as StocksPayload
      setPayload(resolvedPayload)
      return resolvedPayload
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load stock data.')
      return null
    } finally {
      setIsLoading(false)
    }
  }, [])

  const startStagedRefresh = useCallback(async () => {
    clearScheduledRefreshes()
    setStatusMessage('Loading live stock prices...')

    const quotesPayload = await loadStocks({ refresh: true, stage: 'quotes' })

    if (!quotesPayload) {
      return
    }

    setStatusMessage(
      'EPS and Market Cap values will be fetched automatically in another 2 minutes.',
    )

    const marketCapTimeout = setTimeout(async () => {
      setStatusMessage('Fetching live Market Cap data...')
      const marketCapPayload = await loadStocks({ refresh: true, stage: 'market-cap' })

      if (!marketCapPayload) {
        return
      }

      setStatusMessage(
        'Stock and Market Cap data is accurate, and the app will next fetch EPS data.',
      )

      const epsTimeout = setTimeout(async () => {
        setStatusMessage('Fetching live EPS data...')
        const epsPayload = await loadStocks({ refresh: true, stage: 'eps' })

        if (!epsPayload) {
          return
        }

        setStatusMessage('All data is current.')
      }, 65000)

      timeoutRefs.current.push(epsTimeout)
    }, 65000)

    timeoutRefs.current.push(marketCapTimeout)
  }, [clearScheduledRefreshes, loadStocks])

  useEffect(() => {
    startStagedRefresh()

    return () => {
      clearScheduledRefreshes()
    }
  }, [clearScheduledRefreshes, startStagedRefresh])

  return (
    <main>
      <header className="page-header">
        <div className="header-inner">
          <div>
            <p className="eyebrow">Twelve Data Market View</p>
            <h1>52-Week Stock Position</h1>
            <p className="updated-at">
              {payload?.updatedLabel ? `Latest refresh: ${payload.updatedLabel}` : 'Loading market data...'}
              {payload?.cached ? ' · cached' : ''}
            </p>
            <p className="status-message">{statusMessage}</p>
            {payload?.warning ? <p className="warning-text">{payload.warning}</p> : null}
          </div>

          <button
            className="refresh-button"
            type="button"
            onClick={() => startStagedRefresh()}
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
            {payload?.source ? `${payload.source} loaded server-side` : 'Twelve Data loaded server-side'}
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
          })}
        </section>
      </section>
    </main>
  )
}

export default App
