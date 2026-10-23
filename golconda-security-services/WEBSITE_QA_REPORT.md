# Website audit and release verification — 23 October 2026

## Scope and safety

- Continued the existing `codex/complete-implementation` checkout from production
  commit `b5a81f84b7eb345c39c73555c734e05b069e4d35`; existing work was preserved.
- The supplied task's migration status was historical. Record Management is already
  applied as Supabase migration **20261023093445_record_management**, corresponding
  to local `20261022190000_record_management.sql`. It must not be replayed.
- No new database migration, production test record, financial entry, file upload,
  deletion, archive, restoration, environment change or backup operation was used
  for this audit. Production checks are read-only or rejected unauthenticated calls.
- Full backup restore rehearsal remains explicitly waived by the owner. Existing
  verified database/private-file backups are preserved outside Git.
- Destructive lifecycle tests used disposable **local in-memory PostgreSQL 17**,
  production-schema metadata and entirely synthetic identities/records.
- `scripts/qa-fixture.js` binds only to loopback. It injects the real Express app
  and SQL functions, with mock Auth/REST/Storage transport. It does **not** read a
  production URL/key, encrypted credentials, employee rows or financial data.
  Mock credentials are synthetic and accepted only by this local fixture.

## Reproducible issues fixed (nine groups)

| # | Issue / root cause | Fix and verification |
|---|---|---|
| 1 | History and File Cleanup accidentally displayed an Add New Service form because the generic editor used a negative exclusion list. | Positive catalogue-module allowlist; both screens checked in the browser and guarded by regression. |
| 2 | Supervisor/Field Officer site choices were blank: a shared checklist rendered `full_name`/`employee_code` for site objects. | Render site `title`/`site_code`; exclude archived choices. Both employee UIs saved named site assignments; SSR regression covers both. |
| 3 | Relationships and compensation stayed stale after edits: the relation effect depended only on `items.length`. | Refresh on records/guards changing; stable empty defaults. Field Officer reporting changes and employee edits checked in browser. |
| 4 | View Public Website showed stale Services/Events/Notifications: public data loaded only at initial mount. | Reload public data on leaving admin mode. Published synthetic content appeared on the public page. |
| 5 | All public forms shared one feedback variable and had no synchronous in-flight guard. | Per-form messages and pending states; duplicate rapid submissions blocked while pending. All three forms submitted successfully in browser; response/database failure tests retain no-false-success checks. Deliberate later resubmissions are not globally deduplicated. |
| 6 | Admin account email/Logout widened the document at 360/390px; filter labels also had poor contrast on white panels. | Wrap identifiers, stack small-screen header/forms/cards and use a dark filter label. Populated payroll tables and a strong-confirmation modal tested without document overflow. |
| 7 | Dashboard advance retries omitted the existing database idempotency reference; null RPC results could falsely report success; expected duplicate recovery conflicts were reported as generic failures. | Stable reference for an unchanged same-page submission, synchronous pending guard, positive saved-ID validation, persisted-payload comparison and safe 409/503 recovery errors. Concurrent same-reference HTTP retries created one advance; changed details returned 409; repeated monthly recovery retained one allocation. |
| 8 | Complaint cards displayed Untitled Record and omitted the complainant identity. | Shared record label includes `complainant_name`; browser list/review and pure regression checked. |
| 9 | Site import UI/error said 5 MB although the configured cap is 3.5 MB. | Derive displayed limits from parser constants; oversized-file regression and rendered form checked. |

## Module results and restrictions

PASS below means the stated executed coverage, **not a claim of destructive hosted
production testing**. PostgreSQL tests execute real lifecycle/RLS/constraint code;
the fixture Auth/Storage transport is simulated, not a hosted Supabase instance.

| Module | Isolated HTTP -> PostgreSQL | Browser exercised | Retention behavior |
|---|---|---|---|
| Guards | Create/read/edit, multi-site, duplicate/invalid values, dates, archive/restore, linked delete, imports | Create/edit, date, site, search/visibility, archive/restore, cancelled delete, actual linked-delete 409, CSV/XLSX download and content validation | Operational/financial/audit dependencies prevent permanent deletion. |
| Supervisors | Same employee lifecycle, assignment and cross-type identity checks | Create/edit, named site assignment, archive/restore, cancelled permanent delete | Restored inactive; no automatic reassignment. |
| Field Officers | Same employee lifecycle and isolation from other employee tables | Create/edit, supervisor reporting change, site assignment, archive/restore | Reporting/assignment history retained. |
| Sites | Create/read/edit, duplicate codes, both day-first dates, archive/restore and linked-delete 409 | Create/edit and archive/restore; employee relationships displayed | Does not delete employees or money/history. |
| Services | Full create/read/edit/deactivate/activate/archive/restore/confirmed deletion | Publish/public display, edit, archive/restore and actual typed-confirmation deletion of a synthetic service | Intakes using a service label or other linked dependencies block removal. |
| Events | Full catalogue lifecycle | Publish/date/public display, edit, archive/restore | Restored content remains hidden until separately activated. |
| Notifications | Full catalogue lifecycle and public RLS visibility | Publish/public display, edit, archive/restore | Publication and active flags reviewed separately; timing/expiry unit tests pass. |
| Profile media | SDK File multipart upload, exact downloaded bytes, signed access, private direct-access rejection, metadata/archive/restore, reference-blocked cleanup and orphan cleanup | File selection/upload requests persisted metadata; edit/hide/archive/private restore checked after tab recovery | Compliance and referenced/audited objects retained; physical removal requires explicit reviewed cleanup. See browser-tool limitation below. |
| Enquiries | Public submit, persistence, notes/status, close/reopen/archive/restore | Submit and all review/retention actions | Original evidence immutable; no permanent delete. |
| Applications | Same intake lifecycle and permissions | Submit and all review/retention actions | No CV upload exists; not invented. |
| Complaints | Same intake lifecycle, resolve/reopen, notes and validation | Submit, correct name, resolve/reopen, review and archive/restore | Original details preserved; no permanent delete. |
| Payroll/advances | Precision, positive money, salary summaries, recoveries, duplicate retries, conflicts and retained money | Synthetic advance 1000.25, recovery 100.25, remaining balance 900.00; monthly estimate loaded | Append-only financial history; explicit recovery month; no unrelated-delete path. |
| History/File Cleanup | SQL RLS/permission and cleanup reservation/reference regressions | Both screens loaded without the unrelated editor | History read-only; no production cleanup performed. |

