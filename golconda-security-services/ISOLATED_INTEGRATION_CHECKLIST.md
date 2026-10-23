# Record Management — isolated integration attempt, 22 October 2026

> Historical isolated-testing checklist. The owner subsequently waived Docker
> testing and authorized production release conditional on verified backups.
> Current status: [PRODUCTION_RELEASE_GATE.md](PRODUCTION_RELEASE_GATE.md).

## Release decision: BLOCKED

All existing work remains on `codex/complete-implementation`. No production
migrations, data writes/deletes, environment changes, merges, pushes or releases
were performed. No real employee or financial records were copied. No container
or hosted project was created, and no operating-system installation was attempted.

## Checklist

| Check | Status | Evidence / exact limitation |
| --- | --- | --- |
| Preserve existing implementation and development branch | PASS | Existing branch/worktree retained; no reset/discard |
| Disposable full local Supabase stack | BLOCKED | No Docker or Podman command/service found, Docker Desktop absent from its standard install path, WSL reports not installed, no DOCKER_HOST configured |
| Native Supabase alternative | BLOCKED | Official native runtime supports Linux and Apple-silicon macOS, not Windows; this host is Windows |
| Single Record Management migration, isolated PostgreSQL | PASS | Executed again by regression suite in in-memory PostgreSQL 17.5 using captured schema metadata and synthetic records |
| Migration on a full local Supabase stack | BLOCKED | Container runtime prerequisite unavailable; embedded PostgreSQL is not a full Auth/Storage stack |
| Role/RLS/foreign-key/lifecycle/rollback assertions | PASS | Executed PostgreSQL tests, including anon/non-admin/admin/service roles and current default grants |
| Actual Supabase Auth signup/login/JWT/PostgREST integration | BLOCKED | No local Auth/PostgREST services; role/JWT stand-ins cannot establish this result |
| Archive/restore and dependency conflicts in SQL | PASS | All operational types, content and intake families exercised; restore does not republish/reassign |
| Actual private Storage upload/read/delete/retry | BLOCKED | No local Storage service; existing Storage HTTP tests mock the provider |
| Cleanup reservation/reference/nonce/retry protections in SQL | PASS | Executed against synthetic storage metadata; not a real object deletion |
| Multi-session concurrency and lock-wait/deadlock behavior | BLOCKED | Embedded engine is single-connection; no native/container PostgreSQL server installed |
| Payroll amounts, advances, assignments and retained audit protection | PASS | Synthetic SQL regressions protect financial records and historical links; archive does not change joining/end dates or salary accrual |
| Same-effective-date compensation removal restriction | PASS | Database rejects destructive branch atomically; HTTP regression confirms actionable 409 and no false success |
| Production project identity | PASS | Read-only connector confirms ntcvrxdyukfpobjvxxiz, ACTIVE_HEALTHY, PostgreSQL 17.11 |
| Identify actual recoverable production database backup | BLOCKED | Available connector exposes no backup inventory; project health is not backup evidence. Workspace search found migration/preflight SQL, not a production data dump |
| Verify actual private-file backup / restoration | BLOCKED | No private-object backup artifact or restore proof available; no files were downloaded/exported |
| Regression suite rerun | PASS | npm test: 123 tests, 123 passed, 0 failed/skipped |
| Production build rerun | PASS | npm run build passed; existing ExcelJS large-chunk warning remains |
| Whitespace verification | PASS | git diff --check passed |
| Production release | BLOCKED | Integration and recovery gates remain; explicit production approval still required |

## Minimum owner action

1. Install and start **Docker Desktop** on this Windows machine, completing any
   Windows/WSL setup it prompts for. Confirm the engine is running (`docker info`
   succeeds). A working Docker-compatible engine supplied by your administrator
   is also sufficient. No hosted Supabase project or paid upgrade is needed.
2. Make the existing production backup inventory/artifacts available through an
   authenticated Dashboard session or provide the local path to an existing
   securely stored backup manifest. Do not paste database passwords, keys, tokens
   or backup contents into chat. If backups do not exist, arrange the read-only
   database export and separate private-object export described below.
3. After the remaining checks pass and backup evidence is verified, explicitly
   approve production migration/release. Current authorization excludes it.

## Next local run once the engine is available

- Use a separate disposable, unlinked local project directory. Do not run reset,
  db push or the old timestamp-mismatched feature migrations from the linked
  application directory. Confirm the runtime's endpoints are loopback-only and
  its database is local before any write. Keep local keys outside Git/logs.
