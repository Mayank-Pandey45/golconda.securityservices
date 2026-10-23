# Record management implementation and release notes

**State: local development branch only. Do not deploy this code before the new
migration is explicitly approved for production. No production migration was executed.**
Latest database rehearsal and release gates: [RECORD_MANAGEMENT_RELEASE.md](RECORD_MANAGEMENT_RELEASE.md).
Branch: codex/complete-implementation; base Preview commit f833e933.

## Architecture reviewed

The React/Vite admin dashboard reads Supabase with the user's authenticated
session and existing administrator RLS. Existing operational writes use Express
RPC adapters behind one Vercel api/index.js function. Public intake is persisted
by the backend; profile files and employee photos upload directly into private
Storage buckets. Existing payroll, advance corrections/recoveries, assignments
and audit trails are retained.

Read-only inspection of production metadata covered all public columns, foreign
keys, checks, public/storage RLS policies and existing lifecycle routines. No
business rows were read for this implementation. No production writes occurred.
Existing ALL policies allowed some browser metadata deletes and several UI
handlers removed files immediately. The new code replaces those paths.

## Module matrix (implemented locally; database execution pending)

| Module | Editing | Archive/deactivate/close | Restore | Permanent deletion |
| --- | --- | --- | --- | --- |
| Guards | Existing validated profile, compensation and multi-site editor | Archive/deactivate closes current links without deleting history | Returns inactive; assignments require explicit review | FK/audit/financial references block; ordinarily retained because operational rows are audited |
| Supervisors | Existing profile/reporting/compensation editor | Same, including closing current reporting links | Inactive; no automatic reassignment | Same retained-history restriction |
| Field Officers | Existing profile/reporting/compensation editor | Same | Inactive; no automatic reassignment | Same retained-history restriction |
| Sites | Existing atomic site/assignment editor | Archive/deactivate closes links; legacy guard pointer remains consistent | Inactive; no automatic deployment | Assignment, audit, legacy-pointer or financial references block |
| Services | Existing content editor via validated API | Hide/activate and archive | Hidden until separately activated | Archived records only; typed confirmation; FK and retained intake references checked |
| Events | Existing content editor via API | Hide/activate and archive | Hidden until activated | Archived records only, dependency checks and typed confirmation |
| Notifications | Existing schedule/severity/editor via API | Deactivate/unpublish or archive | Unpublished/inactive; explicit publish review required | Archived records only, dependency checks and typed confirmation |
| Profile documents/media | Metadata/file replacement and explicit public approval | Hide or archive; file retained | Private draft, never auto-published | Compliance retention blocks; other archived metadata can be removed when safe; file removal is separate |
| Contact submissions | Review notes and new/read/closed status | Close/reopen or archive | Original workflow state retained | Disabled: owner retention policy not provided |
| Job applications | Review notes and new/reviewing/closed status | Close/reopen or archive | Original workflow state retained | Disabled: owner retention policy not provided |
| Complaints | Review notes and pending/resolved status; resolved timestamp maintained | Close/reopen or archive | Original workflow state retained | Disabled: owner retention policy not provided |
| Advances, recoveries, corrections, salary adjustments | Existing audited correction/recovery/approval workflows | Not hidden or destroyed to simulate cancellation | Not applicable | No delete: append-only business history |
| Compensation and assignment/reporting history | Current configuration editors/version/closure workflows remain | End current links through domain editors | Historical links are never silently reopened | No browser update/delete of historical rows |
| Audit log and integration outbox | Read-only History view | No archive/edit controls | Not applicable | No management deletion |
| Media cleanup queue | Review/retry pending jobs | Referenced objects become retained; processing is reserved | Not a record restore mechanism | Physical orphan removal requires DELETE FILE <id> confirmation |
| Auth/admin membership | Existing Supabase Auth/admin membership | Unchanged, outside dashboard lifecycle CRUD | Unchanged | No new account-deletion capability |

Active/Inactive/Archived/All visibility filters exist on all lifecycle modules.
Existing operational filters (on leave, relieved, designation, site) remain.
Dashboard metrics continue to query database totals, including retained rows.
Services/events/public notifications and approved-profile API exclude hidden or
archived content. Admin read access still includes drafts/archives.

