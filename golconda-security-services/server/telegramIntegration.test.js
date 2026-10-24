import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { handleTelegramWebhook } from "./telegramIntegration.js";

const ownerId = "12345678-1234-1234-1234-123456789012";
const webhookSecret = "integration-webhook-secret-value-at-least-32-chars";
const botEnv = { TELEGRAM_BOT_TOKEN: "test-bot-token", TELEGRAM_WEBHOOK_SECRET: webhookSecret };
const now = new Date();

function telegramUpdate({ senderId = 456, text = "1000Test Sentry at North Gate food cash", updateId = 77, chatType = "private", date = Math.floor(Date.now() / 1000) - 10 } = {}) {
  return { update_id: updateId, message: { date, text, from: { id: senderId }, chat: { id: senderId, type: chatType } } };
}

function callbackUpdate({ senderId = 456, data, updateId = 78 } = {}) {
  return { update_id: updateId, callback_query: { id: `callback-${updateId}`, from: { id: senderId }, message: { date: Math.floor(Date.now() / 1000) - 10, chat: { id: senderId, type: "private" } }, data } };
}

function telegramDb({ linked = true, secondAdmin = false, queryErrors = {} } = {}) {
  const tables = {
    admin_users: [{ user_id: ownerId }, ...(secondAdmin ? [{ user_id: "22345678-1234-1234-1234-123456789012" }] : [])],
    telegram_admin_links: linked ? [{ admin_user_id: ownerId, telegram_user_id: "456", linked_at: now.toISOString(), revoked_at: null }] : [],
    telegram_link_codes: [], telegram_aliases: [], telegram_pending_advances: [], telegram_wizard_sessions: [],
    telegram_update_receipts: [], telegram_bot_events: [], advances: [],
    guards: [{ id: 8, employee_code: "G-001", full_name: "Test Sentry", status: "active", designation: "Security Guard" }],
    supervisors: [], field_officers: [],
    sites: [{ id: 4, title: "North Gate", site_code: "NG-01", status: "active" }],
    guard_site_assignments: [{ id: 1, guard_id: 8, site_id: 4, valid_from: "2026-01-01", valid_to: null }],
    supervisor_site_assignments: [], field_officer_site_assignments: [],
    employee_compensation: [],
  };
  const state = { tables, rpcCalls: [], nextAdvanceId: 900, queryCount: 0, queries: [], queryErrors };

  function matches(row, filters) {
    return filters.every(([kind, key, value]) => {
      if (kind === "eq") return row[key] === value;
      if (kind === "is") return (row[key] ?? null) === value;
      if (kind === "gt") return row[key] != null && row[key] > value;
      if (kind === "gte") return row[key] != null && row[key] >= value;
      if (kind === "lt") return row[key] != null && row[key] < value;
      if (kind === "ilike") {
        const escaped = String(value).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("%", ".*").replaceAll("_", ".");
        return new RegExp(`^${escaped}$`).test(String(row[key] || "").toLowerCase());
      }
      return true;
    });
  }

  function from(table) {
    const query = { action: "select", filters: [], returnRows: false, options: {}, selectedColumns: "" };
    query.select = (columns, options = {}) => { query.selectedColumns = String(columns || ""); query.options = options || {}; query.returnRows = true; return query; };
    query.eq = (key, value) => { query.filters.push(["eq", key, value]); return query; };
    query.is = (key, value) => { query.filters.push(["is", key, value]); return query; };
    query.gt = (key, value) => { query.filters.push(["gt", key, value]); return query; };
    query.gte = (key, value) => { query.filters.push(["gte", key, value]); return query; };
    query.lt = (key, value) => { query.filters.push(["lt", key, value]); return query; };
    query.ilike = (key, value) => { query.filters.push(["ilike", key, value]); return query; };
    query.limit = value => { query.take = value; return query; };
    query.order = () => query;
    query.insert = value => { query.action = "insert"; query.payload = value; return query; };
    query.upsert = (value, options = {}) => { query.action = "upsert"; query.payload = value; query.options = options; return query; };
    query.update = value => { query.action = "update"; query.payload = value; return query; };
    query.delete = () => { query.action = "delete"; return query; };
    query.then = (resolve, reject) => execute().then(resolve, reject);
    async function execute() {
      state.queryCount += 1;
      state.queries.push({ table, action: query.action, columns: query.selectedColumns });
      const rows = tables[table] || (tables[table] = []);
      const selected = rows.filter(row => matches(row, query.filters));
      if (query.action === "select") {
        if (state.queryErrors[table]) return { data: null, error: state.queryErrors[table] };
        // Match the live Supabase schema: legacy salary fields are only on guards,
        // and employee_compensation has gross_monthly_salary but no salary_frequency.
        const unavailable = table === "supervisors" || table === "field_officers"
          ? new Set(["salary_amount", "salary_frequency"])
          : table === "employee_compensation" ? new Set(["salary_frequency"]) : new Set();
        const missing = query.selectedColumns.split(",").map(value => value.trim()).filter(column => unavailable.has(column));
        if (missing.length) return { data: null, error: Object.assign(new Error("requested column is absent from the production schema cache"), { code: "PGRST204", status: 400 }) };
        if (query.options.head) return { data: null, count: selected.length, error: null };
        const data = query.take ? selected.slice(0, query.take) : selected;
        return { data: query.options.count ? data : data, count: query.options.count ? selected.length : undefined, error: null };
      }
      if (query.action === "insert") {
        const values = Array.isArray(query.payload) ? query.payload : [query.payload];
        const key = table === "telegram_update_receipts" ? "update_id" : table === "telegram_pending_advances" ? "source_update_id" : table === "telegram_link_codes" ? "code_hash" : null;
        for (const value of values) {
          if (key && rows.some(row => row[key] === value[key])) return { data: null, error: { code: "23505" } };
          rows.push({ ...value, id: value.id || (table === "telegram_pending_advances" ? randomUUID() : rows.length + 1), created_at: value.created_at || now.toISOString() });
        }
        const inserted = values.map(value => rows.find(row => key ? row[key] === value[key] : row.id === value.id) || rows.at(-1));
        return { data: query.returnRows ? inserted : null, error: null };
      }
      if (query.action === "upsert") {
        const value = query.payload;
        const conflictKey = table === "telegram_wizard_sessions" ? "telegram_user_id" : table === "telegram_admin_links" ? "admin_user_id" : "id";
        const prior = rows.find(row => row[conflictKey] === value[conflictKey]);
        if (prior) Object.assign(prior, value); else rows.push({ ...value, id: value.id || rows.length + 1 });
        const result = rows.find(row => row[conflictKey] === value[conflictKey]);
        return { data: query.returnRows ? result : null, error: null };
      }
      if (query.action === "update") {
        for (const row of selected) Object.assign(row, query.payload);
        return { data: query.returnRows ? (query.options.single ? selected[0] : selected) : null, error: null };
      }
      if (query.action === "delete") {
        tables[table] = rows.filter(row => !selected.includes(row));
        return { data: query.returnRows ? selected : null, count: selected.length, error: null };
      }
      return { data: null, error: null };
    }
    query.maybeSingle = async () => {
      const result = await execute();
      if (result.error) return result;
      const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
      return { data: rows[0] || null, error: null };
    };
    query.single = async () => {
      const result = await execute();
      if (result.error) return result;
      const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
      return { data: rows[0] || null, error: rows.length ? null : new Error("not found") };
    };
    return query;
  }

  return {
    state,
    from,
    async rpc(name, args) {
      state.rpcCalls.push({ name, args });
      const ref = args.p_advance.external_reference;
      const existing = tables.advances.find(row => row.source === args.p_advance.source && row.external_reference === ref);
      if (existing) return { data: existing.id, error: null };
      const id = ++state.nextAdvanceId;
      tables.advances.push({ id, ...args.p_advance, recorded_by: args.p_actor_id });
      return { data: id, error: null };
    },
  };
}

