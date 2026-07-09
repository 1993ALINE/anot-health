# 30+ Minute Audio Handling — Test Report

**Date:** 2026-07-05  
**Environment:** Production (`https://app.anot.health`) + Deepgram live API  
**Test script:** `anot-backend-main/anot-backend-main/scripts/test-45min-audio.js`

---

## PART 1: Deepgram Limits

| Limit | Value |
|-------|-------|
| Max file size | **2048 MB (2 GB)** |
| Max duration | **No hard limit** (Nova models: processing may 504 after ~10 min server-side; client timeout should be `duration + 300s`) |
| Max concurrent jobs | **100** per project (Nova/Base/Enhanced) |
| Recommended client timeout | **`file_seconds + 300`** |
| Cost (Nova-3 Medical) | **~$0.004/min** |

**45-minute recording estimates:**
- File size: **82–114 MB** (16 kHz silent WAV / speech-looped WAV); **~5–15 MB** typical WebM/Opus clinical recording; up to **500 MB** at max upload cap
- Cost: **~$0.18** (45 × $0.004)
- Processing time observed: **16–69 s** (direct API); **~2 min** (production pipeline, speech)

---

## PART 2: System Limits

### Backend (production EB — verified)

| Setting | Value |
|---------|-------|
| `REQUEST_TIMEOUT` | **600000 ms (10 min)** — upload socket timeout |
| `DEEPGRAM_TIMEOUT_MS` | **1800000 ms (30 min)** |
| `TRANSCRIPTION_STUCK_MS` | **1800000 ms (30 min)** |
| `FFMPEG_MAX_UPLOAD_MB` | **500 MB** |
| Nginx `client_max_body_size` | **500m** |
| Multer max | **500 MB** (via `ffmpegUploadLimits.js`) |

### Frontend

| Setting | Value |
|---------|-------|
| Max upload file size | **500 MB** (`audioUpload.js`) |
| Upload fetch timeout | **None** (browser default; long uploads use backend 10 min socket) |
| Transcription poll max wait | **1800000 ms (30 min)** |
| Poll interval | **10 s** |
| Per-poll request timeout | **30 s** |

### S3

| Limit | Value |
|-------|-------|
| Max object size | **5 TB** (multipart) |
| Practical cap in app | **500 MB** (nginx + Multer) |

### Node.js (test machine)

| Metric | Value |
|--------|-------|
| System RAM | **8.4 GB** |
| Upload client peak RSS | **~637 MB** (113 MB file read into memory for FormData) |
| EB instance | **t3.micro (1 GB)** — uploads **stream to S3** on server (no full-file buffer) |
| Memory for 500 MB upload (server) | **~100–200 MB** streaming (not 500 MB+) |

---

## PART 3 & 4: Test Results

### Test A — 45 min silent WAV (82.4 MB)

| Step | Result |
|------|--------|
| Deepgram direct API | ✅ **200 OK** in 16.5–53 s |
| Production upload | ✅ **HTTP 200** in **23 s** (29.9 Mbps) → S3 `/uploads/visit_414_*.webm` |
| Auto-transcription | ❌ **failed** — empty transcript (silent audio; expected) |

### Test B — 45 min speech-looped WAV (113.6 MB) — **PRIMARY PASS**

| Step | Result |
|------|--------|
| Deepgram direct API | ✅ **200 OK** in **69.1 s**, transcript **29,679 chars** |
| Production upload | ✅ **HTTP 200** in **35 s** (27.1 Mbps) |
| Transcription pipeline | ✅ **completed** in **~2 min 14 s**, transcript **28,905 chars** |
| Visit ID | **416** |

**No timeout errors observed.**

---

## PART 5: Fixes Applied

| Proposed fix | Applied? | Reason |
|--------------|----------|--------|
| Increase `REQUEST_TIMEOUT` to 20 min | **No** | 113 MB uploaded in 35 s; 10 min sufficient |
| Increase `DEEPGRAM_TIMEOUT_MS` to 45 min | **No** | 45-min speech transcribed in ~2 min |
| Increase `TRANSCRIPTION_STUCK_MS` to 45 min | **No** | Not needed |
| Frontend warn if >30 min | **Yes** | Toast in Clinician portal at 30 min |
| Deepgram 2 GB file size guard | **Yes** | Check in `deepgramService.startTranscription` |

---

## PART 6: Supported Limits Summary

| Parameter | Supported value |
|-----------|-----------------|
| **Maximum audio duration** | **~60 min** (within 500 MB cap at typical Opus/WebM bitrates) |
| **Maximum file size** | **500 MB** (app); **2048 MB** (Deepgram API) |
| **Upload timeout** | **600 s (10 min)** socket |
| **Transcription timeout** | **1800 s (30 min)** default; dynamic up to 30 min by file size |
| **Cost per 45-min recording** | **~$0.18** |
| **Warning threshold** | **30 min** — clinician toast recommends ending or splitting |
| **Recommendation** | Split encounters **>60 min** or when approaching **500 MB** |

---

## Artifacts

- `test-fixtures/deepgram/test-45min.wav` — 82.4 MB, 45 min silent
- `test-fixtures/deepgram/test-45min-speech.wav` — 113.6 MB, 45 min speech loop
- `test-fixtures/deepgram/test-45min-results.txt` — run log
- `scripts/test-45min-audio.js` — repeatable E2E test

---

**Verdict:** System handles **30–60 minute** clinical audio within current limits. No timeout increases required for production.
