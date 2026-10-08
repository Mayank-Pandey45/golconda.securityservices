import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUtcDate, toDateInputValue, toUtcDateTimestamp } from "./dateOnly.js";

test("event calendar dates remain stable across the local timezone", () => {
  const timestamp = toUtcDateTimestamp("2026-10-15");
  assert.equal(timestamp, "2026-10-15T00:00:00.000Z");
  assert.equal(toDateInputValue(timestamp), "2026-10-15");
  assert.notEqual(formatUtcDate(timestamp), "COMING SOON");
});

test("empty or invalid event dates remain empty and render as coming soon", () => {
  assert.equal(toDateInputValue(null), "");
  assert.equal(toDateInputValue("not-a-date"), "");
  assert.equal(toUtcDateTimestamp(""), null);
  assert.equal(formatUtcDate(null), "COMING SOON");
});
