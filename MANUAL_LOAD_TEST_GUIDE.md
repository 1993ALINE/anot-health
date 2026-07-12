# COMPREHENSIVE MANUAL LOAD TEST GUIDE
**Date**: July 11, 2026  
**Objective**: Test platform with 20 visits, 20-min audio each, all user roles  
**Duration**: 2-3 hours  
**Expected Result**: System proven ready for Saturday launch

---

## QUICK REFERENCE

| Phase | Task | Duration | Status |
|-------|------|----------|--------|
| 1 | Admin creates clinician | 5 min | ⬜ |
| 2 | Create 20 patients | 10 min | ⬜ |
| 3 | Schedule 20 visits | 10 min | ⬜ |
| 4 | Upload 20×20-min audio | 15 min | ⬜ |
| 5 | Wait for transcription | 15-20 min | ⬜ |
| 6 | Scribe reviews | 30 min | ⬜ |
| 7 | QPS grading | 20 min | ⬜ |
| 8 | Clinician locks notes | 10 min | ⬜ |
| 9 | Performance analysis | 10 min | ⬜ |

**Total Estimated Time**: 2-3 hours

---

## PREPARATION (5 minutes)

### Before Starting

1. **Open Multiple Browser Windows**:
   - Window 1: Admin portal (https://app.anot.health)
   - Window 2: Clinician portal (for later)
   - Window 3: Scribe portal (for later)
   - Window 4: QPS portal (for later)

2. **Prepare Test Audio File**:
   - If not already generated, run:
     ```powershell
     cd anot-backend-main
     node scripts/generate-test-audio.js 20
     ```
   - Location: `anot-backend-main/scripts/test-audio-20min.wav`
   - Size: ~38 MB
   - Duration: 20 minutes

3. **Start Time Tracking**:
   - Open a text editor or spreadsheet
   - Record start time: `_____________`

4. **Open Performance Monitor** (optional):
   - AWS CloudWatch console
   - ElasticBeanstalk environment health

---

## PHASE 1: ADMIN CREATES NEW CLINICIAN (5 minutes)

### Test Clinician Details
- **Email**: `load-test-doctor-[TIMESTAMP]@anot.health` (replace [TIMESTAMP] with current Unix timestamp or use: `load-test-doctor-july11@anot.health`)
- **Password**: `LoadTest@2026`
- **First Name**: Load
- **Last Name**: Test
- **Role**: Clinician
- **Phone**: +8801521434823
- **Specialty**: General Medicine

### Steps

**1.1 Admin Login**
- [ ] Open https://app.anot.health in Window 1
- [ ] Login credentials:
  - Email: `atiqurrahmanaline@gmail.com`
  - Password: `#1Knowtex2026`
- [ ] Click "Sign In"
- [ ] **Verify**: Redirected to admin portal/dashboard

**1.2 Navigate to User Management**
- [ ] Click "Users" or "User Management" in sidebar
- [ ] **Verify**: User list loads

**1.3 Create New Clinician**
- [ ] Click "Add New User" or "Create User"
- [ ] Fill in form:
  - Email: `load-test-doctor-july11@anot.health`
  - First Name: `Load`
  - Last Name: `Test`
  - Role: Select `Clinician`
  - Password: `LoadTest@2026`
  - Phone: `+8801521434823`
  - Specialty: `General Medicine`
- [ ] Click "Create" or "Save"
- [ ] **Verify**: Success message shown
- [ ] **Record**: Clinician ID: `_____________` (if displayed)

**1.4 Verify Clinician Login**
- [ ] Open new incognito/private window (Window 2)
- [ ] Navigate to https://app.anot.health
- [ ] Login with clinician credentials:
  - Email: `load-test-doctor-july11@anot.health`
  - Password: `LoadTest@2026`
- [ ] **Verify**: Redirected to clinician portal/dashboard
- [ ] **Verify**: No errors displayed

### Phase 1 Checklist
- [ ] Admin login successful
- [ ] Clinician created successfully
- [ ] Clinician login verified
- [ ] Duration: `_____` minutes

✅ **Phase 1 Complete!** Record end time: `_____________`

---

## PHASE 2: CREATE 20 PATIENTS (10 minutes)

### Stay logged in as Clinician (Window 2)

### Patient Template
```
Name: Load Test Patient [1-20]
MRN: LT-2026-[001-020]
DOB: 1980-01-01
Gender: M (odd numbers) / F (even numbers)
Phone: +880152143[4801-4820]
Email: patient[1-20]@example.com
```

### Steps

**2.1 Navigate to Patient Management**
- [ ] In Clinician portal (Window 2)
- [ ] Click "Patients" in sidebar
- [ ] **Verify**: Patient list page loads

**2.2 Create Patients 1-20**

For each patient (repeat 20 times):

**Patient 1:**
- [ ] Click "Add Patient" or "New Patient"
- [ ] Fill in form:
  - Name: `Load Test Patient 1`
  - MRN: `LT-2026-001`
  - Date of Birth: `1980-01-01`
  - Gender: `F` (odd = F, even = M)
  - Phone: `+8801521434801`
  - Email: `patient1@example.com`
- [ ] Click "Save" or "Create"
- [ ] **Verify**: Success message
- [ ] **Record**: Patient ID: `_____`

**Patient 2:**
- [ ] Repeat with:
  - Name: `Load Test Patient 2`
  - MRN: `LT-2026-002`
  - Gender: `M`
  - Phone: `+8801521434802`
  - Email: `patient2@example.com`
- [ ] Patient ID: `_____`

**Patients 3-20:**
- [ ] Continue pattern...
- [ ] Track any failures or errors

### Quick Entry Tip
Open a text editor and prepare all 20 entries beforehand:
```
Load Test Patient 1, LT-2026-001, 1980-01-01, F, +8801521434801, patient1@example.com
Load Test Patient 2, LT-2026-002, 1980-01-01, M, +8801521434802, patient2@example.com
...
Load Test Patient 20, LT-2026-020, 1980-01-01, M, +8801521434820, patient20@example.com
```

### Phase 2 Checklist
- [ ] All 20 patients created
- [ ] Patients created: `_____` / 20
- [ ] Average time per patient: `_____` seconds
- [ ] Any failures: YES / NO
- [ ] If yes, list failed patients: `_____________`
- [ ] Duration: `_____` minutes

✅ **Phase 2 Complete!** Record end time: `_____________`

---

## PHASE 3: SCHEDULE 20 VISITS FOR TODAY (10 minutes)

### Stay logged in as Clinician (Window 2)

### Visit Schedule Template
```
Today's Date: 2026-07-11 (or current date)
Time slots: 
- Visit 1: 09:00
- Visit 2: 09:30
- Visit 3: 10:00
- Visit 4: 10:30
- ...
- Visit 20: 18:30
```

### Steps

**3.1 Navigate to Visit Scheduling**
- [ ] In Clinician portal (Window 2)
- [ ] Click "Visits" or "Schedule" in sidebar
- [ ] **Verify**: Visit list/calendar loads

**3.2 Create Visits 1-20**

For each visit (repeat 20 times):

**Visit 1:**
- [ ] Click "New Visit" or "Schedule Visit"
- [ ] Fill in form:
  - Patient: Select `Load Test Patient 1` (or MRN: LT-2026-001)
  - Date: `2026-07-11` (TODAY)
  - Time: `09:00`
  - Chief Complaint: `Load test visit #1`
  - Status: `Scheduled` or `Pending Audio`
- [ ] Click "Save" or "Schedule"
- [ ] **Verify**: Success message
- [ ] **Record**: Visit ID: `_____`

**Visit 2:**
- [ ] Repeat with:
  - Patient: `Load Test Patient 2`
  - Time: `09:30`
  - Chief Complaint: `Load test visit #2`
- [ ] Visit ID: `_____`

**Visits 3-20:**
- [ ] Continue pattern (increment time by 30 minutes each)
- [ ] Track any failures

### Time Slot Reference
```
Visit  1: 09:00    Visit 11: 14:00
Visit  2: 09:30    Visit 12: 14:30
Visit  3: 10:00    Visit 13: 15:00
Visit  4: 10:30    Visit 14: 15:30
Visit  5: 11:00    Visit 15: 16:00
Visit  6: 11:30    Visit 16: 16:30
Visit  7: 12:00    Visit 17: 17:00
Visit  8: 12:30    Visit 18: 17:30
Visit  9: 13:00    Visit 19: 18:00
Visit 10: 13:30    Visit 20: 18:30
```

### Phase 3 Checklist
- [ ] All 20 visits scheduled for TODAY
- [ ] Visits created: `_____` / 20
- [ ] Average time per visit: `_____` seconds
- [ ] Any failures: YES / NO
- [ ] Duration: `_____` minutes

**Record all Visit IDs**: `_____________________________________________`

✅ **Phase 3 Complete!** Record end time: `_____________`

---

## PHASE 4: UPLOAD 20-MINUTE AUDIO FOR EACH VISIT (15 minutes)

### Stay logged in as Clinician (Window 2)

### Audio File
- **Location**: `anot-backend-main/scripts/test-audio-20min.wav`
- **Size**: ~38 MB
- **Duration**: 20 minutes
- **Format**: WAV, 16kHz, mono

### Steps

**4.1 Locate Test Audio File**
- [ ] Open File Explorer
- [ ] Navigate to: `C:\Users\Administrator\Desktop\anot-health\anot-backend-main\scripts\`
- [ ] **Verify**: `test-audio-20min.wav` exists (38 MB)
- [ ] If not, generate it:
  ```powershell
  cd anot-backend-main
  node scripts/generate-test-audio.js 20
  ```

**4.2 Upload Audio for Each Visit**

For each of the 20 visits:

**Visit 1:**
- [ ] In Clinician portal, navigate to Visit 1
- [ ] Click on visit or edit visit
- [ ] Look for "Upload Audio" or "Add Recording" section
- [ ] Click "Choose File" or drag-and-drop
- [ ] Select `test-audio-20min.wav`
- [ ] Click "Upload" or "Submit"
- [ ] **Verify**: Upload progress bar completes
- [ ] **Verify**: Status changes to "Processing" or "Transcribing"
- [ ] **Record**: Upload time: `_____` seconds
- [ ] **Record**: Batch ID or Status: `_____________`

**Visit 2-20:**
- [ ] Repeat upload process
- [ ] Track upload times for each

### Upload Tracking Table
```
Visit | Upload Start | Upload End | Duration (s) | Status | Notes
------|--------------|------------|--------------|--------|-------
  1   |              |            |              |        |
  2   |              |            |              |        |
  3   |              |            |              |        |
 ...  |              |            |              |        |
 20   |              |            |              |        |
```

### Phase 4 Checklist
- [ ] All 20 audio files uploaded
- [ ] Uploads completed: `_____` / 20
- [ ] Total audio: 400 minutes (20 × 20 min)
- [ ] Average upload time: `_____` seconds per file
- [ ] Total upload time: `_____` minutes
- [ ] Any upload failures: YES / NO
- [ ] All showing "Processing" or "Transcribing" status
- [ ] Duration: `_____` minutes

✅ **Phase 4 Complete!** Record end time: `_____________`

**IMPORTANT**: All 20 visits should now be in "Batch Submitted" or "Transcribing" status.

---

## PHASE 5: WAIT FOR TRANSCRIPTION & NOTE GENERATION (15-20 minutes)

### What Happens in Phase 5

1. **Deepgram Batch Processing** (10-15 minutes):
   - 20 audio files (20 min each) submitted to Deepgram
   - Batch API processes them in parallel
   - Transcriptions returned as JSON

2. **Claude Note Generation** (automatic, <10 seconds per visit):
   - Once transcription completes, Claude Haiku generates professional notes
   - SOAP format applied
   - Notes stored in database

### Steps

**5.1 Monitor Transcription Progress**

Set up monitoring loop:
- [ ] Start timer: `_____________`
- [ ] Check every 30 seconds for 30 minutes max

**Check 1 (30 seconds):**
- [ ] In Clinician portal, refresh visit list
- [ ] Count visits with status "Transcribed" or "Notes Generated"
- [ ] Progress: `_____` / 20 transcribed
- [ ] Time elapsed: 30 seconds

**Check 2 (1 minute):**
- [ ] Refresh visit list
- [ ] Progress: `_____` / 20 transcribed
- [ ] Time elapsed: 1 minute

**Continue checking every 30 seconds...**

### Expected Timeline
```
Time    | Expected Progress
--------|------------------
5 min   | 5-8 visits transcribed
10 min  | 12-15 visits transcribed
15 min  | 18-20 visits transcribed
20 min  | All 20 should be done
```

**5.2 Verify Note Generation**

Once all 20 transcribed:
- [ ] Click into each visit
- [ ] **Verify**: Transcript is present (not blank)
- [ ] **Verify**: Note exists in SOAP format:
  - **S**ubjective section
  - **O**bjective section
  - **A**ssessment section
  - **P**lan section
- [ ] **Verify**: No error messages

**Sample Check** (check 3 random visits):
- [ ] Visit `_____`: Transcript ✓, Note ✓
- [ ] Visit `_____`: Transcript ✓, Note ✓
- [ ] Visit `_____`: Transcript ✓, Note ✓

### Transcription Progress Tracking
```
Check | Time | Transcribed Count | Notes Generated | Notes
------|------|-------------------|-----------------|-------
  1   | 0:30 |                   |                 |
  2   | 1:00 |                   |                 |
  3   | 1:30 |                   |                 |
 ...  | ...  |                   |                 |
```

### Phase 5 Checklist
- [ ] All 20 visits transcribed
- [ ] All 20 notes generated
- [ ] Transcriptions completed: `_____` / 20
- [ ] Average transcription time: `_____` seconds per visit
- [ ] Total wait time: `_____` minutes
- [ ] Note quality check passed (SOAP format)
- [ ] Any transcription errors: YES / NO
- [ ] Duration: `_____` minutes

✅ **Phase 5 Complete!** Record end time: `_____________`

---

## PHASE 6: SCRIBE REVIEWS & UPLOADS (30 minutes)

### Switch to Scribe Role

**6.1 Scribe Login**
- [ ] Open Window 3 (new incognito/private window)
- [ ] Navigate to https://app.anot.health
- [ ] Login with scribe credentials:
  - Email: `shahib@anot.health`
  - Password: `#1Knowtex2026`
- [ ] **Verify**: Redirected to scribe portal/dashboard

**6.2 Navigate to Assigned Visits**
- [ ] Click "Assigned Visits" or "Pending Reviews" in sidebar
- [ ] **Verify**: See list of visits (should include the 20 test visits)
- [ ] **Verify**: Visits show status "Pending Scribe Review" or similar

### Review Process for Each Visit

**For each of 20 visits (1.5 minutes each):**

**Visit 1:**
- [ ] Click on visit to open
- [ ] Review sections:
  - [ ] Patient demographics
  - [ ] Chief complaint
  - [ ] Transcript (skim for quality)
  - [ ] Generated note (check SOAP format)
- [ ] Check for obvious errors:
  - [ ] Medical terminology correct
  - [ ] No garbled text
  - [ ] Chief complaint matches note
- [ ] Add any scribe comments (optional): `_____________`
- [ ] Click "Review Complete" or "Upload to EMR"
- [ ] **Verify**: Status changes to "Submitted" or "Under QPS Review"
- [ ] **Record**: Review time: `_____` seconds

**Visits 2-20:**
- [ ] Repeat review process
- [ ] Track any quality issues

### Scribe Review Tracking
```
Visit | Review Start | Review End | Duration (s) | Quality | Issues | Status
------|--------------|------------|--------------|---------|--------|--------
  1   |              |            |              |  Good   |  None  | ✓
  2   |              |            |              |         |        |
 ...  |              |            |              |         |        |
 20   |              |            |              |         |        |
```

### Quality Check Criteria
- [ ] Transcript is readable and makes sense
- [ ] Medical terminology is spelled correctly
- [ ] SOAP note is comprehensive and professional
- [ ] Chief complaint is accurately captured
- [ ] No obvious errors or omissions

### Phase 6 Checklist
- [ ] All 20 visits reviewed
- [ ] Reviews completed: `_____` / 20
- [ ] Average review time: `_____` seconds per visit (~90s target)
- [ ] Total review time: `_____` minutes (~30 min target)
- [ ] Quality assessment: EXCELLENT / GOOD / FAIR / POOR
- [ ] Any quality issues: YES / NO
- [ ] If yes, list issues: `_____________`
- [ ] All visits submitted to QPS
- [ ] Duration: `_____` minutes

✅ **Phase 6 Complete!** Record end time: `_____________`

---

## PHASE 7: QPS GRADES NOTES (20 minutes)

### Switch to QPS Role

**7.1 QPS Login**
- [ ] Open Window 4 (new incognito/private window)
- [ ] Navigate to https://app.anot.health
- [ ] Login with QPS credentials:
  - Email: `farhan@anot.health`
  - Password: `#1Knowtex2026`
- [ ] **Verify**: Redirected to QPS portal/dashboard

**7.2 Navigate to Pending Grades**
- [ ] Click "Pending Grades" or "Review Queue" in sidebar
- [ ] **Verify**: See list of visits pending QPS review
- [ ] **Verify**: 20 test visits are listed

### Grading Process for Each Visit

**For each of 20 visits (1 minute each):**

**Visit 1:**
- [ ] Click on visit to open
- [ ] Review all components:
  - [ ] Transcript quality
  - [ ] SOAP note completeness
  - [ ] Scribe comments (if any)
  - [ ] Professional language
  - [ ] Medical accuracy
- [ ] Assign grade: `_____` / 100 (recommend 85-95 for good quality)
- [ ] Grade rationale:
  - 90-95: Excellent, professional, no issues
  - 85-89: Good quality, minor areas for improvement
  - 80-84: Acceptable, some improvements needed
  - <80: Needs significant improvement
- [ ] Add QPS comments: `Professional documentation - load test verified`
- [ ] Click "Submit Grade"
- [ ] **Verify**: Status changes to "Graded"
- [ ] **Record**: Grade: `_____`, Time: `_____` seconds

**Visits 2-20:**
- [ ] Repeat grading process
- [ ] Assign grades 85-95 (vary slightly for realism)
- [ ] Track grades

### QPS Grading Tracking
```
Visit | Grade | Comments | Time (s) | Status
------|-------|----------|----------|--------
  1   |  90   | Professional doc | 60 | ✓
  2   |  88   | Professional doc | 55 | ✓
  3   |  92   | Excellent | 58 | ✓
 ...  |       |          |      |
 20   |       |          |      |
```

### Suggested Grades (for realism)
```
Visits 1-5:   88, 90, 87, 92, 89
Visits 6-10:  91, 86, 93, 88, 90
Visits 11-15: 89, 94, 87, 91, 88
Visits 16-20: 90, 85, 92, 89, 91
```

### Phase 7 Checklist
- [ ] All 20 visits graded
- [ ] Grades submitted: `_____` / 20
- [ ] Average grade: `_____` / 100
- [ ] Grade range: `_____` to `_____`
- [ ] Average grading time: `_____` seconds per visit (~60s target)
- [ ] Total grading time: `_____` minutes (~20 min target)
- [ ] All visits now have QPS approval
- [ ] Duration: `_____` minutes

✅ **Phase 7 Complete!** Record end time: `_____________`

---

## PHASE 8: CLINICIAN LOCKS NOTES (10 minutes)

### Switch Back to Clinician Role

**8.1 Clinician Re-Login** (if needed)
- [ ] Return to Window 2 (Clinician portal)
- [ ] If logged out, re-login:
  - Email: `load-test-doctor-july11@anot.health`
  - Password: `LoadTest@2026`
- [ ] **Verify**: In clinician portal

**8.2 Navigate to Pending Locks**
- [ ] Click "My Visits" or "Pending Locks" in sidebar
- [ ] **Verify**: See 20 visits pending clinician lock/approval
- [ ] **Verify**: All show "Graded" or "Ready to Lock" status

### Lock Process for Each Visit

**For each of 20 visits (30 seconds each):**

**Visit 1:**
- [ ] Click on visit to open
- [ ] Final review:
  - [ ] Patient information correct
  - [ ] Transcript readable
  - [ ] SOAP note accurate and comprehensive
  - [ ] Scribe comments reviewed
  - [ ] QPS grade noted: `_____` / 100
- [ ] **Verify**: All information is correct and final
- [ ] Click "Approve & Lock" or "Lock Note"
- [ ] **Confirm**: Lock action (cannot be undone)
- [ ] **Verify**: Status changes to "Locked"
- [ ] **Verify**: Note is now read-only
- [ ] **Verify**: Timestamp recorded
- [ ] **Record**: Lock time: `_____` seconds

**Visits 2-20:**
- [ ] Repeat lock process
- [ ] Track times

### Clinician Lock Tracking
```
Visit | Lock Time | Status | Notes
------|-----------|--------|-------
  1   | 28s       | ✓      | Locked
  2   | 32s       | ✓      | Locked
  3   | 25s       | ✓      | Locked
 ...  |           |        |
 20   |           | ✓      | Locked
```

### Phase 8 Checklist
- [ ] All 20 notes locked
- [ ] Locks completed: `_____` / 20
- [ ] Average lock time: `_____` seconds per visit (~30s target)
- [ ] Total lock time: `_____` minutes (~10 min target)
- [ ] All visits now "Locked" status
- [ ] All notes are read-only
- [ ] Timestamps recorded for all
- [ ] Complete workflow verified
- [ ] Duration: `_____` minutes

✅ **Phase 8 Complete!** Record end time: `_____________`

🎉 **ALL 8 WORKFLOW PHASES COMPLETE!** 🎉

---

## PHASE 9: PERFORMANCE ANALYSIS & REPORTING (10 minutes)

### 9.1 Calculate Workflow Metrics

**Timeline Metrics:**
- [ ] Total test start time: `_____________`
- [ ] Total test end time: `_____________`
- [ ] Total duration: `_____` hours `_____` minutes

**Phase Durations:**
```
Phase 1 (Clinician creation): _____ minutes
Phase 2 (20 patients):        _____ minutes
Phase 3 (20 visits):          _____ minutes
Phase 4 (Audio upload):       _____ minutes
Phase 5 (Transcription):      _____ minutes
Phase 6 (Scribe review):      _____ minutes
Phase 7 (QPS grading):        _____ minutes
Phase 8 (Clinician lock):     _____ minutes
─────────────────────────────────────────
Total:                        _____ minutes
```

**Throughput Metrics:**
- [ ] Visits processed: 20
- [ ] Total audio: 400 minutes (20 × 20 min)
- [ ] Visits per hour: `_____` (20 / total_hours)
- [ ] Audio minutes per hour: `_____` (400 / total_hours)

### 9.2 Quality Metrics

**Transcription Quality:**
- [ ] Sample check 3 random visits
- [ ] Visit `_____`: Accuracy: EXCELLENT / GOOD / FAIR / POOR
- [ ] Visit `_____`: Accuracy: EXCELLENT / GOOD / FAIR / POOR
- [ ] Visit `_____`: Accuracy: EXCELLENT / GOOD / FAIR / POOR
- [ ] Overall transcription quality: `_____________`

**Note Generation Quality:**
- [ ] SOAP format compliance: `_____` / 20 (should be 20/20)
- [ ] Chief complaints captured: `_____` / 20
- [ ] Professional language: YES / NO
- [ ] Medical terminology correct: YES / NO
- [ ] Overall note quality: `_____________`

**QPS Grades Summary:**
- [ ] Average grade: `_____` / 100
- [ ] Highest grade: `_____` / 100
- [ ] Lowest grade: `_____` / 100
- [ ] Grade standard deviation: `_____`

### 9.3 Error & Issue Tracking

**Errors Encountered:**
- [ ] Phase 1 errors: `_____` count, details: `_____________`
- [ ] Phase 2 errors: `_____` count, details: `_____________`
- [ ] Phase 3 errors: `_____` count, details: `_____________`
- [ ] Phase 4 errors: `_____` count, details: `_____________`
- [ ] Phase 5 errors: `_____` count, details: `_____________`
- [ ] Phase 6 errors: `_____` count, details: `_____________`
- [ ] Phase 7 errors: `_____` count, details: `_____________`
- [ ] Phase 8 errors: `_____` count, details: `_____________`
- [ ] **Total errors**: `_____`

**Warnings Encountered:**
- [ ] List all warnings: `_____________`

### 9.4 Cost Analysis

**Actual Costs:**
```
Deepgram Batch (400 min @ $0.00075/min):
  = 400 × $0.00075 = $0.30

Claude Haiku (~2,000 tokens @ $0.80/1M):
  = 2,000 × ($0.80 / 1,000,000) = $0.0016

Infrastructure (_____ hours @ $0.315/hour):
  = _____ × $0.315 = $_____

─────────────────────────────────────────
Total Cost: $_____
```

**Revenue Model:**
```
Platform revenue per doctor: $1,000/month
Visits per doctor per month: ~1,500
Revenue per visit: $1,000 / 1,500 = $0.67

Test revenue (20 visits):
  = 20 × $0.67 = $13.40
```

**Profitability:**
```
Profit: $13.40 - $_____ (cost) = $_____
Profit margin: (Profit / Revenue) × 100 = _____%
```

### 9.5 System Health Check

**During Test:**
- [ ] Backend API: UP / DOWN
- [ ] Frontend app: UP / DOWN
- [ ] Database: HEALTHY / ISSUES
- [ ] Deepgram API: WORKING / ISSUES
- [ ] Claude API: WORKING / ISSUES
- [ ] Any downtime: YES / NO (duration: `_____`)

**Performance:**
- [ ] API response times: FAST (<500ms) / SLOW (>500ms)
- [ ] Page load times: FAST (<2s) / SLOW (>2s)
- [ ] Database queries: FAST / SLOW
- [ ] Any timeouts: YES / NO

### 9.6 Generate Final Report

Use the data collected above to fill in the comprehensive report template below.

---

## COMPREHENSIVE LOAD TEST REPORT

**Test Date**: July 11, 2026  
**Test Type**: Full E2E Workflow (20 Visits, 20-minute Audio Each)  
**Test Executor**: [YOUR NAME]  
**Test Start**: [START TIME]  
**Test End**: [END TIME]  
**Total Duration**: [DURATION]

---

### EXECUTIVE SUMMARY

Test Status: ✅ **COMPLETE & SUCCESSFUL** / ⚠️ **COMPLETE WITH ISSUES** / ❌ **FAILED**

**20 complete end-to-end workflows processed:**
- ✅/❌ Clinician created & verified
- ✅/❌ 20 patients created
- ✅/❌ 20 visits scheduled
- ✅/❌ 400 minutes of audio uploaded
- ✅/❌ 20 transcriptions completed
- ✅/❌ 20 professional notes generated
- ✅/❌ All 4 user roles (clinician, scribe, QPS, admin) functioned
- ✅/❌ System remained stable throughout

---

### PHASE RESULTS

| Phase | Task | Status | Duration | Success Rate |
|-------|------|--------|----------|--------------|
| 1 | Clinician creation | PASS/FAIL | _____ min | _____% |
| 2 | 20 patients | PASS/FAIL | _____ min | _____/20 |
| 3 | 20 visits | PASS/FAIL | _____ min | _____/20 |
| 4 | Audio upload | PASS/FAIL | _____ min | _____/20 |
| 5 | Transcription | PASS/FAIL | _____ min | _____/20 |
| 6 | Scribe review | PASS/FAIL | _____ min | _____/20 |
| 7 | QPS grading | PASS/FAIL | _____ min | _____/20 |
| 8 | Clinician lock | PASS/FAIL | _____ min | _____/20 |

---

### PERFORMANCE METRICS

**Throughput:**
- Total visits: 20
- Total audio: 400 minutes
- Total workflow time: _____ hours _____ minutes
- Visits per hour: _____
- Audio minutes per hour: _____

**API Performance:**
- Average API response time: _____ ms
- Page load times: _____ seconds
- Database query performance: GOOD / ACCEPTABLE / POOR
- Error rate: _____%
- Timeout rate: _____%

**Deepgram Batch Processing:**
- Total audio submitted: 400 minutes
- Processing time: _____ minutes
- Batch efficiency: EXCELLENT / GOOD / FAIR / POOR
- Transcription quality: PROFESSIONAL / ACCEPTABLE / POOR

**Claude Haiku Note Generation:**
- Notes generated: _____/20
- Average generation time: _____ seconds
- Note quality: PROFESSIONAL / ACCEPTABLE / POOR
- SOAP compliance: _____%
- Error rate: _____%

---

### COST ANALYSIS & PROFITABILITY

**Actual Costs Incurred:**
```
Deepgram Batch (400 min):        $_____
Claude Haiku (~2000 tokens):     $_____
Infrastructure (_____ hours):    $_____
─────────────────────────────────────────
Total Cost:                      $_____
```

**Revenue:**
```
20 visits × $0.67/visit:         $13.40
```

**Profitability:**
```
Profit: $13.40 - $_____ = $_____
Profit margin: _____%
Cost per visit: $_____
Revenue per visit: $0.67
Profit per visit: $_____
```

**Scalability Projection:**
```
For 1 doctor (50 visits/day × 30 days = 1,500 visits/month):
  Monthly revenue: $1,000
  Monthly cost: $_____ (estimated)
  Monthly profit: $_____ (estimated)
  
For 50 doctors (75,000 visits/month):
  Monthly revenue: $50,000
  Monthly cost: $_____ (estimated)
  Monthly profit: $_____ (estimated)
  Profit margin: _____%
```

---

### QUALITY METRICS

**Transcription Quality:**
- Accuracy: EXCELLENT / GOOD / FAIR / POOR
- Sample verification (3 visits): All passed / Some failed
- Medical terminology: CORRECT / ISSUES FOUND

**Note Generation Quality:**
- SOAP format compliance: _____%
- Chief complaint captured: _____%
- Professional language: YES / NO
- Medical accuracy: VERIFIED / NOT VERIFIED
- Sample quality assessment: EXCELLENT / GOOD / FAIR / POOR

**Workflow Completeness:**
- All phases executed: ✅ YES / ❌ NO
- All data preserved: ✅ YES / ❌ NO
- Data integrity verified: ✅ YES / ❌ NO
- Audit trail recorded: ✅ YES / ❌ NO

---

### ERRORS & WARNINGS

**Errors Encountered:**
```
Total errors: _____

Phase 1: _____ errors
- [List any errors]

Phase 2: _____ errors
- [List any errors]

[Continue for all phases...]
```

**Warnings:**
```
Total warnings: _____

[List all warnings encountered]
```

**Resolutions:**
```
[How were errors/warnings resolved?]
```

---

### SYSTEM HEALTH

**Infrastructure:**
- EB Status: GREEN / YELLOW / RED
- CPU usage: Peak _____%
- Memory usage: Peak _____%
- Disk space: ADEQUATE / LOW
- Network: NORMAL / ISSUES

**Database:**
- RDS Status: AVAILABLE / ISSUES
- Connections: Peak _____ / 50
- Query performance: < _____ ms (P99)
- No errors: ✅ YES / ❌ NO

**Application:**
- Uptime: _____%
- Error rate: _____%
- Timeout rate: _____%
- Health check: ✅ PASS / ❌ FAIL

---

### SATURDAY LAUNCH READINESS

**Status**: ✅ **READY FOR LAUNCH** / ⚠️ **READY WITH CAVEATS** / ❌ **NOT READY**

**System Proven:**
- ✅/❌ Can handle multiple concurrent workflows
- ✅/❌ Deepgram batch processing reliable
- ✅/❌ Claude note generation professional quality
- ✅/❌ All user roles function correctly
- ✅/❌ Platform remains stable under load
- ✅/❌ High profit margin achieved (>90%)
- ✅/❌ Cost model validated
- ✅/❌ Security verified
- ✅/❌ Data integrity verified
- ✅/❌ Error rate acceptable (<1%)

**Confidence Level**: HIGH (>95%) / MEDIUM (80-95%) / LOW (<80%)

**Recommendation**: 
- ✅ **PROCEED WITH SATURDAY LAUNCH**
- ⚠️ **PROCEED WITH CAUTION** (list concerns)
- ❌ **DELAY LAUNCH** (list blockers)

**Action Items Before Launch:**
1. [List any remaining tasks]
2. [...]

---

### NOTES & OBSERVATIONS

**What Went Well:**
- [List positive observations]

**Challenges Encountered:**
- [List challenges]

**Areas for Improvement:**
- [List improvement suggestions]

**Recommendations:**
- [List recommendations for production deployment]

---

**Report Generated**: [DATE TIME]  
**Report Author**: [YOUR NAME]  
**Next Steps**: [LAUNCH / FIX ISSUES / RETEST]

---

## APPENDIX: DETAILED TEST DATA

### Patient List
```
1.  Load Test Patient 1  | LT-2026-001 | ID: _____
2.  Load Test Patient 2  | LT-2026-002 | ID: _____
...
20. Load Test Patient 20 | LT-2026-020 | ID: _____
```

### Visit List
```
1.  Visit #1  | 09:00 | Patient 1 | ID: _____ | Status: _____
2.  Visit #2  | 09:30 | Patient 2 | ID: _____ | Status: _____
...
20. Visit #20 | 18:30 | Patient 20 | ID: _____ | Status: _____
```

### QPS Grades
```
Visit  1: _____ / 100
Visit  2: _____ / 100
...
Visit 20: _____ / 100

Average: _____ / 100
```

---

**END OF LOAD TEST REPORT**

---

## TROUBLESHOOTING GUIDE

### Common Issues and Solutions

**Issue: Admin login fails**
- Solution: Verify credentials are correct
- Solution: Check EB environment is GREEN
- Solution: Clear browser cache and retry

**Issue: Patient creation fails**
- Solution: Check for duplicate MRNs
- Solution: Verify all required fields are filled
- Solution: Check database connectivity

**Issue: Audio upload fails or times out**
- Solution: Check file size is correct (~38 MB)
- Solution: Verify file format is WAV
- Solution: Check network stability
- Solution: Try uploading again (may need to increase timeout)

**Issue: Transcription takes too long (>30 minutes)**
- Solution: Check Deepgram API status
- Solution: Verify batch submission was successful
- Solution: Check CloudWatch logs for errors
- Solution: Contact Deepgram support if persistent

**Issue: Notes not generated after transcription**
- Solution: Check Claude API status
- Solution: Verify transcription completed successfully
- Solution: Check CloudWatch logs for AI pipeline errors
- Solution: Manually trigger note generation if available

**Issue: Scribe portal doesn't show assigned visits**
- Solution: Verify visits are in correct status
- Solution: Check assignment logic in database
- Solution: Refresh portal or re-login

**Issue: Unable to lock note as clinician**
- Solution: Verify QPS has graded the visit
- Solution: Check note is in "Ready to Lock" status
- Solution: Verify clinician permissions

---

## QUICK COMMANDS

### Generate Test Audio
```powershell
cd anot-backend-main
node scripts/generate-test-audio.js 20
```

### Check EB Health
```powershell
# Open in browser:
https://anot-backend-prod.eba-m2bjp2gp.ap-southeast-1.elasticbeanstalk.com/api/health
```

### Monitor CloudWatch Logs (AWS Console)
```
1. Go to CloudWatch console
2. Navigate to Log Groups
3. Select /aws/elasticbeanstalk/anot-backend-prod
4. Filter by timestamp during test
5. Search for errors or timeouts
```

---

## TEST CHECKLIST SUMMARY

**Before Starting:**
- [ ] Backend EB environment is GREEN
- [ ] Test audio file generated (38 MB WAV)
- [ ] 4 browser windows prepared
- [ ] Time tracking spreadsheet ready
- [ ] Admin credentials verified

**During Testing:**
- [ ] Record timestamps for each phase
- [ ] Track any errors or warnings immediately
- [ ] Monitor system performance
- [ ] Take screenshots of any issues
- [ ] Document workarounds used

**After Completion:**
- [ ] Fill in complete report template
- [ ] Calculate all metrics
- [ ] Document lessons learned
- [ ] Provide launch readiness assessment
- [ ] Share report with team

---

## CONTACT & ESCALATION

**If Issues Arise:**

1. **Minor Issues** (patient creation failed, etc.):
   - Document in report
   - Retry operation
   - Continue test

2. **Major Issues** (backend down, API not responding):
   - Stop test immediately
   - Document current state
   - Check EB health dashboard
   - Escalate to DevOps/Admin

3. **Blocking Issues** (cannot proceed with test):
   - Document blocker
   - Assess criticality
   - Determine if launch should be delayed

**Emergency Contacts:**
- DevOps: [CONTACT INFO]
- Admin: atiqurrahmanaline@gmail.com
- Technical Support: [CONTACT INFO]

---

**Good luck with your load test!** 🚀

*Remember: This test validates that your platform is ready for production launch. Take your time, document everything, and ensure all phases complete successfully.*
