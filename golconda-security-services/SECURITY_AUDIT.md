# Security, performance, and failure-scenario review

**Scope:** current code in this worktree and local tests/build when run. Live Supabase/Vercel observations in this report are historical and were not re-queried during the current pre-release pass because no explicit staging credentials or Vercel project access were available. This is not an independent penetration test or a production verification of pending migrations.

## 19 security areas

| # | Area | Result and evidence |
| ---: | --- | --- |
| 1 | SQL injection | **PASS — source review.** Supabase queries use structured filters; server writes pass JSON/typed values to fixed RPC names. Dynamic SQL in the site-import routine formats only a fixed internal table list. No arbitrary SQL endpoint was found. |
| 2 | XSS | **PASS — source review.** React renders user-provided content as text; no `dangerouslySetInnerHTML`, `innerHTML`, or `eval` use was found. External notification/file links are protocol-checked before rendering. |
| 3 | CSRF | **PASS for the current model, with XSS caveat.** API/admin calls use an explicit Supabase bearer token header, not an ambient application cookie. API responses do not enable cross-origin access. A same-origin script injection could still act as the signed-in admin. |
| 4 | Authentication and sessions | **PASS in code / MANUAL Supabase settings remain.** Sensitive API writes verify the access token and `admin_users` membership; database routines repeat the admin check. Browser Supabase Auth persists a session in browser storage. MFA, production signup settings, and leaked-password protection were not verified in Dashboard. |
| 5 | Rate limiting | **LIMITATION.** Express rate limits are process-local and do not aggregate across Vercel instances. An owner must publish a Vercel Firewall IP rate-limit rule for contact, application, complaint, and guard-import `POST` routes before public traffic. |
| 6 | Input validation and sanitization | **PASS in code.** Public forms, employee/site records, advance amounts, dates, import rows, employee codes, and upload types/size are validated on the server or database as applicable. CSV/XLSX formulas are not evaluated. |
| 7 | Parameterized database queries | **PASS — source review.** User values use Supabase query builders or RPC arguments, not concatenated SQL. |
| 8 | CORS restrictions | **PASS.** There is no CORS allow-all middleware. The frontend uses same-origin `/api/*`; a regression test checks that the API does not emit `Access-Control-Allow-Origin` for an untrusted origin. |
| 9 | HTTPS and secure transport | **CONFIGURED / NOT LIVE-VERIFIED.** Vercel serves the canonical site over HTTPS. `vercel.json` adds HSTS; verify the response header after the next Preview deployment. |
| 10 | IDOR/BOLA | **PASS in source / LIVE RLS TEST BLOCKED.** Every operations API verifies administrator membership before acting; IDs are validated and the SQL routines verify actor membership and record relationships. The connected production database has not received the pending RLS migration, so post-migration database denial tests remain required. |
| 11 | Debug mode and error leakage | **PASS in reviewed code.** No `debugger`, browser `console.log`, or browser `console.debug` remains. Server logs include only an error code/name, not request bodies, tokens, or provider secrets; API 500 responses use a generic message. |
| 12 | CAPTCHA / anti-abuse | **PARTIAL.** No CAPTCHA is integrated. Start with the Vercel Firewall rule; reassess if measured abuse requires CAPTCHA. No CAPTCHA credentials are present. |
| 13 | Administrative audit logging | **CODED / LIVE TEST BLOCKED.** Triggers record before/after data and actor for operations, compensation, assignments, and financial changes. Authenticated roles can read the audit table only as admins and cannot write it directly. The migration is pending, so actual trigger behavior still needs staging verification. |
| 14 | Private Storage and object policies | **CODED / LIVE TEST BLOCKED.** `employee-private` and `company-profile` are configured private with admin-only storage policies. Public profile links are issued only for approved records and expire after one hour. Verify the buckets/policies after applying migrations. |
| 15 | Admin page/API authorization | **PASS in code.** The UI checks Supabase admin membership and the API independently checks the bearer token and admin table. Frontend visibility is not the authorization boundary. |
| 16 | Dependencies | **PASS — `npm audit --audit-level=moderate` reported 0 vulnerabilities.** |
| 17 | File validation and handling | **PASS in code.** Profile files use MIME allowlists and size limits; employee photos have a smaller limit; storage is private. Import rejects formulas and malformed CSV/XLSX. CSV exports escape formula-triggering prefixes. |
| 18 | Independent review and regression testing | **PARTIAL.** Regression tests cover API auth, import idempotency, validation, spreadsheet formulas/exports, same-origin CORS, public-profile filtering, and health/intake behavior. No independent security reviewer, staging test, or human usability test participated. |
| 19 | Security headers and webhook authentication | **CODED / PREVIEW VERIFICATION REQUIRED.** Vercel CSP, frame, MIME, referrer, permissions, and HSTS headers are configured in `vercel.json`. Telegram validates the secret-token header and private-chat user allowlist before database access. Google sync requires a constant-time checked `CRON_SECRET` bearer token and is disabled unless explicitly enabled with valid settings. Tests cover rejected secrets/senders; live integration/scheduler setup remains unverified. No production Cron is configured. |

## Ten failure and abuse scenarios

