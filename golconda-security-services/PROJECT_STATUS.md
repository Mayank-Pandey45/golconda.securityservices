# Golconda Security Services — Project Status

**Review date:** 21 October 2026
**Branch:** `codex/complete-implementation`
**State:** Local changes only. Nothing has been committed, pushed, or deployed.

## Architecture and current deployment

- React 18/Vite builds the public site and admin dashboard into `dist/`.
- Supabase JS in the browser uses only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Public content and admin CRUD use Supabase RLS.
- Node.js Vercel Functions live under `api/`. They adapt the existing Express routes through `server/vercelAdapter.js`; helper code is outside `api/` so it is not discovered as a route.
- Production API calls use same-origin `/api/*`. Vercel CORS is not enabled. `CLIENT_ORIGINS` and `VITE_API_URL` are not required; leave `VITE_API_URL` empty.
- `vercel.json` adds security headers and immutable caching for Vite's hashed `/assets/*` files. Render configuration is not used.
- This app is nested under `golconda-security-services/` in the Git repository. Set Vercel Project Settings → Build and Deployment → Root Directory to `golconda-security-services`.
- Canonical site URL: `https://golconda-securityservices.vercel.app/`.

The last recorded live Vercel check found the previous build. Vercel was not re-queried during this pre-release pass; the implementation in this worktree has not been deployed from this branch.

## Last recorded live Supabase snapshot

This is a prior read-only snapshot, not a live check performed during this pre-release pass. No staging Supabase credentials or local Supabase/PostgreSQL tooling were available in this worktree environment.

Read-only inspection of the connected project showed:

| Data | Live count/status |
| --- | ---: |
| Services | 5 |
| Events | 2 |
| Notifications | 2 |
| Sites | 1 |
| Guards | 1 |
| Profile documents | 0 |
| Supervisors / field officers | Tables do not exist yet |

Applied migrations: `20261007160814_operations_and_intake.sql` and `20261007160935_tighten_admin_policies.sql`.

Pending migrations, in order:

1. `20261008164000_public_profile_guard_management_notifications.sql` — guard salary/profile columns, normalized phone uniqueness, public-notification scheduling/policies, private `company-profile` bucket and admin policy.
2. `20261021151502_operations_platform_core.sql` — site billing/status fields, supervisors, field officers, dated many-to-many assignment history, compensation and salary adjustments, advances/recoveries/corrections, audit triggers, RLS, private employee storage, and guarded database routines.
3. `20261021191500_advance_integrations_outbox.sql` — private, opt-in Google Sheets outbox, leased batch claim, and service-role-only retry/completion routines. With the integration flag off or incomplete server credentials, advance writes add no outbox row.

The pending migrations have **not** been applied to production. The second migration backfills existing `guards.site_id` values into `guard_site_assignments`; the legacy `guards.site_id` remains a compatibility pointer to the first active assignment. The admin UI uses the assignment table. The legacy `sites.assigned_guards` field is not used by the UI.

No production rows were added, deleted, or migrated during this task. The new data tables and policies are therefore not available in the current live schema until the migrations are reviewed and applied.

## API endpoints

| Method and path | Purpose / authorization |
| --- | --- |
| `GET /api/health` | Checks actual Supabase reachability; returns 503 when the database cannot be reached. |
| `GET /api/profile` | Returns approved public profile files only; signed links for private bucket objects expire after one hour. |
| `POST /api/contact` | Validates and stores contact submissions. |
| `POST /api/applications` | Validates and stores job applications. |
| `POST /api/complaints` | Validates and stores complaints. |
| `POST /api/guards/import` | Requires a valid Supabase session and `admin_users` membership; validates again on the server. |
| `POST /api/operations/sites` | Admin-only site CRUD and relationship assignment. |
| `POST /api/operations/site-import` | Admin-only validated site/people import; database routine commits the batch transactionally. |
| `POST /api/operations/people` | Admin-only supervisor/field-officer CRUD and assignment updates. |
| `POST /api/operations/guards` | Admin-only guard CRUD and multi-site assignments. |
| `GET, POST /api/operations/advances` | Admin-only paginated/filterable register, corrections, recoveries, and salary adjustment actions. |
| `GET /api/operations/payroll` | Admin-only monthly estimate with dated compensation and explicit advance recoveries. |
| `POST /api/integrations/telegram` | Validates the Telegram webhook secret and private sender allowlist, then records a deduplicated advance through the existing database routine. Disabled until Telegram variables are configured. |
| `GET /api/integrations/sheets-sync` | Requires a `CRON_SECRET` bearer token and syncs a bounded outbox batch to Google Sheets with retryable failures. Disabled until Google variables are configured. |

Public intake success is returned only after the database insert returns a record ID. The frontend requires `{ ok: true, id }` before showing success. Outbound email delivery is disabled, and the former admin message-to-applicant/complainant API and email sender were removed. Contact, complaint, and application records still persist; no Resend call is made.

## Admin features in the local implementation

