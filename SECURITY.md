# Security Policy

## Reporting a Vulnerability

If you discover a security issue in Anot Health, please report it responsibly:

1. **Do not** open a public GitHub issue for exploitable vulnerabilities.
2. Email the maintainers with a description, reproduction steps, and impact assessment.
3. Allow reasonable time for a fix before public disclosure.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.42.x  | :white_check_mark: |
| < 1.42  | :x:                |

## Security Controls (Summary)

- **Authentication:** JWT with `token_version` revocation; MFA required for admin accounts.
- **CSRF:** Stateless double-submit cookie (`__Host-csrf_token` in production over HTTPS).
- **CSP:** Strict Content-Security-Policy without `unsafe-inline` scripts/styles.
- **Rate limiting:** API and login throttling with Redis backing when configured.
- **Webhooks:** HMAC-signed Deepgram callbacks with replay window limits.
- **PHI:** Audit logging, encrypted MFA secrets, production-safe error messages.

## Dependency Audit — Acceptable Risks

Last reviewed: 2025-06-25 (`npm audit` in CI via `.github/workflows/security-scan.yml`).

| Package / Advisory | Severity | Decision | Rationale |
| ------------------ | -------- | -------- | --------- |
| Transitive dev-only tooling | Low–Moderate | Accept | Confined to CI/dev; no production runtime exposure. |
| `pdfkit` / font parsing chain | Moderate | Accept | Used only for admin export PDFs; input is server-generated report data. |
| `bull` / Redis queue | Low | Accept | Internal job queue; not exposed to untrusted input. Monitor for Redis AUTH misconfiguration. |

Run `npm audit` in `anot-backend-main/anot-backend-main` and `anot-frontend-main/anot-frontend-main` before each release. Apply `npm audit fix` for patch-level issues with available fixes; document any remaining findings here.

## Deployment

Production deploys require passing tests (`npm test` in CI or locally) before running `scripts/deploy-to-eb.ps1`. Deploy uses AWS CLI credentials on the operator machine (not long-lived keys in GitHub). Elastic Beanstalk health must reach **Ready / Green** before the deploy script exits.
