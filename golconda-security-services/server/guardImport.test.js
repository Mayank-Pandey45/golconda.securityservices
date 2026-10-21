import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createApp, createIntakeRateLimiter } from "./index.js";

function fakeDatabase({ admin = true, existingGuards = [], sites = [
  { id: 9, title: "North Gate", site_code: "NORTH", status: "active" },
  { id: 10, title: "South Gate", site_code: "SOUTH", status: "active" },
] } = {}) {
  const guards = existingGuards.map((guard, index) => ({ id: index + 1, ...guard }));
  let nextId = guards.length + 1;
  const database = {
    guards,
    assignments: [],
    rpcCalls: [],
    auth: { async getUser(token) { return token === "valid-token" ? { data: { user: { id: "admin-user" } }, error: null } : { data: null, error: new Error("invalid token") }; } },
    async rpc(name, args) {
      database.rpcCalls.push({ name, args });
      if (name !== "save_guard_profile") return { data: null, error: new Error("Unexpected RPC") };
      const phoneKey = String(args.p_person.phone).replace(/\D/g, "");
      if (guards.some(guard => String(guard.phone).replace(/\D/g, "") === phoneKey || (args.p_person.employee_code && guard.employee_code?.toLowerCase() === args.p_person.employee_code.toLowerCase()))) {
        return { data: null, error: { code: "23505" } };
      }
      const record = { ...args.p_person, id: nextId++, site_id: args.p_site_ids[0] || null };
      guards.push(record);
      for (const site_id of args.p_site_ids) database.assignments.push({ guard_id: record.id, site_id });
      return { data: record.id, error: null };
    },
    from(table) {
      const query = { operation: "select", filters: {}, rangeFrom: 0, rangeTo: Infinity };
      query.select = () => { if (!query.operation || query.operation === "select") query.operation = "select"; return query; };
      query.eq = (field, value) => { query.filters[field] = value; return query; };
      query.order = () => query;
      query.range = (from, to) => { query.rangeFrom = from; query.rangeTo = to; return query; };
      query.maybeSingle = async () => ({ data: table === "admin_users" && admin ? { user_id: "admin-user" } : null, error: null });
      query.upsert = (values, options) => { query.operation = "upsert"; query.values = values; query.options = options; return query; };
      query.then = (resolve, reject) => Promise.resolve().then(() => {
        if (table === "sites") return { data: sites.slice(query.rangeFrom, query.rangeTo + 1), error: null };
        if (table === "guards" && query.operation === "select") return { data: guards.map(({ id, phone, employee_code }) => ({ id, phone, employee_code })).slice(query.rangeFrom, query.rangeTo + 1), error: null };
        return { data: [], error: null };
      }).then(resolve, reject);
      return query;
    },
  };
  return database;
}

async function withApi(database, run) {
  const server = createServer(createApp({
    database,
    staticFiles: false,
    intakeLimiter: createIntakeRateLimiter({ limit: 100 }),
    guardImportLimiter: createIntakeRateLimiter({ limit: 100 }),
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test("guard import verifies an admin session before touching guard records", async () => {
  const database = fakeDatabase({ admin: false });
  await withApi(database, async url => {
    const noToken = await fetch(`${url}/api/guards/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: [] }) });
    assert.equal(noToken.status, 401);
    const nonAdmin = await fetch(`${url}/api/guards/import`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" }, body: JSON.stringify({ rows: [] }) });
    assert.equal(nonAdmin.status, 403);
  });
  assert.equal(database.guards.length, 0);
});

test("guard import validates rows server-side, resolves sites, skips duplicates, and is idempotent", async () => {
  const database = fakeDatabase();
  const rows = [
    { rowNumber: 2, fields: { "Employee Code": "GSS-GRD-ASH", "Full Name": "Asha Rao", Phone: "+91 98765 43210", "Assigned Sites": "North Gate; SOUTH", Salary: "₹18,000", "Salary Frequency": "Monthly", "Date of Birth": "1990-02-03", "Residential Address": "Hyderabad" } },
    { rowNumber: 3, fields: { "Full Name": "Duplicate", Phone: "919876543210", "Assigned Site": "North Gate" } },
    { rowNumber: 4, fields: { "Full Name": "Missing Phone" } },
    { rowNumber: 5, fields: { "Full Name": "Bala Rao", Phone: "9876543211", "Assigned Site": "Unknown" } },
  ];

  await withApi(database, async url => {
    const send = () => fetch(`${url}/api/guards/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      body: JSON.stringify({ rows }),
    });
    const first = await send();
    assert.equal(first.status, 200);
    const summary = await first.json();
    assert.deepEqual({ inserted: summary.inserted, skipped: summary.skipped, failed: summary.failed }, { inserted: 1, skipped: 1, failed: 2 });
    assert.equal(summary.rows.find(row => row.row === 4).status, "failed");
    assert.equal(summary.rows.find(row => row.row === 5).status, "failed");
    assert.equal(database.guards[0].site_id, 9);
    assert.equal(database.guards[0].salary_amount, 18000);
    assert.equal(database.guards[0].employee_code, "GSS-GRD-ASH");
    assert.equal(database.guards[0].date_of_birth, "1990-02-03");
    assert.deepEqual(database.assignments, [{ guard_id: 1, site_id: 9 }, { guard_id: 1, site_id: 10 }]);
    assert.deepEqual(database.rpcCalls[0].args.p_site_ids, [9, 10]);
    assert.equal(summary.rows[0].salary_amount, undefined);

    const second = await send();
    const repeated = await second.json();
    assert.equal(repeated.inserted, 0);
    assert.equal(repeated.skipped, 2);
    assert.equal(database.guards.length, 1);
  });
});

test("guard import rejects oversized batches", async () => {
  const database = fakeDatabase();
  await withApi(database, async url => {
    const response = await fetch(`${url}/api/guards/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      body: JSON.stringify({ rows: Array.from({ length: 501 }, (_, index) => ({ rowNumber: index + 2, fields: {} })) }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /maximum of 500/i);
  });
});

test("guard import checks duplicate guards and resolves sites beyond the first 1000 records", async () => {
  const existingGuards = Array.from({ length: 1001 }, (_, index) => ({
    employee_code: `GSS-GRD-${index}`,
    phone: `9${String(index).padStart(9, "0")}`,
  }));
  existingGuards[1000] = { employee_code: "GSS-GRD-LATE", phone: "919876543210" };
  const sites = [
    { id: 9, title: "North Gate", site_code: "NORTH", status: "active" },
    ...Array.from({ length: 1000 }, (_, index) => ({ id: index + 10, title: `Site ${index}`, site_code: `SITE-${index}`, status: "active" })),
    { id: 2000, title: "Late Site", site_code: "LATE", status: "active" },
  ];
  const database = fakeDatabase({ existingGuards, sites });
  const rows = [
    { rowNumber: 2, fields: { "Full Name": "Duplicate", Phone: "+91 98765 43210", "Assigned Site": "North Gate" } },
    { rowNumber: 3, fields: { "Full Name": "New Guard", Phone: "9876543999", "Assigned Site": "LATE" } },
  ];
  await withApi(database, async url => {
    const response = await fetch(`${url}/api/guards/import`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      body: JSON.stringify({ rows }),
    });
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.skipped, 1);
    assert.equal(summary.inserted, 1);
    assert.equal(database.assignments.at(-1).site_id, 2000);
  });
});
