## Current Telegram release state — 24 October 2026

The owner-admin Telegram advance workflow and protected employee identity fields are implemented. Migration `20261023184408_secure_telegram_admin_and_employee_identity` is applied to production `ntcvrxdyukfpobjvxxiz`; postflight confirmed RLS and service-role-only access, and all nine new tables are empty. The live bot still needs its Telegram token and webhook secret in Vercel Production. Identity values remain unavailable for new writes until the owner configures `EMPLOYEE_IDENTITY_ENCRYPTION_KEY` there. No employee identity or advance records were added for release testing.

## Website QA update — 23 October 2026

Nine issue groups fixed and covered in WEBSITE_QA_REPORT.md. Final automated
verification: 156/156 tests PASS, production build PASS, npm audit zero
vulnerabilities, git diff --check PASS. Synthetic HTTP/PostgreSQL lifecycle tests
and browser workflows cover every existing management module; production checks
remain non-destructive. Full coverage limitations are explicitly in the report.
No new migration is required. Existing record_management is already applied as
20261023093445; do NOT replay local 20261022190000_record_management.sql.
No production records, money, audit history, files or environment values were
changed for testing. No new backup/restore/Docker setup was performed.
Email, Telegram and Google Sheets remain disabled. Existing hosted configuration
is preserved. Earlier reports below describe earlier release stages.

---
## Production migration verified — 23 October 2026

Owner explicitly accepted proceeding without full backup restore rehearsal.
The reviewed 20261022190000_record_management.sql was applied successfully through
Supabase apply_migration to production ntcvrxdyukfpobjvxxiz. Supabase recorded it
as version 20261023093445, name record_management. This is the same migration,
not another pending migration: do NOT replay the local timestamp with db push.
All read-only postflight schema/RLS/RPC/Storage permission checks passed.
All 23 pre-existing application table row counts and business-data fingerprints
matched the pre-migration baseline (new archive/default metadata excluded).
Backup: 20261023T083254Z-f02149b6; database + both private buckets/one file verified.
Latest tests 131/131, build PASS, audit zero vulnerabilities, diff check PASS.
Full restore rehearsal remains explicitly waived; no destructive live tests.
Production code deployment verification follows separately. Email, Telegram and
Google Sheets remain disabled. Prior blocked/backup/setup notes below are history.

---
> **Latest release preparation (22 October 2026):** see [RECORD_MANAGEMENT_RELEASE.md](RECORD_MANAGEMENT_RELEASE.md). Record Management SQL was rehearsed only in disposable PostgreSQL 17.5; the production database and environment were unchanged. Synthetic advance tests confirm no outbox jobs are queued when Sheets is disabled. Telegram, Sheets and outbound email remain disabled; no Cron or hosted integration was enabled. Older snapshots below are historical.

# Telegram and Google Sheets setup

Telegram and Google Sheets are optional server-only integrations. Supabase remains the source of truth. The Telegram integration is owner-admin only and stays unavailable until its production secrets and webhook are configured. Google Sheets remains disabled unless separately configured.

## Telegram owner-admin advance entry

The webhook is `POST /api/integrations/telegram`. It accepts private chats only. An owner administrator signs in to the dashboard, generates a one-time linking code in **Telegram Integration**, then sends `/link CODE` to the bot. Codes are stored as hashes, expire after ten minutes, and can be used once. The bot rechecks that the linked identity is still the single authorized admin before each operation. Telegram usernames are not used for authorization; group chats cannot perform reads or writes.

The bot accepts natural-language English, Hinglish, Hindi, and Devanagari numerals, including amount-before-name messages and no-space amount/name forms. It matches only active employee and Site records, checks their current assignment, and stages a short-lived preview. **No advance is saved until the linked administrator taps Confirm & Save.** Edits require another confirmation. Writes use the existing `record_advance` routine with a stable idempotency reference. Ambiguities, unknown abbreviations, expenses, bad amounts, or Site mismatches do not create an advance. Aliases and abbreviation expansions must be explicitly approved in the dashboard.

Commands include `/start`, `/help`, `/dashboard`, `/guards`, `/sites`, `/search`, `/salary`, `/report`, `/advance`, `/newadvance`, `/link`, `/unlink`, and `/cancel`. Actual paid and pending salary amounts remain unavailable because the application has no authoritative salary-payment ledger.

