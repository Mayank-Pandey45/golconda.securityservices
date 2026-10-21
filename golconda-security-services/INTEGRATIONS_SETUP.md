# Telegram and Google Sheets setup

Both integrations are implemented as optional, server-only Vercel functions. Supabase remains the source of truth. **Both integrations must remain disabled for this release.** Do not add integration credentials to Vercel or configure a production Cron. The setup below is for a future Preview-only validation after separate owner approval.

## Telegram advance entry

The webhook is `POST /api/integrations/telegram`. It accepts private chats only and the exact command format:

```text
/advance <employee_code> <amount> <site_code> [description]
```

For example: `/advance GSS-GRD-102 1500 SITE-05 Cash advance`. Employee codes and site codes must match one active directory record. The database routine also verifies the person's active assignment to that site. Names are not used for matching.

Before enabling it:

1. Create a bot with BotFather and retain its token in a password manager.
2. Obtain the numeric Telegram user ID for each permitted administrator. This function accepts a comma-separated user allowlist and rejects group chats.
3. In Vercel Preview, configure `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (at least 32 characters), `TELEGRAM_ALLOWED_USER_IDS`, and `TELEGRAM_ADMIN_USER_ID`. The last value must be an existing administrator UUID in Supabase `admin_users`.
4. Configure these values only in encrypted Vercel environment settings. Never add them to Vite variables, source files, deployment logs, or chat messages.
5. Apply the pending Supabase migrations first. Then register the Preview webhook with Telegram using the `/setWebhook` Bot API and set its `secret_token` to the exact `TELEGRAM_WEBHOOK_SECRET` value. Use `https://<preview-host>/api/integrations/telegram` as the URL.
6. Test an authorized successful command, bad amount, unknown employee/site code, unauthorized sender, and repeated webhook delivery against Preview. Do not configure Production as part of this release; future activation requires separate approval.

The handler validates Telegram's `X-Telegram-Bot-Api-Secret-Token` before database access and checks the sender allowlist before parsing. It records Telegram's message timestamp in UTC, tags the source as `telegram`, and uses Telegram's `update_id` as a stable external reference. A unique database index and the `record_advance` routine make concurrent/repeated deliveries one logical advance. The configured admin UUID is recorded as the responsible administrator. Responses do not include private profile data.

Required variables:

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Sends command confirmations through the Bot API. |
| `TELEGRAM_WEBHOOK_SECRET` | Verifies Telegram's webhook header. |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated numeric private-chat sender IDs. |
| `TELEGRAM_ADMIN_USER_ID` | Existing Supabase `admin_users.user_id` used for the audited write. |

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
