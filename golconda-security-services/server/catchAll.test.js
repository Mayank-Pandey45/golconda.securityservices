import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync } from "node:fs";
import { createCatchAllHandler } from "../api/[...path].js";
import { createApp } from "./index.js";

function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; }, json(body) { this.body = body; return this; } };
}
const request = (url, body = {}) => ({ url, method: "POST", headers: { "content-type": "application/json", authorization: "Bearer retained-token" }, body });

test("one deployable API file forwards all fourteen routes, query strings, bodies and authorization", () => {
  assert.deepEqual(readdirSync(new URL("../api/", import.meta.url)), ["[...path].js"]);
  const paths = ["health", "profile", "integrations/sheets-sync", "integrations/telegram", "guards/import", "operations/sites", "operations/site-import", "operations/people", "operations/guards", "operations/advances", "operations/payroll", "contact", "applications", "complaints"];
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
