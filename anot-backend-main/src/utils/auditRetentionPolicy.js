/**
 * HIPAA audit log retention — 6-year minimum (2190 days), 10-year cap.
 */

const MIN_AUDIT_RETENTION_DAYS = 2190
const MAX_AUDIT_RETENTION_DAYS = 3650
const DEFAULT_AUDIT_RETENTION_DAYS = 2555

function clampAuditRetentionDays(days) {
  const n = Number(days)
  const value = Number.isFinite(n) ? n : DEFAULT_AUDIT_RETENTION_DAYS
  return Math.max(MIN_AUDIT_RETENTION_DAYS, Math.min(value, MAX_AUDIT_RETENTION_DAYS))
}

module.exports = {
  MIN_AUDIT_RETENTION_DAYS,
  MAX_AUDIT_RETENTION_DAYS,
  DEFAULT_AUDIT_RETENTION_DAYS,
  clampAuditRetentionDays,
}
