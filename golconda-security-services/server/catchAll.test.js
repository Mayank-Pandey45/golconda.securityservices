import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync } from "node:fs";
import { createCatchAllHandler } from "../api/index.js";
import { createApp } from "./index.js";

function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; }, json(body) { this.body = body; return this; } };
}
const request = (url, body = {}) => ({ url, method: "POST", headers: { "content-type": "application/json", authorization: "Bearer retained-token" }, body });

test("one deployable API file forwards all fifteen routes, query strings, bodies and authorization", () => {
  assert.deepEqual(readdirSync(new URL("../api/", import.meta.url)), ["index.js"]);
  const paths = ["health", "profile", "integrations/sheets-sync", "integrations/telegram", "guards/import", "operations/records", "operations/sites", "operations/site-import", "operations/people", "operations/guards", "operations/advances", "operations/payroll", "contact", "applications", "complaints"];
  const handler = createCatchAllHandler((req, res) => res.json({ url: req.url, body: req.body, authorization: req.headers.authorization }));
  for (const path of paths) {
    const req = request(`/api/${path}?period=2026-10&site_id=1`, { marker: path });
    if (["health", "profile", "integrations/sheets-sync", "operations/payroll"].includes(path)) req.method = "GET";
    const res = response(); handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.url, req.url);
    assert.deepEqual(res.body.body, { marker: path });
    assert.equal(res.body.authorization, "Bearer retained-token");
  }
});

test("catch-all reconstructs array and string platform parameters without losing filters", () => {
  const handler = createCatchAllHandler((req, res) => res.json({ url: req.url }));
  for (const path of [["operations", "advances"], "operations/advances"]) {
    const req = { ...request("/?site_id=2&from=2026-10-01"), method: "GET", query: { path } };
    const res = response(); handler(req, res);
    assert.equal(res.body.url, "/api/operations/advances?site_id=2&from=2026-10-01");
  }
});

test("catch-all rejects unknown paths, wrong methods, multipart bodies and oversized imports", () => {
  const handler = createCatchAllHandler(() => assert.fail("Rejected request reached Express"));
  const cases = [[request("/api/not-found"), 404], [{ ...request("/api/contact"), method: "DELETE" }, 405],
    [{ ...request("/api/contact"), headers: { "content-type": "multipart/form-data" } }, 415],
    [request("/api/contact", { text: "x".repeat(31 * 1024) }), 413],
    [request("/api/guards/import", { text: "x".repeat(4 * 1024 * 1024) }), 413]];
  for (const [req, code] of cases) { const res = response(); handler(req, res); assert.equal(res.statusCode, code); }
});

test("catch-all handles lazy malformed platform JSON and parses string JSON", () => {
  const handler = createCatchAllHandler((req, res) => res.json(req.body));
  const malformed = request("/api/contact");
  Object.defineProperty(malformed, "body", { get() { throw new SyntaxError("Malformed JSON"); } });
  const rejected = response(); handler(malformed, rejected); assert.equal(rejected.statusCode, 400);
  const accepted = response(); handler(request("/api/contact", '{"name":"Client"}'), accepted);
  assert.deepEqual(accepted.body, { name: "Client" });
});

