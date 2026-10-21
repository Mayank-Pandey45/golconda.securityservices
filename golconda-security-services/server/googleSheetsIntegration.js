import { createPrivateKey, createSign, timingSafeEqual } from "node:crypto";

const SHEET_HEADERS = [
  "Advance ID", "Date (Asia/Kolkata)", "Time (Asia/Kolkata)", "Employee Code", "Employee Name",
  "Employee Type", "Site Code", "Site Name", "Amount (INR)", "Payment Mode", "Description", "Source",
];
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_ROOT = "https://sheets.googleapis.com/v4/spreadsheets";

export class SheetsSyncError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function serviceAccountFromEnv(env) {
  let account;
  try { account = JSON.parse(String(env.GOOGLE_SERVICE_ACCOUNT_JSON || "")); }
  catch { throw new SheetsSyncError("google_credentials_invalid"); }
  if (!account?.client_email || !account?.private_key || !account.private_key.includes("PRIVATE KEY")) {
    throw new SheetsSyncError("google_credentials_invalid");
  }
  try { createPrivateKey(String(account.private_key).replace(/\\n/g, "\n")); }
  catch { throw new SheetsSyncError("google_credentials_invalid"); }
  return account;
}

export function isGoogleSheetsSyncConfigured(env = process.env) {
  if (env.GOOGLE_SHEETS_SYNC_ENABLED !== "true") return false;
  if (!String(env.GOOGLE_SHEET_ID || "").trim()) return false;
  if (!String(env.GOOGLE_SHEET_TAB ?? "Advances").trim()) return false;
  if (String(env.CRON_SECRET || "").trim().length < 32) return false;
  try {
    serviceAccountFromEnv(env);
    return true;
  } catch {
    return false;
  }
}

async function googleAccessToken(account, fetchImpl) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  let assertion;
  try {
    assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(String(account.private_key).replace(/\\n/g, "\n"), "base64url")}`;
  } catch {
    throw new SheetsSyncError("google_credentials_invalid");
  }
  let response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new SheetsSyncError("google_token_refresh_failed");
  }
  if (!response.ok) throw new SheetsSyncError("google_token_refresh_failed");
  const data = await response.json().catch(() => null);
  if (!data?.access_token) throw new SheetsSyncError("google_token_refresh_failed");
  return data.access_token;
}

function sheetRange(tab, suffix) {
  return `'${String(tab).replace(/'/g, "''")}'!${suffix}`;
}

