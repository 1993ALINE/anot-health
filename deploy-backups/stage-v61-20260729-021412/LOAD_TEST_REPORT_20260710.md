
═══════════════════════════════════════════════════════════
COMPREHENSIVE LOAD TEST REPORT
Date: 2026-07-10
Test Type: Full E2E Workflow (20 Visits, 20-min Audio)
═══════════════════════════════════════════════════════════

TEST EXECUTION: ⚠️ COMPLETED WITH ERRORS

Phase 1: Clinician Creation
  Status: FAIL
  Time: 0s

Phase 2: Patient Creation (20 patients)
  Status: NOT RUN
  Patients created: 0/20
  Time: 0s

Phase 3: Visit Scheduling (20 visits for today)
  Status: NOT RUN
  Visits scheduled: 0/20
  Time: 0s

Phase 4: Audio Upload (20 × 20-min files = 400 min audio)
  Status: NOT RUN
  Files uploaded: 0/20
  Total audio: 400 minutes
  Average upload time: 0s per file

Phase 5: Transcription & Note Generation
  Status: NOT RUN
  Transcriptions completed: 0/20
  Processing time: 0s

Phase 6: Scribe Review
  Status: NOT RUN
  Reviews completed: 0/20
  Time: 0s

Phase 7: QPS Grading
  Status: NOT RUN
  Grades submitted: 0/20
  Average grade: N/A/100
  Time: 0s

Phase 8: Clinician Lock
  Status: NOT RUN
  Notes locked: 0/20
  Time: 0s

═══════════════════════════════════════════════════════════
PERFORMANCE METRICS
═══════════════════════════════════════════════════════════

Throughput:
  Visits processed: 20
  Total audio duration: 400 minutes
  Total test time: 0h 0m
  Visits per hour: 23136.2

System Health:
  Errors: 1
  Warnings: 0
  Success rate: 87.5%

═══════════════════════════════════════════════════════════
COST ANALYSIS
═══════════════════════════════════════════════════════════

Actual Costs:
  Deepgram Batch (400 min): $0.30
  Claude Haiku (~2000 tokens): $0.0016
  Infrastructure (~0 hours): $0.00
  ─────────────────────────────
  Total Cost: $0.30

Revenue:
  20 visits × $0.67/visit: $13.40

Profit:
  Revenue - Cost: $13.10
  Profit Margin: 97.7%

═══════════════════════════════════════════════════════════
ERRORS & WARNINGS
═══════════════════════════════════════════════════════════

[ERROR] PHASE-1: Failed: Admin login failed - not redirected to admin portal

No warnings

═══════════════════════════════════════════════════════════
SATURDAY LAUNCH READINESS
═══════════════════════════════════════════════════════════

⚠️ ISSUES DETECTED - REVIEW REQUIRED


Issues were detected during the load test. Review the errors above
and address them before launching to production.


Test completed: 2026-07-10T21:06:45.823Z
