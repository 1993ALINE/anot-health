# Quick Reference: final-comprehensive-platform-audit.ps1

## ✅ STATUS: ALL SYNTAX ERRORS FIXED - READY TO USE

## Quick Start

### 1. Dry Run (Safe - No Execution)
```powershell
powershell -ExecutionPolicy Bypass -File scripts/final-comprehensive-platform-audit.ps1 -DryRun
```
**What it does:** Shows what tests would be run, generates empty reports  
**Time:** < 10 seconds  
**Use when:** You want to see the test plan without actually running tests

### 2. Live Testing (Requires Services Running)
```powershell
powershell -ExecutionPolicy Bypass -File scripts/final-comprehensive-platform-audit.ps1 -Live
```
**What it does:** Executes ALL role-based tests against running system  
**Time:** ~6 hours for complete audit  
**Use when:** Services are running and you want comprehensive testing

## Common Use Cases

### Test Specific Issues

#### Scribe Tooltip/UI Issues
```powershell
powershell -ExecutionPolicy Bypass -File scripts/final-comprehensive-platform-audit.ps1 -Live -RoleOnly Scribe -FocusOnTooltipIssues -FocusOnPortalUI -VerboseOutput
```
**Focus:** Scribe UI, tooltips, portal layout  
**Time:** ~90 minutes  

#### HIPAA Compliance Only
```powershell
powershell -ExecutionPolicy Bypass -File scripts/final-comprehensive-platform-audit.ps1 -Live -RoleOnly HIPAA
```
**Focus:** Compliance, audit logs, encryption, access controls  
**Time:** ~30 minutes

#### Clinician Audio Stress Test
```powershell
powershell -ExecutionPolicy Bypass -File scripts/final-comprehensive-platform-audit.ps1 -Live -RoleOnly Clinician -IncludeLargeAudioTesting
```
**Focus:** Audio upload, transcription, large files (1+ hour)  
**Time:** ~120 minutes (includes large file testing)

## Parameters Reference

| Parameter | Type | Description |
|-----------|------|-------------|
| `-DryRun` | Switch | Show test plan without execution |
| `-Live` | Switch | Execute actual tests (default if none specified) |
| `-AllRoles` | Switch | Test all 5 roles (default) |
| `-RoleOnly <Role>` | String | Test single role: HIPAA, Clinician, Scribe, Admin, QPS |
| `-VerboseOutput` | Switch | Show detailed progress messages |
| `-CaptureScreenshots` | Switch | Capture screenshots of issues (requires Selenium) |
| `-FocusOnTooltipIssues` | Switch | Extra attention to tooltip problems |
| `-FocusOnPortalUI` | Switch | Extra attention to portal UI issues |
| `-IncludeLargeAudioTesting` | Switch | Test 1+ hour audio files (slow) |

## The 5 Testing Roles

1. **HIPAA Auditor** (30 min)
   - Access logging with timestamp/user/action
   - PII/PHI not in plain text
   - Encryption at rest (database, S3)
   - TLS 1.3 in transit
   - Audit log immutability
   - No credentials in logs
   - Data retention policies
   - Access controls per role
   - 30+ compliance checks

2. **Clinician** (90 min)
   - Login & access control
   - Small audio (5 min) - upload & transcription
   - Medium audio (30 min) - upload & transcription
   - Large audio (1+ hr) - stress test (optional)
   - Patient records list & filtering
   - Record editing & annotations
   - Approval workflows
   - Data export (PDF, EHR)
   - Error scenarios
   - Security verification

3. **Scribe** (90 min)
   - Task queue access
   - Audio playback
   - **Tooltip testing** - truncation, positioning, visibility
   - **Portal UI testing** - alignment, spacing, modals, responsive
   - Note editing (undo/redo)
   - Formatting & validation
   - Submission workflow
   - Performance testing

4. **Admin** (60 min)
   - User management (list, create, edit, disable)
   - Settings configuration
   - Reports & analytics
   - Audit log access
   - Backup verification

5. **QPS** (60 min)
   - Quality dashboard
   - Record review & scoring
   - Quality metrics
   - Feedback workflows

## Output Reports

All reports saved to: `anot-backend-main/anot-backend-main/dist/`

### 1. audit-results.json
```json
{
  "auditInfo": { ... },
  "summary": {
    "totalIssues": 0,
    "critical": 0,
    "platformHealthScore": 100,
    "recommendation": "GO - Ready for launch"
  },
  "issues": [ ... ]
}
```

### 2. comprehensive-audit-report.html
Beautiful web-based report with:
- Platform health score (0-100)
- Issues by severity/role/category
- Detailed reproduction steps
- Suggested fixes
- Visual badges and styling

### 3. issues-checklist.txt
Printable checklist with:
```
[ISSUE-0001] [CRITICAL] Role - Issue Name
   Description
   Status: [ ] Pending  [ ] Fixed  [ ] Won't Fix
   Assigned to: _______________
```

## Exit Codes

- `0` = Success or dry-run
- `1` = High severity issues (review recommended)
- `2` = Critical issues (no-go for launch)

## Platform Health Scoring

**Score = 100 - penalties**
- Each CRITICAL issue: -20 points
- Each HIGH issue: -10 points
- Each MEDIUM issue: -5 points
- Each LOW issue: -2 points

**Recommendations:**
- Score 80-100: "GO - Ready for launch"
- Score 60-79: "CONDITIONAL - Address high severity"
- Score 0-59: "NO-GO - Critical issues must be fixed"

## Prerequisites for Live Testing

✅ Backend running: `http://localhost:5000`  
✅ Frontend running: `http://localhost:3000`  
✅ Test users created (see script for default emails)  
✅ Test data in database  
⚠️ Selenium (optional, for screenshots)

## What Was Fixed

1. ✅ Line 220: Variable reference syntax (`$issue.Property`)
2. ✅ Line 1164: Missing `=` in hash table (`rolesTested =`)
3. ✅ Lines 1200+: UTF8Encoding syntax (PowerShell 5.1 compatible)
4. ✅ Parameter conflict: Renamed `$Verbose` to `$VerboseOutput`
5. ✅ All braces balanced and validated

## Troubleshooting

**"Services not available"**
→ Start backend: `node src/server.js` in anot-backend-main  
→ Start frontend: `npm run dev` in anot-frontend-main

**"Login failed"**
→ Update test user credentials in script `$TestUsers` hashtable  
→ Create test accounts in database

**"Parameter not found"**
→ Use `-VerboseOutput` not `-Verbose` (renamed to avoid conflict)

**Script won't run**
→ Add `-ExecutionPolicy Bypass` to PowerShell command

---

**Last Updated:** 2026-06-23  
**Status:** ✅ FULLY FUNCTIONAL - READY FOR PRODUCTION USE