async function sheetsRequest({ fetchImpl, token, spreadsheetId, range, method = "GET", body, append = false }) {
  const suffix = append ? ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS" : method === "PUT" ? "?valueInputOption=RAW" : "";
  const endpoint = `${GOOGLE_SHEETS_ROOT}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new SheetsSyncError(method === "GET" ? "google_sheet_read_failed" : "google_sheet_write_failed");
  }
  if (!response.ok) throw new SheetsSyncError(method === "GET" ? "google_sheet_read_failed" : "google_sheet_write_failed");
  return response.json().catch(() => ({}));
}

function formatDateAndTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new SheetsSyncError("advance_timestamp_invalid");
  const options = { timeZone: "Asia/Kolkata" };
  const datePart = new Intl.DateTimeFormat("en-CA", { ...options, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const timePart = new Intl.DateTimeFormat("en-GB", { ...options, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
  return [datePart, timePart];
}

function sheetValues(row) {
  const [date, time] = formatDateAndTime(row.occurred_at);
  return [
    String(row.advance_id), date, time, String(row.employee_code || ""), String(row.employee_name || ""),
    String(row.employee_type || ""), String(row.site_code || ""), String(row.site_name || ""), Number(row.amount),
    String(row.payment_mode || ""), String(row.description || ""), String(row.source || ""),
  ];
}

async function setRetry(database, advanceId, code) {
  const { error } = await database.rpc("retry_advance_sheet_sync", { p_advance_id: advanceId, p_error_code: code });
  if (error) throw new SheetsSyncError("outbox_retry_update_failed");
}

async function setSynced(database, advanceId) {
  const { error } = await database.rpc("complete_advance_sheet_sync", { p_advance_id: advanceId });
  if (error) throw new SheetsSyncError("outbox_completion_failed");
}

export async function syncAdvanceSheetOutbox({ database, env = process.env, fetchImpl = fetch, batchSize = 20 }) {
  const spreadsheetId = String(env.GOOGLE_SHEET_ID || "").trim();
  const tab = String(env.GOOGLE_SHEET_TAB || "Advances").trim();
  const credentialJson = String(env.GOOGLE_SERVICE_ACCOUNT_JSON || "");
  if (!database) throw new SheetsSyncError("database_unavailable");
  if (!isGoogleSheetsSyncConfigured(env) || !tab || !credentialJson) throw new SheetsSyncError("google_sheets_disabled");

  const { data: rows, error: claimError } = await database.rpc("claim_advance_sheet_sync", { p_limit: Math.max(1, Math.min(50, batchSize)) });
  if (claimError) throw new SheetsSyncError("outbox_claim_failed");
  if (!rows?.length) return { processed: 0, synced: 0, failed: 0 };

  let token;
  try {
    token = await googleAccessToken(serviceAccountFromEnv(env), fetchImpl);
  } catch (error) {
    const code = error instanceof SheetsSyncError ? error.code : "google_token_refresh_failed";
    for (const row of rows) await setRetry(database, row.advance_id, code);
    return { processed: rows.length, synced: 0, failed: rows.length };
  }

  let headers;
  let idColumn;
  try {
    const headerResult = await sheetsRequest({ fetchImpl, token, spreadsheetId, range: sheetRange(tab, "A1:L1") });
    headers = headerResult.values?.[0] || [];
    if (headers.length === 0) {
      await sheetsRequest({ fetchImpl, token, spreadsheetId, range: sheetRange(tab, "A1:L1"), method: "PUT", body: { majorDimension: "ROWS", values: [SHEET_HEADERS] } });
      headers = SHEET_HEADERS;
    }
    if (SHEET_HEADERS.some((header, index) => headers[index] !== header)) throw new SheetsSyncError("sheet_header_mismatch");
    idColumn = await sheetsRequest({ fetchImpl, token, spreadsheetId, range: sheetRange(tab, "A2:A") });
  } catch (error) {
    const code = error instanceof SheetsSyncError ? error.code : "google_sheet_read_failed";
    for (const row of rows) await setRetry(database, row.advance_id, code);
    return { processed: rows.length, synced: 0, failed: rows.length };
  }

  const sheetRows = idColumn.values || [];
  const rowByAdvanceId = new Map();
  sheetRows.forEach((values, index) => {
    const id = String(values?.[0] ?? "").trim();
    if (id && !rowByAdvanceId.has(id)) rowByAdvanceId.set(id, index + 2);
  });

  let synced = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const values = [sheetValues(row)];
      const existingRow = rowByAdvanceId.get(String(row.advance_id));
      if (existingRow) {
        await sheetsRequest({ fetchImpl, token, spreadsheetId, range: sheetRange(tab, `A${existingRow}:L${existingRow}`), method: "PUT", body: { majorDimension: "ROWS", values } });
      } else {
        const result = await sheetsRequest({ fetchImpl, token, spreadsheetId, range: sheetRange(tab, "A:L"), method: "POST", body: { majorDimension: "ROWS", values }, append: true });
        const rowNumber = Number(/![A-Z]+(\d+):/.exec(result.updates?.updatedRange || "")?.[1]);
        if (!Number.isSafeInteger(rowNumber) || rowNumber < 2) throw new SheetsSyncError("google_sheet_write_failed");
        rowByAdvanceId.set(String(row.advance_id), rowNumber);
      }
      await setSynced(database, row.advance_id);
      synced += 1;
    } catch (error) {
      const code = error instanceof SheetsSyncError ? error.code : "google_sheet_write_failed";
      await setRetry(database, row.advance_id, code);
      failed += 1;
    }
  }
  return { processed: rows.length, synced, failed };
}

export function hasCronAuthorization(authorization, secret) {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || ""));
  if (!match || !secret) return false;
  const a = Buffer.from(match[1], "utf8");
  const b = Buffer.from(String(secret), "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