Original intake fields are immutable in the API and draft database trigger.
Only review notes/status and lifecycle metadata can change. No retention period
or statutory payroll policy was invented. Deactivation/archive does NOT change
joining/end dates, salary configuration, advances or payroll accrual. The prior
owner-approved calendar-month/inclusive-date payroll policy remains unchanged.

## API and permission boundary

POST /api/operations/records uses the existing single Vercel function (no new
serverless function). It checks Supabase getUser and admin_users membership
before validation or any RPC. Module/action/field/ID allowlists and scalar/URL/
visibility validation prevent arbitrary table access. Existing operational save
routes remain, and their legacy delete actions forward to the same confirmed,
dependency-checked lifecycle API. Table-write grants for authenticated users on
managed metadata are withdrawn in the draft migration, so browser REST writes
cannot bypass the server boundary. Existing RLS remains enabled and protects
reads. Privileged lifecycle RPCs are granted only to service_role and validate
the authenticated actor supplied by the server.

The SQL routines use fixed pg_catalog search paths and validated table/column
identifiers. Public catalogue policies become RESTRICTIVE; existing permissive
policies remain and therefore cannot bypass archived/hidden filtering. A small
SECURITY DEFINER boolean helper checks only the current auth.uid() membership
without granting public access to admin_users or employee data.

400 = invalid fields/confirmation; 401 = expired/missing session; 403 = not admin;
404 = missing record; 409 = retained dependencies/archive/conflict; 500 = safe
generic persistence/cleanup failure; 503 = required migration unavailable.
UI dialogs show failures inside the dialog. Permanent deletion requires the
exact record ID plus explicit acknowledgement; archive/restore also confirm.

Operational parent row locks and all inbound FK checks protect even CASCADE or
SET NULL relationships. Foreign keys are never disabled. Operational audit
references block deletion, compliance-document history blocks removal even
after category edits, and intake deletion stays disabled. Content deletion
retains its immutable audit snapshots. Legacy service labels are not relational
IDs: exact retained intake labels block service removal; archive is preferred.

A related record-identity bug was corrected: new advance selection now uses
employee_type:id rather than a numeric ID shared by several employee tables.
New advances cannot target archived records after the draft database guard is
installed; historical balances, recoveries and corrections remain available.

## Private media and orphan handling

Archive/hide never deletes a file. Metadata replacement/deletion queues old
objects in media_cleanup_queue in the same database transaction. Failed or
uncertain uploads request a queue entry; if the server is unavailable the UI
reports the private path for reconciliation instead of deleting blindly.

Cleanup is an explicit admin action: reserve the queue row/path, check all
current/archived references, then remove through the Supabase Storage API and
record completion/retry. It never issues SQL DELETE against storage.objects.
The file path is reserved against new attachments until the operation finishes.
Employee-photo audit references and compliance-media audit references retain
objects. Ambiguous legacy Storage URLs in content cause conservative retention
until manually normalized; shared objects are not assumed to be orphaned.
Authenticated browser Storage deletion and overwrite/move updates are blocked for the managed buckets. New uploads use fresh immutable paths.

A worker crash can leave processing reserved. There is deliberately no automatic
lease expiry or Cron. An operator must confirm no worker is running, inspect the
object and references, then reconcile the reservation under separate approval.
Audit records and cleanup requested/processed actor IDs are kept.

Already-issued public signed URLs remain usable until expiry (currently up to
one hour). Archive prevents new public URLs; it cannot revoke a URL already
shared. Never publish confidential files. Private bucket protections remain.

## Migration, prerequisites and rollout

New draft: supabase/migrations/20261022190000_record_management.sql.
Read-only prerequisite script: supabase/preflight_record_management.sql.
The migration was executed only in disposable in-memory PostgreSQL tests. The
preflight file was prepared; equivalent read-only production metadata queries
were executed. Neither file was applied to production.

Required: the existing 23-table operations schema, private company-profile and
employee-private buckets, operations_private.audit_operations_change(), current
assignment compatibility triggers and prior payroll/advance RPCs. Existing
migration timestamps differ between local feature sources and production;
reconcile documented history rather than blindly running supabase db push.

