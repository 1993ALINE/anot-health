CREATE TABLE IF NOT EXISTS system_settings (
  id                 INTEGER PRIMARY KEY DEFAULT 1,
  system_name        TEXT NOT NULL DEFAULT 'Anot',
  system_email       TEXT,
  phone              TEXT,
  address            TEXT,
  company_info       TEXT,
  footer_text        TEXT,
  support_contact    TEXT,
  social_links       JSONB NOT NULL DEFAULT '{}'::jsonb,
  logo_data_url      TEXT,
  favicon_data_url   TEXT,
  primary_color      VARCHAR(16) NOT NULL DEFAULT '#2563eb',
  secondary_color    VARCHAR(16) NOT NULL DEFAULT '#0d9488',
  system_description TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT system_settings_singleton CHECK (id = 1)
);

INSERT INTO system_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

