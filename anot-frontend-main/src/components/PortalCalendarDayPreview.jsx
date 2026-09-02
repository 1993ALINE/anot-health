/**
 * Rich hover preview for portal schedule calendar day cells (Clinician + Scribe).
 */
export default function PortalCalendarDayPreview({
  showToday = false,
  heading,
  providerName,
  rows = [],
  visitTotal,
  emptyMessage = 'No visits scheduled',
  loading = false,
  classPrefix = 'portal-cal-strip',
}) {
  const base = `${classPrefix}__day-preview ${classPrefix}__day-preview--rich`

  if (loading) {
    return (
      <span className={base} role="tooltip">
        Loading visit summary…
      </span>
    )
  }

  const rowTotal = rows.reduce((sum, row) => sum + (row.count || 0), 0)
  const total = visitTotal ?? rowTotal
  if (total === 0) {
    return (
      <span className={base} role="tooltip">
        {emptyMessage}
      </span>
    )
  }

  return (
    <span className={base} role="tooltip">
      {showToday ? <span className={`${classPrefix}__day-preview-today`}>Today</span> : null}
      <span className={`${classPrefix}__day-preview-heading`}>{heading}</span>
      {providerName ? (
        <span className={`${classPrefix}__day-preview-provider`}>{providerName}</span>
      ) : null}
      <span className={`${classPrefix}__day-preview-rule`} aria-hidden="true" />
      {rows.map((row) => (
        <span key={row.key} className={`${classPrefix}__day-preview-row`}>
          <span className={`${classPrefix}__day-preview-count ${classPrefix}__day-preview-count--${row.key}`}>
            {row.count}
          </span>
          {' '}
          {row.label}
        </span>
      ))}
    </span>
  )
}
