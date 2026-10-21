import { timingSafeEqual } from "node:crypto";
import { isGoogleSheetsSyncConfigured } from "./googleSheetsIntegration.js";

const commandHelp = "Use: /advance EMPLOYEE_CODE AMOUNT SITE_CODE [description]";

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function parseAllowlist(value) {
  return new Set(String(value || "").split(",").map(item => item.trim()).filter(item => /^\d{1,20}$/.test(item)));
}

function parseAdvanceCommand(text) {
  const match = /^\/advance(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{1,64})\s+(\d{1,9}(?:\.\d{1,2})?)\s+([A-Za-z0-9_-]{1,64})(?:\s+([\s\S]{1,500}))?\s*$/i.exec(String(text || "").trim());
  if (!match) return null;
  const amount = Number(match[2]);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) return null;
  return { employeeCode: match[1], amount: amount.toFixed(2), siteCode: match[3], description: String(match[4] || "").trim() };
}

async function sendTelegramMessage({ fetchImpl, botToken, chatId, text }) {
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok === false) throw new Error("telegram_reply_failed");
}

async function lookupActiveEmployee(database, employeeCode) {
  const tables = [
    ["guard", "guards", "guard_id"],
    ["supervisor", "supervisors", "supervisor_id"],
    ["field_officer", "field_officers", "field_officer_id"],
  ];
  const results = await Promise.all(tables.map(async ([employeeType, table, idField]) => {
    const result = await database.from(table).select("id,employee_code,status")
      .eq("employee_code", employeeCode.toUpperCase()).maybeSingle();
    return { employeeType, idField, ...result };
  }));
  if (results.some(result => result.error)) throw new Error("employee_lookup_failed");
  const matches = results.filter(result => result.data && String(result.data.status || "").toLowerCase() === "active");
  if (matches.length === 0) return { error: "No active employee matches that employee code." };
  if (matches.length > 1) return { error: "That employee code is ambiguous. Ask an administrator to correct the directory." };
  return matches[0];
}

export async function handleTelegramWebhook({ body, secretToken, database, env = process.env, fetchImpl = fetch }) {
  const botToken = String(env.TELEGRAM_BOT_TOKEN || "");
  const expectedSecret = String(env.TELEGRAM_WEBHOOK_SECRET || "");
  const adminUserId = String(env.TELEGRAM_ADMIN_USER_ID || "");
  const allowedUsers = parseAllowlist(env.TELEGRAM_ALLOWED_USER_IDS);
  if (!botToken || expectedSecret.length < 32 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(adminUserId) || !allowedUsers.size) {
    return { status: 503, body: { error: "Telegram integration is not configured." } };
  }
  if (!safeEqual(secretToken, expectedSecret)) return { status: 401, body: { error: "Webhook authentication failed." } };

  const message = body?.message;
  const senderId = String(message?.from?.id ?? "");
  if (!/^\d{1,20}$/.test(senderId) || !allowedUsers.has(senderId) || message?.chat?.type !== "private" || String(message?.chat?.id ?? "") !== senderId) {
    return { status: 403, body: { error: "Sender is not authorized." } };
  }
  const chatId = message.chat.id;
  const updateId = body?.update_id;
  if (!Number.isSafeInteger(updateId) || updateId < 0 || !Number.isSafeInteger(message.date) || message.date <= 0) {
    return { status: 400, body: { error: "Telegram update is invalid." } };
  }

  const reply = async text => {
    try {
      await sendTelegramMessage({ fetchImpl, botToken, chatId, text });
      return { status: 200, body: { ok: true } };
    } catch {
      return { status: 502, body: { error: "Telegram could not confirm the request. Delivery can be retried safely." } };
    }
  };

  const command = parseAdvanceCommand(message.text);
  if (!command) return reply(commandHelp);
  if (!database) return reply("Advance storage is temporarily unavailable. Please retry later.");
  if (!Number.isFinite(new Date(message.date * 1000).valueOf()) || message.date * 1000 > Date.now() + 5 * 60 * 1000) {
    return reply("The message timestamp is invalid. Please send the command again.");
  }

  const externalReference = `telegram-update-${updateId}`;
  try {
    const prior = await database.from("advances").select("id").eq("source", "telegram")
      .eq("external_reference", externalReference).maybeSingle();
    if (prior.error) throw new Error("advance_lookup_failed");
    if (prior.data?.id) return reply(`This advance was already recorded (ID ${prior.data.id}).`);

    const employee = await lookupActiveEmployee(database, command.employeeCode);
    if (employee.error) return reply(employee.error);
    const siteResult = await database.from("sites").select("id,site_code,status")
      .eq("site_code", command.siteCode.toUpperCase()).maybeSingle();
    if (siteResult.error) throw new Error("site_lookup_failed");
    if (!siteResult.data || String(siteResult.data.status || "").toLowerCase() !== "active") {
      return reply("No active site matches that site code.");
    }

    const advance = {
      employee_type: employee.employeeType,
      guard_id: employee.employeeType === "guard" ? employee.data.id : null,
      supervisor_id: employee.employeeType === "supervisor" ? employee.data.id : null,
      field_officer_id: employee.employeeType === "field_officer" ? employee.data.id : null,
      site_id: siteResult.data.id,
      amount: command.amount,
      occurred_at: new Date(message.date * 1000).toISOString(),
      payment_mode: "",
      description: command.description,
      source: "telegram",
      external_reference: externalReference,
      enqueue_sheet_sync: isGoogleSheetsSyncConfigured(env),
    };
    const { data: advanceId, error } = await database.rpc("record_advance", { p_advance: advance, p_actor_id: adminUserId });
    if (error || !advanceId) throw new Error("advance_insert_failed");
    return reply(`Advance ₹${command.amount} was recorded (ID ${advanceId}).`);
  } catch {
    return reply("Advance storage is temporarily unavailable. Please retry later.");
  }
}
