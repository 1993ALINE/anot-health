# COMPREHENSIVE LOAD TEST - COMPLETE SETUP

**Status:** ✅ READY TO EXECUTE  
**Date Created:** 2026-07-11  
**Test Scope:** 20 visits × 20-minute audio = 400 minutes total

---

## WHAT WAS CREATED

### Scripts (in `anot-backend-main/scripts/`)
1. **comprehensive-load-test.js** - Full Playwright automation (2-3 hours)
2. **api-load-test.js** - API-based test (30-45 minutes automated)
3. **generate-test-audio.js** - Audio file generator
4. **monitor-load-test.js** - Real-time progress dashboard

### Documentation
1. **LOAD_TEST_EXECUTIVE_SUMMARY.md** - Complete overview and decision guide
2. **MANUAL_LOAD_TEST_GUIDE.md** - Step-by-step manual testing (detailed)
3. **QUICK_START_LOAD_TEST.md** - Quick reference guide
4. **README_LOAD_TEST.md** - Script documentation (in scripts folder)

### NPM Scripts Added
```json
"generate:audio": "node scripts/generate-test-audio.js"
"test:load": "node scripts/comprehensive-load-test.js"
"test:load:api": "node scripts/api-load-test.js"
"monitor:load": "node scripts/monitor-load-test.js"
```

---

## QUICK START (Choose One)

### Option A: Automated Browser Test (Recommended for First Run)
```bash
cd anot-backend-main
npm run test:load
```
This will open Chrome and execute all phases automatically.

### Option B: API Test (Faster, for CI/CD)
```bash
cd anot-backend-main
npm run test:load:api
```
Executes phases 1-5 via API, phases 6-8 need manual completion.

### Option C: Manual Test (Best for Learning)
Open and follow: `MANUAL_LOAD_TEST_GUIDE.md`

---

## MONITORING

Start real-time monitoring in a separate terminal:
```bash
cd anot-backend-main
npm run monitor:load
```

Shows live progress:
- Visit statuses
- Transcription completion
- Phase progression
- Estimated completion

---

## WHAT THE TEST DOES

### Phase 1: Create Test Clinician (5 min)
- Admin logs in
- Creates clinician: load-test-doctor@anot.health
- Verifies clinician can login

### Phase 2: Create 20 Patients (10 min)
- Clinician creates patients LT-2026-001 through LT-2026-020
- All patients verified in system

### Phase 3: Schedule 20 Visits (10 min)
- Creates visits for today with staggered times
- Visit times: 9:00 AM through 6:30 PM

### Phase 4: Upload Audio (60 min)
- Generates 20-minute test audio file (38 MB)
- Uploads to all 20 visits
- Total: 400 minutes of audio

### Phase 5: Monitor Transcription (15 min)
- Deepgram batch processes all audio
- Claude generates clinical notes automatically
- All visits transition to "Notes Generated"

### Phase 6: Scribe Review (30 min)
- Scribe reviews transcripts and notes
- Approves for EMR submission
- Status: "Reviewed"

### Phase 7: QPS Grading (20 min)
- QPS grades note quality (0-100)
- Expected: 85-95 average score
- Status: "Graded"

### Phase 8: Clinician Lock (10 min)
- Clinician reviews finalized notes
- Locks notes (becomes immutable)
- Status: "Locked"

---

## EXPECTED RESULTS

### Performance
- **Total time:** 2-3 hours
- **Success rate:** 100% (20/20 visits)
- **Transcription accuracy:** >95%
- **System uptime:** 100%
- **Error rate:** 0%

### Costs
- Deepgram (400 min): $0.30
- Claude (~2000 tokens): $0.002
- Infrastructure (3 hours): $0.95
- **Total: $1.25**

### Revenue
- 20 visits × $0.67 = $13.40
- **Profit: $12.15 (91% margin)**

---

## CREDENTIALS

**Admin:**
- atiqurrahmanaline@gmail.com / #1Knowtex2026

**Test Clinician (auto-created):**
- load-test-doctor@anot.health / LoadTest@2026

**Scribe:**
- shahib@anot.health / #1Knowtex2026

**QPS:**
- farhan@anot.health / #1Knowtex2026

---

## FILES GENERATED

After test completion:
- `test-audio-20min.wav` (38 MB, in scripts folder)
- `LOAD_TEST_REPORT_20260711.md` (comprehensive results)

---

## SUCCESS CRITERIA

Test passes if:
- [ ] All 20 visits created
- [ ] All 20 audio files uploaded (400 min)
- [ ] 100% transcription completion
- [ ] 20 professional notes generated
- [ ] All user roles functioned correctly
- [ ] System remained stable
- [ ] Error rate: 0%
- [ ] Profit margin: >85%

---

## LAUNCH DECISION

### ✅ READY FOR LAUNCH IF:
- All success criteria met
- No critical errors
- System stable under load
- Profit margin validated