Configure these values in Vercel Production environment settings, never in Vite variables, source files, deployment logs, or chat messages:

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Sends owner-admin bot replies. |
| `TELEGRAM_WEBHOOK_SECRET` | At least 32 characters; verifies Telegram's `X-Telegram-Bot-Api-Secret-Token` header. |
| `EMPLOYEE_IDENTITY_ENCRYPTION_KEY` | Base64 encoding of exactly 32 random bytes; protects optional ID values on the server. |

Create the identity key in a secure environment, for example with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`, then store it only as a server-side Vercel Production secret. Do not print it into a terminal transcript or commit it. The application accepts only Aadhaar's last four digits; it never accepts a full Aadhaar number. PAN and other ID values are encrypted at rest, masked on reads, and their writes fail closed until this key exists.

After the migration is applied and the token and webhook secret are configured, set Telegram's webhook URL to `https://golconda-securityservices.vercel.app/api/integrations/telegram` and set `secret_token` to the exact `TELEGRAM_WEBHOOK_SECRET`. Verify it with Telegram's `getWebhookInfo`; do not place credentials in the URL. Keep bot credentials and the identity encryption key server-only. Never send any identity values through Telegram.

## Google Sheets advance synchronization

The authenticated worker is `GET /api/integrations/sheets-sync`. It rejects requests unless `GOOGLE_SHEETS_SYNC_ENABLED=true`, a valid service-account private key and sheet ID are present, and `CRON_SECRET` has at least 32 characters. The advance writer opts into outbox enqueue only when that full configuration is valid; otherwise a new advance creates no outbox row. When enabled, the worker claims a bounded batch with a lease, writes or updates the row identified by Advance ID, then marks the outbox item complete. Provider failures record a sanitized error code and an exponential retry time. A timed-out append is safe: the retry re-reads Advance IDs and updates the existing row instead of appending another.

The worker exports only: Advance ID, local date/time (`Asia/Kolkata`), employee code/name/type, site code/name, amount, payment mode, description, and source. It excludes DOB, address, photos, and salary details. If the first row is empty, the worker writes the expected headers; a non-empty mismatched header is treated as a retryable configuration error rather than overwritten.

Setup:

1. Create a Google Cloud project, enable the Google Sheets API, and create a dedicated service account with spreadsheet access only.
2. Create/select the destination workbook and share it with the service account as an editor. Use a dedicated tab, defaulting to `Advances`.
3. Only after separate approval, configure these variables in a Vercel Preview project. They are server-only; store the private key only in Vercel's encrypted settings. Keep Production unset.
4. Apply the outbox migration in isolated staging. The trigger queues an advance only when the server's transaction-local opt-in flag is true; it does not backfill historical advances.
5. No Vercel Cron is configured and none should be added for this release. For future Preview validation only, manually call the authenticated worker after enabling it with Preview credentials:

   ```text
   GET https://<preview-host>/api/integrations/sheets-sync
   Authorization: Bearer <CRON_SECRET>
   ```

   Never put the secret in a public URL or expose it in logs/chat. Production scheduling requires separate approval and is outside this work.
6. Test against a non-production workbook: first sync, repeat/retry, revoked credential, inaccessible sheet, and a partial batch failure. Confirm the Supabase advance persists when the sheet is unavailable.
7. Rotate Preview credentials and verify retries after recovery. Production configuration is outside this work and requires separate approval.

Required variables:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google service-account credentials, server-side only. |
| `GOOGLE_SHEET_ID` | Destination spreadsheet identifier. |
| `GOOGLE_SHEET_TAB` | Optional destination tab; defaults to `Advances`. |
| `CRON_SECRET` | Bearer secret required for the worker. |

## Verification limits

Unit/regression tests use mocked Telegram and Google responses and cover secret and sender rejection, duplicate and concurrent Telegram delivery, bad inputs, database outage, stable row identity, disabled Sheets mode (no outbox claim), append timeout/retry, invalid credentials, expired credentials, and a partial Google write failure. They do not prove that the live Telegram bot, Vercel environment, Google service account, spreadsheet permissions, scheduler, or migrations are configured correctly. SQL execution remains blocked because no explicitly identified isolated staging database is available. Do not enable either integration in Production as part of this task.