function telegramFetch(requests = [], failMethod = "", apiResult = { ok: true, result: {} }) {
  let failed = false;
  return async (url, options) => {
    const method = url.split("/").at(-1);
    requests.push({ method, body: JSON.parse(options.body) });
    if (method === failMethod && !failed) { failed = true; throw new Error("temporary Telegram transport failure"); }
    return { ok: true, status: 200, async json() { return apiResult; } };
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

function captureLogger() {
  const events = [];
  return { events, info: value => events.push(value), warn: value => events.push(value), error: value => events.push(value) };
}

async function deliver(database, body, fetchImpl, secretToken = webhookSecret, options = {}) {
  return handleTelegramWebhook({ body, secretToken, database, env: botEnv, fetchImpl, now: options.now || new Date(), logger: options.logger || silentLogger });
}

test("Telegram rejects invalid webhook tokens and acknowledges authenticated non-private updates", async () => {
  const database = telegramDb(); const calls = [];
  const badSecret = await deliver(database, telegramUpdate(), telegramFetch(calls), "wrong");
  const group = await deliver(database, telegramUpdate({ chatType: "group", updateId: 79 }), telegramFetch(calls));
  assert.equal(badSecret.status, 401);
  assert.equal(group.status, 200);
  assert.deepEqual(group.body, { ok: true, ignored: true });
  assert.equal(calls.length, 0);
  assert.equal(database.state.rpcCalls.length, 0);
  assert.equal(database.state.tables.telegram_pending_advances.length, 0);
});

test("An unlinked private /start receives linking instructions without admin lookup", async () => {
  const database = telegramDb({ linked: false }); const requests = []; const logger = captureLogger();
  const now = new Date("2026-10-24T02:03:00.000Z");
  const result = await deliver(database, telegramUpdate({ senderId: 789, text: "/start", updateId: 780, date: Math.floor(now.valueOf() / 1000) }), telegramFetch(requests), webhookSecret, { now, logger });
  assert.equal(result.status, 200);
  assert.ok(requests.some(item => item.method === "sendMessage" && /To link:/.test(item.body.text)));
  assert.equal(database.state.queryCount, 0);
  assert.equal(database.state.rpcCalls.length, 0);
  assert.equal(database.state.tables.telegram_pending_advances.length, 0);
  assert.ok(logger.events.some(event => event.event === "telegram_webhook" && event.update_id === 780 && event.update_type === "message" && event.outcome === "start_help_sent"));
  assert.ok(logger.events.some(event => event.event === "telegram_bot_api" && event.method === "sendMessage" && event.outcome === "success"));
  const diagnostics = JSON.stringify(logger.events);
  for (const privateValue of ["789", "/start", "test-bot-token", webhookSecret]) assert.ok(!diagnostics.includes(privateValue));
});

test("A linked /salary command replies from synthetic salary data without logging employee or amount", async () => {
  const database = telegramDb(); const requests = []; const logger = captureLogger();
  database.state.tables.guards[0] = { ...database.state.tables.guards[0], employee_code: "SYN-GRD-000002", full_name: "Synthetic Guard", salary_amount: "25000.00", salary_frequency: "monthly" };
  const now = new Date("2026-10-24T02:03:00.000Z");
  const update = telegramUpdate({ text: "/salary SYN-GRD-000002", updateId: 781, date: Math.floor(now.valueOf() / 1000) });
  const result = await deliver(database, update, telegramFetch(requests), webhookSecret, { now, logger });
  assert.equal(result.status, 200);
  const reply = requests.find(request => request.method === "sendMessage")?.body?.text || "";
  assert.match(reply, /configured monthly salary estimate/i);
  assert.match(reply, /actual paid and pending amounts: unavailable/i);
  assert.ok(logger.events.some(event => event.event === "telegram_webhook" && event.outcome === "salary_reply_sent"));
  assert.ok(logger.events.some(event => event.event === "telegram_bot_api" && event.method === "sendMessage" && event.outcome === "success"));
  const diagnostics = JSON.stringify(logger.events);
  for (const privateValue of ["Synthetic Guard", "SYN-GRD-000002", "25000", "456", "test-bot-token", webhookSecret]) assert.ok(!diagnostics.includes(privateValue));
  assert.equal(database.state.rpcCalls.length, 0);
  assert.equal(database.state.tables.advances.length, 0);
});

test("A linked supervisor /salary lookup uses the compensation ledger schema", async () => {
  const database = telegramDb(); const requests = [];
  database.state.tables.supervisors.push({ id: 12, employee_code: "SYN-SUP-000012", full_name: "Synthetic Supervisor", status: "active" });
  database.state.tables.employee_compensation.push({ employee_type: "supervisor", supervisor_id: 12, gross_monthly_salary: "32000.00", effective_from: "2026-10-01" });
  const now = new Date("2026-10-24T02:03:00.000Z");
  const update = telegramUpdate({ text: "/salary SYN-SUP-000012", updateId: 787, date: Math.floor(now.valueOf() / 1000) });
  const result = await deliver(database, update, telegramFetch(requests), webhookSecret, { now });
  assert.equal(result.status, 200);
  const reply = requests.find(request => request.method === "sendMessage")?.body?.text || "";
  assert.match(reply, /configured monthly salary estimate/i);
  assert.match(reply, /₹32,000/);
  assert.ok(!database.state.queries.some(query => query.table === "supervisors" && /salary_amount|salary_frequency/.test(query.columns)));
  assert.ok(!database.state.queries.some(query => query.table === "employee_compensation" && /salary_frequency/.test(query.columns)));
  assert.equal(database.state.rpcCalls.length, 0);
  assert.equal(database.state.tables.advances.length, 0);
});

test("An unlinked private /salary command replies with linking instructions and never looks up salary data", async () => {
  const database = telegramDb({ linked: false }); const requests = []; const logger = captureLogger();
  const now = new Date("2026-10-24T02:03:00.000Z");
  const update = telegramUpdate({ senderId: 789, text: "/salary SYN-GRD-000002", updateId: 782, date: Math.floor(now.valueOf() / 1000) });
  const result = await deliver(database, update, telegramFetch(requests), webhookSecret, { now, logger });
  assert.equal(result.status, 200);
  const reply = requests.find(request => request.method === "sendMessage")?.body?.text || "";
  assert.match(reply, /not linked/i);
  assert.match(reply, /\/start/);
  assert.match(reply, /\/link CODE/);
  assert.ok(!/salary|₹|\d{3,}/i.test(reply));
  assert.deepEqual(database.state.queries.map(query => query.table), ["telegram_admin_links"]);
  assert.ok(logger.events.some(event => event.event === "telegram_webhook" && event.outcome === "unlinked_linking_instructions_sent"));
  assert.ok(logger.events.some(event => event.event === "telegram_bot_api" && event.method === "sendMessage" && event.outcome === "success"));
  const diagnostics = JSON.stringify(logger.events);
  for (const privateValue of ["789", "SYN-GRD-000002", "test-bot-token", webhookSecret]) assert.ok(!diagnostics.includes(privateValue));
  assert.equal(database.state.rpcCalls.length, 0);
});

test("Old private messages are safely acknowledged without command execution", async () => {
  const database = telegramDb(); const requests = []; const logger = captureLogger();
  const now = new Date("2026-10-24T02:03:00.000Z");
  const oldDate = Math.floor((now.valueOf() - 25 * 60 * 60 * 1000) / 1000);
  const result = await deliver(database, telegramUpdate({ text: "/salary SYN-GRD-000002", updateId: 783, date: oldDate }), telegramFetch(requests), webhookSecret, { now, logger });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, ignored: true });
  assert.equal(database.state.queryCount, 0);
  assert.equal(database.state.rpcCalls.length, 0);
  assert.equal(requests.length, 0);
  assert.ok(logger.events.some(event => event.event === "telegram_webhook" && event.outcome === "stale_update_ignored"));
});

