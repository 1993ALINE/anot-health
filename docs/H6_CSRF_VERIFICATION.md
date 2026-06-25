# H6 — Admin Form CSRF Verification

**Status:** ✅ Verified (no code changes required)

**Date:** 2026-06-25

## Summary

All Admin portal mutating requests route through `apiFetch()` / `apiMutate()` in
`anot-frontend-main/src/services/api.js`, which attaches:

- `credentials: 'include'` (sends the `csrf_token` cookie)
- `X-CSRF-Token` header (double-submit token from `GET /api/csrf-token`)

## Admin form audit

| Feature | API module | Method | Uses apiFetch/apiMutate |
|---------|------------|--------|-------------------------|
| Assignments — create | `assignmentsAPI.create()` | POST `/assignments` | ✅ `apiMutate` → `apiFetch` |
| Assignments — delete | `assignmentsAPI.delete()` | DELETE `/assignments/:id` | ✅ |
| Assignments — list | `assignmentsAPI.getAll()` | GET `/assignments` | ✅ `apiFetch` |
| Settings — save | `settingsAPI.update()` | PUT `/settings` | ✅ |
| User CRUD | `usersAPI.*` | POST/PUT/PATCH/DELETE | ✅ |
| Support message | `supportAPI.sendMessage()` | POST `/support/message` | ✅ |
| Audit retention | `adminAPI.applyAuditRetention()` | POST `/audit/retention/apply` | ✅ |

**Source:** `src/pages/Admin/index.jsx` imports `assignmentsAPI`, `settingsAPI`,
`usersAPI`, and `adminAPI` — no raw `fetch()` calls in Admin pages.

## Raw fetch inventory (frontend)

Only three intentional exceptions remain:

1. `src/services/api.js` — internal `apiFetch()` implementation
2. `src/utils/csrf.js` — CSRF bootstrap (`GET /csrf-token`) to avoid circular imports
3. `src/service-worker.js` — PWA cache (not API layer)

## Manual test procedure

1. Sign in as Admin → open **Assignments**
2. Open DevTools → **Network** tab → filter **Fetch/XHR**
3. Submit a new clinician–scribe assignment
4. Select the `POST …/api/assignments` request
5. Under **Request Headers**, confirm:
   - `X-CSRF-Token: <token>`
   - `Cookie` includes `csrf_token=…`

Repeat for **Settings → Save** (`PUT /api/settings`) and **Support** form if used.

## Expected result

```
Request Headers:
  Authorization: Bearer …
  Content-Type: application/json
  X-CSRF-Token: <64-char hex>
  Cookie: csrf_token=<same value>; …
```

If the server returns **403** with a CSRF message, `apiFetch` automatically retries
once with a refreshed token.

## Conclusion

H6 requirement satisfied: Admin forms use the unified API layer with CSRF protection.
No additional frontend changes needed after H5 `apiFetch()` migration.
