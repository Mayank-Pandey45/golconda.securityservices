import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createApp, createIntakeRateLimiter } from "./index.js";
import { createVercelRouteHandler } from "../api/_express.js";
import healthFunction from "../api/health.js";
import contactFunction from "../api/contact.js";
import applicationsFunction from "../api/applications.js";
import complaintsFunction from "../api/complaints.js";
import sendMessageFunction from "../api/send-message.js";

const originalEmailEnv = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL,
};

before(() => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.EMAIL_FROM = "GSS Test <test@example.com>";
  process.env.NOTIFICATION_EMAIL = "inbox@example.com";
});

after(() => {
  for (const [key, value] of Object.entries(originalEmailEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fakeDatabase({ failInsertTable, isAdmin = true, healthError = null } = {}) {
  const rows = {};
  const database = {
    rows,
    auth: {
      async getUser(token) {
        return token === "valid-token"
          ? { data: { user: { id: "admin-uuid", email: "admin@example.com" } }, error: null }
          : { data: { user: null }, error: new Error("Invalid token") };
      },
    },
    from(table) {
      const query = {
        values: null,
        insert(values) { this.values = values; return this; },
        select() { return this; },
        limit() { return this; },
        eq() { return this; },
        async single() {
          if (table === failInsertTable) return { data: null, error: new Error("database unavailable") };
          const record = { ...this.values, id: rows[table]?.length + 1 || 1, created_at: new Date().toISOString() };
          rows[table] ||= [];
          rows[table].push(record);
          return { data: { id: record.id, created_at: record.created_at }, error: null };
        },
        async maybeSingle() {
          if (table === "admin_users") {
            return isAdmin
              ? { data: { user_id: "admin-uuid" }, error: null }
              : { data: null, error: null };
          }
          return { data: null, error: healthError };
        },
      };
      return query;
    },
  };
  return database;
}

async function withApi(database, emailSender, run, appOptions = {}) {
  const server = createServer(createApp({
    database,
    emailSender,
    staticFiles: false,
    ...appOptions,
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("same-origin API does not emit cross-origin CORS permissions", async () => {
  await withApi(fakeDatabase(), async () => {}, async url => {
    const response = await fetch(`${url}/api/health`, { headers: { Origin: "https://untrusted.example" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

test("Vercel route adapters export serverless functions and route only their supported method", async () => {
  const functions = [
    [healthFunction, "GET", "POST"],
    [contactFunction, "POST", "GET"],
    [applicationsFunction, "POST", "GET"],
    [complaintsFunction, "POST", "GET"],
    [sendMessageFunction, "POST", "GET"],
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
});

test("health returns 200 only after a successful Supabase query", async () => {
  await withApi(fakeDatabase(), async () => {}, async url => {
    const response = await fetch(`${url}/api/health`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.databaseConfigured, true);
    assert.equal(result.databaseReachable, true);
  });

  await withApi(fakeDatabase({ healthError: new Error("database unavailable") }), async () => {}, async url => {
    const response = await fetch(`${url}/api/health`);
    const result = await response.json();
    assert.equal(response.status, 503);
    assert.equal(result.databaseConfigured, true);
    assert.equal(result.databaseReachable, false);
  });
});

test("health reports missing intake email variable names without exposing values", async () => {
  const emailVariables = {
    RESEND_API_KEY: "test-resend-key",
    EMAIL_FROM: "GSS Test <test@example.com>",
    NOTIFICATION_EMAIL: "inbox@example.com",
  };
  const originalValues = Object.fromEntries(Object.keys(emailVariables).map((key) => [key, process.env[key]]));

  try {
    Object.assign(process.env, emailVariables);
    await withApi(fakeDatabase(), async () => {}, async url => {
      const configuredResponse = await fetch(`${url}/api/health`);
      const configured = await configuredResponse.json();
      assert.equal(configured.emailConfigured, true);
      assert.deepEqual(configured.emailMissing, []);

      for (const missingVariable of Object.keys(emailVariables)) {
        delete process.env[missingVariable];
        const response = await fetch(`${url}/api/health`);
        const result = await response.json();
        assert.equal(result.emailConfigured, false);
        assert.deepEqual(result.emailMissing, [missingVariable]);
        assert.equal(JSON.stringify(result).includes(emailVariables.RESEND_API_KEY), false);
        process.env[missingVariable] = emailVariables[missingVariable];
      }
    });
  } finally {
    for (const [key, value] of Object.entries(originalValues)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("complaint is stored and the email layer is called", async () => {
  const database = fakeDatabase();
  const emails = [];
  await withApi(database, async message => emails.push(message), async url => {
    const response = await fetch(`${url}/api/complaints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ complainant_name: "Test Guard", role: "Security Guard", phone: "+91 90000 11111", subject: "Shift issue", details: "A test complaint." }),
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(result.emailSent, true);
    assert.equal(database.rows.complaints[0].subject, "Shift issue");
    assert.equal(emails.length, 1);
    assert.match(emails[0].text, /A test complaint/);
  });
});

test("invalid complaint input is rejected before database or email work", async () => {
  const database = fakeDatabase();
  let emailCount = 0;
  await withApi(database, async () => { emailCount += 1; }, async url => {
    const response = await fetch(`${url}/api/complaints`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ complainant_name: "", phone: "bad", subject: "", details: "" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(database.rows.complaints || [], []);
    assert.equal(emailCount, 0);
  });
});

test("database failure returns an error and never reports complaint success", async () => {
  const database = fakeDatabase({ failInsertTable: "complaints" });
  let emailCount = 0;
  await withApi(database, async () => { emailCount += 1; }, async url => {
    const response = await fetch(`${url}/api/complaints`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ complainant_name: "Test Guard", role: "Security Guard", phone: "9000011111", subject: "Issue", details: "Details" }),
    });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).ok, undefined);
    assert.equal(emailCount, 0);
  });
});

test("missing email configuration does not undo a persisted complaint", async () => {
  delete process.env.RESEND_API_KEY;
  const database = fakeDatabase();
  let emailCount = 0;
  await withApi(database, async () => { emailCount += 1; }, async url => {
    const response = await fetch(`${url}/api/complaints`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ complainant_name: "Test Guard", role: "Security Guard", phone: "9000011111", subject: "Issue", details: "Details" }),
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(result.emailSent, false);
    assert.equal(database.rows.complaints.length, 1);
    assert.equal(emailCount, 0);
  });
  process.env.RESEND_API_KEY = "test-key";
});

test("email provider failure is reported separately after complaint persistence", async () => {
  const database = fakeDatabase();
  const emailFailure = Object.assign(new Error("provider unavailable"), { code: "EMAIL_PROVIDER_ERROR" });
  await withApi(database, async () => { throw emailFailure; }, async url => {
    const response = await fetch(`${url}/api/complaints`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ complainant_name: "Test Guard", role: "Security Guard", phone: "9000011111", subject: "Issue", details: "Details" }),
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(result.emailSent, false);
    assert.equal(database.rows.complaints.length, 1);
  });
});

test("public submission is unavailable when the server database is not configured", async () => {
  let emailCount = 0;
  await withApi(null, async () => { emailCount += 1; }, async url => {
    const health = await fetch(`${url}/api/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).databaseReachable, false);
    const response = await fetch(`${url}/api/complaints`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ complainant_name: "Test Guard", role: "Security Guard", phone: "9000011111", subject: "Issue", details: "Details" }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, undefined);
    assert.equal(emailCount, 0);
  });
});

test("intake rate limit is shared across public form endpoints", async () => {
  const database = fakeDatabase();
  let emailCount = 0;
  await withApi(database, async () => { emailCount += 1; }, async url => {
    const first = await fetch(`${url}/api/contact`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Person", email: "test@example.com", service: "General enquiry", message: "A test enquiry." }),
    });
    assert.equal(first.status, 201);

    const limited = await fetch(`${url}/api/complaints`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ complainant_name: "Test Guard", role: "Security Guard", phone: "9000011111", subject: "Issue", details: "Details" }),
    });
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /Too many submissions/);
    assert.equal(database.rows.contact_submissions.length, 1);
    assert.equal(database.rows.complaints, undefined);
    assert.equal(emailCount, 1);
  }, { intakeLimiter: createIntakeRateLimiter({ limit: 1, windowMs: 60_000 }) });
});

test("contact and job forms persist to their own tables", async () => {
  const database = fakeDatabase();
  await withApi(database, async () => {}, async url => {
    const contact = await fetch(`${url}/api/contact`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Client", email: "client@example.com", service: "Guarding", message: "Need a quote." }),
    });
    const application = await fetch(`${url}/api/applications`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Applicant", email: "candidate@example.com", role: "Guard", message: "Available." }),
    });
    assert.equal(contact.status, 201);
    assert.equal(application.status, 201);
    assert.equal(database.rows.contact_submissions[0].name, "Client");
    assert.equal(database.rows.job_applications[0].full_name, "Applicant");
  });
});

test("admin message endpoint checks admin bearer auth and sends only when configured", async () => {
  const database = fakeDatabase();
  const emails = [];
  await withApi(database, async message => emails.push(message), async url => {
    const unauthorized = await fetch(`${url}/api/send-message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test", message: "Test body" }),
    });
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`${url}/api/send-message`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      body: JSON.stringify({ title: "Test", message: "Test body", recipients: "person@example.com" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).emailSent, true);
    assert.equal(emails.length, 1);
  });
});

test("admin message rejects a signed-in non-admin", async () => {
  const database = fakeDatabase({ isAdmin: false });
  let emailCount = 0;
  await withApi(database, async () => { emailCount += 1; }, async url => {
    const response = await fetch(`${url}/api/send-message`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      body: JSON.stringify({ title: "Test", message: "Test body", recipients: "person@example.com" }),
    });
    assert.equal(response.status, 403);
    assert.equal(emailCount, 0);
  });
});
