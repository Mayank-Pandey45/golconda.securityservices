# Project Status — 2026-10-08

## Current architecture

- React 18/Vite serves the public site and admin dashboard as static frontend assets.
- Supabase JS in the browser handles public reads, Supabase Auth, and admin CRUD subject to RLS. The frontend uses only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
- The existing Express routes are still used by local development. Vercel exposes each route through a Node.js serverless function under `api/`; the Vite `dist/` frontend is deployed separately by Vercel's Vite support.
- Frontend API calls are always same-origin `/api/*`. Production CORS allowlists and `CLIENT_ORIGINS` are unnecessary for this deployment model. The Vite proxy to localhost:4000 is development-only.
- Render-only `render.yaml` was removed. There is no `vercel.json` because the app uses hash anchors rather than pathname routing; Vercel's Vite detection and `api/` function discovery provide the required deployment behavior.

## API and behavior

Vercel functions are present for `GET /api/health`, `POST /api/contact`, `POST /api/applications`, `POST /api/complaints`, and `POST /api/send-message`. They reuse the same Express validation and persistence logic as local development. The Vercel adapter avoids reparsing JSON bodies already parsed by the Vercel Node runtime and restricts each function to its intended HTTP method.

Health checks query Supabase and return 503 on missing configuration or a database error. Intake rows are persisted before email notification is attempted; an email failure is returned as a warning and cannot produce a false database failure or undo the stored row. Admin messaging validates a Supabase bearer token and `public.admin_users` membership before sending.

The existing 10 requests per IP per 15 minutes Express limiter is process-local and therefore only a local/development safeguard under Vercel's horizontally scaled serverless execution. Before public traffic, create and publish one Vercel Firewall rule matching POST plus path expression `^/api/(contact|applications|complaints)$`; use an IP key, fixed window, 10 requests per 10 minutes, and default 429 action. Vercel currently lists WAF rate limiting on all plans; quotas and pricing vary by plan.

## Supabase data and security

Existing tables: `admin_users`, `services`, `events`, `notifications`, `complaints`, `sites`, `profile_docs`, `guards`, `contact_submissions`, and `job_applications`.

Services, events, notifications, sites, guards, complaints, contact submissions, and job applications are database-backed. Admin dashboard counts use exact Supabase table counts. Services/events/notifications public display and admin CRUD are database-backed. Guard-site assignments use `guards.site_id`; the compatibility `sites.assigned_guards` field is not used to derive UI assignments.

Tracked additive migrations:

- `supabase/migrations/20261007160814_operations_and_intake.sql`
- `supabase/migrations/20261007160935_tighten_admin_policies.sql`

These were previously confirmed applied to the connected Supabase project; confirm migration history before a new environment is used. Existing data was preserved. After explicitly removing the two identified placeholders, the last verified production counts were services 5, events 2, and notifications 2; sites, guards, complaints, contact submissions, and applications were 0, and profile documents were 1. No database changes are required specifically for Vercel.

Supabase Auth leaked-password protection is a manual Dashboard setting: **Authentication → Attack Protection → Leaked Password Protection**. It is not changed by application code.

## Environment variables

Set these Vercel Project environment variables:

- Server runtime only: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `NOTIFICATION_EMAIL`.
- Vite build/browser: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.

`SUPABASE_SECRET_KEY` and `RESEND_API_KEY` must never use a `VITE_` prefix. `CLIENT_ORIGINS` is not required for same-origin Vercel functions. `VITE_API_URL` is removed so API calls cannot silently point to another host. `NODE_ENV` and the function port are managed by Vercel. `.env.example` contains blank placeholders only.

## Vercel deployment steps

1. Import the repository in Vercel and set Root Directory to `golconda-security-services`.
2. Use Vite, install command `npm ci`, build command `npm run build`, and output directory `dist`.
3. Add the seven environment variables above to Production. Configure Preview/Development separately; avoid pointing untrusted Preview deployments at production data.
4. Deploy a Preview first. Verify the API functions and admin flows there.
5. In Vercel Firewall, create and publish the IP-based rate-limit rule for the three public intake POST paths (10 requests per 10 minutes).
6. Configure Supabase Auth leaked-password protection, confirm migrations/admin user, then promote the verified deployment to Production.
7. Verify production health, all three public forms, admin authentication/CRUD, and a safe Resend message.

## Verification status

Vercel API route wrappers, same-origin API URL behavior, body-size/content-type checks, and updated documentation are in place. `npm test` passes (16 tests), `npm run build` succeeds (1,622 modules), `npm audit --audit-level=moderate` reports zero vulnerabilities, and `git diff --check` passes. Vercel deployment and live forms/email verification have not been run. No commit, push, or deployment has been made.
