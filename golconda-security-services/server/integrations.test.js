import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { hasCronAuthorization, isGoogleSheetsSyncConfigured, syncAdvanceSheetOutbox } from "./googleSheetsIntegration.js";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const sheetsEnv = {
  GOOGLE_SHEETS_SYNC_ENABLED: "true",
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sheets@example.invalid", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }),
  GOOGLE_SHEET_ID: "sheet-test-id",
  GOOGLE_SHEET_TAB: "Advances",
  CRON_SECRET: "test-only-cron-secret-with-more-than-32-characters",
};
const sheetHeaders = ["Advance ID", "Date (Asia/Kolkata)", "Time (Asia/Kolkata)", "Employee Code", "Employee Name", "Employee Type", "Site Code", "Site Name", "Amount (INR)", "Payment Mode", "Description", "Source"];

function sheetRows() {
  return [1, 2].map(id => ({ advance_id: id, employee_type: "guard", employee_code: `EMP-0${id}`, employee_name: `Guard ${id}`, site_code: "SITE-01", site_name: "North Gate", amount: 1500, occurred_at: "2026-10-21T10:30:00.000Z", payment_mode: "Cash", description: "Travel", source: "dashboard" }));
}

function sheetsDb(rows = sheetRows()) {
  const state = { completed: [], retries: [], calls: [] };
  return {
    state,
    async rpc(name, args) {
      state.calls.push({ name, args });
      if (name === "claim_advance_sheet_sync") return { data: rows, error: null };
      if (name === "complete_advance_sheet_sync") { state.completed.push(args.p_advance_id); return { data: true, error: null }; }
      if (name === "retry_advance_sheet_sync") { state.retries.push({ id: args.p_advance_id, code: args.p_error_code }); return { data: true, error: null }; }
      return { data: null, error: new Error("Unexpected RPC") };
    },
  };
}

function googleFetch({ existingIds = [], failedWrites = new Set(), lostAppendIds = new Set() } = {}) {
  const state = { ids: [...existingIds], appends: 0, updates: 0, requests: [] };
  const fetchImpl = async (url, options = {}) => {
    state.requests.push({ url, options });
    if (url === "https://oauth2.googleapis.com/token") return { ok: true, async json() { return { access_token: "mock-access-token" }; } };
    const method = options.method || "GET";
    const path = decodeURIComponent(url.split("/values/")[1].split(":append")[0].split("?")[0]);
    if (method === "GET" && path.endsWith("A1:L1")) return { ok: true, async json() { return { values: [sheetHeaders] }; } };
    if (method === "GET" && path.endsWith("A2:A")) return { ok: true, async json() { return { values: state.ids.map(id => [String(id)]) }; } };
    if (method === "PUT") {
      state.updates += 1;
      const rowId = Number(JSON.parse(options.body).values[0][0]);
      if (failedWrites.has(rowId)) return { ok: false, async json() { return {}; } };
      if (!state.ids.includes(rowId)) state.ids.push(rowId);
      return { ok: true, async json() { return { updatedRange: `Advances!A${state.updates + 1}:L${state.updates + 1}` }; } };
    }
    if (method === "POST" && url.includes(":append?")) {
      state.appends += 1;
      const rowId = Number(JSON.parse(options.body).values[0][0]);
      if (lostAppendIds.has(rowId) && state.appends === 1) {
        state.ids.push(rowId);
        throw new Error("connection reset after append");
      }
      if (failedWrites.has(rowId)) return { ok: false, async json() { return {}; } };
      state.ids.push(rowId);
      return { ok: true, async json() { return { updates: { updatedRange: `Advances!A${state.ids.length + 1}:L${state.ids.length + 1}` } }; } };
    }
    throw new Error(`Unexpected Google request ${method} ${url}`);
  };
  return { state, fetchImpl };
}

test("Google Sheets worker authenticates a scheduled caller using a bearer secret", () => {
  assert.equal(hasCronAuthorization("Bearer worker-secret", "worker-secret"), true);
  assert.equal(hasCronAuthorization("Bearer wrong", "worker-secret"), false);
  assert.equal(hasCronAuthorization("worker-secret", "worker-secret"), false);
});

