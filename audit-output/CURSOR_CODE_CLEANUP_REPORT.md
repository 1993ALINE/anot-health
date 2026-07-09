# CODE CLEANUP & UNUSED CODE REPORT
## Generated: Thursday, July 2, 2026

**Scope:** Backend `anot-backend-main/anot-backend-main/src/` and Frontend `anot-frontend-main/anot-frontend-main/src/`

---

## BACKEND UNUSED CODE

### Unused Files (Delete These)

| File | Reason | Safe to Delete? |
|------|--------|-----------------|
| `src/services/streamingAudioProcessor.js` | Bull/Redis audio queue — never imported anywhere in `src/` | ⚠️ REVIEW — May be planned feature; safe if Redis queue not in use |
| `src/utils/cloudWatchValidator.js` | CloudWatch validation utility — zero imports in codebase | ✅ YES |
| `scripts/inventory.js` | Legacy MySQL inventory script; app uses PostgreSQL only | ⚠️ REVIEW — Keep if used for ops |

### Unused Functions

| Function | File | Location | Safe to Delete? |
|----------|------|----------|-----------------|
| `extractConfidence` (imported but unused) | `transcriptionService.js` | line 1 | ✅ YES — Remove import |
| N/A — most exports are wired through routes | — | — | — |

### Unused Dependencies

| Package | Used? | Recommendation |
|---------|-------|----------------|
| `mysql2` | ❌ NO (only `scripts/inventory.js`) | Remove from `package.json` if inventory script deleted |
| `bull` | ⚠️ Only in unused `streamingAudioProcessor.js` | Remove both if streaming processor deleted |
| `redis` | ✅ YES — rate limit store, streaming processor | Keep (rate limits use it) |
| `rate-limit-redis` | ✅ YES — `rateLimit.js` | Keep |
| All other deps | ✅ Used | Keep |

**npm audit (backend):** 2 moderate vulnerabilities via transitive `uuid` in `bull` and `exceljs`. Fix in next sprint (major version bumps required).

### Dead Code (Commented Out)

Backend has minimal large commented-out blocks. Most `//` comments are documentation, not dead code. Notable items:

| File | Notes |
|------|-------|
| `server.js` | Extensive section headers (keep — documentation) |
| `auth.js:34` | Stale comment says "60s TTL" but code uses 10s — fix comment only |

### Test Files Without Meaningful Tests

| File | Issue |
|------|-------|
| N/A (backend) | All 26 test files contain real assertions |

---

## FRONTEND UNUSED CODE

### Unused Components / Utils

| Component/Util | File | Used In? | Safe to Delete? |
|----------------|------|----------|-----------------|
| `sanitize.js` | `src/utils/sanitize.js` | Nowhere — zero imports | ✅ YES |
| `PortalTooltip` | `src/components/PortalTooltip.jsx` | Nowhere — never imported | ✅ YES |
| `ConfidenceBadge` | `src/components/ConfidenceBadge.jsx` | Re-exported from `shared.jsx:495` but never consumed by any page | ✅ YES (+ `confidence.css`) |
| `confidence.js` | `src/utils/confidence.js` | Only used by unused `ConfidenceBadge` | ✅ YES (with ConfidenceBadge) |

### Used Components (Verified — Do NOT Delete)

All other components in `src/components/` are imported by at least one portal page. Key large consumers:
- `Clinician/index.jsx` — 3,634 lines, imports 15+ components
- `Admin/index.jsx` — 2,442 lines
- `Scribe/index.jsx` — 1,583 lines

### Unused Dependencies

| Package | Used? | Recommendation |
|---------|-------|----------------|
| `react` / `react-dom` | ✅ | Keep |
| `react-router-dom` | ✅ | Keep |
| `recharts` | ✅ — `AdminMiniCharts.jsx`, lazy-loaded in Admin | Keep |
| `typescript` | ⚠️ DevDep only — no `.ts` files in src | Consider removing if not planning TS migration |

**npm audit (frontend):** 1 low severity in dev-only `esbuild` (Windows dev server). Not production runtime risk.