test("A Telegram HTTP 200 with Bot API ok=false fails visibly instead of claiming a reply", async () => {
  const logger = captureLogger();
  const result = await deliver(telegramDb({ linked: false }), telegramUpdate({ senderId: 789, text: "/start", updateId: 784 }), telegramFetch([], "", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }), webhookSecret, { logger });
  assert.equal(result.status, 503);
  assert.ok(logger.events.some(event => event.event === "telegram_dependency_failure" && event.dependency === "telegram_bot_api" && event.operation === "sendMessage" && event.http_status === 200 && event.error_code === 403 && event.sanitized_description === "bot_blocked_by_user"));
  assert.ok(logger.events.some(event => event.event === "telegram_webhook" && event.outcome === "handler_failed" && event.http_status === 503 && event.failure_dependency === "telegram_bot_api" && event.dependency_http_status === 200 && event.dependency_error_code === 403));
  assert.ok(!JSON.stringify(logger.events).includes("Forbidden: bot was blocked by the user"));
});

test("Telegram transport failures identify the dependency and redact exception text", async () => {
  const logger = captureLogger();
  const fetchImpl = async () => { throw Object.assign(new Error("fetch failed for chat 987654321 and private message text"), { code: "ECONNRESET" }); };
  const result = await deliver(telegramDb({ linked: false }), telegramUpdate({ senderId: 789, text: "/start", updateId: 786 }), fetchImpl, webhookSecret, { logger });
  assert.equal(result.status, 503);
  assert.ok(logger.events.some(event => event.event === "telegram_dependency_failure" && event.dependency === "telegram_bot_api" && event.operation === "sendMessage" && event.outcome === "transport_error" && event.http_status === null && event.error_code === "ECONNRESET" && event.sanitized_description === "network_transport_failure"));
  assert.ok(logger.events.some(event => event.event === "telegram_webhook" && event.outcome === "handler_failed" && event.failure_dependency === "telegram_bot_api" && event.failure_category === "network_transport_failure"));
  const diagnostics = JSON.stringify(logger.events);
  for (const privateValue of ["987654321", "private message text", "789", "test-bot-token", webhookSecret]) assert.ok(!diagnostics.includes(privateValue));
});

