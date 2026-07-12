# QUICK START: Load Test Execution

## Three Ways to Run the Load Test

### Option 1: Automated Browser Test (Recommended)

```bash
cd anot-backend-main
npm run test:load
```

This will:
- Launch Chrome browser
- Execute all 8 phases automatically
- Generate comprehensive report
- Save results to LOAD_TEST_REPORT_[date].md

**Time:** 2-3 hours (fully automated)

---

### Option 2: API-Based Test (Faster)

```bash
cd anot-backend-main
npm run test:load:api
```

This will:
- Use direct API calls (no browser)
- Create clinician, patients, visits
- Upload audio files
- Monitor transcription
- Phases 6-8 need manual completion

**Time:** 30-45 minutes for automated portion

---

### Option 3: Manual Testing

Follow the detailed guide:

```bash
# Open the manual guide
code ../MANUAL_LOAD_TEST_GUIDE.md
```

**Time:** 2-3 hours (manual steps)

---

## Prerequisites

Before running any test:

1. **Backend server running:**
   ```bash
   cd anot-backend-main
   npm start
   ```

2. **Database accessible**

3. **Admin credentials verified:**
   - Email: atiqurrahmanaline@gmail.com
   - Password: #1Knowtex2026

4. **Test audio file (auto-generated):**
   ```bash
   npm run generate:audio
   ```

---

## Test Phases

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Create test clinician | 5 min |
| 2 | Create 20 patients | 10 min |
| 3 | Schedule 20 visits | 10 min |
| 4 | Upload 20-min audio × 20 | 60 min |
| 5 | Monitor transcription | 15 min |
| 6 | Scribe reviews | 30 min |
| 7 | QPS grading | 20 min |
| 8 | Clinician locks | 10 min |

**Total:** 2-3 hours

---

## Quick Commands

```bash
# Generate test audio only
npm run generate:audio

# Run full automated test
npm run test:load

# Run API-based test
npm run test:load:api

# Check test results
cat LOAD_TEST_REPORT_*.md
```

---

## Expected Results

**Success Criteria:**
- All 20 visits processed end-to-end
- 400 minutes of audio transcribed
- System remained stable
- Error rate: 0%
- Profit margin: 90%+

**Costs:**
- Deepgram: $0.30
- Claude: $0.002
- Infrastructure: $0.95
- **Total: $1.25**

**Revenue:** $13.40  
**Profit:** $12.15 (91% margin)

---

## Troubleshooting

**Browser test fails:**
- Check if Chrome is installed
- Try headless mode
- Use API test instead

**API test fails:**
- Verify backend is running
- Check API endpoint URLs
- Review error logs

**Audio upload fails:**
- Check file size limit
- Verify S3 permissions
- Monitor CloudWatch logs

---

## After Test Completion

1. Review generated report
2. Check CloudWatch metrics
3. Verify database records
4. Document any issues
5. Plan fixes if needed

---

## Launch Readiness Checklist

- [ ] All 20 visits processed successfully
- [ ] Transcription accuracy verified
- [ ] Note quality acceptable
- [ ] System remained stable
- [ ] Cost model validated
- [ ] Error rate: 0%

**If all checked:** READY FOR LAUNCH!

---

## Support

- Check logs: CloudWatch, Sentry
- Review metrics: RDS Performance Insights
- Database queries: See manual guide
- API testing: Use Postman collection

**Ready to test!**
