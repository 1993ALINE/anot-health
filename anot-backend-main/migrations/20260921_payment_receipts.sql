-- Migration: Add payment_receipts table for clinician billing history
-- Each row represents one subscription payment period for a clinician.
-- The receipt_number is a human-readable unique ID (REC-XXXXXXXX format).

CREATE TABLE IF NOT EXISTS payment_receipts (
  id                  SERIAL PRIMARY KEY,
  clinician_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receipt_number      VARCHAR(64) UNIQUE NOT NULL,
  plan_name           VARCHAR(128) NOT NULL DEFAULT '30-Day Clinician Pro',
  billing_period_days INT NOT NULL DEFAULT 30,
  amount              NUMERIC(10, 2) NOT NULL,
  payment_status      VARCHAR(32) NOT NULL DEFAULT 'paid',
  -- payment_status values: 'paid', 'pending', 'failed', 'refunded'
  payment_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  transaction_id      VARCHAR(128),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_clinician
  ON payment_receipts(clinician_id, payment_date DESC);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_status
  ON payment_receipts(payment_status);