test("Repeated linked updates report a duplicate reply failure for Telegram retry", async () => {
  const database = telegramDb(); const update = telegramUpdate({ text: "/salary G-001", updateId: 785 });
  const first = await deliver(database, update, telegramFetch([]));
  assert.equal(first.status, 200);
  const logger = captureLogger();
  const replay = await deliver(database, update, telegramFetch([], "", { ok: false, error_code: 429 }), webhookSecret, { logger });
  assert.equal(replay.status, 503);
  assert.ok(logger.events.some(event => event.event === "telegram_dependency_failure" && event.dependency === "telegram_bot_api" && event.operation === "sendMessage" && event.outcome === "failure" && event.error_code === 429 && event.sanitized_description === "rate_limited"));
  assert.ok(logger.events.some(event => event.event === "telegram_webhook" && event.outcome === "handler_failed" && event.failure_dependency === "telegram_bot_api" && event.failure_category === "rate_limited"));
  assert.equal(database.state.tables.telegram_update_receipts.length, 1);
  assert.equal(database.state.tables.advances.length, 0);
  assert.equal(database.state.rpcCalls.length, 0);
});

test("Unlinked private supported commands receive linking instructions without protected execution", async () => {
  const database = telegramDb({ linked: false }); const requests = [];
  const result = await deliver(database, telegramUpdate({ senderId: 789, text: "/newadvance", updateId: 781 }), telegramFetch(requests));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(database.state.queryCount, 1); // Only the active Telegram-link lookup.
  assert.match(requests[0]?.body?.text || "", /not linked/i);
  assert.match(requests[0]?.body?.text || "", /\/link CODE/);
  assert.ok(!/salary|₹|\d{3,}/i.test(requests[0]?.body?.text || ""));
  assert.equal(database.state.tables.telegram_update_receipts.length, 0);
  assert.equal(database.state.tables.telegram_wizard_sessions.length, 0);
  assert.equal(database.state.tables.telegram_pending_advances.length, 0);
  assert.equal(database.state.rpcCalls.length, 0);
});

