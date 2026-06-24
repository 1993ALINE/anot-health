# User Consent Management

- **Fix ID:** fix-user-consent
- **Audit ref:** ULT-0007
- **Priority:** HIGH
- **Generated:** 2026-06-24 08:41:42
- **Duration:** 0.1s

## Summary

Created user_consents table migration, /api/consent routes for recording consent, and privacy policy consent documentation.

## Changes

| Action | Path |
|--------|------|
| (none) | - |

## Rollback

Run: powershell -File scripts/fix-user-consent.ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/fix-user-consent/manifest.json

## Next steps

- Apply migration: psql -f migrations/20260624_user_consents.sql
- Add consent UI modal on first login
- Link PRIVACY-POLICY-CONSENT.md from app footer