- Database-backed counts for services, events, notifications, sites, guards, supervisors, field officers, advances, complaints, enquiries, applications, and profile documents.
- Database-backed Services, Events, and Notifications; public notification reads are restricted by RLS to active, published, unexpired records.
- Site create/edit/deactivate/safe-delete, service-specific client billing, staff selection, import preview, template, and export.
- Guard add/edit/deactivate/safe-delete, profile fields, private photo, multiple active site assignments, CSV/XLSX import preview and export. The import uses the same `save_guard_profile` routine as manual edits and accepts several site names/codes separated by semicolons.
- Supervisor and field-officer management, site assignment and reporting relationships, compensation and private profile fields. CSV export is available; bulk import for these two directories is not implemented yet.
- Advances for all three employee types, date/month/site/person filters, paginated results, filtered CSV/XLSX export, audited correction/reversal, and one salary-period recovery allocation per advance.
- Telegram advance entry code is present but disabled until separately configured and tested; it uses employee/site codes, a private-chat sender allowlist, webhook secret, database idempotency key, and original-message UTC timestamp.
- Google Sheets code is present but disabled. The server opts into outbox enqueue only when `GOOGLE_SHEETS_SYNC_ENABLED=true` and the sheet ID, valid service-account key, and sufficiently long `CRON_SECRET` are all present. Otherwise advance records do not create unsynced queue entries. No Vercel Cron job is configured.
- Salary estimates use monthly compensation, calendar-day proration, approved adjustments, and explicitly allocated recoveries. Joining and employment-end dates are inclusive; inactive status alone does not stop accrual. Advance events and recovery/adjustment entries use an exclusive next-month Asia/Kolkata midnight cutoff; `salary_period` assigns a recovery month. Daily guard rates are stored on the profile but are not included in estimates because attendance is not tracked. ESI/PF reference fields do not calculate automatic deductions.
- Company profile uploads are private by default; an admin must explicitly approve public material. The terms and privacy pages are drafts requiring owner/legal review.

## Security and operational limits

- Sensitive API writes verify the Supabase bearer session and admin membership server-side. Database routines repeat the admin check. New operational tables use RLS; financial correction and recovery rows are append-only for authenticated users, and audit-log writes are revoked from authenticated users.
- `employee-private` and `company-profile` are private buckets with administrator-only object policies. Public profile access uses an approved record and expiring signed URL.
- Express rate limits are process-local. They are useful in local development but are not an aggregate serverless limit. Publish a Vercel Firewall IP rate-limit rule for `POST /api/contact`, `/api/applications`, `/api/complaints`, `/api/guards/import` before production traffic.
- CAPTCHA is not implemented. Reassess only if Vercel Firewall controls and observed abuse require it; no CAPTCHA credentials are present.
- Telegram and Google Sheets code is implemented and covered by mocked regression tests, but neither integration is enabled or live-verified. The outbox migration is pending. Do not configure these integrations or add a production cron until separately approved. See `INTEGRATIONS_SETUP.md` for future Preview-only validation requirements.
- Production Auth settings such as MFA, public signup, and leaked-password protection must be checked in Supabase Dashboard. Enable leaked-password protection at **Authentication → Attack Protection → Leaked Password Protection**.
- Supabase CLI, Docker, and `psql` are not installed, and no explicitly identified isolated staging connection is configured. The migrations were reviewed as source only; they have not been parsed by PostgreSQL or applied to any database in this pass.
- Admin directory screens currently load a full authorized directory for client-side search/assignment views. Advances are paginated. Large-directory load testing and converting the remaining directories to server-side pagination remain open performance work.

## Supabase seed configuration

`supabase/config.toml` has `[db.seed] enabled = false` and `sql_paths = []`. There is no seed file and no invalid seed reference. Do not enable a production seed/reset workflow.

## Required production environment variables

| Variable | Where it is used |
| --- | --- |
| `SUPABASE_URL` | Vercel server runtime |
| `SUPABASE_SECRET_KEY` | Vercel server runtime only; never expose to the browser |
| `VITE_SUPABASE_URL` | Vite build/browser public client |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Vite build/browser public client |

Optional integrations are currently disabled and must stay disabled during this validation. If separately approved later, Telegram uses `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_IDS`, and `TELEGRAM_ADMIN_USER_ID`. Sheets additionally requires `GOOGLE_SHEETS_SYNC_ENABLED=true`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEET_ID`, and `CRON_SECRET` (at least 32 characters); `GOOGLE_SHEET_TAB` is optional. These are server-only settings. Do not configure them now or add a production Cron job.

`VITE_API_URL` remains empty for same-origin Vercel functions. `CLIENT_ORIGINS` is not required. `RESEND_API_KEY`, `EMAIL_FROM`, and `NOTIFICATION_EMAIL` are no longer used by this implementation and must not be added to `.env.example`. `PORT` is only for local Express development.

## Deployment order for the owner

1. Create or identify an isolated Supabase staging project and verify its project reference in Supabase Dashboard. Do not use Production.
2. In the staging SQL Editor, run `supabase/preflight_staging.sql` read-only. Resolve missing baseline history/schema prerequisites, public bucket findings, or duplicate normalized phone groups before considering migrations.
3. Back up staging. Review and apply the migrations in timestamp order in staging only. Verify migration history, private buckets, RLS, foreign keys, import behavior, payroll boundaries, assignment closure, and transaction rollback using synthetic records.
4. Point a Vercel Preview deployment only at staging and add the Vercel Firewall IP rate-limit rule before public testing.
5. In Supabase Dashboard, enable leaked-password protection at Authentication → Attack Protection → Leaked Password Protection; review signup, redirect, and admin membership settings.
6. Run the Preview workflows and denied-access/storage tests. Keep Telegram, Sheets, email, and Vercel Cron disabled.
7. Production migration and deployment require a separate review and explicit release decision. Do not apply migrations to Production during staging validation.

## Verification status

- Current local verification: `npm test` **PASS, 64/64**; `npm run build` **PASS**, with the existing ExcelJS chunk warning (~940 KB / 271 KB gzip); `npm audit --audit-level=moderate` **PASS, 0 vulnerabilities**; `git diff --check` **PASS**.
- Static SQL migration contract tests and JS policy examples do not execute PostgreSQL. No SQL was executed in this worktree; staging execution is blocked because no explicitly identified staging database or local PostgreSQL tooling is configured.
- Telegram and Google behavior is tested with mocked providers only. No Vercel deployment, credential-backed integration test, load test, or real-user test was performed.
