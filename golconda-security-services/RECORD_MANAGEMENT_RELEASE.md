# Record Management release verification — 22 October 2026

> Latest decision: the owner waived Docker/full isolated integration and
> authorized production release conditional on verified database/private-file
> backups. See [PRODUCTION_RELEASE_GATE.md](PRODUCTION_RELEASE_GATE.md).
> The release attempt stopped at unavailable backup access; production is unchanged.

## Decision

Latest full-stack attempt and PASS/BLOCKED checklist:
[ISOLATED_INTEGRATION_CHECKLIST.md](ISOLATED_INTEGRATION_CHECKLIST.md).
This Windows host has no usable container runtime or WSL installation; the
native Supabase runtime does not support Windows. Tests/build were rerun and
passed, but actual Auth/Storage/concurrent-session and backup recovery checks
remain blocked. No production changes occurred.

**Ready for further isolated integration verification; not yet approved for production.**
No production migrations, business-data writes/deletes, commits, pushes, merges,
deployment or environment changes were performed. Telegram, Google Sheets and
outbound email remain disabled. All existing work is preserved on
`codex/complete-implementation`, based on f833e933e32a5d73d47c5e66eeae07f03f4529e3.

## Production inspection (read only)

Project: `ntcvrxdyukfpobjvxxiz`; server PostgreSQL 17.11. Inspected the 23 public
tables' columns (including generated/identity columns), constraints, indexes,
RLS policies, grants, trigger definitions and 25 application/private functions.
All 23 public tables have RLS enabled. Production postgres/supabase_admin public
default ACLs auto-grant tables/functions/sequences to API roles; explicit
revocations must therefore be tested under those defaults. Both `company-profile` (20 MiB limit)
and `employee-private` (10 MiB limit) are private buckets. Normalized-phone
duplicate-group counts are zero separately for Guards, Supervisors and Field
Officers. No employee or submission records were exported.

| Applied production version | Feature | Local source filename version |
| --- | --- | --- |
| 20261007160814 | operations_and_intake | 20261007160814 |
| 20261007160935 | tighten_admin_policies | 20261007160935 |
| 20261021201840 | public_profile_guard_management_notifications | 20261008164000 |
| 20261021201904 | operations_platform_core | 20261021151502 |
| 20261021201911 | advance_integrations_outbox | 20261021191500 |

**Only new required migration:** `20261022190000_record_management.sql`.
Reviewed file SHA-256 (current local bytes):
`AA1A0477674DA87E14019F6948F6E17E249CC9A2444857CCF50631B6301E6541`.
Recompute from the frozen release file if Git normalizes line endings.
The other three differently timestamped feature files are already represented
in production. Do not blindly `db push`, re-run them or repair history without
checking the reviewed version mapping. Production has no Record Management
archive columns, queue or lifecycle RPCs yet.

Security advisor: leaked-password protection remains disabled. The owner should
enable it in Supabase Dashboard → Authentication → Sign In / Providers → Email
→ Password security → Prevent use of leaked passwords (availability depends on
the project plan). No setting was changed here. See the official remediation:
https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

## Exact required database changes

1. Add nullable `archived_at timestamptz` and `archived_by uuid` plus `(archived_at,id)`
   indexes on Guards, Supervisors, Field Officers, Sites, Services, Events,
   Notifications, Profile Docs, Contact Submissions, Job Applications, Complaints.
   No existing employee, payroll, assignment or intake row is removed.
2. Add `is_active boolean NOT NULL DEFAULT true` to Services/Events and
   `admin_notes text NOT NULL DEFAULT ''` to the three intake tables.
3. Add private `media_cleanup_queue`, its identity sequence, admin-only SELECT
   policy, service-only mutations and audit trigger. Actor FKs reference Auth
   users with SET NULL; archive actor metadata intentionally has no Auth FK.
4. Add service-only SECURITY INVOKER RPCs: `manage_admin_record`,
   `queue_media_cleanup`, `claim_media_cleanup`, `complete_media_cleanup`.
   The authenticated API supplies a verified administrator actor. Add the
   fixed-search-path SECURITY DEFINER boolean membership helper used by RLS;
   it exposes no employee/admin table rows. Private trigger helpers are revoked
   from PUBLIC/anon/authenticated; all helpers have fixed search paths.
