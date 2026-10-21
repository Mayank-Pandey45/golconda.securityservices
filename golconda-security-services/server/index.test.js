import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createApp, createIntakeRateLimiter } from "./index.js";
import { createVercelRouteHandler } from "./vercelAdapter.js";
import healthFunction from "./vercel-endpoints/health.js";
import contactFunction from "./vercel-endpoints/contact.js";
import applicationsFunction from "./vercel-endpoints/applications.js";
import complaintsFunction from "./vercel-endpoints/complaints.js";
import profileFunction from "./vercel-endpoints/profile.js";
import guardImportFunction from "./vercel-endpoints/guards/import.js";
import operationsSitesFunction from "./vercel-endpoints/operations/sites.js";
import operationsSiteImportFunction from "./vercel-endpoints/operations/site-import.js";
import operationsPeopleFunction from "./vercel-endpoints/operations/people.js";
import operationsGuardsFunction from "./vercel-endpoints/operations/guards.js";
import operationsAdvancesFunction from "./vercel-endpoints/operations/advances.js";
import operationsPayrollFunction from "./vercel-endpoints/operations/payroll.js";
import telegramFunction from "./vercel-endpoints/integrations/telegram.js";
import sheetsSyncFunction from "./vercel-endpoints/integrations/sheets-sync.js";

function fakeDatabase({ failInsertTable, healthError = null } = {}) {
  const rows = {};
  const database = {
    rows,
    from(table) {
      const query = {
        values: null,
        insert(values) { this.values = values; return this; },
        select() { return this; },
        limit() { return this; },
        async single() {
          if (table === failInsertTable) return { data: null, error: new Error("database unavailable") };
          const record = { ...this.values, id: rows[table]?.length + 1 || 1, created_at: new Date().toISOString() };
          rows[table] ||= [];
          rows[table].push(record);
          return { data: { id: record.id, created_at: record.created_at }, error: null };
        },
        async maybeSingle() {
          return { data: null, error: healthError };
        },
      };
      return query;
    },
  };
  return database;
}