test("Unlinked natural-language advance input receives linking instructions and is never looked up", async () => {
  const database = telegramDb({ linked: false }); const requests = [];
  const result = await deliver(database, telegramUpdate({ senderId: 789, text: "Srikant 200 Maharaja Food", updateId: 788 }), telegramFetch(requests));
  assert.equal(result.status, 200);
  assert.deepEqual(database.state.queries.map(query => query.table), ["telegram_admin_links"]);
  assert.match(requests[0]?.body?.text || "", /not linked/i);
  assert.match(requests[0]?.body?.text || "", /\/start/);
  assert.equal(database.state.tables.telegram_pending_advances.length, 0);
  assert.equal(database.state.rpcCalls.length, 0);
});

test("A Supabase link lookup error remains retryable and is identified as a database failure", async () => {
  const database = telegramDb();
  const logger = captureLogger();
  const originalFrom = database.from;
  database.from = table => {
    if (table !== "telegram_admin_links") return originalFrom(table);
    const query = { select() { return query; }, eq() { return query; }, is() { return query; }, async maybeSingle() { return { data: null, error: Object.assign(new Error("synthetic lookup failure"), { code: "42501", status: 403 }) }; } };
    return query;
  };
  const result = await deliver(database, telegramUpdate({ senderId: 789, text: "/dashboard", updateId: 783 }), telegramFetch([]), webhookSecret, { logger });
  assert.equal(result.status, 503);
  assert.equal(database.state.rpcCalls.length, 0);
  assert.equal(database.state.tables.telegram_pending_advances.length, 0);
  assert.ok(logger.events.some(event => event.event === "telegram_dependency_failure" && event.dependency === "supabase" && event.operation === "select" && event.target === "telegram_admin_links" && event.http_status === 403 && event.error_code === "42501" && event.sanitized_description === "database_permission_denied"));
  assert.ok(logger.events.some(event => event.event === "telegram_webhook" && event.outcome === "handler_failed" && event.failure_dependency === "supabase" && event.failure_target === "telegram_admin_links" && event.dependency_error_code === "42501"));
  assert.ok(!JSON.stringify(logger.events).includes("synthetic lookup failure"));
});

