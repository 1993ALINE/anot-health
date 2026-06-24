/** Row builder for Scribe calendar day preview tooltips */
export function scribeDayPreviewRows(stats) {
  if (!stats) { return null }
  const rows = []
  if (stats.pending > 0) { rows.push({ key: 'pending', label: 'Pending notes', count: stats.pending }) }
  if (stats.submitted > 0) { rows.push({ key: 'submitted', label: 'Submitted', count: stats.submitted }) }
  if (stats.overdue > 0) { rows.push({ key: 'overdue', label: 'Overdue', count: stats.overdue }) }
  if (stats.completed > 0) { rows.push({ key: 'completed', label: 'Completed', count: stats.completed }) }
  if (stats.total > 0 && rows.length === 0) {
    rows.push({ key: 'pending', label: 'Visits', count: stats.total })
  }
  return rows
}
