import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error(`[${this.props.portalName || 'Portal'}]`, error, info)
  }

  handleRetry = () => {
    this.setState({ error: null })
    this.props.onRetry?.()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const name = this.props.portalName || 'This page'
    return (
      <div className="portal-error-boundary" role="alert">
        <h2 className="portal-error-boundary__title">{name} encountered an error</h2>
        <p className="portal-error-boundary__msg">
          {error?.message || 'Something went wrong while rendering this screen.'}
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
