# Claude API Cost Tracking & Monitoring

**Implemented:** July 12, 2026  
**Purpose:** Prevent unexpected Claude API costs and monitor usage in real-time

---

## Overview

This system provides comprehensive cost tracking, monitoring, and safety controls for Claude API usage:

✅ **Real-time cost tracking** - Track every API call with token counts and costs  
✅ **Daily spending limits** - Configurable daily budget with optional hard caps  
✅ **Rate limiting** - Prevent accidental mass API calls  
✅ **Usage analytics** - Detailed breakdowns by day, month, and visit  
✅ **Alert system** - Warnings when approaching limits  
✅ **Database persistence** - Historical cost data for billing analysis

---

## Quick Start

### 1. Environment Configuration

Add to your `.env` file:

```bash
# Claude Cost Control
CLAUDE_DAILY_LIMIT=5.00           # Daily spending limit (default: $5.00)
CLAUDE_ENFORCE_CAP=false          # Hard cap: blocks calls when limit reached
CLAUDE_RATE_LIMIT=30              # Max calls per minute (default: 30)
```

### 2. Database Setup

Run the migration to create the usage tracking table:

```bash
# Using psql
psql -d anot_db -f src/migrations/add_claude_usage_log.sql

# Or via Node.js
node -e "require('./src/config/db').query(require('fs').readFileSync('src/migrations/add_claude_usage_log.sql', 'utf8'))"
```

### 3. Monitor Costs

```bash
# One-time snapshot
node scripts/monitor-claude-costs.js

# Watch mode (updates every 30s)
node scripts/monitor-claude-costs.js --watch

# Custom alert threshold
node scripts/monitor-claude-costs.js --watch --alert 10
```

---

## Features

### Automatic Cost Tracking

Every Claude API call is automatically logged with:

- **Input tokens** - Transcript and system prompt
- **Output tokens** - Generated SOAP notes
- **Cache metrics** - Cache creation and hits
- **Cost calculation** - Exact cost in USD
- **Visit association** - Linked to visit ID

**Console output example:**
```
[CLAUDE-COST] Visit 486 | Call: $0.00248 | Daily: $0.05 (20 calls) | Total: $5.87 (2,350 calls)
```

### Spending Alerts

Automatic warnings when approaching limits:

**80% Warning:**
```
⚠️  CLAUDE COST WARNING: $4.12 (82% of $5.00 daily limit)
   Calls today: 1,661
   Remaining budget: $0.88
```

**100% Alert:**
```
❌ CLAUDE DAILY LIMIT REACHED: $5.04 >= $5.00
   Today: 2,033 calls
   URGENT: Review usage immediately!
```

### Rate Limiting

Prevents accidental mass API calls:

- **Default:** 30 calls per minute
- **Window:** Rolling 60-second window
- **Configurable:** Set `CLAUDE_RATE_LIMIT` environment variable

**Error message when exceeded:**
```
Rate limit exceeded: 30 calls in last minute. Max: 30/min. Wait 15s.
```

### Daily Reset

Automatically resets daily counters at midnight:

```
[CLAUDE-RESET] New day detected. Yesterday's cost: $4.87 (1,965 calls)
```