async function withApi(database, run, appOptions = {}) {
  const server = createServer(createApp({
    database,
    staticFiles: false,
    ...appOptions,
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const submissions = [
  {
    endpoint: "contact",
    table: "contact_submissions",
    body: { name: "Client", email: "client@example.com", service: "Guarding", message: "Need a quote." },
  },
  {
    endpoint: "applications",
    table: "job_applications",
    body: { name: "Applicant", email: "candidate@example.com", role: "Guard", message: "Available." },
  },
  {
    endpoint: "complaints",
    table: "complaints",
    body: { complainant_name: "Test Guard", role: "Security Guard", phone: "9000011111", subject: "Shift issue", details: "A complaint." },
  },
];

test("same-origin API does not emit cross-origin CORS permissions", async () => {
  await withApi(fakeDatabase(), async url => {
    const response = await fetch(url + "/api/health", { headers: { Origin: "https://untrusted.example" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

test("Vercel route adapters expose each supported API function and restrict its method", async () => {
  const functions = [
    [healthFunction, "GET", "POST"],
    [contactFunction, "POST", "GET"],
    [applicationsFunction, "POST", "GET"],
    [complaintsFunction, "POST", "GET"],
    [profileFunction, "GET", "POST"],
    [guardImportFunction, "POST", "GET"],
    [operationsSitesFunction, "POST", "GET"],
    [operationsSiteImportFunction, "POST", "GET"],
    [operationsPeopleFunction, "POST", "GET"],
    [operationsGuardsFunction, "POST", "GET"],
    [operationsAdvancesFunction, "GET, POST", "DELETE"],
    [operationsPayrollFunction, "GET", "POST"],
    [telegramFunction, "POST", "GET"],
    [sheetsSyncFunction, "GET", "POST"],
  ];
  assert.ok(functions.every(([handler]) => typeof handler === "function"));

  for (const [handler, allowedMethod, disallowedMethod] of functions) {
    const response = {
      headers: {},
      statusCode: 200,
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handler({ method: disallowedMethod }, response);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, allowedMethod);
    assert.deepEqual(response.body, { error: "Method not allowed." });
  }

  const routeApp = (req, res) => res.status(200).json({ url: req.url });
  const route = createVercelRouteHandler("/api/contact", ["POST"], routeApp);
  const forwarded = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {},
  });
  const routedResponse = forwarded();
  route({ method: "POST", url: "/?source=vercel", headers: { "content-type": "application/json" }, body: {} }, routedResponse);
  assert.equal(routedResponse.statusCode, 200);
  assert.deepEqual(routedResponse.body, { url: "/api/contact?source=vercel" });

  const wrongTypeResponse = forwarded();
  route({ method: "POST", url: "/api/contact", headers: { "content-type": "text/plain" }, body: "{}" }, wrongTypeResponse);
  assert.equal(wrongTypeResponse.statusCode, 415);

  const tooLargeResponse = forwarded();
  route({ method: "POST", url: "/api/contact", headers: { "content-type": "application/json" }, body: { message: "x".repeat(31 * 1024) } }, tooLargeResponse);
  assert.equal(tooLargeResponse.statusCode, 413);

  const importApp = (req, res) => res.status(200).json({ length: req.body.length });
  const importRoute = createVercelRouteHandler("/api/guards/import", ["POST"], importApp, 1024 * 1024);
  const largerBodyResponse = forwarded();
  importRoute({ method: "POST", url: "/api/guards/import", headers: { "content-type": "application/json" }, body: { data: "x".repeat(40 * 1024) } }, largerBodyResponse);
  assert.equal(largerBodyResponse.statusCode, 200);
});

test("health reports only Supabase configuration and reachability", async () => {
  await withApi(fakeDatabase(), async url => {
    const response = await fetch(url + "/api/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "Golconda Security Services API",
      databaseConfigured: true,
      databaseReachable: true,
    });
  });

  await withApi(fakeDatabase({ healthError: new Error("database unavailable") }), async url => {
    const response = await fetch(url + "/api/health");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "degraded",
      service: "Golconda Security Services API",
      databaseConfigured: true,
      databaseReachable: false,
    });
  });
});

test("contact, application, and complaint submissions persist without external services", async () => {
  const database = fakeDatabase();
  const externalRequests = [];
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (!target.startsWith("http://127.0.0.1:")) {
      externalRequests.push(new URL(target).origin);
      return Promise.reject(new Error("Unexpected external request."));
    }
    return nativeFetch(input, init);
  };

  try {
    await withApi(database, async url => {
      for (const submission of submissions) {
        const response = await fetch(url + "/api/" + submission.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(submission.body),
        });
        const result = await response.json();
        assert.equal(response.status, 201);
        assert.equal(result.ok, true);
        assert.equal(typeof result.id, "number");
        assert.ok(Number.isFinite(Date.parse(result.created_at)));
        assert.match(result.message, /received successfully/i);
        assert.equal(database.rows[submission.table].length, 1);
      }
    });
  } finally {
    globalThis.fetch = nativeFetch;
  }

  assert.deepEqual(externalRequests, []);
});

test("invalid submissions are rejected before database writes", async () => {
  const database = fakeDatabase();
  const invalidSubmissions = [
    { endpoint: "contact", body: { name: "Client", email: "invalid", message: "Need help." } },
    { endpoint: "applications", body: { email: "candidate@example.com" } },
    { endpoint: "complaints", body: { complainant_name: "", role: "Invalid", phone: "bad", subject: "", details: "" } },
  ];

  await withApi(database, async url => {
    for (const submission of invalidSubmissions) {
      const response = await fetch(url + "/api/" + submission.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission.body),
      });
      assert.equal(response.status, 400);
      assert.ok((await response.json()).error);
    }
  });

  assert.deepEqual(database.rows, {});
});

test("database insert failures return errors instead of success", async () => {
  for (const submission of submissions) {
    const database = fakeDatabase({ failInsertTable: submission.table });
    await withApi(database, async url => {
      const response = await fetch(url + "/api/" + submission.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission.body),
      });
      assert.equal(response.status, 500);
      const result = await response.json();
      assert.equal(result.ok, undefined);
      assert.equal(result.error, "The request could not be completed.");
    });
    assert.deepEqual(database.rows, {});
  }
});

test("public submissions return 503 when storage is not configured", async () => {
  await withApi(null, async url => {
    const health = await fetch(url + "/api/health");
    assert.equal(health.status, 503);
    assert.equal((await health.json()).databaseReachable, false);

    for (const submission of submissions) {
      const response = await fetch(url + "/api/" + submission.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission.body),
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).ok, undefined);
    }
  });
});

test("intake rate limit is shared across public submission routes", async () => {
  const database = fakeDatabase();
  await withApi(database, async url => {
    const first = await fetch(url + "/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submissions[0].body),
    });
    assert.equal(first.status, 201);

    const limited = await fetch(url + "/api/complaints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submissions[2].body),
    });
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /Too many submissions/);
    assert.equal(database.rows.contact_submissions.length, 1);
    assert.equal(database.rows.complaints, undefined);
  }, { intakeLimiter: createIntakeRateLimiter({ limit: 1, windowMs: 60_000 }) });
});
