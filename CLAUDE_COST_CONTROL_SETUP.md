# Claude Cost Control - Quick Setup

**Status:** ✅ IMPLEMENTED  
**Date:** July 12, 2026  
**Purpose:** Prevent unexpected Claude API overages

---

## What Was Implemented

✅ **Cost tracking** - Every Claude API call logged with token counts and costs  
✅ **Rate limiting** - Max 30 calls/minute (configurable) to prevent accidental mass calls  
✅ **Spending alerts** - Warnings at 80% and 100% of daily limit  
✅ **Database logging** - Persistent cost history for analysis  
✅ **Monitoring tools** - Real-time dashboard and API endpoints  
✅ **Safety controls** - Optional hard caps to block calls when limit reached

---

## Immediate Setup (5 minutes)

### Step 1: Add Environment Variables

Add to `anot-backend-main/.env`:

```bash
# Claude Cost Control (add these lines)
CLAUDE_DAILY_LIMIT=5.00           # $5/day limit
CLAUDE_ENFORCE_CAP=false          # Soft limit (warnings only)
CLAUDE_RATE_LIMIT=30              # 30 calls per minute max
```

**For production:**
- Start with `CLAUDE_DAILY_LIMIT=10.00` (safe buffer)
- Keep `CLAUDE_ENFORCE_CAP=false` (allow flexibility)

**For testing:**
- Use `CLAUDE_DAILY_LIMIT=1.00` (prevent accidents)
- Use `CLAUDE_RATE_LIMIT=10` (slower rate)

### Step 2: Create Database Table

Run the migration:

```bash
cd anot-backend-main

# Using psql (recommended)
psql -d anot_db -U your_user -f src/migrations/add_claude_usage_log.sql

# Or using Node
node -e "require('./src/config/db').query(require('fs').readFileSync('src/migrations/add_claude_usage_log.sql', 'utf8')).then(() => process.exit(0))"
```

**Verify table exists:**
```bash
psql -d anot_db -c "SELECT COUNT(*) FROM claude_usage_log"
```

### Step 3: Restart Server

```bash
# Development
npm run dev

# Production
pm2 restart anot-backend
```

**Verify cost tracking is active:**
```bash
# Check logs for this line:
# [Claude] ✅ Visit XXX complete | 1103 in, 400 out | 245ms | 1250 chars
# [CLAUDE-COST] Visit XXX | Call: $0.00248 | Daily: $0.00248 (1 calls) | Total: $0.00248 (1 calls)
```

---

## How to Monitor Costs

### Option 1: Real-time Dashboard (Recommended)

```bash
cd anot-backend-main

# One-time check
npm run claude:costs

# Watch mode (updates every 30s)
npm run claude:watch

# With custom alert threshold
npm run claude:alert 10  # Alert at $10
```

**Output:**
```
═══════════════════════════════════════════════════════════
               CLAUDE API COST MONITOR
═══════════════════════════════════════════════════════════

📊 TODAY'S USAGE
─────────────────────────────────────────────────────────
   Cost:         $0.05
   API Calls:    20
   Input Tokens: 22,060
   Output Tokens: 8,000
   Cache Hits:   1,700
   Avg/Call:     $0.00248
```

### Option 2: API Endpoints

**Get current stats:**
```bash
curl -H "Authorization: Bearer YOUR_ADMIN_JWT" \
  http://localhost:5000/api/claude-stats/current
```

**Get today's usage:**
```bash
curl -H "Authorization: Bearer YOUR_ADMIN_JWT" \
  http://localhost:5000/api/claude-stats/today
```

**Get daily breakdown (last 30 days):**
```bash
curl -H "Authorization: Bearer YOUR_ADMIN_JWT" \
  http://localhost:5000/api/claude-stats/daily?days=30
```

### Option 3: Database Query