- Initialize the stack using the installed CLI's current --help guidance, with
  PostgreSQL 17 and no Telegram/Sheets/email configuration. Reconstruct public
  schema from the reviewed production metadata; use the stack's real managed
  Auth/Storage schemas rather than the embedded test stand-ins. Recreate the
  two private buckets and their reviewed policies. No production rows/files.
- Apply only the new Record Management migration to this local baseline. Run
  the read-only postflight checklist, then create synthetic admin/non-admin
  users using actual local Auth and exercise the API with their issued tokens.
- Test uploads and signed reads, replacement/archival retention, cleanup claims,
  API removal failure/retry, completion nonce and interrupted processing. Keep
  application and Storage clients pointed only at the local stack.
- Use two independent sessions for archive vs. new assignment/advance and
  cleanup claim vs. new attachment. Check both interleavings and explicit
  conflict/retry behavior. A single connection or Promise.all on PGlite cannot
  verify this. Verify finances, assignments and audit history after every case.
- Re-run the full tests/build. Remove only the specifically identified local
  synthetic project/volumes after results are recorded; never use remote reset.

## Exact compensation restriction and normal-admin impact

Existing `save_guard_profile` stores monthly compensation in
`employee_compensation`. Its daily/no-monthly-salary branch tries to DELETE a
row whose `effective_from` equals the submitted `salary_effective_date` (or the
routine's current-date default). The new BEFORE DELETE guard rejects a matching
row removal with SQLSTATE 55000. The API returns HTTP 409 explaining that the
salary change was not saved. The whole RPC is atomic: associated guard edits,
assignment changes and compensation changes roll back together.

Example: monthly compensation already exists from 2026-10-01. Switching to
daily pay or clearing the monthly amount with the same effective date is blocked.
Changing to a later, reviewed effective date can close the earlier monthly row
without removing it, provided normal date/compensation validation also passes.
Do not choose an arbitrary date simply to avoid the guard. Attendance and daily
payroll calculations remain outside the existing payroll implementation.

Normal monthly salary edits and profile/site/lifecycle operations retain their
existing validation. The Guard editor preserves its loaded salary fields when
editing an existing guard. However, any save/import that submits daily/blank pay
and a date matching an existing compensation row will be blocked—even when the
operator mainly intended to edit a name/phone. Review inconsistent legacy pay
fields rather than dropping the compensation row. No new salary policy, joining
date rule or payroll accrual rule was introduced.

## Recoverable production backup procedure — prepared, NOT executed/verified

The official Supabase guidance distinguishes database recovery from object-file
recovery. A healthy project and a schema-only fixture prove neither. No actual
backup timestamp, file checksum or recovery success is asserted here.

1. Inspect Database → Backups for the EXISTING project, recording the successful
   checkpoint, available retention/recovery range and recovery owner. If an
   owner-managed logical backup is needed, follow the current Supabase CLI
   backup guide for roles, schema and data plus migration history and custom
   Auth/Storage policies. Use credentials supplied locally through secure means;
   do not reset production passwords or change settings just for this check.
2. Capture a consistent checkpoint during an agreed quiet/admin-write window.
   Keep exports encrypted and access restricted outside Git and the deployment
   directory. Record project ref, UTC timestamp, tool versions, sizes and SHA-256
   checksums. Check that exports contain the required operational/financial/audit
   tables and Auth recovery material; an application-only JSON export is not a
   complete database recovery mechanism.
3. Separately export every object from `employee-private` and `company-profile`,
   recursively and with pagination. Save a protected manifest containing bucket,
   full object path, size, content type and SHA-256 of downloaded bytes. Preserve
   bucket configuration and policies. Check every page/download for errors and
   compare metadata references with the manifest; report missing files rather
   than deleting references. Do not store public signed URLs as file backups.
4. Verify archive integrity/checksums and a restore rehearsal on a controlled
   recovery target, never production. Validate table counts, constraints,
   migration history, financial totals and referential links; restore files into
   private test buckets and compare hashes and referenced paths. Rehearse owner
   access and private-file reads without exposing restored confidential data.
5. Keep real recovery data separate from the synthetic development environment.
   No real-data restore is authorized into this task's test fixture; obtain an
   existing DBA recovery verification or separate approval for a protected
   recovery rehearsal. Record evidence and securely retire recovery copies.

The procedure has been checked against the official documentation, but its
execution and the recoverability of this project's actual backups remain
BLOCKED until the required environment, artifacts/access and evidence exist.

Sources:
- https://supabase.com/docs/guides/local-development/docker-and-native-runtimes
- https://supabase.com/docs/guides/platform/backups
- https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
