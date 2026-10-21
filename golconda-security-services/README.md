# Golconda Security Services

Responsive React/Vite company website and admin operations dashboard, using Supabase for authentication, database and private file storage, with Node.js API functions on Vercel.

## Local development

Use Node.js 22.9 or newer and npm:

```sh
npm ci
npm run dev
```

Vite runs on `http://localhost:5173`; the local Express API runs on port 4000. Vite proxies same-origin `/api/*` calls to Express. Use `npm test` for the unit/API suite and `npm run build` for the production frontend build.

## Architecture

- `src/` contains the React public site, Supabase Auth integration, and admin modules.
- `api/` contains one Vercel Function wrapper per real `/api/*` route. Shared adapter code is in `server/vercelAdapter.js`, outside `api/`, to prevent Vercel from discovering a helper as a route.
- `server/` contains Express route handlers, validation, Supabase service client initialization, operations workflows, and the Vercel adapter.
- `shared/` contains input normalization shared by browser previews and server-side validation.
- `supabase/migrations/` contains schema and RLS changes. Review and apply them in order before deploying features that depend on them.
- `public/` contains the logo, sitemap, robots file, and draft Terms and Privacy pages.

The browser always calls `/api/...` on its current origin. Production does not configure CORS or `CLIENT_ORIGINS`; local development uses only the Vite proxy. `vercel.json` configures response security headers and long-lived caching for content-hashed assets.

## API routes

- `GET /api/health` — checks live Supabase reachability.
- `GET /api/profile` — returns only approved public profile documents and short-lived signed object links.
- `POST /api/contact`, `/api/applications`, `/api/complaints` — validate and persist submissions. Success is shown only after the API confirms a saved record ID. No outbound email is sent.
- `POST /api/guards/import` — admin-authenticated guard CSV/XLSX import.
- `POST /api/operations/sites`, `/api/operations/site-import` — site management, staff assignments and transactional site import.
- `POST /api/operations/people` — supervisor and field-officer management.
- `POST /api/operations/guards` — guard management and multi-site assignments.
- `GET, POST /api/operations/advances` — filtered/paginated register, record corrections, salary recoveries, and adjustments.
- `GET /api/operations/payroll` — monthly salary estimates.

Vercel function wrappers enforce methods, content types, and body limits. API mutations verify a Supabase bearer token and `admin_users` membership server-side; database routines also verify the administrator.

## Supabase and data

Services, Events, and Notifications are database-backed. Public notification reads are restricted by RLS to active and published records. Complaint, contact, and job submissions persist in Supabase. Private guard and employee details are admin-only; public company profile files require explicit publication approval.

The live schema currently has the two 7 October migrations applied. The 8 October profile/notification migration and 21 October operations migration remain pending. The latter adds supervisors, field officers, assignment history, compensation, financial records, RLS and audit routines. See [PROJECT_STATUS.md](./PROJECT_STATUS.md) before applying either migration.

Legacy `guards.site_id` remains a compatibility pointer to one active site; the UI uses `guard_site_assignments` for the multiple-site source of truth. `sites.assigned_guards` is not used by the UI. Payroll estimates exclude daily guard rates and automatic ESI/PF deductions; see the admin disclosure and project status.

## Vercel environment variables

Configure these four values for each intended Vercel environment:

| Variable | Scope |
| --- | --- |
| `SUPABASE_URL` | Server runtime |
| `SUPABASE_SECRET_KEY` | Server runtime only; never browser-visible |
| `VITE_SUPABASE_URL` | Vite build/browser |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Vite build/browser |

Keep `VITE_API_URL` empty; calls are same-origin. `CLIENT_ORIGINS` is not required. `RESEND_API_KEY`, `EMAIL_FROM`, and `NOTIFICATION_EMAIL` are not used. `.env.example` contains no secrets; `PORT=4000` is only a local development default.

Optional Telegram and Google Sheets variables are listed in `.env.example` and described in [INTEGRATIONS_SETUP.md](./INTEGRATIONS_SETUP.md). They are server-only and should be configured only after the matching migrations are applied and Preview verification is complete. Google sync also requires a scheduler that calls the authenticated worker.

In Vercel, use the repository's `golconda-security-services` project root, `npm ci`, `npm run build`, output directory `dist`, and a Node.js runtime meeting the package engine. Keep Preview on a non-production Supabase project.

## Manual production prerequisites

1. Apply the pending migrations to a staging Supabase project, inspect RLS and private buckets, then apply them to production in timestamp order.
2. Enable leaked-password protection in Supabase Dashboard → **Authentication → Attack Protection → Leaked Password Protection**; verify public signup and admin membership settings.
3. Publish a Vercel Firewall IP rate-limit rule for the public form and guard-import `POST` routes. The in-process Express limiter is not shared across serverless instances.
4. Preview-test the functions, public forms, admin operations, and financial flows before promoting to the canonical domain.

Telegram advance entry and Google Sheets sync are implemented but remain unconfigured and unverified against real credentials. The current Google outbox migration queues new advances only. Safe setup and verification steps are documented in [INTEGRATIONS_SETUP.md](./INTEGRATIONS_SETUP.md). Load-test instructions are in [SECURITY_AUDIT.md](./SECURITY_AUDIT.md); the k6 script is `scripts/k6-load.js`.

The Terms and Privacy pages are drafts and need owner/legal review. No live migration, commit, push, or deployment was performed as part of this task.