test("Google Sheets sync stays disabled unless explicitly enabled with complete valid credentials", async () => {
  const database = sheetsDb();
  let providerCalls = 0;
  const disabled = { ...sheetsEnv, GOOGLE_SHEETS_SYNC_ENABLED: "false" };
  assert.equal(isGoogleSheetsSyncConfigured(disabled), false);
  await assert.rejects(syncAdvanceSheetOutbox({ database, env: disabled, fetchImpl: async () => { providerCalls += 1; } }), { code: "google_sheets_disabled" });
  assert.deepEqual(database.state.calls, []);
  assert.equal(providerCalls, 0);
  assert.equal(isGoogleSheetsSyncConfigured({ ...sheetsEnv, CRON_SECRET: "short" }), false);
  assert.equal(isGoogleSheetsSyncConfigured({ ...sheetsEnv, GOOGLE_SHEET_TAB: "   " }), false);
  assert.equal(isGoogleSheetsSyncConfigured({ ...sheetsEnv, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sheets@example.invalid", private_key: "not-a-real-key" }) }), false);
  assert.equal(isGoogleSheetsSyncConfigured(sheetsEnv), true);
});

test("Google Sheets sync updates an existing Advance ID and appends a new one", async () => {
  const database = sheetsDb();
  const google = googleFetch({ existingIds: [1] });
  const result = await syncAdvanceSheetOutbox({ database, env: sheetsEnv, fetchImpl: google.fetchImpl });
  assert.deepEqual(result, { processed: 2, synced: 2, failed: 0 });
  assert.deepEqual(database.state.completed, [1, 2]);
  assert.equal(database.state.retries.length, 0);
  assert.equal(google.state.updates, 1);
  assert.equal(google.state.appends, 1);
  const write = google.state.requests.find(request => request.options.method === "PUT");
  const values = JSON.parse(write.options.body).values[0];
  assert.equal(values.length, 12);
  assert.equal(values[0], "1");
  assert.equal(values[1], "2026-10-21");
  assert.equal(values[2], "16:00:00");
  assert.equal(write.options.headers.Authorization, "Bearer mock-access-token");
});

test("Google Sheets append timeout retries by Advance ID without duplicating a row", async () => {
  const database = sheetsDb([sheetRows()[0]]);
  const google = googleFetch({ lostAppendIds: new Set([1]) });
  const first = await syncAdvanceSheetOutbox({ database, env: sheetsEnv, fetchImpl: google.fetchImpl });
  assert.deepEqual(first, { processed: 1, synced: 0, failed: 1 });
  assert.deepEqual(database.state.retries, [{ id: 1, code: "google_sheet_write_failed" }]);
  const retryDatabase = sheetsDb([sheetRows()[0]]);
  const second = await syncAdvanceSheetOutbox({ database: retryDatabase, env: sheetsEnv, fetchImpl: google.fetchImpl });
  assert.deepEqual(second, { processed: 1, synced: 1, failed: 0 });
  assert.equal(google.state.appends, 1);
  assert.equal(google.state.updates, 1);
});

test("Google Sheets handles expired credentials and partial write failure with sanitized retries", async () => {
  const expiredDb = sheetsDb([sheetRows()[0]]);
  const expiredFetch = async url => url === "https://oauth2.googleapis.com/token"
    ? { ok: false, async json() { return { error: "invalid_grant", private: "never surface this" }; } }
    : { ok: true, async json() { return {}; } };
  const expired = await syncAdvanceSheetOutbox({ database: expiredDb, env: sheetsEnv, fetchImpl: expiredFetch });
  assert.deepEqual(expired, { processed: 1, synced: 0, failed: 1 });
  assert.deepEqual(expiredDb.state.retries, [{ id: 1, code: "google_token_refresh_failed" }]);

  const partialDb = sheetsDb();
  const google = googleFetch({ failedWrites: new Set([1]) });
  const partial = await syncAdvanceSheetOutbox({ database: partialDb, env: sheetsEnv, fetchImpl: google.fetchImpl });
  assert.deepEqual(partial, { processed: 2, synced: 1, failed: 1 });
  assert.deepEqual(partialDb.state.completed, [2]);
  assert.deepEqual(partialDb.state.retries, [{ id: 1, code: "google_sheet_write_failed" }]);
});