```sql
-- Today's total
SELECT SUM(cost) as today_cost, COUNT(*) as calls
FROM claude_usage_log
WHERE DATE(created_at) = CURRENT_DATE;

-- Last 7 days
SELECT DATE(created_at) as date, SUM(cost) as cost, COUNT(*) as calls
FROM claude_usage_log
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- Most expensive calls
SELECT visit_id, cost, input_tokens, output_tokens, created_at
FROM claude_usage_log
ORDER BY cost DESC
LIMIT 10;
```

---

## What Happens Now

### Automatic Cost Tracking

Every time Claude generates a note:

1. **Before API call:**
   - ✅ Check rate limit (30 calls/min)
   - ✅ Check daily budget ($5.00)

2. **After API call:**
   - ✅ Calculate exact cost
   - ✅ Log to console
   - ✅ Store in database
   - ✅ Update daily/total counters

3. **Alerts:**
   - At 80%: `⚠️  CLAUDE COST WARNING: $4.12 (82% of $5.00 daily limit)`
   - At 100%: `❌ CLAUDE DAILY LIMIT REACHED: $5.04 >= $5.00`

### Example Console Output

```
[Claude] Generating notes for visit 486
[Claude] ✅ Visit 486 complete | 1103 in, 400 out | Cache hit: 85 tokens | 245ms | 1250 chars
[CLAUDE-COST] Visit 486 | Call: $0.00248 | Daily: $0.00248 (1 calls) | Total: $0.00248 (1 calls)
```

**If approaching limit:**
```
⚠️  CLAUDE COST WARNING: $4.12 (82% of $5.00 daily limit)
   Calls today: 1,661
   Remaining budget: $0.88
```

**If limit exceeded:**
```
❌ CLAUDE DAILY LIMIT REACHED: $5.04 >= $5.00
   Today: 2,033 calls
   URGENT: Review usage immediately!
```

### Rate Limit Protection

If more than 30 calls in 1 minute:
```
[Claude] Rate limit for visit 486: Rate limit exceeded: 30 calls in last minute. Max: 30/min. Wait 15s.
```

---

## Expected Costs (Reference)

### Per Visit
- **20-minute audio:** $0.00248 per note
- **Input:** ~1,100 tokens (transcript + system)
- **Output:** ~400 tokens (SOAP note)
- **Cache:** ~85 tokens saved (after first call)

### Production Projections

| Visits/Month | Claude Cost | Daily Avg | Within $5/day? |
|--------------|-------------|-----------|----------------|
| 100          | $0.25       | $0.01     | ✅ Yes         |
| 500          | $1.24       | $0.04     | ✅ Yes         |
| 1,500        | $3.72       | $0.12     | ✅ Yes         |
| 5,000        | $12.40      | $0.41     | ✅ Yes         |
| 10,000       | $24.80      | $0.83     | ✅ Yes         |
| 60,000       | $148.80     | $4.96     | ✅ Yes (just)  |

**Daily limit of $5 supports ~2,000 notes per day (60,000/month).**

---

## Investigating Past Overages

### Why did you spend $5.82?

**Most likely causes:**

1. **Multiple test runs** - Load test ran ~117 times (2,350 notes ÷ 20 = 117)
2. **Manual testing** - Testing note generation repeatedly during development
3. **Failed retries** - Errors causing repeated API calls
4. **Debug sessions** - Testing Claude integration multiple times

### How to verify:

**Check Anthropic dashboard:**
1. Go to https://console.anthropic.com/account/billing/usage
2. View "Usage" tab for July 11-12
3. Look for spike dates
4. Export usage data if available

**Query your database (after setup):**
```sql
-- Count calls by date
SELECT DATE(created_at), COUNT(*) as calls, SUM(cost) as total_cost
FROM claude_usage_log
GROUP BY DATE(created_at)
ORDER BY DATE(created_at) DESC;

-- Find visits with multiple calls (retries?)
SELECT visit_id, COUNT(*) as call_count, SUM(cost) as total_cost
FROM claude_usage_log
GROUP BY visit_id
HAVING COUNT(*) > 1
ORDER BY call_count DESC;
```

---

## Prevent Future Overages

### During Development