5. Add lifecycle, immutable-intake, attachment/reference reservation, replaced-
   file queue, public-content audit, available-assignment and archived-advance
   guards. Add a compensation DELETE guard, described below.
6. Revoke authenticated direct writes to the eleven managed tables and direct
   update/delete of compensation and assignment/reporting history. Existing
   server domain RPCs, Auth and foreign keys remain enabled. No FK is dropped,
   disabled or changed to CASCADE.
   Explicitly revoke TRUNCATE from anon/authenticated on all 23 existing public
   application tables plus the new queue. RLS does not cover TRUNCATE; current
   default ACLs otherwise grant it. No legitimate dashboard workflow needs it.
7. Add restrictive public visibility policies and restrictive browser Storage
   DELETE/UPDATE policies. New immutable-path uploads and permitted reads remain.
8. Bound migration lock waits to 5 seconds and each statement to 120 seconds.
   These do not eliminate locking: normal index creation/ALTER TABLE can block
   writes, and transaction locks last until COMMIT. Use a quiet change window.

### Compatibility and business rules

Guards/Supervisors/Field Officers/Sites: archive/deactivate closes live site and
reporting links with valid end dates; historical links are retained. Multi-site
guard legacy pointers continue to select a surviving active assignment. Restore
leaves the record inactive and creates no assignments. Joining/end dates,
compensation, advances/corrections/recoveries and payroll accrual are untouched.
The legacy `sites.assigned_guards` string remains compatibility metadata; the UI
continues to use assignment tables for operational relationships.

Services/Events/Notifications: restored content remains hidden/inactive;
Notifications also remain unpublished. Permanent deletion requires archive,
typed confirmation and absence of dependencies. All inbound FK actions,
including CASCADE and SET NULL, are checked rather than allowed to alter children.
Exact service labels in retained enquiries/applications also block deletion.

Profile media: archive/restore never removes objects; restore is private.
Compliance current/audit references prevent permanent removal even after a
category change. Cleanup reserves an unreferenced path and requires a nonce to
complete/retry. Processing jobs have no automatic expiry. Audit-retained employee
photos and ambiguous legacy Storage URLs are conservatively retained. Already
issued signed URLs may remain valid for up to one hour. Physical file recovery
requires an independent object backup.

Contacts/Applications/Complaints: originals are immutable, notes/status remain
editable, close/reopen and archive/restore work; no permanent delete until an
owner-approved retention policy exists. Complaint resolution timestamps follow
status. Audit and financial records are not lifecycle deletion targets.

**Discovered existing hazard and local fix:** `save_guard_profile` has a legacy
same-effective-date monthly-to-daily/no-monthly-salary branch that deletes its
compensation row. The new BEFORE DELETE guard rejects that branch atomically
with an actionable HTTP 409. Existing compensation remains. Review a dated
salary transition; this does not invent salary/proration policy. The block is an
intentional restriction that administrators must know before release.

## Executed isolated database rehearsal

Final verification: `npm test` **123/123 passed**, including executed database,
permission, FK and rollback assertions; production build passed; dependency
audit reported **0 vulnerabilities**; `git diff --check` passed. The production
build's existing ExcelJS large-chunk warning remains. Only placeholder
`.env.example` is tracked; no credentials were added to the schema fixture.

No Docker/PostgreSQL executable was found on PATH and no hosted isolated project
was configured. The practical alternative used is **in-memory PostgreSQL 17.5
via pinned development-only PGlite 0.4.6**, matching production's major version.
It has no database URL, network connection, production keys or production rows.

Reproduce after `npm ci`:

```powershell
node --test server/recordDatabase.test.js
npm test
npm run build
npm audit --audit-level=moderate
git diff --check
```

`supabase/tests/production-schema-metadata.json` is a schema-only fixture captured
from the read-only inspection. The helper recreates public columns, generated
phone fields, constraints, indexes, functions, triggers, RLS and table grants.
Auth users/uid and Storage objects are minimal stand-ins. Existing function
creation privileges are reconstructed; this is not a full hosted Supabase clone.
Production postgres default ACLs for new tables/functions/sequences are also
reproduced before applying the migration, including tests for explicit function,
sequence and TRUNCATE revocations. Roles used for RLS checks are non-superuser anon/authenticated; service_role has
BYPASSRLS as in the application trust boundary.