test("Unlinked callback queries and repeated deliveries are acknowledged without side effects", async () => {
  const database = telegramDb({ linked: false }); const requests = [];
  const update = callbackUpdate({ senderId: 789, data: "confirm:pending-id", updateId: 782 });
  const [first, replay] = await Promise.all([
    deliver(database, update, telegramFetch(requests)),
    deliver(database, update, telegramFetch(requests)),
  ]);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(first.body, { ok: true, ignored: true });
  assert.deepEqual(replay.body, { ok: true, ignored: true });
  assert.equal(database.state.rpcCalls.length, 0);
  assert.equal(database.state.tables.telegram_pending_advances.length, 0);
  assert.equal(database.state.tables.telegram_update_receipts.length, 0);
  assert.equal(requests.length, 0);
});

test("Authenticated private messages with an invalid timestamp are acknowledged without processing", async () => {
  const database = telegramDb(); const requests = [];
  const update = telegramUpdate({ text: "/newadvance", updateId: 784 });
  update.message.date = 0;
  const result = await deliver(database, update, telegramFetch(requests));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, ignored: true });
  assert.equal(database.state.tables.telegram_wizard_sessions.length, 0);
  assert.equal(database.state.tables.telegram_pending_advances.length, 0);
  assert.equal(database.state.rpcCalls.length, 0);
  assert.equal(requests.length, 0);
});

test("Plain mixed-language advance input creates an unsaved preview with explicit edit and confirm actions", async () => {
  const database = telegramDb(); const requests = [];
  const result = await deliver(database, telegramUpdate(), telegramFetch(requests));
  assert.equal(result.status, 200);
  assert.equal(database.state.tables.telegram_pending_advances.length, 1);
  assert.equal(database.state.rpcCalls.length, 0);
  const request = requests.find(item => item.method === "sendMessage");
  assert.match(request.body.text, /Advance Entry Preview · Not Saved/);
  assert.match(request.body.text, /Test Sentry/);
  assert.match(request.body.text, /₹1,000/);
  assert.equal(database.state.tables.telegram_pending_advances[0].source_update_id, 77);
  const callbacks = request.body.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
  assert.ok(callbacks.some(value => value.startsWith("confirm:")));
  assert.ok(callbacks.includes(`edit:employee:${database.state.tables.telegram_pending_advances[0].id}`));
  assert.ok(callbacks.includes(`edit:date:${database.state.tables.telegram_pending_advances[0].id}`));
});

test("Linked natural-language lookup works against the live employee/site schema and multi-word Site names", async () => {
  const database = telegramDb(); const requests = [];
  database.state.tables.guards[0] = { id: 88, employee_code: "SYN-GRD-000088", full_name: "Srikant Sharma", status: "active", designation: "Security Guard" };
  database.state.tables.sites[0] = { id: 44, title: "Maharaja Food", site_code: "MFC-44", status: "active" };
  database.state.tables.guard_site_assignments[0] = { id: 9, guard_id: 88, site_id: 44, valid_from: "2026-10-01", valid_to: null };
  const result = await deliver(database, telegramUpdate({ text: "srikant 200 maharaja food", updateId: 789 }), telegramFetch(requests));
  assert.equal(result.status, 200);
  assert.equal(database.state.tables.telegram_pending_advances.length, 1);
  const pending = database.state.tables.telegram_pending_advances[0];
  assert.equal(pending.guard_id, 88);
  assert.equal(pending.site_id, 44);
  assert.equal(pending.amount, "200.00");
  assert.equal(database.state.rpcCalls.length, 0);
  assert.match(requests.find(item => item.method === "sendMessage")?.body?.text || "", /Maharaja Food/);
  assert.ok(!database.state.queries.some(query => ["supervisors", "field_officers"].includes(query.table) && /salary_amount|salary_frequency/.test(query.columns)));
});

