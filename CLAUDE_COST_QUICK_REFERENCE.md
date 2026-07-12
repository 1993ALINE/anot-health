# Claude Cost Control - Quick Reference Card

**Version:** 1.0 | **Date:** July 12, 2026

---

## 🚀 Quick Setup (5 min)

```bash
# 1. Add to .env
echo "CLAUDE_DAILY_LIMIT=5.00" >> anot-backend-main/.env
echo "CLAUDE_ENFORCE_CAP=false" >> anot-backend-main/.env
echo "CLAUDE_RATE_LIMIT=30" >> anot-backend-main/.env

# 2. Run migration
cd anot-backend-main
psql -d anot_db -f src/migrations/add_claude_usage_log.sql

# 3. Verify installation
npm run claude:verify

# 4. Restart server
npm run dev  # or: pm2 restart anot-backend

# 5. Test monitoring
npm run claude:costs
```

---

## 📊 Monitoring Commands

```bash
# One-time cost check
npm run claude:costs

# Live monitoring (updates every 30s)
npm run claude:watch

# With custom alert threshold
npm run claude:alert 10

# Verify installation
npm run claude:verify
```

---

## 🔧 Configuration (.env)

```bash
# Daily spending limit (default: $5.00)
CLAUDE_DAILY_LIMIT=5.00

# Hard cap enforcement (default: false)
# false = soft limit (warnings only)
# true = hard cap (blocks calls when limit reached)
CLAUDE_ENFORCE_CAP=false

# Rate limit: max calls per minute (default: 30)
CLAUDE_RATE_LIMIT=30
```

**Recommended settings:**
- **Development:** `LIMIT=1.00`, `CAP=false`, `RATE=10`
- **Production:** `LIMIT=10.00`, `CAP=false`, `RATE=30`
- **Load testing:** `LIMIT=0.50`, `CAP=false`, `RATE=5`

---

## 📈 Expected Costs

| Usage | Cost/Note | 100 Notes | 1,000 Notes | 10,000 Notes |
|-------|-----------|-----------|-------------|--------------|
| **20-min audio** | $0.00248 | $0.25 | $2.48 | $24.80 |

**Daily capacity at $5 limit:** ~2,000 notes/day  
**Monthly capacity at $5/day:** ~60,000 notes/month

---

## 🚨 Alerts You'll See

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

**Rate Limit:**
```
Rate limit exceeded: 30 calls in last minute. Max: 30/min. Wait 15s.
```

---

## 🔍 API Endpoints (Admin Only)

```bash
# Current session stats
GET /api/claude-stats/current

# Today's usage
GET /api/claude-stats/today

# Daily breakdown (last 30 days)
GET /api/claude-stats/daily?days=30

# Monthly summary
GET /api/claude-stats/monthly

# Visit-specific usage
GET /api/claude-stats/usage-by-visit/:visitId

# Manual reset (admin)
POST /api/claude-stats/reset
```

---

## 💾 Database Queries

```sql
-- Today's cost
SELECT SUM(cost), COUNT(*) 
FROM claude_usage_log 
WHERE DATE(created_at) = CURRENT_DATE;

-- Last 7 days breakdown
SELECT DATE(created_at), SUM(cost), COUNT(*)
FROM claude_usage_log
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(created_at)
ORDER BY DATE(created_at) DESC;

-- Most expensive calls
SELECT visit_id, cost, input_tokens, output_tokens, created_at
FROM claude_usage_log
ORDER BY cost DESC
LIMIT 10;

-- Visits with multiple API calls (possible retries)
SELECT visit_id, COUNT(*), SUM(cost)
FROM claude_usage_log
GROUP BY visit_id
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC;

-- Use built-in views
SELECT * FROM claude_daily_costs WHERE date > NOW() - INTERVAL '30 days';
SELECT * FROM claude_monthly_costs;
```

---

## 🐛 Troubleshooting

### "Table does not exist"
```bash
psql -d anot_db -f src/migrations/add_claude_usage_log.sql
```

