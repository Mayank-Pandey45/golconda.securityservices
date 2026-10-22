import assert from "node:assert/strict";
import { test } from "node:test";
import { apiUrl } from "./api.js";

test("API URLs stay same-origin paths", () => {
  assert.equal(apiUrl("/api/complaints"), "/api/complaints");
  assert.equal(apiUrl("api/health"), "/api/health");
  assert.equal(apiUrl("//example.com/api/contact"), "/example.com/api/contact");
  assert.equal(apiUrl("https://example.com/api/contact"), "/https://example.com/api/contact");
});


test('API errors include HTTP status and safe structured validation details', async () => {
  const { readApiResponse } = await import('./api.js');
  const response = new Response(JSON.stringify({ error: 'Invalid rows.', details: { rows: [{ row: 3, message: 'Joining date is invalid.' }] } }), { status: 400 });
  await assert.rejects(() => readApiResponse(response), /HTTP 400: Invalid rows. Row 3: Joining date is invalid/);
  await assert.rejects(() => readApiResponse(new Response('NOT_FOUND', { status: 404 })), /HTTP 404: API route not found/);
  await assert.rejects(() => readApiResponse(new Response('<html>Login</html>', { status: 200 })), /HTTP 200:.*invalid API response/);
  await assert.rejects(() => readApiResponse(new Response(JSON.stringify({ error: 'secret=do-not-render', details: { rows: [null], matches: [null] } }), { status: 500 })), error => !error.message.includes('do-not-render') && error.message.includes('HTTP 500'));
  assert.deepEqual(await readApiResponse(new Response('{"ok":true}')), { ok: true });
});