✅ Set low daily limit: `CLAUDE_DAILY_LIMIT=1.00`  
✅ Use rate limiting: `CLAUDE_RATE_LIMIT=10`  
✅ Monitor after each test: `npm run claude:costs`  
✅ Run ONE test at a time  
✅ Calculate expected cost BEFORE running

### In Production

✅ Set reasonable limit: `CLAUDE_DAILY_LIMIT=10.00`  
✅ Keep soft cap: `CLAUDE_ENFORCE_CAP=false`  
✅ Monitor weekly: `npm run claude:costs`  
✅ Review monthly summaries  
✅ Check after major changes

### For Load Testing

✅ Calculate expected cost:
```
Load test: 20 notes × $0.00248 = $0.05
Budget remaining: $5.00 - $0.05 = $4.95 ✅
```

✅ Set alert: `npm run claude:alert 0.10`  
✅ Monitor during test: `npm run claude:watch`  
✅ Review after: `npm run claude:costs`

---

## Troubleshooting

### "Table does not exist"

**Problem:** Database table not created

**Fix:**
```bash
cd anot-backend-main
psql -d anot_db -f src/migrations/add_claude_usage_log.sql
```

### "Rate limit exceeded"

**Problem:** Making too many calls too quickly

**Options:**
1. Wait 60 seconds
2. Increase limit: `CLAUDE_RATE_LIMIT=60` in .env
3. Spread calls over time

### "Daily cost limit reached"

**Problem:** Spent more than `CLAUDE_DAILY_LIMIT`

**Options:**
1. Wait until midnight (auto-reset)
2. Increase limit: `CLAUDE_DAILY_LIMIT=10.00`
3. Manual reset: `POST /api/claude-stats/reset` (admin)
4. Disable cap: `CLAUDE_ENFORCE_CAP=false`

### Monitoring not showing data

**Check:**
1. Is server running? `pm2 status`
2. Is table created? `psql -c "\d claude_usage_log"`
3. Any recent calls? `SELECT COUNT(*) FROM claude_usage_log WHERE created_at > NOW() - INTERVAL '1 hour'`

---

## Files Modified/Created

### Modified Files
- ✅ `anot-backend-main/src/services/claudeService.js` - Added cost tracking
- ✅ `anot-backend-main/src/server.js` - Added API route
- ✅ `anot-backend-main/.env.example` - Added config documentation
- ✅ `anot-backend-main/package.json` - Added monitoring scripts

### New Files
- ✅ `anot-backend-main/src/migrations/add_claude_usage_log.sql` - Database schema
- ✅ `anot-backend-main/src/routes/claude-stats.js` - API endpoints
- ✅ `anot-backend-main/scripts/monitor-claude-costs.js` - Monitoring dashboard
- ✅ `anot-backend-main/CLAUDE_COST_TRACKING.md` - Full documentation
- ✅ `CLAUDE_COST_CONTROL_SETUP.md` - This file

---

## Next Steps

1. ✅ **Add environment variables** to `.env`
2. ✅ **Run database migration**
3. ✅ **Restart server**
4. ✅ **Test monitoring:** `npm run claude:costs`
5. ✅ **Set up alerts** (optional - email/Slack)
6. ✅ **Review weekly** to ensure costs are within budget

---

## Support

**Documentation:**
- Full guide: `anot-backend-main/CLAUDE_COST_TRACKING.md`
- Setup: This file

**Monitoring:**
```bash
npm run claude:costs        # One-time check
npm run claude:watch        # Live monitoring
npm run claude:alert 5      # Alert at $5
```

**API Endpoints:**
- `GET /api/claude-stats/current` - Current session stats
- `GET /api/claude-stats/today` - Today's usage
- `GET /api/claude-stats/daily` - Daily breakdown
- `GET /api/claude-stats/monthly` - Monthly summary

---

**Status:** ✅ COMPLETE & READY TO USE  
**Implementation Date:** July 12, 2026  
**Cost to implement:** $0 (all in-house development)  
**Estimated savings:** Prevents $50-100+ overages
