# Foreign Key Constraints

- **Fix ID:** fix-foreign-keys
- **Audit ref:** ULT-0008
- **Priority:** HIGH
- **Generated:** 2026-06-24 08:41:40
- **Duration:** 0.1s

## Summary

Created FK migration SQL with idempotent DO blocks, rollback SQL, and Node validation script for orphan detection.

## Changes

| Action | Path |
|--------|------|
| (none) | - |

## Rollback

Run: powershell -File scripts/fix-foreign-keys.ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/fix-foreign-keys/manifest.json

## Next steps

- Run: node scripts/validate-fk-integrity.js (must exit 0)
- Apply: psql -f migrations/20260624_foreign_key_constraints.sql
- Rollback: psql -f migrations/20260624_foreign_key_constraints_rollback.sql