### Unused CSS

| File | Used? | Safe to Delete? |
|------|-------|-----------------|
| `src/components/confidence.css` | Only with unused `ConfidenceBadge` | ✅ YES |
| `src/components/portalTooltip.css` | Check with PortalTooltip | ✅ YES if PortalTooltip deleted |
| All portal `*.css` in pages/ | ✅ Imported by respective pages | Keep |

### Dead Code (Commented Out)

Frontend JSX files are large but mostly active code. No significant multi-line commented blocks identified. ESLint catches unused imports in most files.

### Test Files Without Meaningful Tests

| File | Lines | Issue |
|------|-------|-------|
| `src/__tests__/App.test.jsx` | 7 | Smoke only: `expect(true).toBe(true)` — replace with real App mount test or delete |

---

## LARGE FILES (Refactor Candidates — P2)

| File | Lines | Recommendation |
|------|------:|----------------|
| `pages/Clinician/index.jsx` | 3,634 | Split into: Schedule, Recording, Notes, OfflineSync modules |
| `pages/Admin/index.jsx` | 2,442 | Split into tab components: Users, Settings, Payroll, Audit |
| `pages/Scribe/index.jsx` | 1,583 | Split into: DayPreview, NoteEditor, Grading |
| `pages/QPS/index.jsx` | 913 | Moderate — split when touching |
| `pages/shared.jsx` | 495 | Extract shared sub-components |
| `services/api.js` | 503 | Acceptable for API client |
| `controllers/authController.js` | 640 | Split login/MFA/register into separate modules |

---

## TOTAL PROJECT CLEANUP

### Current State

| Metric | Value |
|--------|------:|
| Backend source files | 86 |
| Frontend source files | 69 |
| Total source lines | ~41,452 |
| Unused files (confirmed) | 2–4 |
| Unused frontend utils/components | 4 |
| Unused dependencies (backend) | 1–2 (`mysql2`, possibly `bull`) |
| Dead code (commented blocks) | Minimal (~<1%) |
| Files >1,000 lines | 3 frontend pages |

### After Cleanup (Estimated)

| Metric | Value |
|--------|------:|
| Files removed | 4–6 |
| Lines removed | ~400–600 |
| Dependencies removed | 1–2 |
| **Estimated reduction** | **~1–2% LOC, ~5% unused asset cleanup** |

---

## Recommendations

### P0 (Before Saturday)
1. **Verify production env** — No action on unused code; ensure deploy isn't blocked
2. **Do NOT remove `bull`/`redis`** without confirming rate-limit Redis store is the only Redis usage

### P1 (This Week)
1. **DELETE** `src/utils/sanitize.js` (unused)
2. **DELETE** `src/components/PortalTooltip.jsx` + `portalTooltip.css` (if exists)
3. **DELETE** `src/components/ConfidenceBadge.jsx` + `confidence.css` + `src/utils/confidence.js`
4. **Remove re-export** from `shared.jsx:495`
5. **DELETE** `src/utils/cloudWatchValidator.js`
6. **Remove unused import** `extractConfidence` in `transcriptionService.js`
7. **Replace or delete** smoke-only `App.test.jsx`

### P2 (Next Sprint)
1. **REFACTOR** `Clinician/index.jsx`, `Admin/index.jsx`, `Scribe/index.jsx` into tab modules
2. **REVIEW** `streamingAudioProcessor.js` — implement or delete
3. **REMOVE** `mysql2` + `scripts/inventory.js` if MySQL inventory no longer needed
4. **UPGRADE** `bull`/`exceljs` to resolve npm audit moderate findings
5. **CONSOLIDATE** duplicate admin route files if any (`admin.js` appears twice in git status due to path normalization only)

---

## Time Estimate

| Task | Duration |
|------|----------|
| Quick cleanup (delete unused files/deps) | 30 min |
| Deep cleanup (remove dead code, fix ESLint warnings) | 2 hours |
| Comprehensive refactor (split large files) | 4–8 hours |

---

*See `CLEANUP_TASKS.md` for actionable sprint backlog.*
