# Free manual production backup — Windows

**Prepared, not yet executed against production.** No paid plan, Docker,
production password reset, migrations or production data changes are required.
Existing production release authorization remains conditional on verified
database AND private-file backups. Do not treat an unexecuted script or the
schema-only test fixture as a backup.

## Exact blockers on this machine

- PostgreSQL **18.6** clients are now installed and verified at
  `C:\Program Files\PostgreSQL\18\bin`. Pass this directory with `-PgBin`.
  Matching PostgreSQL 17 and 18 client toolchains are supported for the expected
  production PostgreSQL 17 server; older, mixed or unsupported clients fail closed.
- No direct PostgreSQL password/connection or pgpass configuration is available.
- The Supabase connector can run SQL but cannot perform a pg_dump or download
  private files. An API key is not a PostgreSQL database password.
- No real backup export, integrity check or restore rehearsal has succeeded.
  Production migration/deployment remains stopped at this gate.

## 1. Install client tools (free, no server/Docker needed)

Use the official PostgreSQL Windows download page:
https://www.postgresql.org/download/windows/

Choose PostgreSQL **17 or 18** command-line tools. The official page also links a
binary ZIP, which can be extracted without installing a server. Locate the
directory containing all four EXEs: pg_dump, pg_restore, pg_dumpall and psql.
Default script directory: `C:\Program Files\PostgreSQL\17\bin`.
Your installed directory: `C:\Program Files\PostgreSQL\18\bin`.
For another location, pass `-PgBin 'C:\your-client-folder\bin'` to both commands
below. No Windows database service is needed merely to create/read an archive.

## 2. Configure authenticated access securely, only on your computer

In the existing project's Supabase **Connect** panel, choose **Session pooler**
on port **5432**, database `postgres`, user `postgres.ntcvrxdyukfpobjvxxiz`.
Copy its actual hostname; do not guess it. This avoids needing direct IPv6.
The direct connection is also supported if reachable: host
`db.ntcvrxdyukfpobjvxxiz.supabase.co`, user `postgres`, port 5432.
Do not use the transaction-pooler port 6543.

Have the EXISTING database password ready. It is not your Supabase account
password or an API key. If it is unknown, obtain it from your own password
manager/admin; do not reset a live password as part of this workflow.

Also obtain the existing server secret/service_role key from this project's API
Keys settings or your authorized secret store. An anon/publishable key cannot
back up private buckets. Do not put the key in VITE_* or send it in chat.

Open local PowerShell in the application folder and run:

```powershell
cd 'C:\Users\Mayank Pandey\Documents\ChatGPT\golcondasecservices\golconda-security-services-worktree\golconda-security-services'
.\scripts\manual-backup.ps1 -PgBin 'C:\Program Files\PostgreSQL\18\bin' -Configure
```

It prompts for host/user (not secrets), then two **hidden** secrets. Credentials
are encrypted with Windows DPAPI for the current Windows user using Export-Clixml,
inside an access-restricted folder outside Git. No password/key goes into command
arguments, source code, shell history, `.env` files or output.

Default backup root: `C:\Users\Mayank Pandey\Golconda Backups`.
Only the current user, SYSTEM and Administrators receive folder access. The
credential files need this Windows user/machine to decrypt. Database archives
themselves are compressed, not encrypted: keep the restricted folder on a
protected disk and any off-machine copy on encrypted storage.

Folder hardening updates only the DACL via .NET Access-only descriptors, removes
inherited/explicit unrelated permissions, and reads the result back from disk.
It never requests SACL/auditing access or changes ownership, so SeSecurityPrivilege
and Administrator elevation are not needed when your account can manage the
folder's DACL. A denied or unverifiable permission change stops before credential
or backup writes. Existing encrypted credential contents are not rewritten.
`-Configure` now refuses to overwrite any existing configuration/credential file;
if already configured, skip it and use the backup command in step 3 directly.

### Correcting an incorrectly configured password/key

Use **-Reconfigure** explicitly. All four values (host, username, database password
and server Storage key) are prompted again; passwords/keys remain hidden:

