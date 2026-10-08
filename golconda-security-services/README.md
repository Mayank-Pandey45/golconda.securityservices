# Golconda Security Services

Responsive React/Vite site with a Vercel-hosted serverless API and Supabase-backed public content and administration.

## Local development

Requirements: Node.js 22.9 or newer and npm.

```sh
npm ci
npm run dev
```

Vite runs on `http://localhost:5173`; the local Express API runs on port 4000. Vite proxies relative `/api/*` requests to Express. `npm test` runs the API and date-format tests; `npm run build` creates the static frontend in `dist/`.

## Architecture

- `src/` contains the React frontend. It calls Supabase directly with the public publishable key for public content, Supabase Auth, and admin operations governed by RLS.
- `api/` contains one Node.js Vercel Function per existing Express endpoint. The functions reuse the Express route handlers but do not serve static files; Vercel serves the Vite output separately.
- `server/` contains shared API validation, Supabase service client, Resend integration, and the Express app used by local development.
- `supabase/migrations/` contains the additive database schema and policy changes for operations and intake submissions.

All browser API requests are relative same-origin paths under `/api/`. Vercel serves the frontend and its API functions from the same deployment, so `CLIENT_ORIGINS` and `VITE_API_URL` are not required. No `vercel.json` is needed: this app uses hash anchors and has no client-side pathname routes; Vercel detects Vite and the `api/` functions from the project root.

## API endpoints

- `GET /api/health` — checks Supabase connectivity and reports safe configuration flags; returns 503 if Supabase is unavailable.
- `POST /api/contact` — validates and stores contact enquiries, then attempts a Resend email.
- `POST /api/applications` — validates and stores job applications, then attempts a Resend email.
- `POST /api/complaints` — validates and stores complaints, then attempts a Resend email.
- `POST /api/send-message` — sends an admin message through Resend after verifying the Supabase bearer token and `public.admin_users` membership.

Intake endpoints return success only after the row is stored. If email delivery fails after persistence, the response clearly reports that the record was saved and email was not sent. The Express rate limiter remains useful in local development. Vercel production requires a published Firewall rate-limit rule because in-memory function state is not shared across serverless instances. Create one rule matching `POST` and the path expression `^/api/(contact|applications|complaints)$`, keyed by IP, with a fixed window of 10 requests per 10 minutes and the default 429 action. Vercel currently supports Firewall rate limiting on all plans; quotas and pricing vary by plan.

## Supabase and administration

Public visitors can read services, events, and notifications. Admin users sign in with Supabase Auth; the frontend verifies membership in `public.admin_users`. Admin CRUD for services, events, notifications, sites, guards, complaints, profile documents, contact submissions, and applications uses the public Supabase client under RLS. Guards are assigned through `guards.site_id`; the legacy `sites.assigned_guards` field is not used for assignment display.

Public submissions and admin email delivery use the server-only Supabase secret key. Create the admin Auth user and add its UUID to `public.admin_users` using an authorized database session. Never expose the secret key or Resend API key to the browser.

The project migrations are additive and preserve existing content. Confirm these migrations are applied to the Supabase project before deploying:

- `20261007160814_operations_and_intake.sql`
- `20261007160935_tighten_admin_policies.sql`

No Vercel-specific database migration is required. The current project has no Supabase Storage upload bucket; the profile vault manages external document URLs only.

Enable Supabase leaked-password protection in Dashboard → **Authentication → Attack Protection → Leaked Password Protection**.

## Vercel deployment

Import the Git repository in Vercel and set **Root Directory** to `golconda-security-services`. Use a Node.js version satisfying the package engine (`>=22.9`; Vercel Node 22.x or 24.x works), Vite, install command `npm ci`, build command `npm run build`, and output directory `dist`. Leave the root directory included in the build. Do not configure a Render service or a separate API origin.

Add these variables in Vercel Project Settings → Environment Variables for the environments you will use:

| Variable | Scope | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Server runtime | Supabase project URL for server API functions |
| `SUPABASE_SECRET_KEY` | Server runtime only | Privileged writes and admin token verification; secret key, never browser-visible |
| `VITE_SUPABASE_URL` | Build/browser | Supabase project URL for public client |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Build/browser | Public Supabase publishable key |
| `RESEND_API_KEY` | Server runtime only | Resend email delivery key |
| `EMAIL_FROM` | Server runtime | Verified sender address/name in Resend |
| `NOTIFICATION_EMAIL` | Server runtime | Destination for intake notifications |

`CLIENT_ORIGINS` is not required: frontend and API share one Vercel origin, and the API does not grant cross-origin browser access. `VITE_API_URL` is intentionally removed; the frontend always calls same-origin `/api/*`. Vercel supplies `NODE_ENV` and the function port.

Before enabling public traffic, create and publish the Firewall rule for the three intake `POST` routes, then verify `/api/health`, a contact submission, a complaint, an application, admin login/CRUD, and a test Resend delivery. If Vercel Preview deployments use production Supabase data, protect them or configure preview variables to use a non-production Supabase project.

## Project status

See [PROJECT_STATUS.md](./PROJECT_STATUS.md) for current migrations, tests, and operator actions.