Manual reset (admin only):
```bash
curl -X POST http://localhost:5000/api/claude-stats/reset \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## API Endpoints

### Get Current Statistics

**Endpoint:** `GET /api/claude-stats/current`  
**Access:** Admin only

**Response:**
```json
{
  "success": true,
  "stats": {
    "daily": {
      "cost": 4.8765,
      "calls": 1965,
      "limit": 5.00,
      "remaining": 0.1235,
      "percentUsed": 97.53
    },
    "total": {
      "cost": 5.8765,
      "calls": 2365
    },
    "limits": {
      "dailyLimit": 5.00,
      "warningThreshold": 4.00,
      "enforced": false,
      "rateLimit": 30
    },
    "model": "claude-3-5-haiku-20241022",
    "lastReset": "2026-07-12"
  },
  "timestamp": "2026-07-12T16:45:30.123Z"
}
```

### Get Today's Usage

**Endpoint:** `GET /api/claude-stats/today`  
**Access:** Admin only

**Response:**
```json
{
  "success": true,
  "date": "2026-07-12",
  "database": {
    "calls": 1965,
    "inputTokens": 2168200,
    "outputTokens": 786000,
    "cacheHits": 1248000,
    "totalCost": 4.8765,
    "firstCall": "2026-07-12T04:16:22.000Z",
    "lastCall": "2026-07-12T16:45:30.000Z"
  },
  "memory": { /* in-memory stats */ },
  "limits": { /* current limits */ }
}
```

### Get Daily Breakdown

**Endpoint:** `GET /api/claude-stats/daily?days=30`  
**Access:** Admin only

**Response:**
```json
{
  "success": true,
  "days": 30,
  "data": [
    {
      "date": "2026-07-12",
      "calls": 1965,
      "total_input_tokens": 2168200,
      "total_output_tokens": 786000,
      "total_cache_hits": 1248000,
      "total_cost": "4.8765",
      "avg_cost_per_call": "0.00248",
      "min_cost": "0.00220",
      "max_cost": "0.00280"
    }
  ],
  "total": 4.8765
}
```

### Get Monthly Summary

**Endpoint:** `GET /api/claude-stats/monthly`  
**Access:** Admin only

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "month": "2026-07",
      "calls": 2365,
      "total_cost": "5.8765",
      "avg_cost_per_call": "0.00248"
    }
  ]
}
```

### Get Visit-Specific Usage

**Endpoint:** `GET /api/claude-stats/usage-by-visit/:visitId`  
**Access:** Admin or visit owner

**Response:**
```json
{
  "success": true,
  "visitId": 486,
  "calls": 1,
  "data": [
    {
      "id": 1234,
      "input_tokens": 1103,
      "output_tokens": 400,
      "cache_creation_tokens": 0,
      "cache_read_tokens": 85,
      "cost": "0.00248",
      "model": "claude-3-5-haiku-20241022",
      "created_at": "2026-07-12T04:16:22.000Z"
    }
  ],
  "totalCost": 0.00248
}
```

---

## Cost Monitoring Dashboard

Run the interactive monitor:

```bash
node scripts/monitor-claude-costs.js --watch --alert 5
```

**Output:**

```
═══════════════════════════════════════════════════════════
               CLAUDE API COST MONITOR
═══════════════════════════════════════════════════════════

📊 TODAY'S USAGE
─────────────────────────────────────────────────────────
   Cost:         $4.88
   API Calls:    1,965
   Input Tokens: 2,168,200
   Output Tokens: 786,000
   Cache Hits:   1,248,000
   Avg/Call:     $0.00248
   First Call:   4:16:22 AM
   Last Call:    4:45:30 PM

📅 THIS MONTH
─────────────────────────────────────────────────────────
   Cost:         $5.88
   API Calls:    2,365

📈 LAST 7 DAYS
─────────────────────────────────────────────────────────
   Jul 12: $4.88 (1965 calls)
   Jul 11: $0.05 (20 calls)
   Jul 10: $0.00 (0 calls)

🕐 RECENT API CALLS (Last 10)
─────────────────────────────────────────────────────────
   1. Visit 505 | 4:45:30 PM | $0.00248 | 1103→400 ⚡
   2. Visit 504 | 4:45:28 PM | $0.00248 | 1103→400 ⚡
   3. Visit 503 | 4:45:26 PM | $0.00248 | 1103→400 ⚡
   ...

═══════════════════════════════════════════════════════════
Alert Threshold: $5.00/day
Watch mode: Updates every 30 seconds (Ctrl+C to exit)
```

---

## Configuration Options

### Spending Limits

**Soft limit (warning only):**
```bash
CLAUDE_DAILY_LIMIT=5.00
CLAUDE_ENFORCE_CAP=false  # Default: allows exceeding limit with warnings
```

**Hard cap (blocks calls):**
```bash
CLAUDE_DAILY_LIMIT=5.00
CLAUDE_ENFORCE_CAP=true   # Throws error when limit reached
```

### Rate Limiting

**Default:** 30 calls per minute
```bash
CLAUDE_RATE_LIMIT=30
```

**For high-volume (use with caution):**
```bash
CLAUDE_RATE_LIMIT=100     # 100 calls per minute
```

**For testing/debugging:**
```bash
CLAUDE_RATE_LIMIT=5       # 5 calls per minute (very restrictive)
```

