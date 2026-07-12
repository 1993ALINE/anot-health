# LOAD TEST INFRASTRUCTURE

Comprehensive load testing suite for ANOT Health platform.

## Files Created

1. **comprehensive-load-test.js** - Full browser automation test
2. **api-load-test.js** - API-based load test (faster)
3. **generate-test-audio.js** - Audio file generator
4. **monitor-load-test.js** - Real-time progress monitor
5. **MANUAL_LOAD_TEST_GUIDE.md** - Step-by-step manual testing guide
6. **QUICK_START_LOAD_TEST.md** - Quick start guide

## Quick Start

### Generate Test Audio
```bash
npm run generate:audio
```

### Run Automated Test
```bash
npm run test:load
```

### Run API Test
```bash
npm run test:load:api
```

### Monitor Progress
```bash
npm run monitor:load
```

## Test Scope

- Creates 1 test clinician
- Creates 20 test patients
- Schedules 20 visits
- Uploads 20-minute audio files (400 min total)
- Monitors transcription and note generation
- Tracks scribe review, QPS grading, clinician lock

## Expected Results

- Total time: 2-3 hours
- Total cost: $1.25
- Total revenue: $13.40
- Profit margin: 91%

## Files Generated

- test-audio-20min.wav (38 MB)
- LOAD_TEST_REPORT_[date].md

## Prerequisites

- Backend server running
- Database accessible
- Admin credentials configured
- Playwright installed (for browser test)

## Support

See MANUAL_LOAD_TEST_GUIDE.md for detailed instructions.