Changes: nullable archived_at/archived_by metadata and indexes on 11 tables;
is_active on services/events (existing rows default true); admin_notes on three
intake tables; one private cleanup queue; four service-only lifecycle/media RPCs;
a boolean admin helper; trigger guards/audit/cleanup; narrower metadata write
grants, historical update/delete grants and restrictive public/Storage policies.
archived_by stores a validated actor UUID without an Auth FK, so account deletion
cannot break archive-trigger invariants. Existing audit actor behavior remains.
The migration now has a 5-second lock timeout and 120-second statement timeout.
A compensation DELETE guard rejects the legacy same-effective-date monthly-to-
daily removal branch atomically. A dated salary transition requires review;
no salary, eligibility or proration policy was changed.
Client TRUNCATE privileges are explicitly revoked across all application tables;
the isolated fixture reproduces production default grants to verify this guard.

Approval gate:
1. Repeat the bundled in-memory PostgreSQL rehearsal with `npm test`.
   For full hosted verification, obtain an explicitly identified local Supabase
   stack or isolated database. No hosted staging project is configured here.
2. Run the read-only preflight there, review grants/policies/function signatures,
   bucket configuration and baseline migration history, and take a usable backup.
3. Only after approval, execute this migration transaction there. Do not reapply
   older feature migrations based on local filename timestamps.
4. Verify real PostgreSQL/RLS behavior as anon, non-admin, admin and service:
   archive/restore visibility; immutable originals; duplicate/conflicting input;
   dependency rejection for every FK type; no audit/financial deletion; closure
   dates and legacy pointer; new-link rejection for unavailable records; restore
   without reassignment; simultaneous reference/cleanup; failed Storage retry;
   worker interruption; old-client direct-write denial; signed URL expiry.
5. Re-run all tests/build, then point all four Preview Supabase variables only
   at that test database and rebuild Preview under separate authorization.
6. Production migration and application release require explicit owner approval,
   a fresh backup and an observed change window. ALTER TABLE and ordinary index/
   trigger creation acquire locks; do not assume zero-lock deployment.
   Deploy only after the approved migration is present. New public queries need
   its columns; deploying code first can break content loading.

## Rollback and recovery

The migration is wrapped in BEGIN/COMMIT: a failure before commit rolls back its
DDL atomically. Explicit rollback and failure-before-COMMIT were tested in
embedded PostgreSQL 17.5 against the production metadata fixture, including
restoration of prior table privileges and retention of synthetic business rows.
This is not a production backup-restore rehearsal.

After commit, prefer a forward fix or application rollback while KEEPING the
archive metadata, queue, audit rows, restrictive visibility policies, and delete
guards. Earlier application versions may lose edit/delete capability because
unsafe direct writes were intentionally revoked; this is safer than restoring
unchecked deletes. Archived/hide flags remain protected even under old clients.

Do not drop columns/tables or reset archive flags as a rollback: that loses
retention/public-visibility state. Do not restore broad write grants or remove
guards without a separately reviewed rollback migration and owner approval.
Export new metadata, queue and audit state first. If no production use occurred,
a DBA may design an inverse from the preflight privilege/policy snapshot, but
must preserve any queued files, audit snapshots and archived business records.
Physical file removal is irreversible through this application; restoring a
file requires a verified external object backup. Do not restore production over
new legitimate records to undo a smoke test.

## Verification scope

Release-preparation verification: **123/123 tests passed**, including actual
embedded PostgreSQL 17.5 migration/RLS/FK/rollback execution. Build, audit
(zero vulnerabilities) and whitespace checks passed. See the release report
for the remaining hosted-integration, concurrency and recovery gates.

Initial implementation verification on 2026-10-22: `npm test` passed 102/102 tests;
`npm run build` passed (existing ExcelJS chunk-size warning);
`npm audit --audit-level=moderate` reported zero vulnerabilities;
`git diff --check` passed (Git emitted only LF/CRLF conversion notices).
Only `.env.example` is tracked among environment files. No commit, push or
deployment was made.

Automated tests now also execute the actual migration, functions, triggers,
foreign keys, roles, restrictive RLS policies and transaction rollback in
disposable PostgreSQL 17.5 (PGlite 0.4.6). The public schema metadata fixture
contains no production business rows or credentials. Auth users/uid and Storage
objects are minimal local fixtures. Existing HTTP tests still mock hosted
Supabase/Storage calls. Hosted JWT verification, real Storage deletion, concurrent
transactions, load/lock timing and production-backup restoration are not covered.
No production writes, migrations, pushes or deployments were performed.

References:
- https://www.postgresql.org/docs/17/sql-createpolicy.html
- https://supabase.com/docs/guides/storage/management/delete-objects
