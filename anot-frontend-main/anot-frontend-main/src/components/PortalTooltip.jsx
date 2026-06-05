import './portalTooltip.css'

export default function PortalTooltip({
  tip,
  placement = 'above',
  block = false,
  className = '',
  children,
}) {
  if (!tip) return children
  return (
    <span
      className={[
        'portal-tooltip-wrap',
        `portal-tooltip-wrap--${placement}`,
        block ? 'portal-tooltip-wrap--block' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
      <span className={`portal-tooltip portal-tooltip--${placement}`} role="tooltip">
        {tip}
      </span>
    </span>
  )
}