Tests execute the real migration SQL, preserve pre-migration synthetic finance
and payroll amounts, exercise every operational type and content/intake family,
test anon/non-admin/admin permissions, all three inbound FK deletion actions,
restore without reassignment/publishing, immutable originals, cleanup references,
nonce/retry, compliance history and the legacy compensation conflict.

Two rollback paths are executed: replace the final COMMIT with ROLLBACK; and
inject an error immediately before COMMIT then ROLLBACK. Both remove the new
DDL/queue and preserve existing synthetic business rows; prior grants return.
The original migration file is never altered for these rollback tests.

### Limits / remaining release gates

- This is a single-connection WASM PostgreSQL 17.5 rehearsal, not the exact
  hosted 17.11 runtime. Multi-session races/deadlocks, realistic lock timings and
  large-data index performance are **not tested**.
- Real Supabase JWT/PostgREST grants, private file upload, signed URL expiry,
  Storage API deletion/retry and interrupted worker reconciliation still need
  an isolated full Supabase stack. The existing HTTP tests mock Storage.
- No fresh production database/data/object backup has been restored and
  validated during this task. A schema-only fixture is NOT a data backup.
- The owner must approve the restricted same-day salary transition and the
  release window/production migration. Intake/compliance permanent deletion
  stays disabled; no retention duration is assumed.
- Leaked-password protection remains an owner security setting; ExcelJS still
  produces the existing large-chunk build warning.

Safest next practical step: run a local Supabase/PostgreSQL 17 stack (Docker or
an isolated machine), use this reviewed schema-only baseline and synthetic
records, then execute the migration and the same SQL assertions. Connect only
that local stack for actual Auth/Storage tests. Use two independent database
sessions to test archive vs. assignment/advance creation and cleanup claim vs.
new attachment; assert either serialization or an explicit retry with no data
loss. Do not repoint Preview to production for these write tests. No new hosted
project is needed, and no production rollback-only rehearsal is proposed.

## Approved production rollout procedure (NOT executed)

1. Freeze the reviewed commit and SQL checksum; repeat the read-only preflight
   and compare migration history/columns/grants with this report. Resolve drift.
2. Verify a fresh recoverable database backup AND private-object backup; rehearse
   restoring them off production. Record checkpoint, recovery owner and window.
3. Complete the integration/race checks above. Obtain explicit production
   approval; temporarily avoid concurrent admin mutations during the window.
4. Apply ONLY the reviewed Record Management SQL using the Supabase migration
   mechanism (`apply_migration` with the exact SQL and descriptive migration
   name), not raw untracked SQL, reset or blind `db push`. The migration is one
   transaction. Record the actual applied version/name/checksum; the mechanism
   may assign a new timestamp, so reconcile it with the local source version.
5. If lock/statement timeout or any error occurs: stop, verify transaction and
   history state, and investigate. Do not bypass guards, extend locks blindly,
   partially resume the SQL or redeploy against a half-reviewed state.
6. Verify all 11 archive column pairs/indexes, two active flags, three notes
   fields, queue/RLS/grants, four RPC privileges, helpers and triggers, Storage
   policies and existing FK/financial constraints. Confirm migration history
   entry and unchanged pre/post business-row counts and financial aggregates.
   Run `supabase/postflight_record_management.sql` read-only: every result must
   pass. The bundled isolated test executes this checklist against the migrated
   schema; it complements, rather than replaces, Auth/Storage integration checks.
7. Only then release the application under separately explicit merge/deployment
   approval. New queries depend on the new columns; code-first release is unsafe.
8. Verify production health and read-only public/admin paths. Creation/deletion
   smoke tests on production need their own explicit data-write approval.

## Rollback procedure

Before commit: the tested transaction rollback restores prior DDL/grants; no
existing data is removed by the migration itself. The migration mechanism's
history write must also be confirmed absent after failure.

After commit: stop new admin mutations, keep archive flags, queue, audit history,
restrictive policies and delete guards. Roll back application code to the known
previous version if necessary; older direct browser editors will safely fail
instead of bypassing retained-history restrictions. Do not restore old grants,
unhide archived content or drop metadata to make the old UI write again. Prefer
a reviewed forward fix. Export any new state before a DBA considers an inverse.
There is deliberately no destructive automatic down migration. A later inverse
requires its own approval and rehearsal, based on actual usage after release.

Removed private objects cannot be recovered by SQL rollback. Reconcile every
processing claim and restore from the verified object backup if needed. Never
overwrite newer legitimate production records with a blanket backup restore.
