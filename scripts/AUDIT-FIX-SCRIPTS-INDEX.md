# Ultimate Audit Fix Scripts Index

Generated for the 15 high/medium priority warnings from `ultimate-comprehensive-audit.ps1`.

## Usage

Run individual fixes:

```powershell
powershell -File scripts/fix-unit-tests.ps1 -Force
powershell -File scripts/fix-ci-cd-pipeline.ps1 -Force
# ... etc
```

Run all fixes in priority order:

```powershell
powershell -File scripts/run-all-audit-fixes.ps1 -Force
```

Preview without writing files:

```powershell
powershell -File scripts/fix-unit-tests.ps1 -DryRun
```

Rollback a specific fix:

```powershell
powershell -File scripts/fix-unit-tests.ps1 -Rollback
```

## Scripts (High Priority)

| Script | Audit ref | Description |
|--------|-----------|-------------|
| `fix-unit-tests.ps1` | ULT-0003/0004/0012/0013 | Jest + Vitest scaffolding, 70% coverage thresholds |
| `fix-ci-cd-pipeline.ps1` | ULT-0014/0015 | GitHub Actions: test, deploy, security-scan |
| `fix-csrf-protection.ps1` | ULT-0005 | CSRF middleware + frontend token helper |
| `fix-rds-performance-insights.ps1` | ULT-0009 | Enable RDS PI + CloudWatch dashboard JSON |
| `fix-foreign-keys.ps1` | ULT-0008 | FK migration + integrity validation script |
| `fix-dom-xss.ps1` | ULT-0010 | sanitize.js + CSP hardening + audit report |
| `fix-correlation-ids.ps1` | ULT-0011 | X-Correlation-Id middleware + log integration |
| `fix-user-consent.ps1` | ULT-0007 | user_consents table + API + privacy docs |
| `fix-mfa-auth.ps1` | ULT-0006 | TOTP setup, recovery codes, admin enforcement |
| `fix-eslint-warnings.ps1` | ULT-0001 | Strict ESLint + auto-fix |
| `fix-dead-code.ps1` | ULT-0002 | Dead code scan + unused import cleanup |

## Scripts (Medium Priority)

| Script | Description |
|--------|-------------|
| `fix-api-documentation.ps1` | OpenAPI spec + API.md + /api/openapi.yaml route |
| `fix-load-testing.ps1` | k6 baseline/auth load tests + performance report |
| `fix-landscape-css.ps1` | Landscape media queries for mobile portals |
| `fix-confidence-scores.ps1` | confidence_score DB column + UI badge |

## Outputs

| Location | Contents |
|----------|----------|
| `dist/fix-reports/` | Per-script JSON + MD change reports |
| `dist/fix-backups/<fix-id>/` | File backups + manifest.json for rollback |
| `docs/audit-fixes/` | Per-fix documentation |

## Shared module

All scripts dot-source `scripts/fix-common.ps1` for path resolution, backups, before/after previews, and report generation.