```powershell
.\scripts\manual-backup.ps1 -PgBin 'C:\Program Files\PostgreSQL\18\bin' -Reconfigure
.\scripts\manual-backup.ps1 -PgBin 'C:\Program Files\PostgreSQL\18\bin'
```

For the Session pooler enter `postgres.ntcvrxdyukfpobjvxxiz`, NOT `postgres`.
The full username is set in PGUSER and supplied explicitly via --username to
psql, pg_dump and pg_dumpall. The database role reported by the pooler/backend
may still be postgres; that is distinct from the pooler's full login username.

The replacement is staged as one DPAPI credential bundle in the protected
credentials directory, read back, checked for encryption and validated against
the entered values. A short read-only PostgreSQL version query validates the
database login; a read-only bucket listing validates server-key access to both
private buckets. Process output/errors are captured privately in memory, never
written to credential-validation logs or printed as raw provider errors.
Incorrect credentials, cancellation, encryption failure, unavailable services or
commit failure leave the current credential state active and unchanged.

Only after all checks pass is `credentials.bundle.xml` activated with one
same-directory atomic rename/replacement. Host and both credentials therefore
switch together. The previous bundle is retained as an encrypted `.previous-*.xml`
file; legacy connection.json/database.xml/storage.xml remain untouched. Backup
reads prefer the complete active bundle, with legacy loading supported when no
bundle exists. An exclusive lock prevents mixed generations during concurrent
configuration/read operations. No delete-then-copy fallback is used.

These commands update local encrypted credentials, not the Supabase database
password or production settings. No production migration/deployment is run.

If a company execution policy blocks local scripts, ask the administrator to
approve the reviewed script. Do not disable security policy globally.

## 3. Create the backup

Avoid other admin uploads/edits while the export runs; the script does not
change production settings or lock the website into maintenance mode.

```powershell
.\scripts\manual-backup.ps1 -PgBin 'C:\Program Files\PostgreSQL\18\bin'
```

Each run creates a new UTC timestamped folder, refuses destinations under Git or
through junctions/symlinks, and never overwrites an earlier backup. A failed run
leaves partial files for private investigation and does NOT create the final
verification marker. Tell the release agent only that local configuration is
ready or provide the backup folder path, never credentials or backup contents.

## What the workflow does

1. Confirms the known project host/user, PostgreSQL server major 17, encrypted
   connection (`sslmode=require`) and matching client toolchain major 17 or 18.
   Clients must not be older than the server. Sets process-local read-only defaults.
2. Uses **pg_dump --format=custom**, without schema/table exclusions, preserving
   complete accessible database schema/data, ACLs and ownership. This includes
   application, Auth, Storage metadata and migration-history tables. Any access
   failure stops the workflow; it never retries by silently excluding a table.
3. Exports supplementary role definitions via pg_dumpall --roles-only, explicitly
   omitting role passwords. PostgreSQL globals are separate from a single database
   dump. Role login passwords must be supplied securely during an actual recovery.
   Cross-version exports quote all identifiers. The verification marker records
   client versions and server major. Use pg_restore from the same selected toolchain.
4. Lists the archive and fully reads/decompresses it with pg_restore to Windows
   `NUL` **without --dbname**. Nothing is restored/executed on production.
5. Checks required operational, financial, audit, intake, Auth, Storage and
   migration-history TABLE DATA entries. Extracts Storage object/bucket metadata
   from the archive to establish the same database snapshot's expected files.
6. Lists **all** buckets with the server key, then recursively lists files with
   pagination, including private buckets. Snapshot bucket/file inventories must
   match; missing/extra/changed records fail verification.
7. Streams every file to disk under a collision-resistant hashed filename, keeping
   original bucket/path mappings in the manifest. This preserves case-sensitive,
   Unicode and Windows-reserved filenames without path traversal/collisions.
8. Checks byte counts and re-reads SHA-256 hashes. Where the source ETag is a plain
   MD5, it also checks downloaded bytes against that source checksum. Re-lists
   inventories after download to reject changes during the export.
9. Produces archive/roles/metadata/manifest checksums and
   `VERIFIED-INTEGRITY.json` only after every required step succeeds. PostgreSQL
   warnings/nonempty diagnostic logs stop automatic verification for private review.
   Credentials are cleared/restored in the process environment on exit.

