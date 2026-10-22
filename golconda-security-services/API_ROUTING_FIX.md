## API routing correction — Preview release; production approval required

Production diagnosis on 22 October 2026: GET /api/health returns JSON 200,
while POST /api/operations/guards, /sites and /people returns text/plain 404
with x-vercel-error: NOT_FOUND. These nested requests do not reach Express.
The previous deployment relied on automatic routing of api/[...path].js;
local tests invoked the handler directly and missed the platform mapping gap.

The pending fix uses one api/index.js function plus an explicit Vercel rewrite:
/api/:path* -> /api/index?__route=:path*. It preserves original request paths
when supplied by Vercel; otherwise it reconstructs them from the internal
rewrite parameter. Business query filters, authorization, JSON validation,
method restrictions and body limits remain intact. Internal routing metadata
is removed before Express. No auth policies, database schema or data changed.

Guard headers now share one parser/server alias mapping, including Full Name,
Guard Full Name, Employee Name, Name of Guard, Staff Name, Mobile No. and
Contact No. Rich-text Excel headers work; duplicate aliases are rejected.
Guard and Site imports share strict calendar validation for ISO, DD-MM-YYYY,
DD/MM/YYYY and DD/MM/YY. Owner-approved century rule: 00–49 -> 2000–2049;
50–99 -> 1950–1999. Invalid calendar dates are rejected, not rolled forward.
Excel Date cells use UTC date parts. Existing Excel serial support remains.

Frontend requests display HTTP status and structured safe API messages.
Raw HTML/plain-text platform errors and credential-like strings are not echoed;
non-JSON success responses are rejected instead of producing false success.

### Release steps (approval required)

1. Review these changes. The owner authorized a branch commit/push for Preview only.
2. After authorization, commit and push only codex/complete-implementation to
   create a Preview in the existing golconda-securityservices Vercel project.
   Root Directory remains golconda-security-services; no environment changes,
   migration, new project, Cron, integration activation or Pro plan is needed.
3. Confirm Preview READY and exactly one API function (api/index). Verify GET
   /api/health, /api/profile, company-profile and static assets. Send {} without
   authentication to POST /api/operations/guards, /sites, /people, /site-import
   and /api/guards/import: expect JSON 401 (not Vercel 404). Authenticated
   non-admins must receive 403. Test an admin request with an unknown action:
   expect JSON 400 and no persistence. Verify malformed JSON -> 400, wrong
   method -> 405, unknown API -> JSON 404. Keep Preview checks read-only or
   rejected because Preview uses the existing production Supabase project.
4. Check CSV/XLSX import previews using the accepted date/header examples;
   do not confirm imports or create real production records for verification
   without separate authorization.
5. Request production approval. Only after approval, merge to main and verify
   the existing production deployment READY, commit SHA, health, nested API
   authorization responses and frontend navigation on the original domain.

Automated tests simulate the Vercel rewrite boundary with real local HTTP,
Express authorization and mocked Supabase persistence. They do not execute a
Vercel deployment. Actual platform verification remains pending Preview release.

### Verification results

- npm test: 82/82 passed, including authorized create flows with mocked DBs.
- npm run build: passed; existing ExcelJS 940 KB chunk warning remains.
- git diff --check: passed.
- No deployed Vercel route/build verification of this fix was performed.
- No production records, database policies, credentials or environments changed.
- The owner authorized committing/pushing codex/complete-implementation for Preview. Production release remains blocked pending separate approval.

### Exact changed files (relative to golconda-security-services)

- api/[...path].js -> api/index.js (rename and rewrite path reconstruction)
- vercel.json
- shared/guardValidation.js
- shared/operationsValidation.js
- shared/importDate.js (new)
- shared/importDate.test.js (new)
- src/guardSpreadsheet.js
- src/guardSpreadsheet.test.js
- src/siteSpreadsheet.test.js
- src/api.js
- src/api.test.js
- src/main.jsx
- src/admin/GuardManagement.jsx
- src/admin/SiteManagement.jsx
- src/admin/PeopleManagement.jsx
- src/admin/AdvancesManagement.jsx
- src/companyProfile.test.js
- server/catchAll.test.js
- server/operations.test.js
- PROJECT_STATUS.md
- RELEASE_VERIFICATION.md
- API_ROUTING_FIX.md (new)

Inspected but unchanged: server/index.js and server/vercelAdapter.js. The
existing Express handlers already implement the routes and admin checks; the
legacy adapter is not the deployed entry point. No new package dependencies.

Routing reference: https://vercel.com/docs/routing/rewrites
