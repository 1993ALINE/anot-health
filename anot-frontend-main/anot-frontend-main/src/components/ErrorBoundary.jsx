import { Component } from 'react'

export function PortalCrashFallback() {
  return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <h2>Something went wrong</h2>
      <p>Please refresh the page.</p>
      <button type="button" onClick={() => window.location.reload()}>
        Refresh
      </button>
    </div>
  )
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error(`[${this.props.portalName || 'Portal'}] Render failed:`, error?.message || 'unknown')
  }

  handleRetry = () => {
    this.setState({ error: null })
    this.props.onRetry?.()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    if (Object.prototype.hasOwnProperty.call(this.props, 'fallback')) {
      return this.props.fallback
    }

    const name = this.props.portalName || 'This page'
    return (
      <div className="portal-error-boundary" role="alert">
        <h2 className="portal-error-boundary__title">{name} encountered an error</h2>
        <p className="portal-error-boundary__msg">
          Failed to load this screen. Please try again.
        </p>
        <div className="portal-error-boundary__actions">
          <button type="button" className="btn btn-navy" onClick={this.handleRetry}>
            Try again
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    )
  }
}
