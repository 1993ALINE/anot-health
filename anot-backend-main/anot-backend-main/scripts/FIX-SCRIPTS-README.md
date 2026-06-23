# AUDIT FIX SCRIPTS - QUICK REFERENCE

**Generated:** 2026-06-23  
**Total Issues:** 47 (8 Critical, 14 High, 18 Medium, 7 Low)

## Quick Start

```powershell
# Navigate to scripts directory
cd anot-backend-main/anot-backend-main/scripts

# Dry run all critical fixes
powershell -File run-all-fixes.ps1 -Phase Critical -DryRun

# Run all critical fixes
powershell -File run-all-fixes.ps1 -Phase Critical -Force

# Run a specific fix
powershell -File fix-ISSUE-001.ps1
```

## Fix Scripts by Priority

### 🔴 CRITICAL (Must fix before launch)

| Issue | Script | Description | Effort | Auto-Fix |
|-------|--------|-------------|--------|----------|
| ISSUE-001 | `fix-ISSUE-001.ps1` | xlsx NPM Vulnerability | 1-2h | ✓ |
| ISSUE-002 | `fix-ISSUE-002.ps1` | Missing Error Boundaries | 4h | Manual |
| ISSUE-003 | `fix-ISSUE-003.ps1` | File Upload Validation | 2-3h | Manual |
| ISSUE-004 | `fix-ISSUE-004.ps1` | DB Connection Recovery | 4-6h | Manual |
| ISSUE-005 | `fix-ISSUE-005.ps1` | Hardcoded CORS URLs | 30m | ✓ |
| ISSUE-006 | `fix-ISSUE-006.ps1` | Audio Memory Leak | 1-2d | Manual |
| ISSUE-007 | `fix-ISSUE-007.ps1` | Password Reset Rate Limit | 1h | Manual |
| ISSUE-008 | `fix-ISSUE-008.ps1` | CloudWatch Logging | 2h | Manual |

### 🟠 HIGH PRIORITY (Should fix before launch)

| Issue | Script | Description | Effort | Auto-Fix |
|-------|--------|-------------|--------|----------|
| ISSUE-009 | `fix-ISSUE-009.ps1` | Console Logs Expose PHI | 1d | Manual |
| ISSUE-010 | `fix-ISSUE-010.ps1` | Session Timeout Not Enforced | 2h | Manual |
| ISSUE-011 | `fix-ISSUE-011.ps1` | Missing Transactions | 4-6h | Manual |
| ISSUE-012 | `fix-ISSUE-012.ps1` | Tooltip Issues | 3-4h | Manual |
| ISSUE-013 | `fix-ISSUE-013.ps1` | No Pagination | 1d | Manual |
| ISSUE-014 | `fix-ISSUE-014.ps1` | Large File Timeouts | 1-2d | See 006 |
| ISSUE-015 | `fix-ISSUE-015.ps1` | Missing Input Sanitization | 2d | Manual |
| ISSUE-016 | `fix-ISSUE-016.ps1` | Concurrent Request Limits | 4-6h | See 007 |
| ISSUE-017 | `fix-ISSUE-017.ps1` | Database Performance | 4h | ✓ |
| ISSUE-018 | `fix-ISSUE-018.ps1` | Error Messages Leak Details | 3-4h | Manual |
| ISSUE-020 | `fix-ISSUE-020.ps1` | Password Policy Enforcement | 2h | Manual |
| ISSUE-021 | `fix-ISSUE-021.ps1` | Missing CSRF Protection | 1d | Manual |
| ISSUE-022 | `fix-ISSUE-022.ps1` | Audit Log Retention | 1-2d | Manual |

### 🟡 MEDIUM PRIORITY (Post-launch improvements)
Issues 023-040: TypeScript, Testing, Caching, API Docs, Monitoring, etc.  
*Create individual fix scripts as needed*

### 🟢 LOW PRIORITY (Polish items)
Issues 041-047: Date formatting, Favicon, Dark mode, Keyboard shortcuts, etc.  
*Address during regular maintenance cycles*

## Master Fix Script

**File:** `run-all-fixes.ps1`

### Usage

