# Unit Tests (Backend + Frontend)

- **Fix ID:** fix-unit-tests
- **Audit ref:** ULT-0003, ULT-0004, ULT-0012, ULT-0013
- **Priority:** HIGH
- **Generated:** 2026-06-24 08:41:33
- **Duration:** 0.6s

## Summary

Added Jest (backend) and Vitest (frontend) test scaffolding with 70% coverage thresholds and sample unit tests.

## Changes

| Action | Path |
|--------|------|
| modified | anot-backend-main\anot-backend-main\package.json |
| modified | anot-frontend-main\anot-frontend-main\package.json |

## Rollback

Run: powershell -File scripts/fix-unit-tests.ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/fix-unit-tests/manifest.json

## Next steps

- Run: cd anot-backend-main/anot-backend-main && npm install && npm test
- Run: cd anot-frontend-main/anot-frontend-main && npm install && npm test
- Expand test suites to reach 70%+ coverage on critical paths
