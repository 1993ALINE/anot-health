# CI/CD Pipeline (GitHub Actions)

- **Fix ID:** fix-ci-cd-pipeline
- **Audit ref:** ULT-0014, ULT-0015
- **Priority:** HIGH
- **Generated:** 2026-06-24 08:41:34
- **Duration:** 0.1s

## Summary

Created GitHub Actions workflows for automated testing on PR, deployment on main, and weekly security scanning.

## Changes

| Action | Path |
|--------|------|
| (none) | - |

## Rollback

Run: powershell -File scripts/fix-ci-cd-pipeline.ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/fix-ci-cd-pipeline/manifest.json

## Next steps

- Add repository secrets for deployment (AWS, Railway, etc.)
- Customize deploy.yml with your EB/CloudFront steps
- Enable branch protection requiring test.yml to pass