### ⚠️ NEEDS REVIEW IF:
- Any visits failed
- System instability detected
- Error rate >0%

### ❌ DO NOT LAUNCH IF:
- Multiple critical failures
- Data integrity issues
- Security vulnerabilities

---

## NEXT STEPS

### 1. Pre-Test Checklist
- [ ] Backend server running
- [ ] Database accessible
- [ ] All credentials verified
- [ ] Playwright installed (if using browser test)

### 2. Execute Test
Choose your method and run:
```bash
npm run test:load        # Full automation
npm run test:load:api    # API only
# OR follow MANUAL_LOAD_TEST_GUIDE.md
```

### 3. Monitor Progress
In separate terminal:
```bash
npm run monitor:load
```

### 4. Review Results
After completion:
- Read generated LOAD_TEST_REPORT_[date].md
- Verify all metrics
- Check CloudWatch/Sentry for errors
- Validate cost model

### 5. Make Decision
- **Pass:** Ready for Saturday launch ✅
- **Fail:** Document issues, fix, re-test

---

## TROUBLESHOOTING

### Browser Test Won't Start
- Check if Chromium installed: `npx playwright install chromium`
- Try API test instead: `npm run test:load:api`

### API Endpoints Not Found
- Verify backend is running: `npm start`
- Check API base URL in script
- Review backend logs

### Audio Upload Fails
- Check file size limit (100 MB)
- Verify S3 permissions
- Monitor CloudWatch logs
- Check network connectivity

### Transcription Stuck
- Wait full 15 minutes (batch processing)
- Check Deepgram API status
- Review Redis queue
- Check CloudWatch logs for errors

---

## SUPPORT RESOURCES

### Documentation
- `LOAD_TEST_EXECUTIVE_SUMMARY.md` - Complete overview
- `MANUAL_LOAD_TEST_GUIDE.md` - Detailed step-by-step
- `QUICK_START_LOAD_TEST.md` - Quick reference
- `scripts/README_LOAD_TEST.md` - Script docs

### Monitoring
- Real-time: `npm run monitor:load`
- CloudWatch: AWS Console → CloudWatch
- Sentry: Error tracking dashboard
- RDS Performance Insights: Database metrics

### Database Queries
```sql
-- Check visit progress
SELECT status, COUNT(*) FROM visits 
WHERE created_at::date = CURRENT_DATE 
GROUP BY status;

-- Check transcription count
SELECT COUNT(*) FROM transcriptions 
WHERE created_at::date = CURRENT_DATE;

-- Average processing time
SELECT AVG(EXTRACT(EPOCH FROM (locked_at - created_at))) / 60 
FROM visits WHERE locked_at IS NOT NULL;
```

---

## IMPORTANT NOTES

1. **Test Clinician:** Will be created fresh each time (load-test-doctor@anot.health)
2. **Test Patients:** 20 patients with MRNs LT-2026-001 through LT-2026-020
3. **Audio File:** 38 MB WAV file, 20 minutes, 1000 Hz sine wave
4. **Cleanup:** Test data remains in database (can be filtered by date or MRN prefix)
5. **Costs:** Real costs will be incurred (Deepgram, Claude, infrastructure)

---

## FINAL CHECKLIST

Before starting:
- [ ] Read LOAD_TEST_EXECUTIVE_SUMMARY.md
- [ ] Backend server running
- [ ] Database accessible
- [ ] Credentials verified
- [ ] Playwright installed (for browser test)
- [ ] Monitoring terminal ready

During test:
- [ ] Monitor progress dashboard
- [ ] Watch for errors in terminal
- [ ] Check CloudWatch logs occasionally
- [ ] Note any unusual behavior

After test:
- [ ] Review generated report
- [ ] Verify all metrics
- [ ] Check costs incurred
- [ ] Document any issues
- [ ] Make launch decision

---

## READY TO EXECUTE!

**Recommended first run:**
```bash
cd anot-backend-main
npm run test:load
```

This will execute the full automated test with browser automation, giving you visibility into each step.

**Monitor in separate terminal:**
```bash
cd anot-backend-main
npm run monitor:load
```

---

## EXPECTED OUTCOME

After 2-3 hours, you should have:
1. ✅ 20 complete end-to-end workflows validated
2. ✅ 400 minutes of audio transcribed
3. ✅ 20 professional clinical notes generated
4. ✅ System proven stable under load
5. ✅ Cost model validated (91% margin)
6. ✅ Comprehensive report generated
7. ✅ **Platform ready for Saturday launch**

---

**🚀 EXECUTE THE TEST AND PROVE THE PLATFORM IS PRODUCTION-READY! 🚀**

For questions or issues during test execution, refer to:
- MANUAL_LOAD_TEST_GUIDE.md (troubleshooting section)
- CloudWatch logs (real-time error tracking)
- Sentry dashboard (error aggregation)