### Import/export coverage

- CSV aliases, common equivalent names, mixed-validity rows, invalid email/phone,
  invalid dates, formula rejection and formula-safe export remain in regressions.
- Real XLSX bytes were parsed through the frontend parser, submitted over HTTP,
  and read back from PostgreSQL with `2026-04-10` and `2026-04-01` ISO dates.
- Full **500-row** Guard import saved all valid synthetic records; a 501-row
  request was rejected; prior employees/financial records stayed intact.
- The existing tests cover queries past Supabase's 1,000-row default cap,
  ambiguous matches, inactive imports and fixed two-digit-year policy.
- Browser CSV and Excel export buttons produced actual files. Both were parsed
  again and verified for name, joining date and salary accuracy.
- Browser CSV/XLSX chooser-based imports were not completed. Their parser/API/SQL
  flows were tested; do not describe that as a completed chooser-based E2E test.

## Responsive/public/authentication checks

- Public home, dedicated Profile and populated admin financial layout checked at
  **360, 390, 768, 1366 and 1920px**. Document overflow was absent after the fix;
  wide financial tables scroll inside their own container.
- Mobile navigation, FAQ expansion, same-page anchor targets, Profile/return-home,
  public content and empty states checked. No broken homepage fragment targets.
- Synthetic admin login, refresh/session restoration and logout checked. Real
  production Auth/dashboard verification is part of the final read-only smoke.
- Every protected mutation route tested with missing, expired and non-admin
  synthetic sessions (401/403). Anonymous/private-data RLS and direct write/RPC
  restrictions remain in executed PostgreSQL tests.
- Only the available Chromium-based in-app browser ran. Safari, Firefox and
  separate Edge/browser-engine coverage were **not run**.

## Limitations, not silent passes

- File chooser automation returned CDP mouse/focus timeouts. Upload requests did
  persist synthetic media, but the entire browser success/preview sequence was
  not observed without tab recovery. Exact SDK File upload/download/cleanup is
  tested through the local API transport. A manual hosted upload/import smoke
  remains useful; no destructive production write was substituted for it.
- This is migration/lifecycle testing, not full backup recovery, hosted Auth
  service integration, hosted Storage load testing or multi-session PostgreSQL
  race testing. PGlite serializes statements on one connection.
- There is no attendance system, statutory ESI/PF calculation, bank transfer or
  payroll disbursement/status ledger. Existing payroll is a calendar-month
  estimate with approved manual adjustments and explicitly allocated recovery.
- Joining/end dates are inclusive; status alone does not stop accrual. The
  same-effective-date compensation **deletion** guard is intentional: review a
  dated salary transition instead of deleting retained history.
- Same-page advance retries preserve the request reference. After a reload/new
  tab, review the register before resubmitting an uncertain payment. External API
  clients should supply a stable `external_reference` to obtain retry protection.
- Supabase leaked-password protection remains an owner Auth setting. Advisor
  warnings for `record_admin_access()` are intentional: it is a fixed-search-path,
  caller-bound boolean predicate required by restrictive content RLS. It exposes
  no membership rows; anon false/non-admin false/admin true are SQL-tested.
- No CAPTCHA/Firewall credentials or platform rules were invented. Existing
  server rate-limit tests remain; per-instance serverless limits are not a global
  distributed abuse guarantee. Telegram, Sheets and outbound email remain off.

## Reproduce safely

```powershell
npm test
npm run build
npm audit --audit-level=moderate
git diff --check
node scripts/qa-fixture.js
```

The optional fixture website is `http://127.0.0.1:5187`. Its only test account is
`qa-admin@example.invalid` / `Synthetic-local-only-123!` (not a real credential).
It overrides only its process's Vite public variables to localhost. Never deploy
this fixture or connect it to a hosted database. Stop the process to dispose of
all synthetic database/files. `qa-artifacts/` and downloaded QA files are not Git
release content. No paid resources or additional Vercel projects were created.

## Final command results

- npm test: **156/156 PASS**, zero failed/skipped.
- npm run build: **PASS**; existing lazy ExcelJS chunk-size warning only.
- npm audit --audit-level=moderate: **PASS**, zero vulnerabilities.
- git diff --check: **PASS**.
- Final production commit/deployment are verified separately against GitHub and Vercel metadata.
