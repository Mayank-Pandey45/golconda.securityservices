import assert from "node:assert/strict";
import { test } from "node:test";
import { apiUrl } from "./api.js";

test("API URLs stay same-origin paths", () => {
  assert.equal(apiUrl("/api/complaints"), "/api/complaints");
  assert.equal(apiUrl("api/health"), "/api/health");
  assert.equal(apiUrl("//example.com/api/contact"), "/example.com/api/contact");
  assert.equal(apiUrl("https://example.com/api/contact"), "/https://example.com/api/contact");
});
