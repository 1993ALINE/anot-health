-- Migration: Add clinician package tracking, clinic address, and default template settings
ALTER TABLE users ADD COLUMN IF NOT EXISTS clinic_address TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS package_name VARCHAR(128) DEFAULT '30-Day Clinician Pro';
ALTER TABLE users ADD COLUMN IF NOT EXISTS package_amount_paid NUMERIC(10, 2) DEFAULT 199.00;
ALTER TABLE users ADD COLUMN IF NOT EXISTS package_duration_days INT DEFAULT 30;
ALTER TABLE users ADD COLUMN IF NOT EXISTS package_start_date DATE DEFAULT CURRENT_DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS package_end_date DATE DEFAULT (CURRENT_DATE + INTERVAL '30 days');
ALTER TABLE users ADD COLUMN IF NOT EXISTS package_status VARCHAR(32) DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_template_id VARCHAR(64) DEFAULT 'soap-adult';