```powershell
# Run all critical fixes (dry run)
powershell -File run-all-fixes.ps1 -Phase Critical -DryRun

# Run all critical fixes (actual execution)
powershell -File run-all-fixes.ps1 -Phase Critical -Force

# Run all high priority fixes
powershell -File run-all-fixes.ps1 -Phase High -Force

# Run everything (not recommended - do phases)
powershell -File run-all-fixes.ps1 -Phase All -Force

# Continue even if a fix fails
powershell -File run-all-fixes.ps1 -Phase Critical -Force -ContinueOnError

# Generate JSON report
powershell -File run-all-fixes.ps1 -Phase Critical -Force -GenerateReport
```

### Parameters

- `-Phase` : Which phase to run (Critical, High, Medium, Low, All)
- `-DryRun` : Show what would be fixed without making changes
- `-Force` : Skip all confirmations
- `-ContinueOnError` : Continue even if a fix fails
- `-GenerateReport` : Save execution report to JSON file

## Fix Script Pattern

Each fix script follows this pattern:

1. **Phase 1: Pre-flight checks** - Verify files and dependencies exist
2. **Phase 2: Identify problem** - Analyze current state
3. **Phase 3: Apply fix** - Make changes (or show dry-run)
4. **Phase 4: Verify fix** - Confirm changes applied correctly
5. **Phase 5: Test** - Provide testing instructions

## Dependencies

Some fixes require additional dependencies:

```powershell
# ISSUE-006: Bull job queue
npm install bull redis

# ISSUE-009: Winston logger
npm install winston

# ISSUE-007: Rate limiting
npm install express-rate-limit rate-limit-redis

# ISSUE-008: AWS SDK (if not installed)
npm install aws-sdk
```

## Environment Variables

Required environment variables for fixes:

```bash
# Database (ISSUE-004)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=anot_health
DB_USER=postgres
DB_PASSWORD=secret

# Redis (ISSUE-006, ISSUE-007)
REDIS_URL=redis://localhost:6379

# AWS (ISSUE-008, ISSUE-022)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx
CLOUDWATCH_LOG_GROUP=/aws/anot-health/application

# CORS (ISSUE-005)
CORS_ORIGINS=https://yourdomain.com,https://app.yourdomain.com
FRONTEND_URL=https://app.yourdomain.com

# Audit Archive (ISSUE-022)
AUDIT_ARCHIVE_BUCKET=anot-health-audit-logs
```

## Recommended Fix Order

1. **Day 1-2: Critical Automated Fixes**
   - ISSUE-001 (xlsx vulnerability)
   - ISSUE-005 (CORS URLs)
   - Test and commit

2. **Day 2-3: Critical Manual Fixes**
   - ISSUE-002 (Error boundaries)
   - ISSUE-003 (File validation)
   - ISSUE-007 (Rate limiting)
   - ISSUE-008 (CloudWatch)
   - Test and commit

3. **Day 4-5: Critical Complex Fixes**
   - ISSUE-004 (DB recovery)
   - ISSUE-006 (Audio memory)
   - Test thoroughly

4. **Week 2: High Priority Fixes**
   - Run remaining high priority scripts
   - Comprehensive testing

5. **Post-Launch: Medium/Low Priority**
   - Address as time permits
   - During regular maintenance cycles

## Testing Checklist

After running fixes:

- [ ] Backend starts without errors
- [ ] Frontend builds and runs
- [ ] All portals (Clinician, Admin, Scribe) accessible
- [ ] File uploads work correctly
- [ ] Database queries perform well
- [ ] Rate limiting works
- [ ] CloudWatch logs appear
- [ ] Error boundaries catch errors gracefully
- [ ] Session timeout works
- [ ] Run Playwright E2E tests

## Rollback Plan

If a fix causes issues:

1. Check git status: `git status`
2. Review changes: `git diff`
3. Revert specific file: `git checkout -- path/to/file`
4. Or revert all changes: `git reset --hard HEAD`

## Support

For issues with fix scripts:
1. Review the audit report: `AUDIT-REPORT.md`
2. Check script output for errors
3. Run with `-DryRun` first to preview changes
4. Test in development environment before production

---

**Last Updated:** 2026-06-23  
**Audit Report:** AUDIT-REPORT.md  
**Platform Health Score:** 72/100
