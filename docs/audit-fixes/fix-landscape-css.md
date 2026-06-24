# Landscape Orientation CSS

- **Fix ID:** fix-landscape-css
- **Audit ref:** MEDIUM-LANDSCAPE
- **Priority:** MEDIUM
- **Generated:** 2026-06-24 08:42:32
- **Duration:** 0.3s

## Summary

Added landscape-orientation.css with max-height landscape rules for sidebars, modals, and note panels; imported in main.jsx.

## Changes

| Action | Path |
|--------|------|
| modified | dist\landscape-css-report.md |

## Rollback

Run: powershell -File scripts/fix-landscape-css.ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/fix-landscape-css/manifest.json

## Next steps

- Test Clinician and Scribe dashboards at 667x375 landscape
- Adjust class selectors if layout components use different names
