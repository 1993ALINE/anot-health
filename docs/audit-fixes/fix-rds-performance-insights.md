# RDS Performance Insights

- **Fix ID:** fix-rds-performance-insights
- **Audit ref:** ULT-0009
- **Priority:** HIGH
- **Generated:** 2026-06-24 08:41:39
- **Duration:** 3.5s

## Summary

Created CloudWatch dashboard JSON and script to enable RDS Performance Insights on anot-postgres. Before: PI disabled; After: PI enabled with 7-day retention.

## Changes

| Action | Path |
|--------|------|
| (none) | - |

## Rollback

Run: powershell -File scripts/fix-rds-performance-insights.ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/fix-rds-performance-insights/manifest.json

## Next steps

- Ensure AWS credentials with rds:ModifyDBInstance permission
- Run: powershell -File scripts/deploy-rds-dashboard.ps1
- Verify in AWS Console: RDS > Performance Insights tab