test("Directory lookup errors stay retryable and report the exact failed dependency target", async () => {
  const error = Object.assign(new Error("synthetic PostgREST schema cache failure"), { code: "PGRST204", status: 400 });
  const database = telegramDb({ queryErrors: { sites: error } }); const logger = captureLogger();
  const result = await deliver(database, telegramUpdate({ text: "Srikant 200 Maharaja Food", updateId: 790 }), telegramFetch([]), webhookSecret, { logger });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "Telegram could not verify or save this request. No success was confirmed; retry safely or use the dashboard.");
  assert.ok(logger.events.some(event => event.event === "telegram_webhook" && event.outcome === "handler_failed" && event.http_status === 503 && event.failure_dependency === "supabase" && event.failure_operation === "select" && event.failure_target === "sites" && event.dependency_http_status === 400 && event.dependency_error_code === "PGRST204"));
  assert.equal(database.state.tables.telegram_pending_advances.length, 0);
  assert.equal(database.state.rpcCalls.length, 0);
  assert.ok(!JSON.stringify(logger.events).includes("synthetic PostgREST schema cache failure"));
});

test("Unknown employees, unknown sites and ambiguous employee/site matches never stage an advance", async () => {
  const database = telegramDb(); const requests = []; const fetchImpl = telegramFetch(requests);
  await deliver(database, telegramUpdate({ text: "200 No Such Employee North Gate", updateId: 791 }), fetchImpl);
  await deliver(database, telegramUpdate({ text: "200 Test Sentry No Such Site", updateId: 792 }), fetchImpl);
  database.state.tables.guards.push({ id: 9, employee_code: "G-002", full_name: "Test Sentry", status: "active" });
  await deliver(database, telegramUpdate({ text: "200 Test Sentry North Gate", updateId: 793 }), fetchImpl);
  database.state.tables.guards.pop();
  database.state.tables.sites.push({ id: 5, title: "North Gate", site_code: "NG-02", status: "active" });
  await deliver(database, telegramUpdate({ text: "200 Test Sentry North Gate", updateId: 794 }), fetchImpl);
  const replies = requests.filter(item => item.method === "sendMessage").map(item => item.body.text);
  assert.ok(replies.some(text => /could not match an active employee/i.test(text)));
  assert.ok(replies.some(text => /could not match an active site/i.test(text)));
  assert.ok(replies.some(text => /more than one employee/i.test(text)));
  assert.ok(replies.some(text => /more than one site/i.test(text)));
  assert.equal(database.state.tables.telegram_pending_advances.length, 0);
  assert.equal(database.state.rpcCalls.length, 0);
  assert.equal(database.state.tables.advances.length, 0);
});

test("Confirmation rechecks the linked owner and records exactly once through record_advance", async () => {
  const database = telegramDb(); const requests = []; const fetchImpl = telegramFetch(requests);
  await deliver(database, telegramUpdate(), fetchImpl);
  const pendingId = database.state.tables.telegram_pending_advances[0].id;
  const update = callbackUpdate({ data: `confirm:${pendingId}`, updateId: 78 });
  const [first, replay] = await Promise.all([deliver(database, update, fetchImpl), deliver(database, update, fetchImpl)]);
  assert.equal(first.status, 200); assert.equal(replay.status, 200);
  assert.equal(database.state.rpcCalls.length, 1);
  assert.equal(database.state.tables.advances.length, 1);
  const write = database.state.rpcCalls[0];
  assert.equal(write.name, "record_advance");
  assert.equal(write.args.p_actor_id, ownerId);
  assert.equal(write.args.p_advance.source, "telegram");
  assert.equal(write.args.p_advance.external_reference, `telegram-pending-${pendingId}`);
  assert.equal(database.state.tables.telegram_pending_advances[0].status, "saved");
});

test("A lost preview reply can be retried without creating a second pending transaction", async () => {
  const database = telegramDb(); const update = telegramUpdate({ updateId: 88 });
  const first = await deliver(database, update, telegramFetch([], "sendMessage"));
  const retryRequests = [];
  const retry = await deliver(database, update, telegramFetch(retryRequests));
  assert.equal(first.status, 503);
  assert.equal(retry.status, 200);
  assert.equal(database.state.tables.telegram_pending_advances.length, 1);
  assert.equal(database.state.tables.advances.length, 0);
  assert.ok(retryRequests.some(item => /Advance Entry Preview/.test(item.body.text)));
});

