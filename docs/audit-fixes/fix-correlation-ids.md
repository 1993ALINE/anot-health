# Correlation IDs

- **Fix ID:** fix-correlation-ids
- **Audit ref:** ULT-0011
- **Priority:** HIGH
- **Generated:** 2026-06-24 08:41:41
- **Duration:** 0.1s

## Summary

Added correlationId middleware (X-Correlation-Id / X-Request-Id) and wired IDs into error audit logs for end-to-end tracing.

## Changes

| Action | Path |
|--------|------|
| (none) | - |

## Rollback

Run: powershell -File scripts/fix-correlation-ids.ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/fix-correlation-ids/manifest.json

## Next steps

- Pass X-Correlation-Id from frontend api.js on all requests
- Search CloudWatch logs by correlation ID during incident response
