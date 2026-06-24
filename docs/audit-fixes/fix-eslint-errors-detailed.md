# ESLint Errors (Detailed Auto-Fix)

- **Fix ID:** fix-eslint-errors-detailed
- **Audit ref:** ULT-0001
- **Priority:** HIGH
- **Generated:** 2026-06-24 08:58:28
- **Duration:** 56.4s

## Summary

Auto-fixed eqeqeq (0 files), console.log (0), __dirname (0). React-hooks items: 0 -> 0. See dist/eslint-errors-detailed-report.txt.

## Changes

| Action | Path |
|--------|------|
| (none) | - |

## Rollback

Run: powershell -File scripts/fix-eslint-errors-detailed.ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/fix-eslint-errors-detailed/manifest.json

## Next steps

- Review remaining react-hooks items in dist/eslint-errors-detailed-report.txt
- Refactor effects/refs flagged for manual review
- Run npm run lint in anot-frontend-main/anot-frontend-main
