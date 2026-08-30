-- Migration: Add Claude usage logging table
-- Purpose: Track Claude API costs for monitoring and billing analysis
-- Created: 2026-07-12

CREATE TABLE IF NOT EXISTS claude_usage_log (
  id SERIAL PRIMARY KEY,
  visit_id INTEGER,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cost DECIMAL(10, 6) NOT NULL,
  model VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  
  -- Optional: Link to visits table
  CONSTRAINT fk_visit 
    FOREIGN KEY (visit_id) 
    REFERENCES visits(id) 
    ON DELETE SET NULL
);

-- Index for cost analysis queries
CREATE INDEX IF NOT EXISTS idx_claude_usage_created_at 
  ON claude_usage_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claude_usage_visit 
  ON claude_usage_log(visit_id);

-- View for daily cost summary
CREATE OR REPLACE VIEW claude_daily_costs AS
SELECT 
  DATE(created_at) as date,
  COUNT(*) as calls,
  SUM(input_tokens) as total_input_tokens,
  SUM(output_tokens) as total_output_tokens,
  SUM(cache_read_tokens) as total_cache_hits,
  SUM(cost) as total_cost,
  AVG(cost) as avg_cost_per_call,
  MIN(cost) as min_cost,
  MAX(cost) as max_cost
FROM claude_usage_log
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- View for current month summary
CREATE OR REPLACE VIEW claude_monthly_costs AS
SELECT 
  TO_CHAR(created_at, 'YYYY-MM') as month,
  COUNT(*) as calls,
  SUM(cost) as total_cost,
  AVG(cost) as avg_cost_per_call
FROM claude_usage_log
GROUP BY TO_CHAR(created_at, 'YYYY-MM')
ORDER BY month DESC;

COMMENT ON TABLE claude_usage_log IS 'Tracks Claude API usage and costs for monitoring and billing';
COMMENT ON VIEW claude_daily_costs IS 'Daily Claude API cost summary';
COMMENT ON VIEW claude_monthly_costs IS 'Monthly Claude API cost summary';