test("real Express authorization is retained behind the consolidated handler", async () => {
  const app = createApp({ database: {}, staticFiles: false, parseBody: false, operationsLimiter: (_req, _res, next) => next() });
  // A missing bearer token must fail before any business write.
  const handler = createCatchAllHandler(app);
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => { req.body = {}; handler(req, res); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/operations/sites`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.ok((await res.json()).error);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('explicit Vercel wildcard rewrite targets one stable function for every nested API path', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.rewrites.slice(0, 3), [
    { source: '/api/integrations/telegram/admin', destination: '/api/index?__route=integrations/telegram/admin' },
    { source: '/api/integrations/telegram', destination: '/api/index?__route=integrations/telegram' },
    { source: '/api/:path*', destination: '/api/index?__route=:path*' },
  ]);
  const handler = createCatchAllHandler((req, res) => res.json({ url: req.url, query: req.query, body: req.body, authorization: req.headers.authorization }));
  for (const path of ['operations/records', 'operations/guards', 'operations/sites', 'operations/people', 'operations/site-import', 'operations/advances', 'guards/import', 'integrations/telegram', 'integrations/telegram/admin', 'contact', 'applications', 'complaints', 'health', 'profile', 'operations/payroll', 'integrations/sheets-sync']) {
    const isGet = ['health', 'profile', 'operations/payroll', 'integrations/sheets-sync'].includes(path);
    const route = path === 'integrations/telegram' || path === 'integrations/telegram/admin'
      ? config.rewrites.find(item => item.source === `/api/${path}`).destination
      : '/api/index?__route=' + encodeURIComponent(path);
    for (const originalUrl of ['/api/' + path + '?site_id=2', route + '&site_id=2']) {
      const req = { ...request(originalUrl, { action: 'save' }), method: isGet ? 'GET' : 'POST', query: { __route: path, site_id: '2' } };
      const res = response(); handler(req, res);
      assert.equal(res.statusCode, 200); assert.equal(res.body.url, '/api/' + path + '?site_id=2');
      assert.equal(res.body.authorization, 'Bearer retained-token'); assert.equal(res.body.body.action, 'save'); assert.equal(res.body.query.__route, undefined);
    }
  }
  const notFound = response(); handler(request('/api/unknown?__route=operations/guards'), notFound); assert.equal(notFound.statusCode, 404);
});

test('production Telegram webhook rewrite enforces the secret and accepts /start without admin auth', async () => {
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const rewrite = config.rewrites.find(item => item.source === '/api/integrations/telegram');
  assert.deepEqual(rewrite, { source: '/api/integrations/telegram', destination: '/api/index?__route=integrations/telegram' });

  const webhookSecret = 'synthetic-webhook-secret-long-enough-for-tests';
  const outboundTelegramRequests = [];
  const app = createApp({
    database: {},
    env: { TELEGRAM_BOT_TOKEN: 'synthetic-test-token', TELEGRAM_WEBHOOK_SECRET: webhookSecret },
    fetchImpl: async (url, options) => {
      outboundTelegramRequests.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
      return { ok: true, async json() { return { ok: true, result: { message_id: 321 } }; } };
    },
    staticFiles: false,
    parseBody: false,
    intakeLimiter: (_req, _res, next) => next(),
  });
  const handler = createCatchAllHandler(app);
  const server = createServer(async (req, res) => {
    const rewritten = new URL(rewrite.destination, 'http://local');
    req.url = rewritten.pathname + rewritten.search;
    req.query = Object.fromEntries(rewritten.searchParams.entries());
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/integrations/telegram`;
    const invalid = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'invalid-synthetic-secret' }, body: '{}',
    });
    assert.equal(invalid.status, 401);
    assert.deepEqual(await invalid.json(), { error: 'Webhook authentication failed.' });
    assert.equal(outboundTelegramRequests.length, 0);

    const started = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': webhookSecret },
      body: JSON.stringify({ update_id: 987654, message: {
        date: Math.floor(Date.now() / 1000), text: '/start', from: { id: 456789 }, chat: { id: 456789, type: 'private' },
      } }),
    });
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), { ok: true });
    assert.equal(outboundTelegramRequests.length, 1);
    assert.equal(outboundTelegramRequests[0].method, 'sendMessage');
    assert.equal(outboundTelegramRequests[0].body.chat_id, 456789);
    assert.match(outboundTelegramRequests[0].body.text, /To link:/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('rewritten guard, site, people and import routes retain authentication and admin authorization', async () => {
  const { createServer } = await import('node:http');
  for (const admin of [false, true]) {
    const database = {
      auth: { async getUser(token) { return token === 'valid-token' ? { data: { user: { id: 'user' } } } : { data: null, error: new Error('Invalid token') }; } },
      from(table) { assert.equal(table, 'admin_users'); return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: admin ? { user_id: 'user' } : null, error: null }; } }; },
      rpc() { assert.fail('Rejected or unknown operation must never write'); }
    };
    const handler = createCatchAllHandler(createApp({ database, staticFiles: false, parseBody: false, operationsLimiter: (_req, _res, next) => next(), guardImportLimiter: (_req, _res, next) => next() }));
    const server = createServer((req, res) => { const url = new URL(req.url, 'http://local'); req.url = '/api/index?__route=' + url.pathname.slice(5); req.query = { __route: url.pathname.slice(5) }; req.body = {}; handler(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const path of ['operations/records', 'operations/guards', 'operations/sites', 'operations/people', 'operations/site-import', 'guards/import']) {
        for (const token of ['', 'invalid-token', 'valid-token']) {
          const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: '{}' });
          assert.equal(response.status, token !== 'valid-token' ? 401 : admin ? 400 : 403, path);
        }
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});
