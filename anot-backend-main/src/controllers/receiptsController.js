const pool = require('../config/db')
const { sendHttpError } = require('../utils/errorMessages')
const { auditLog } = require('../utils/auditLogger')

// ─── Ensure the payment_receipts table exists ────────────────────────────────
// Uses IF NOT EXISTS so it is safe to call on every request without DDL cost
// after the first run (Postgres caches the catalog check).

let tableEnsured = false
async function ensureReceiptsTable() {
  if (tableEnsured) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_receipts (
      id                  SERIAL PRIMARY KEY,
      clinician_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receipt_number      VARCHAR(64) UNIQUE NOT NULL,
      plan_name           VARCHAR(128) NOT NULL DEFAULT '30-Day Clinician Pro',
      billing_period_days INT NOT NULL DEFAULT 30,
      amount              NUMERIC(10, 2) NOT NULL,
      payment_status      VARCHAR(32) NOT NULL DEFAULT 'paid',
      payment_date        DATE NOT NULL DEFAULT CURRENT_DATE,
      period_start        DATE NOT NULL,
      period_end          DATE NOT NULL,
      transaction_id      VARCHAR(128),
      notes               TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payment_receipts_clinician
      ON payment_receipts(clinician_id, payment_date DESC)
  `)
  tableEnsured = true
}

/**
 * Generate a receipt number in the format REC-XXXXXXXX.
 * Uses crypto-random bytes for uniqueness.
 */
function generateReceiptNumber() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars
  let result = 'REC-'
  const bytes = require('crypto').randomBytes(8)
  for (let i = 0; i < 8; i++) {
    result += chars[bytes[i] % chars.length]
  }
  return result
}

/**
 * Seed an initial receipt for a clinician from their current package data
 * if they have no receipt records yet. Called lazily on the first receipts fetch.
 */
async function seedInitialReceiptIfNeeded(clinicianId) {
  const existing = await pool.query(
    'SELECT id FROM payment_receipts WHERE clinician_id = $1 LIMIT 1',
    [clinicianId],
  )
  if (existing.rows.length > 0) return // already has receipts

  // Pull current subscription data from users table
  const userRow = await pool.query(
    `SELECT package_name, package_amount_paid, package_duration_days,
            package_start_date, package_end_date, package_status
     FROM users WHERE id = $1`,
    [clinicianId],
  )
  const u = userRow.rows[0]
  if (!u) return

  const amount = parseFloat(u.package_amount_paid) || 99.00
  const periodStart = u.package_start_date
  const periodEnd   = u.package_end_date
  if (!periodStart || !periodEnd) return

  const receiptNumber = generateReceiptNumber()

  await pool.query(
    `INSERT INTO payment_receipts
       (clinician_id, receipt_number, plan_name, billing_period_days, amount,
        payment_status, payment_date, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (receipt_number) DO NOTHING`,
    [
      clinicianId,
      receiptNumber,
      u.package_name || 'Clinician Pro',
      u.package_duration_days || 30,
      amount,
      u.package_status === 'active' ? 'paid' : (u.package_status || 'paid'),
      periodStart, // payment_date = subscription start date
      periodStart,
      periodEnd,
    ],
  )
}

// ─── GET /api/receipts ──────────────────────────────────────────────────────
// Returns the authenticated clinician's payment receipts, newest first.
// Security: clinician_id is always taken from req.user.id (server-side auth),
// never from a query/body param — prevents IDOR attacks.

const getClinicianReceipts = async (req, res) => {
  try {
    await ensureReceiptsTable()
    await seedInitialReceiptIfNeeded(req.user.id)

    const result = await pool.query(
      `SELECT id, receipt_number, plan_name, billing_period_days, amount,
              payment_status, payment_date, period_start, period_end,
              transaction_id, notes, created_at
       FROM payment_receipts
       WHERE clinician_id = $1
       ORDER BY payment_date DESC, id DESC`,
      [req.user.id],
    )

    res.status(200).json({ receipts: result.rows })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'receiptsController.getClinicianReceipts', req })
  }
}

// ─── GET /api/receipts/:id ──────────────────────────────────────────────────
// Returns one receipt. Ownership is verified — clinician can only fetch their own.

const getClinicianReceiptById = async (req, res) => {
  try {
    await ensureReceiptsTable()

    const { id } = req.params
    const result = await pool.query(
      `SELECT pr.id, pr.receipt_number, pr.plan_name, pr.billing_period_days,
              pr.amount, pr.payment_status, pr.payment_date, pr.period_start,
              pr.period_end, pr.transaction_id, pr.notes, pr.created_at,
              u.name AS clinician_name, u.email AS clinician_email,
              u.clinic_name, u.npi, u.license
       FROM payment_receipts pr
       JOIN users u ON u.id = pr.clinician_id
       WHERE pr.id = $1 AND pr.clinician_id = $2`,
      [id, req.user.id],
    )

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Receipt not found.' })
    }

    void auditLog(
      req.user,
      'RECEIPT_VIEWED',
      'payment_receipt',
      String(id),
      `Receipt ${result.rows[0].receipt_number} viewed`,
      { req, module_key: 'billing', action_category: 'read' },
    ).catch(() => {})

    res.status(200).json({ receipt: result.rows[0] })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'receiptsController.getClinicianReceiptById', req })
  }
}

module.exports = { getClinicianReceipts, getClinicianReceiptById }