### "Rate limit exceeded"
**Wait 60 seconds OR increase limit:**
```bash
# In .env
CLAUDE_RATE_LIMIT=60
```

### "Daily limit reached"
**Option 1:** Wait until midnight (auto-reset)  
**Option 2:** Increase limit in .env and restart  
**Option 3:** Manual reset (admin only):
```bash
curl -X POST http://localhost:5000/api/claude-stats/reset \
  -H "Authorization: Bearer YOUR_JWT"
```

### No cost data showing
1. Check if table exists: `psql -c "\d claude_usage_log"`
2. Check if server restarted: `pm2 status`
3. Generate a test note to trigger logging

---

## 📝 Console Output Examples

**Normal operation:**
```
[Claude] Generating notes for visit 486
[Claude] ✅ Visit 486 complete | 1103 in, 400 out | Cache hit: 85 tokens | 245ms | 1250 chars
[CLAUDE-COST] Visit 486 | Call: $0.00248 | Daily: $0.05 (20 calls) | Total: $5.87 (2,350 calls)
```

**Daily reset:**
```
[CLAUDE-RESET] New day detected. Yesterday's cost: $4.87 (1,965 calls)
```

---

## 🎯 Best Practices

### Development
- ✅ Set low limits: `CLAUDE_DAILY_LIMIT=1.00`
- ✅ Monitor after tests: `npm run claude:costs`
- ✅ Calculate expected cost first
- ✅ Run ONE test at a time

### Production
- ✅ Reasonable limits: `CLAUDE_DAILY_LIMIT=10.00`
- ✅ Soft caps only: `CLAUDE_ENFORCE_CAP=false`
- ✅ Review weekly costs
- ✅ Check monthly summaries

### Load Testing
1. Calculate expected cost: `20 notes × $0.00248 = $0.05`
2. Set alert: `npm run claude:alert 0.10`
3. Monitor during: `npm run claude:watch`
4. Review after: `npm run claude:costs`

---

## 📚 Full Documentation

- **Setup Guide:** `CLAUDE_COST_CONTROL_SETUP.md`
- **Full Documentation:** `anot-backend-main/CLAUDE_COST_TRACKING.md`
- **Implementation Summary:** `CLAUDE_COST_IMPLEMENTATION_SUMMARY.md`
- **This Card:** `CLAUDE_COST_QUICK_REFERENCE.md`

---

## ✅ Verification Checklist

```bash
# Run verification script
npm run claude:verify

# Should show:
✅ Core service file with all functions
✅ Database migration file
✅ API routes file
✅ Server route registration
✅ Monitoring script
✅ Environment variables (or defaults)
✅ npm scripts
✅ Documentation files
```

---

## 🆘 Emergency Actions

### Suspected overspending in progress
```bash
# 1. Check current usage
npm run claude:costs

# 2. If very high, enable hard cap immediately
echo "CLAUDE_ENFORCE_CAP=true" >> anot-backend-main/.env
pm2 restart anot-backend

# 3. Investigate
SELECT DATE(created_at), COUNT(*), SUM(cost)
FROM claude_usage_log
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY DATE(created_at);
```

### Stop all Claude API calls
```bash
# Option 1: Enable hard cap with $0 limit
CLAUDE_DAILY_LIMIT=0.00
CLAUDE_ENFORCE_CAP=true

# Option 2: Remove API key temporarily
# (comment out in .env, restart server)
```

---

## 📞 Quick Links

**Anthropic Console:**
- Billing: https://console.anthropic.com/account/billing/overview
- Usage: https://console.anthropic.com/account/billing/usage

**Internal Monitoring:**
```bash
npm run claude:watch  # Real-time dashboard
```

**API Stats:**
```bash
curl -H "Auth: Bearer $JWT" http://localhost:5000/api/claude-stats/today
```

---

**Last Updated:** July 12, 2026  
**Status:** ✅ Production Ready  
**Support:** See full documentation in `CLAUDE_COST_TRACKING.md`
