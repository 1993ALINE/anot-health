# Dead Code Removal

- **Fix ID:** fix-dead-code
- **Audit ref:** ULT-0002
- **Priority:** HIGH
- **Generated:** 2026-06-24 08:42:29
- **Duration:** 4.0s

## Summary

Scanned for unused exports and removed 0 orphaned single-symbol import lines. Full report in dist/dead-code-report.md.

## Changes

| Action | Path |
|--------|------|
| modified | dist\dead-code-report.md |

## Rollback

Run: powershell -File scripts/fix-dead-code.ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/fix-dead-code/manifest.json

## Next steps

- Review dist/dead-code-report.md for manual cleanup candidates
- Do not delete shared utilities without confirming zero references