test("/newadvance guides through amount and details before staging an unsaved preview", async () => {
  const database = telegramDb(); const requests = []; const fetchImpl = telegramFetch(requests);
  await deliver(database, telegramUpdate({ text: "/newadvance", updateId: 90 }), fetchImpl);
  assert.equal(database.state.tables.telegram_wizard_sessions[0].step, "amount");
  await deliver(database, telegramUpdate({ text: "1200", updateId: 91 }), fetchImpl);
  assert.equal(database.state.tables.telegram_wizard_sessions[0].step, "details");
  await deliver(database, telegramUpdate({ text: "G-001 North Gate food", updateId: 92 }), fetchImpl);
  assert.equal(database.state.tables.telegram_pending_advances.length, 1);
  assert.equal(database.state.tables.telegram_pending_advances[0].amount, "1200.00");
  assert.equal(database.state.rpcCalls.length, 0);
});

test("One-time hashed account linking and /unlink work only for the single verified admin", async () => {
  const database = telegramDb({ linked: false }); const code = "link-test-code-which-is-long-enough";
  database.state.tables.telegram_link_codes.push({ id: 2, admin_user_id: ownerId, code_hash: createHash("sha256").update(code).digest("hex"), expires_at: new Date(Date.now() + 60000).toISOString(), used_at: null });
  const requests = []; const fetchImpl = telegramFetch(requests);
  const link = await deliver(database, telegramUpdate({ senderId: 789, text: `/link ${code}`, updateId: 100 }), fetchImpl);
  assert.equal(link.status, 200);
  assert.equal(database.state.tables.telegram_admin_links[0].telegram_user_id, "789");
  assert.ok(database.state.tables.telegram_link_codes[0].used_at);
  assert.ok(!JSON.stringify(database.state.tables.telegram_link_codes).includes(code));
  const replay = await deliver(database, telegramUpdate({ senderId: 999, text: `/link ${code}`, updateId: 101 }), fetchImpl);
  assert.equal(replay.status, 200);
  assert.equal(database.state.tables.telegram_admin_links.length, 1);
  await deliver(database, telegramUpdate({ senderId: 789, text: "/unlink", updateId: 102 }), fetchImpl);
  assert.ok(database.state.tables.telegram_admin_links[0].revoked_at);
  const after = await deliver(database, telegramUpdate({ senderId: 789, text: "/dashboard", updateId: 103 }), fetchImpl);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, { ok: true });
});

test("Unknown abbreviations, wrong Sites, invalid amounts, and multiple admins never stage a financial write", async () => {
  const database = telegramDb(); const requests = []; const fetchImpl = telegramFetch(requests);
  await deliver(database, telegramUpdate({ text: "500 Test Sentry North Gate gp", updateId: 110 }), fetchImpl);
  await deliver(database, telegramUpdate({ text: "500 Test Sentry Unknown Site", updateId: 111 }), fetchImpl);
  await deliver(database, telegramUpdate({ text: "-20 Test Sentry North Gate", updateId: 112 }), fetchImpl);
  assert.equal(database.state.tables.telegram_pending_advances.length, 0);
  assert.equal(database.state.rpcCalls.length, 0);
  const multipleAdmins = telegramDb({ linked: false, secondAdmin: true });
  const code = "another-link-test-code-which-is-long";
  multipleAdmins.state.tables.telegram_link_codes.push({ id: 3, admin_user_id: ownerId, code_hash: createHash("sha256").update(code).digest("hex"), expires_at: new Date(Date.now() + 60000).toISOString(), used_at: null });
  const refused = await deliver(multipleAdmins, telegramUpdate({ senderId: 789, text: `/link ${code}`, updateId: 113 }), fetchImpl);
  assert.equal(refused.status, 200);
  assert.equal(multipleAdmins.state.tables.telegram_admin_links.length, 0);
});

test("Bot configuration is required before any Telegram write path is available", async () => {
  const result = await handleTelegramWebhook({ body: telegramUpdate(), secretToken: webhookSecret, database: telegramDb(), env: {} });
  assert.equal(result.status, 503);
});
