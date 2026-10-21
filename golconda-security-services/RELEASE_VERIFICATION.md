# Vercel Hobby release verification — 22 October 2026

The existing API wrappers have been consolidated into `api/[...path].js`.
Only this file is a deployable function; `server/vercel-endpoints/` preserves
the old adapters for compatibility tests. The catch-all forwards fourteen
supported routes to Express and preserves query filters and authorization.
Vercel supplies parsed JSON; malformed lazy JSON getters return 400, and
route-specific body limits remain enforced. Multipart API requests are rejected:
profile media and employee photos upload directly to private Supabase Storage.

`server/vercel-endpoints-backup/` is a local safety copy, ignored by Git.
Do not delete it or include it in a commit or deployment upload.

## Production database (read-only verification)

Existing project: `ntcvrxdyukfpobjvxxiz`. Five applied migrations were confirmed:

| Local source version | Applied production version | Migration |
| --- | --- | --- |
| 20261007160814 | 20261007160814 | operations_and_intake |
| 20261007160935 | 20261007160935 | tighten_admin_policies |
| 20261008164000 | 20261021201840 | public_profile_guard_management_notifications |
| 20261021151502 | 20261021201904 | operations_platform_core |
| 20261021191500 | 20261021201911 | advance_integrations_outbox |

Do not run `supabase db push` blindly: the three local source timestamps differ
from the already-applied production versions. No database migration is needed
for the API consolidation. Do not edit migration history without a separately
reviewed migration-history repair.

All 23 public tables have RLS enabled. Inspected sensitive employee, payroll,
advance, audit, and outbox policies require authenticated admin membership.
`company-profile` and `employee-private` buckets exist and are private.
Checked feature columns and nine required business/outbox routines exist;
the routines have fixed `pg_catalog` search paths. No production data or
policies were changed during this verification.

## Deployment and scope

The prior Preview at commit `779b337` is READY in Vercel, while the production
deployment of `36eebf2` failed. The older production deployment remains the
last successful production release. A fresh Preview must be checked after the
current fix is pushed. A READY build alone does not verify live API routing.

Project: `golconda-securityservices`, Vite, Node 24.x. Keep Root Directory set
to `golconda-security-services`. Keep same-origin `/api/*` URLs and the existing
security headers. No Pro plan or production Cron is required.

Outbound email remains removed. Telegram and Google Sheets must remain disabled;
no integration credentials, environment variables, or production settings were
changed. Required server variables remain `SUPABASE_URL` and
`SUPABASE_SECRET_KEY`; public build variables remain `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`.

69 local tests and the Vite production build passed. The ExcelJS size warning is
non-fatal. Tests cover the actual catch-all as well as parser, import, payroll,
authorization, and failure paths. Actual Preview routing, live authenticated
writes, media uploads, mobile layout, runtime logs, and environment scopes still
require deployed verification. Do not use production data for destructive tests.