---

## Database Schema

### `claude_usage_log` Table

Stores every Claude API call for historical analysis:

```sql
CREATE TABLE claude_usage_log (
  id SERIAL PRIMARY KEY,
  visit_id INTEGER,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cost DECIMAL(10, 6) NOT NULL,
  model VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Views

**Daily summary:**
```sql
SELECT * FROM claude_daily_costs WHERE date > NOW() - INTERVAL '30 days';
```

**Monthly summary:**
```sql
SELECT * FROM claude_monthly_costs ORDER BY month DESC;
```

---

## Cost Analysis

### Expected Costs (Production)

**Per visit with 20-minute audio:**
- Input: ~1,100 tokens (transcript + system prompt)
- Output: ~400 tokens (SOAP note)
- Cost: **$0.00248 per visit**

**Monthly projections:**
| Visits/Month | Claude Cost | % of Revenue |
|--------------|-------------|--------------|
| 100          | $0.25       | 0.4%         |
| 500          | $1.24       | 0.4%         |
| 1,500        | $3.72       | 0.4%         |
| 5,000        | $12.40      | 0.4%         |

### Investigation Past Overages

If costs are unexpectedly high, investigate:

1. **Check total calls:**
   ```bash
   node scripts/monitor-claude-costs.js
   ```

2. **Query by date:**
   ```sql
   SELECT DATE(created_at), COUNT(*), SUM(cost)
   FROM claude_usage_log
   WHERE created_at > NOW() - INTERVAL '7 days'
   GROUP BY DATE(created_at);
   ```

3. **Find expensive calls:**
   ```sql
   SELECT visit_id, cost, input_tokens, output_tokens, created_at
   FROM claude_usage_log
   WHERE cost > 0.01
   ORDER BY cost DESC
   LIMIT 20;
   ```

4. **Check for loops/retries:**
   ```sql
   SELECT visit_id, COUNT(*) as call_count, SUM(cost) as total_cost
   FROM claude_usage_log
   GROUP BY visit_id
   HAVING COUNT(*) > 1
   ORDER BY call_count DESC;
   ```

---

## Troubleshooting

### Cost tracking not working

**Check:** Is the table created?
```bash
psql -d anot_db -c "\d claude_usage_log"
```

**Fix:** Run the migration
```bash
psql -d anot_db -f src/migrations/add_claude_usage_log.sql
```

### Rate limit too restrictive

**Symptom:** Getting rate limit errors during normal operation

**Fix:** Increase the limit
```bash
# In .env
CLAUDE_RATE_LIMIT=60  # 60 calls per minute
```

### Daily limit reached but still have budget

**Cause:** In-memory counter reset (server restart)

**Fix:** Check database for actual usage
```bash
node scripts/monitor-claude-costs.js
```

---

## Best Practices

### Development

- Set low daily limits during testing: `CLAUDE_DAILY_LIMIT=1.00`
- Use rate limiting: `CLAUDE_RATE_LIMIT=10`
- Never commit actual API keys

### Production

- Set reasonable daily limits: `CLAUDE_DAILY_LIMIT=50.00`
- Monitor costs weekly
- Review monthly summaries
- Set up external alerts (email/Slack)

### Load Testing

- Disable hard cap: `CLAUDE_ENFORCE_CAP=false`
- Calculate expected cost BEFORE running
- Run ONE test at a time
- Review costs immediately after

---

## Future Enhancements

Potential improvements (not yet implemented):

1. **Email/Slack alerts** - Notify when limits reached
2. **Cost predictions** - Estimate monthly cost based on usage trends
3. **Per-user limits** - Individual budgets for each clinician
4. **Batch API** - 50% cost reduction for non-urgent notes
5. **Cost dashboard** - Web UI for monitoring
6. **Export reports** - CSV/PDF cost reports for accounting

---

## Support

For issues or questions:

1. Check the monitoring dashboard: `node scripts/monitor-claude-costs.js`
2. Review logs: Search for `[CLAUDE-COST]` in CloudWatch
3. Query database: See "Cost Analysis" section above
4. Contact: Technical support

---

**Last Updated:** July 12, 2026  
**Version:** 1.0.0  
**Author:** Cost Control System Implementation
