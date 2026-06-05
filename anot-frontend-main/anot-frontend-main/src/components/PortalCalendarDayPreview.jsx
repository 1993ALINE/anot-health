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

export function scribeDayPreviewRows(stats) {
  if (!stats) return null
  const rows = []
  if (stats.pending > 0) rows.push({ key: 'pending', label: 'Pending notes', count: stats.pending })
  if (stats.submitted > 0) rows.push({ key: 'submitted', label: 'Submitted', count: stats.submitted })
  if (stats.overdue > 0) rows.push({ key: 'overdue', label: 'Overdue', count: stats.overdue })
  if (stats.completed > 0) rows.push({ key: 'completed', label: 'Completed', count: stats.completed })
  if (stats.total > 0 && rows.length === 0) {
    rows.push({ key: 'pending', label: 'Visits', count: stats.total })
  }
  return rows
}
