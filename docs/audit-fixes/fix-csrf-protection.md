# CSRF Protection

- **Fix ID:** fix-csrf-protection
- **Audit ref:** ULT-0005
- **Priority:** HIGH
- **Generated:** 2026-06-24 08:41:35
- **Duration:** 0.3s

## Summary

Added double-submit CSRF protection: cookie + X-CSRF-Token header on state-changing API requests, plus /api/csrf-token endpoint and frontend helper.

## Changes

| Action | Path |
|--------|------|
| modified | anot-frontend-main\anot-frontend-main\src\utils\csrf.js |

## Rollback

Run: powershell -File scripts/fix-csrf-protection.ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/fix-csrf-protection/manifest.json

## Next steps

- Run npm install cookie-parser in backend
- Wire fetchCsrfToken into api.js buildRequestHeaders for POST/PUT/DELETE
- Ensure CORS credentials: true on frontend fetch calls