| # | Scenario | Result |
| ---: | --- | --- |
| 1 | Upload the same guard/site spreadsheet twice | **PASS in local code tests.** Guard import skips normalized duplicate phones; site import matches stable site codes and employee phone/code and is transaction-backed. A real PostgreSQL repeat-import run remains blocked until staging migrations are applied. |
| 2 | Malformed/oversized spreadsheet, invalid date/salary, or formulas | **PASS in local parser/API tests.** CSV/XLSX parsing has file/row caps, formula rejection, date/amount validation, and row-number errors. Staging Supabase execution remains unverified. |
| 3 | Partial site/related-person import failure | **CODED / DATABASE TEST BLOCKED.** One PostgreSQL function performs the site batch in a transaction; any uncaught database failure rolls back that call. This has not been executed against a migrated staging database. |
| 4 | Logged-out/non-admin calls an admin API | **PASS in API tests.** Guard/site endpoints reject missing tokens and non-admin membership before writes. Re-run against the deployed Preview after migrations. |
| 5 | Change site/employee/advance IDs to access unrelated records | **PASS in source review / LIVE RLS TEST BLOCKED.** Server admin checks and routine-level actor checks prevent ordinary authenticated users from using those APIs. Production tables remain governed by the currently applied schema until migrations are applied. |
| 6 | Export a field starting with `=`, `+`, `-`, or `@` | **PASS in spreadsheet tests.** CSV output prefixes formula-triggering values; XLSX writes string cells. |
| 7 | Duplicate Telegram webhook delivery | **PASS in mocked regression tests.** The handler authenticates the secret and allowlisted private sender; repeated and concurrent updates use Telegram `update_id` with the database's unique source/reference key. Live Telegram and pending migration verification remain required. |
| 8 | Google Sheets outage during advance synchronization | **PASS in mocked regression tests.** With the integration explicitly enabled and fully configured, advances enqueue transactionally; provider errors are sanitized and retried, and a timeout-after-append is reconciled by Advance ID. With the feature flag off or configuration incomplete, no outbox row is created. Real Google credentials, permissions, scheduler, and migration are not verified. |
| 9 | Request an unpublished notice or private document | **PASS in source test / LIVE RLS TEST BLOCKED.** Public notices are policy-filtered; profile API filters `is_public` and private storage objects need signed links. Verify direct anonymous database/storage requests after migration. |
| 10 | Concurrent advance correction/recovery or salary change | **CODED / DATABASE TEST BLOCKED.** SQL triggers use transaction-scoped advisory locks and row locks for financial validation; unique constraints protect one recovery per advance/month and external references. No concurrent PostgreSQL test ran because the migration is pending. |

## Performance and caching

- `GET /api/profile` is cached by browsers for 60 seconds and the Vercel edge for 300 seconds. Authenticated advances/payroll responses use `private, no-store`.
- Vite's content-hashed `/assets/*` files receive a one-year immutable cache header. HTML is not assigned an immutable cache lifetime.
- Advance records use server pagination (50 rows in the UI, at most 200 per request) and database-side filtered totals. The other admin directory screens still fetch the authorized directory for client-side search and relationship controls; convert those to server-side paging before the data volume makes that expensive.
- Migration indexes cover the observed site status/code/name filters, employee names/codes, assignment joins, effective compensation periods, advance date/site/employee filters, salary-period recovery lookups, and audit record/date queries. Query plans could not be measured because Supabase CLI/Docker are unavailable and the pending schema is not installed.
- **No load test has been run.** `scripts/k6-load.js` is a repeatable k6 smoke/load script. It blocks the canonical production host, requires `TARGET_ENV=local` or `staging`, and does not submit forms unless explicit synthetic-data confirmation flags are set.

Safe staging run (read-only routes by default):

```powershell
$env:BASE_URL = 'https://your-nonproduction-preview.example'
$env:TARGET_ENV = 'staging'
$env:VUS = '5'
$env:STEADY_DURATION = '2m'
k6 run scripts/k6-load.js
```

To exercise one synthetic public form per VU iteration, use a clean non-production database and set both `ALLOW_SYNTHETIC_SUBMISSIONS=YES` and `CONFIRM_NONPRODUCTION_DATA=YES`. Do not run this against Production. Set `ADMIN_BEARER_TOKEN` only in the local shell to include the authenticated advance-read path; the script never prints it.

The thresholds in the script (`p95 < 1500 ms`, failed requests `< 5%`) are targets, not measured results. Record k6's actual request count, p50/p95, errors, concurrency, environment, and Supabase/Vercel resource observations after a staging run.

## Accessibility and realistic walkthroughs

Source review found labels for forms, status/error text roles, responsive table wrappers, and keyboard-operable native controls. A real keyboard/contrast/device audit was not completed. No real users participated. Before release, walk through tasks as an admin, site supervisor, field officer, guard-record manager, public service requester, and job applicant; test session expiry, mobile layout, slow network, refresh/back, file upload recovery, and long tables. Arrange a supervised test with actual users before describing the product as user-validated.

## Production manual checks

1. Identify an isolated staging Supabase project explicitly. Run `supabase/preflight_staging.sql` there; it is read-only. No PostgreSQL connection/tooling is available in the current environment, so SQL verification is blocked until the owner provides isolated staging access.
2. Apply the migrations to staging only, after resolving preflight findings, then run the blocked RLS, audit, import rollback, concurrency, and private-object checks. Production migrations/deployment need a separate release decision.
3. Enable Supabase leaked-password protection at Authentication → Attack Protection → Leaked Password Protection; review MFA, signup, redirects, and admin membership.
4. Publish a Vercel Firewall IP rate-limit rule for public form and guard-import routes before public traffic.
5. Verify response security headers, sitemap, canonical metadata, and `robots.txt` on a Vercel Preview.
6. Keep Telegram, Google Sheets, email delivery, and Vercel Cron disabled. The previous admin message-to-applicant/complainant email feature and sender route were removed; they require separate product approval before restoration.
7. Review the Terms and Privacy drafts with the business owner/legal adviser.