Files include `database.dump`, `roles.sql`, `database.toc`, protected logs,
`storage-objects.sql`, `storage-buckets.sql`, `storage-manifest.json` and binary
objects. The JSON manifest maps each object to its original bucket/path, size,
source identity/date/ETag and local SHA-256. Credentials live separately in the
root's encrypted `credentials` directory, not inside the export manifest.

## Verification limits and recovery

Archive readability, full payload decompression, required data entries,
Storage completeness and local file integrity are checked. This is **not an
executed full restore rehearsal**; the marker explicitly records that fact.
It is not a backup of external OAuth/provider configuration, project secrets,
Vault/column-encryption root keys or custom-role passwords. If encrypted data or
additional external dependencies are in use, their recovery material must also
be secured and reviewed before calling recovery complete.

PostgreSQL documents that pg_dump 18 can export a PostgreSQL 17 server. This
does NOT guarantee that an 18-generated dump can be restored unchanged into a
17 server. Verify recovery compatibility separately; use the matching 18
pg_restore to read 18-generated archives, and do not assume an older reader or
target supports them. Supporting export does not waive the existing recovery
validation requirement. See https://www.postgresql.org/docs/18/app-pgdump.html.

Recovery must target a separately approved disposable/recovery database, never
production during verification. Inspect roles/extension and Supabase-managed
schema compatibility, recreate appropriate roles securely, then use pg_restore
with error stopping against that explicit recovery target. Do not blindly replay
managed Supabase roles over an existing installation. Verify financial totals,
history, constraints, policies and migration history after restore. Restore files
from manifest mappings via the Storage API to private recovery buckets, verify
their hashes/paths and recreate the saved bucket policy/configuration. Never
restore files by SQL INSERT/DELETE into storage.objects.

The scripts deliberately contain no restore-to-database, upload, delete,
migration, Git push or deployment operation. A release agent must independently
review the successful backup artifacts/checksums and remaining recovery limits
before using the existing conditional production-release authorization. Only the
single Record Management migration may then be applied; the previous five must
not be replayed. No destructive live smoke tests are permitted.

## Verification of the tooling, not of production backups

PowerShell syntax was parsed successfully. Seven offline synthetic tests cover
COPY escaping, nested/paginated private listings, Unicode/Windows filenames,
hashes/byte counts, missing/duplicate/changed files, failed downloads, Git-folder
rejection and incomplete database-archive rejection. Windows restricted-folder
ACLs, DPAPI encrypted credential round-trip and process-only secret helpers were
also executed successfully with synthetic credentials; the checked temporary
test folder was removed. The previous full regression suite passed **130/130**
and the production build passed (existing ExcelJS chunk warning). For the 18.6
compatibility update, all seven backup tests and the PowerShell version cases
were rerun and passed. Actual database exports/archive reads and authenticated
production downloads remain unexecuted until credentials are configured.
The actual 18.6 tools pass `-CheckTools` without loading
credentials or opening a database connection. Pure version regression tests are
in `scripts/test-backup-versions.ps1`.

Reconfiguration and username regressions are in
`scripts/test-backup-reconfiguration.ps1`. They use only synthetic credentials,
exercise real DPAPI encryption/atomic replacement and verify failed login,
encryption, commit and locked-state preservation. The native 18.6 clients are
tested only with version/invalid-option preflights, never a database connection.
The reconfiguration change passed all **131/131** application/offline tests and
the separate PowerShell credential, DACL and version regressions.

The DACL regression in `scripts/test-backup-permissions.ps1` passed under
PowerShell 7 with Administrator=False and SeSecurityPrivilege absent, using only
synthetic encrypted files. It covers broad-rule removal, new/existing folders,
idempotency, owner/content preservation, Configure overwrite prevention and
denied/ignored permission writes. The separate Windows PowerShell 5.1 run was
blocked by that host's script execution policy; no policy was changed or bypassed.

References:
- https://www.postgresql.org/docs/17/app-pgdump.html
- https://www.postgresql.org/docs/17/app-pgrestore.html
- https://supabase.com/docs/reference/javascript/file-buckets-list
- https://supabase.com/docs/guides/platform/backups
