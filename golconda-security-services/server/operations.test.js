import { createCatchAllHandler } from "../api/index.js";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp, createIntakeRateLimiter } from "./index.js";
import { recordAdvance } from "./operations.js";

function fakeDatabase({ admin = true, people = {} } = {}) {
  const calls = [];
  const database = {
    calls,
    auth: { async getUser(token) { return token === "valid-token" ? { data: { user: { id: "admin-user" } }, error: null } : { data: null, error: new Error("invalid") }; } },
    from(table) {
      const filters = {};
      let rangeFrom = 0;
      let rangeTo = Infinity;
      const query = {
        select() { return query; },
        eq(field, value) { filters[field] = value; return query; },
        order() { return query; },
        range(from, to) { rangeFrom = from; rangeTo = to; return query; },
        async maybeSingle() { return { data: table === "admin_users" && admin ? { user_id: "admin-user" } : null, error: null }; },
        then(resolve, reject) {
          const data = (people[table] || []).filter(person => Object.entries(filters).every(([field, value]) => person[field] === value)).slice(rangeFrom, rangeTo + 1);
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) { calls.push({ name, args }); return { data: name === "save_site_with_assignments" ? 5 : name === "save_guard_profile" ? 8 : { sites_created: 1, sites_updated: 0, guards_created: 1, guards_updated: 0, supervisors_created: 0, supervisors_updated: 0, field_officers_created: 0, field_officers_updated: 0, relationships_added: 1, skipped: 0, failed: 0 }, error: null }; },
  };
  return database;
}

async function withApi(database, run) {
  const server = createServer(createApp({ database, staticFiles: false, intakeLimiter: createIntakeRateLimiter({ limit: 100 }), operationsLimiter: createIntakeRateLimiter({ limit: 100 }) }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const validSite = { site_code: "SITE-01", title: "North Gate", service_taken: "BOTH", phone_numbers: "+91 98765 43210", given_emails: "site@example.com" };

test("site operations routes deny unauthenticated and non-admin requests", async () => {
  const database = fakeDatabase({ admin: false });
  await withApi(database, async url => {
    const missing = await fetch(`${url}/api/operations/sites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", site: validSite }) });
    assert.equal(missing.status, 401);
    const denied = await fetch(`${url}/api/operations/site-import`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" }, body: JSON.stringify({ rows: [{ site: validSite }] }) });
    assert.equal(denied.status, 403);
  });
  assert.equal(database.calls.length, 0);
});

test("site create validates input and commits metadata with multi-site assignment IDs atomically", async () => {
  const database = fakeDatabase();
  await withApi(database, async url => {
    const response = await fetch(`${url}/api/operations/sites`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      body: JSON.stringify({ action: "save", site: validSite, guard_ids: [1, 2], supervisor_ids: [3], field_officer_ids: [4] }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.site_id, 5);
    assert.deepEqual(database.calls[0].args.p_guard_ids, [1, 2]);
    assert.deepEqual(database.calls[0].args.p_supervisor_ids, [3]);
  });
});

test("site imports are idempotent by stable codes and reject ambiguous employee matches before writes", async () => {
  const database = fakeDatabase({ people: { guards: [{ employee_code: "GSS-GRD-1", phone: "9876543210", phone_normalized: "9876543210" }] } });
  const row = { rowNumber: 2, site: validSite, guard: { full_name: "Asha Rao", phone: "9876543210" } };
  await withApi(database, async url => {
    const send = body => fetch(`${url}/api/operations/site-import`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" }, body: JSON.stringify(body) });
    const invalid = await send({ rows: [{ ...row, site: { ...validSite, phone_numbers: "bad" } }] });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /rows are invalid/i);
    assert.equal(database.calls.length, 0);

    const success = await send({ rows: [row] });
    assert.equal(success.status, 200);
    assert.equal(database.calls[0].name, "import_operations_sites");
    assert.equal(database.calls[0].args.p_sites[0].guards[0].phone, "9876543210");
  });
});

test("employee cross-type and employee-code conflicts require review", async () => {
  const database = fakeDatabase({ people: { guards: [{ employee_code: "GSS-GRD-1", phone: "9876543210", phone_normalized: "9876543210" }] } });
  await withApi(database, async url => {
    const response = await fetch(`${url}/api/operations/site-import`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      body: JSON.stringify({ rows: [{ site: validSite, supervisor: { full_name: "Asha Rao", phone: "9876543210" } }] }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /ambiguous/i);
  });
  assert.equal(database.calls.length, 0);
});

test("site imports reject a new employee code for a phone already tied to another code", async () => {
  const database = fakeDatabase({ people: { guards: [{ employee_code: "GSS-GRD-1", phone: "9876543210", phone_normalized: "9876543210" }] } });
  await withApi(database, async url => {
    const response = await fetch(`${url}/api/operations/site-import`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      body: JSON.stringify({ rows: [{ site: validSite, guard: { employee_code: "GSS-GRD-2", full_name: "Asha Rao", phone: "9876543210" } }] }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /ambiguous/i);
  });
  assert.equal(database.calls.length, 0);
});

test("site import duplicate checks find conflicting employees after the first 1000 records", async () => {
  const guards = Array.from({ length: 1100 }, (_, index) => {
    const digits = String(index).padStart(9, "0");
    return { id: index + 1, employee_code: `GSS-GRD-${index}`, phone: `9${digits}`, phone_normalized: `9${digits}` };
  });
  guards[1099] = { id: 1100, employee_code: "GSS-GRD-LATE", phone: "9876543210", phone_normalized: "9876543210" };
  const database = fakeDatabase({ people: { guards } });
  await withApi(database, async url => {
    const response = await fetch(`${url}/api/operations/site-import`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      body: JSON.stringify({ rows: [{ site: validSite, guard: { employee_code: "GSS-GRD-OTHER", full_name: "Asha Rao", phone: "9876543210" } }] }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /ambiguous/i);
  });
  assert.equal(database.calls.length, 0);
});

test("guard profile endpoint validates employee codes and saves multiple site assignments atomically", async () => {
  const database = fakeDatabase();
  await withApi(database, async url => {
    const headers = { "Content-Type": "application/json", Authorization: "Bearer valid-token" };
    const invalid = await fetch(`${url}/api/operations/guards`, { method: "POST", headers, body: JSON.stringify({ action: "save", person: { full_name: "Asha Rao", phone: "9876543210", employee_code: "bad code" }, site_ids: [2, 3] }) });
    assert.equal(invalid.status, 400);
    assert.equal(database.calls.length, 0);

    const response = await fetch(`${url}/api/operations/guards`, { method: "POST", headers, body: JSON.stringify({ action: "save", person: { full_name: "Asha Rao", phone: "9876543210", employee_code: "gss-grd-8", designation: "Security Guard", salary_amount: "18000", salary_frequency: "monthly", salary_effective_date: "2026-10-01" }, site_ids: [2, 3] }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).guard_id, 8);
    assert.equal(database.calls[0].name, "save_guard_profile");
    assert.deepEqual(database.calls[0].args.p_site_ids, [2, 3]);
    assert.equal(database.calls[0].args.p_person.employee_code, "GSS-GRD-8");
  });
});

test("advance and payroll filters reject impossible calendar values as client errors", async () => {
  const database = fakeDatabase();
  await withApi(database, async url => {
    const headers = { Authorization: "Bearer valid-token" };
    const impossibleDate = await fetch(`${url}/api/operations/advances?from=2025-02-30`, { headers });
    assert.equal(impossibleDate.status, 400);
    const impossibleMonth = await fetch(`${url}/api/operations/payroll?period=2026-13`, { headers });
    assert.equal(impossibleMonth.status, 400);
  });
  assert.equal(database.calls.length, 0);
});

test("advances only request Sheets enqueue when the integration is explicitly enabled and fully configured", async () => {
  const database = fakeDatabase();
  const input = { employee_type: "guard", employee_id: 4, site_id: 2, amount: "1500", occurred_at: new Date(Date.now() - 60_000).toISOString() };
  const defaultResult = await recordAdvance(database, input, "admin-user", {});
  assert.equal(defaultResult.ok, true);
  assert.equal(database.calls[0].args.p_advance.enqueue_sheet_sync, false);

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const configuredEnv = {
    GOOGLE_SHEETS_SYNC_ENABLED: "true",
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sheets@example.invalid", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }),
    GOOGLE_SHEET_ID: "test-sheet",
    CRON_SECRET: "test-only-cron-secret-with-more-than-32-characters",
  };
  await recordAdvance(database, input, "admin-user", configuredEnv);
  assert.equal(database.calls[1].args.p_advance.enqueue_sheet_sync, true);
  await recordAdvance(database, input, "admin-user", { ...configuredEnv, GOOGLE_SHEETS_SYNC_ENABLED: "false" });
  assert.equal(database.calls[2].args.p_advance.enqueue_sheet_sync, false);
});


test('Vercel rewrite bridge completes authorized Site, Guard and Field Officer creates with mocked persistence', async () => {
  const database = fakeDatabase();
  const handler = createCatchAllHandler(createApp({ database, parseBody: false, staticFiles: false, operationsLimiter: (_req, _res, next) => next() }));
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const path = new URL(req.url, 'http://local').pathname.slice(5);
    req.url = '/api/index?__route=' + encodeURIComponent(path); req.query = { __route: path };
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const person = { full_name: 'Asha Rao', phone: '9876543210', joining_date: '01/04/26' };
    const cases = [
      ['sites', { action: 'save', site: { ...validSite, payroll_effective_date: '01-04-2026' } }, 'save_site_with_assignments'],
      ['guards', { action: 'save', person, site_ids: [2, 3] }, 'save_guard_profile'],
      ['people', { action: 'save', employee_type: 'field_officer', person, site_ids: [2, 3] }, 'save_employee_profile']
    ];
    for (const [path, body, procedure] of cases) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/operations/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, path); assert.equal((await response.json()).ok, true);
      const call = database.calls.at(-1); assert.equal(call.name, procedure); assert.equal(call.args.p_actor_id, 'admin-user');
      if (path === 'sites') assert.equal(call.args.p_site.payroll_effective_date, '2026-04-01');
      else { assert.equal(call.args.p_person.joining_date, '2026-04-01'); assert.deepEqual(call.args.p_site_ids, [2, 3]); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
