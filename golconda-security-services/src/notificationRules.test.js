import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dismissNotification,
  getDismissedNotificationIds,
  isNotificationVisible,
  prioritizeNotifications,
  safeNotificationHref,
  toDateTimeLocalValue,
  toUtcDateTime,
} from "./notificationRules.js";

const now = Date.parse("2026-10-08T12:00:00.000Z");

test("notification visibility honors publication, active status, start and expiry", () => {
  const base = { is_published: true, is_active: true, starts_at: null, expires_at: null };
  assert.equal(isNotificationVisible(base, now), true);
  assert.equal(isNotificationVisible({ ...base, is_published: false }, now), false);
  assert.equal(isNotificationVisible({ ...base, is_active: false }, now), false);
  assert.equal(isNotificationVisible({ ...base, starts_at: "2026-10-08T12:01:00.000Z" }, now), false);
  assert.equal(isNotificationVisible({ ...base, expires_at: "2026-10-08T12:00:00.000Z" }, now), false);
  assert.equal(isNotificationVisible({ ...base, starts_at: "not a date" }, now), false);
});

test("urgent notices are prioritized and session dismissals suppress only the banner candidate", () => {
  const rows = [
    { id: 1, notification_severity: "information", created_at: "2026-10-08T11:00:00Z", is_active: true, is_published: true },
    { id: 2, notification_severity: "urgent", created_at: "2026-10-08T10:00:00Z", is_active: true, is_published: true },
    { id: 3, notification_severity: "warning", created_at: "2026-10-08T11:30:00Z", is_active: true, is_published: true },
  ];
  assert.deepEqual(prioritizeNotifications(rows, now).map(row => row.id), [2, 3, 1]);
  assert.deepEqual(prioritizeNotifications(rows, now, new Set(["2"])).map(row => row.id), [3, 1]);
});

test("notification dismissals are stored per session and link targets reject unsafe schemes", () => {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
  dismissNotification(42, storage);
  assert.deepEqual([...getDismissedNotificationIds(storage)], ["42"]);
  assert.equal(safeNotificationHref("/contact"), "/contact");
  assert.equal(safeNotificationHref("#services"), "#services");
  assert.match(safeNotificationHref("https://example.com/update"), /^https:\/\//);
  assert.equal(safeNotificationHref("javascript:alert(1)"), "");
  assert.equal(safeNotificationHref("//unsafe.example"), "");
  assert.equal(safeNotificationHref("http://example.com"), "");
});

test("notification date/time form values round-trip to UTC timestamps", () => {
  const input = toDateTimeLocalValue("2026-10-08T12:00:00.000Z");
  assert.match(input, /^2026-10-08T/);
  assert.equal(Date.parse(toUtcDateTime(input)), Date.parse(input));
  assert.equal(toUtcDateTime("not a date"), null);
});
