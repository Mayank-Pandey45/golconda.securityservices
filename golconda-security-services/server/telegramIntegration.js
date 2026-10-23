import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isGoogleSheetsSyncConfigured } from "./googleSheetsIntegration.js";
import { parseAdvanceMessage, parseTelegramAmount, parseTelegramDate } from "./telegramParser.js";

const HELP = [
  "Golconda Security Services · Owner Admin Bot",
  "/dashboard — active workforce and site summary",
  "/guards — active Guard directory",
  "/sites — active Site directory",
  "/search NAME_OR_CODE — find an employee or site",
  "/salary EMPLOYEE_CODE — configured salary estimate",
  "/report — current month advance total",
  "/newadvance — guided advance entry",
  "/advance AMOUNT EMPLOYEE SITE [purpose] — start an advance preview",
  "/unlink — revoke this Telegram link",
  "You can also send an advance note in plain English, Hinglish, or Hindi. Every advance requires a Confirm & Save tap.",
  "Only private chats are allowed. Financial writes are unavailable in group chats.",
].join("\n");

const EMPLOYEE_TABLES = Object.freeze({ guard: "guards", supervisor: "supervisors", field_officer: "field_officers" });
const ASSIGNMENT_TABLES = Object.freeze({ guard: "guard_site_assignments", supervisor: "supervisor_site_assignments", field_officer: "field_officer_site_assignments" });

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function sha256(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function isUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "")); }
const nowIso = now => now.toISOString();

async function telegramApi({ fetchImpl, botToken, method, payload }) {
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) throw new Error("telegram_api_failed");
  return result.result;
}

async function reply({ fetchImpl, botToken, chatId, text, keyboard }) {
  return telegramApi({ fetchImpl, botToken, method: "sendMessage", payload: {
    chat_id: chatId, text, disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  } });
}

async function safeEvent(database, event) {
  const { error } = await database.from("telegram_bot_events").insert(event);
  return !error;
}

async function ownerCount(database) {
  const result = await database.from("admin_users").select("user_id", { count: "exact", head: true });
  if (result.error) throw new Error("admin_lookup_failed");
  return result.count;
}

async function activeLink(database, telegramUserId) {
  const { data, error } = await database.from("telegram_admin_links").select("admin_user_id")
    .eq("telegram_user_id", telegramUserId).is("revoked_at", null).maybeSingle();
  if (error) throw new Error("telegram_link_lookup_failed");
  if (!data?.admin_user_id) return null;
  const { data: admin, error: adminError } = await database.from("admin_users").select("user_id")
    .eq("user_id", data.admin_user_id).maybeSingle();
  if (adminError) throw new Error("admin_lookup_failed");
  if (!admin || await ownerCount(database) !== 1) return null;
  return data.admin_user_id;
}

async function handleLinkCommand({ database, code, senderId, fetchImpl, botToken, chatId, now }) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code || "")) return reply({ fetchImpl, botToken, chatId, text: "That linking code is invalid or expired. Generate a fresh code in the admin dashboard." });
  const codeHash = sha256(code);
  const { data: token, error: lookupError } = await database.from("telegram_link_codes").select("id,admin_user_id,expires_at,used_at")
    .eq("code_hash", codeHash).maybeSingle();
  if (lookupError) throw new Error("telegram_link_code_lookup_failed");
  if (!token || token.used_at || new Date(token.expires_at).valueOf() <= now.valueOf()) {
    return reply({ fetchImpl, botToken, chatId, text: "That linking code is invalid, expired, or already used. Generate a fresh code in the admin dashboard." });
  }
  const { data: admin, error: adminError } = await database.from("admin_users").select("user_id")
    .eq("user_id", token.admin_user_id).maybeSingle();
  if (adminError) throw new Error("admin_lookup_failed");
  if (!admin || await ownerCount(database) !== 1) return reply({ fetchImpl, botToken, chatId, text: "Only the verified owner administrator can link this bot." });

  const { data: existing, error: linkError } = await database.from("telegram_admin_links").select("telegram_user_id")
    .eq("admin_user_id", token.admin_user_id).is("revoked_at", null).maybeSingle();
  if (linkError) throw new Error("telegram_link_lookup_failed");
  if (existing && String(existing.telegram_user_id) !== senderId) {
    return reply({ fetchImpl, botToken, chatId, text: "This owner account already has a linked Telegram account. Revoke the existing link from Telegram Integration settings first." });
  }
  const { data: consumed, error: consumeError } = await database.from("telegram_link_codes").update({ used_at: nowIso(now) })
    .eq("id", token.id).is("used_at", null).gt("expires_at", nowIso(now)).select("id").maybeSingle();
  if (consumeError) throw new Error("telegram_link_code_consume_failed");
  if (!consumed) return reply({ fetchImpl, botToken, chatId, text: "That linking code has already been used or expired. Generate a fresh one." });

  const { error: upsertError } = await database.from("telegram_admin_links").upsert({
    admin_user_id: token.admin_user_id, telegram_user_id: senderId, linked_at: nowIso(now), revoked_at: null, revoked_by: null,
  }, { onConflict: "admin_user_id" });
  if (upsertError) throw new Error("telegram_link_save_failed");
  await safeEvent(database, { actor_id: token.admin_user_id, telegram_user_id: senderId, event_type: "admin_linked", details: {} });
  return reply({ fetchImpl, botToken, chatId, text: "Telegram is now linked to the verified owner administrator. Advance messages will always require review and confirmation." });
}

async function loadDirectory(database) {
  const employeeResults = await Promise.all(Object.entries(EMPLOYEE_TABLES).map(async ([employeeType, table]) => {
    const result = await database.from(table).select("id,employee_code,full_name,status,designation,salary_amount,salary_frequency")
      .eq("status", "active").limit(1000);
    return { employeeType, ...result };
  }));
  const siteResult = await database.from("sites").select("id,title,site_code,status").eq("status", "active").limit(1000);
  const aliasResult = await database.from("telegram_aliases").select("id,alias,entity_type,guard_id,supervisor_id,field_officer_id,site_id,replacement").limit(5000);
  if (employeeResults.some(result => result.error) || siteResult.error || aliasResult.error) throw new Error("telegram_directory_lookup_failed");
  const employees = employeeResults.flatMap(result => (result.data || []).map(row => ({ ...row, employee_type: result.employeeType })));
  return { employees, sites: siteResult.data || [], aliases: aliasResult.data || [] };
}

async function currentAssignment(database, employee, siteId) {
  const table = ASSIGNMENT_TABLES[employee.employee_type];
  const employeeKey = `${employee.employee_type}_id`;
  const { data, error } = await database.from(table).select("id").eq(employeeKey, employee.id)
    .eq("site_id", siteId).is("valid_to", null).maybeSingle();
  if (error) throw new Error("telegram_assignment_lookup_failed");
  return Boolean(data?.id);
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value));
}

function reviewKeyboard(id) {
  return [
    [{ text: "Confirm & Save", callback_data: `confirm:${id}` }, { text: "Cancel", callback_data: `cancel:${id}` }],
    [{ text: "Edit Employee", callback_data: `edit:employee:${id}` }, { text: "Edit Site", callback_data: `edit:site:${id}` }],
    [{ text: "Edit Amount", callback_data: `edit:amount:${id}` }, { text: "Edit Date", callback_data: `edit:date:${id}` }],
    [{ text: "Edit Payment Mode", callback_data: `edit:payment_mode:${id}` }, { text: "Edit Notes", callback_data: `edit:notes:${id}` }],
  ];
}

function previewMessage({ employee, site, amount, occurred_at, payment_mode, description, expires_at }) {
  const date = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(new Date(occurred_at));
  const expires = Math.max(1, Math.ceil((new Date(expires_at).valueOf() - Date.now()) / 60000));
  return ["Advance Entry Preview · Not Saved", `Employee: ${employee.full_name} (${employee.employee_code || employee.employee_type})`,
    `Employee ID: ${employee.employee_code || employee.id}`, `Site: ${site.title}`, `Amount: ${formatMoney(amount)}`,
    `Purpose: ${description || "Not specified"}`, `Payment mode: ${payment_mode || "Not specified"}`, `Date: ${date}`,
    `Status: Not Saved · expires in ${expires} minute${expires === 1 ? "" : "s"}`].join("\n");
}

async function makePreview({ database, employee, site, parsed, senderId, actorId, updateId, now, fetchImpl, botToken, chatId }) {
  const assigned = await currentAssignment(database, employee, site.id);
  if (!assigned) {
    await reply({ fetchImpl, botToken, chatId, text: `${employee.full_name} is not currently assigned to ${site.title}. No advance was staged. Send the active Site name or code from the assignment register, or correct the assignment in the dashboard.` });
    return false;
  }
  const pending = {
    telegram_user_id: senderId, actor_id: actorId, source_update_id: updateId, employee_type: employee.employee_type,
    guard_id: employee.employee_type === "guard" ? employee.id : null,
    supervisor_id: employee.employee_type === "supervisor" ? employee.id : null,
    field_officer_id: employee.employee_type === "field_officer" ? employee.id : null,
    site_id: site.id, amount: parsed.amount, occurred_at: parsed.occurred_at,
    payment_mode: parsed.payment_mode, description: parsed.description, notes: parsed.notes,
    expires_at: new Date(now.valueOf() + 10 * 60 * 1000).toISOString(), status: "awaiting_confirmation",
  };
  const { data, error } = await database.from("telegram_pending_advances").insert(pending).select("id").single();
  if (error?.code === "23505") {
    const prior = await database.from("telegram_pending_advances").select("id,status,expires_at").eq("source_update_id", updateId).eq("telegram_user_id", senderId).maybeSingle();
    if (prior.error) throw new Error("telegram_pending_advance_lookup_failed");
    if (prior.data?.status === "awaiting_confirmation" && new Date(prior.data.expires_at).valueOf() > now.valueOf()) {
      await reply({ fetchImpl, botToken, chatId, text: previewMessage({ employee, site, ...parsed, expires_at: prior.data.expires_at }), keyboard: reviewKeyboard(prior.data.id) });
      return true;
    }
    return reply({ fetchImpl, botToken, chatId, text: "This advance request was already handled or expired. Send it again as a new message to prepare another preview." }).then(() => true);
  }
  if (error || !data?.id) throw new Error("telegram_pending_advance_create_failed");
  await safeEvent(database, { actor_id: actorId, telegram_user_id: senderId, event_type: "advance_preview_created", pending_id: data.id, details: { update_id: updateId } });
  const preview = previewMessage({ employee, site, ...parsed, expires_at: pending.expires_at });
  await reply({ fetchImpl, botToken, chatId, text: preview, keyboard: reviewKeyboard(data.id) });
  return true;
}

async function sendPendingPreview({ database, pending, fetchImpl, botToken, chatId }) {
  const employeeId = pending.guard_id || pending.supervisor_id || pending.field_officer_id;
  const { data: employee, error: employeeError } = await database.from(EMPLOYEE_TABLES[pending.employee_type])
    .select("id,employee_code,full_name").eq("id", employeeId).maybeSingle();
  const { data: site, error: siteError } = await database.from("sites").select("id,title,site_code").eq("id", pending.site_id).maybeSingle();
  if (employeeError || siteError || !employee || !site) throw new Error("telegram_pending_advance_lookup_failed");
  await reply({ fetchImpl, botToken, chatId, text: previewMessage({ employee: { ...employee, employee_type: pending.employee_type }, site, ...pending }), keyboard: reviewKeyboard(pending.id) });
}

async function startPendingEdit({ database, pendingId, field, senderId, actorId, now, fetchImpl, botToken, chatId }) {
  const { data: pending, error } = await database.from("telegram_pending_advances").select("id")
    .eq("id", pendingId).eq("telegram_user_id", senderId).eq("actor_id", actorId)
    .eq("status", "awaiting_confirmation").gt("expires_at", nowIso(now)).maybeSingle();
  if (error) throw new Error("telegram_pending_advance_lookup_failed");
  if (!pending) return reply({ fetchImpl, botToken, chatId, text: "This preview was already handled or has expired." });
  const steps = {
    employee: "Send the exact active employee code.", site: "Send the exact active Site code or full Site name.",
    amount: "Send the corrected amount only, for example 1200.50.", date: "Send a date as DD/MM/YYYY or YYYY-MM-DD.",
    payment_mode: "Send Cash, Online, or Not specified.", notes: "Send the corrected note, or a single dash to clear it.",
  };
  const { error: saveError } = await database.from("telegram_wizard_sessions").upsert({
    telegram_user_id: senderId, actor_id: actorId, step: `edit_${field}`, draft: { pending_id: pendingId },
    expires_at: new Date(now.valueOf() + 10 * 60 * 1000).toISOString(), updated_at: nowIso(now),
  }, { onConflict: "telegram_user_id" });
  if (saveError) throw new Error("telegram_edit_session_save_failed");
  return reply({ fetchImpl, botToken, chatId, text: `${steps[field]} The preview is still unsaved. You must confirm the revised preview.` });
}

async function applyPendingEdit({ database, session, text, senderId, actorId, now, fetchImpl, botToken, chatId }) {
  const pendingId = session.draft?.pending_id;
  const { data: pending, error } = await database.from("telegram_pending_advances").select("*").eq("id", pendingId)
    .eq("telegram_user_id", senderId).eq("actor_id", actorId).eq("status", "awaiting_confirmation").gt("expires_at", nowIso(now)).maybeSingle();
  if (error) throw new Error("telegram_pending_advance_lookup_failed");
  if (!pending) {
    await database.from("telegram_wizard_sessions").delete().eq("telegram_user_id", senderId);
    return reply({ fetchImpl, botToken, chatId, text: "This preview was handled or expired. Send a new advance message." });
  }
  const field = session.step.slice("edit_".length);
  const update = { updated_at: nowIso(now) };
  if (field === "amount") {
    const parsed = parseTelegramAmount(text);
    if (parsed.error) return reply({ fetchImpl, botToken, chatId, text: parsed.error });
    update.amount = parsed.amount;
  } else if (field === "date") {
    const parsed = parseTelegramDate(text, now);
    if (parsed.error || !parsed.matched) return reply({ fetchImpl, botToken, chatId, text: parsed.error || "Send a date as DD/MM/YYYY or YYYY-MM-DD." });
    update.occurred_at = parsed.occurredAt;
  } else if (field === "payment_mode") {
    const value = text.trim().toLowerCase();
    if (["cash", "nakad"].includes(value)) update.payment_mode = "Cash";
    else if (["online", "upi", "bank", "transfer"].includes(value)) update.payment_mode = "Online";
    else if (["not specified", "none", "-"] .includes(value)) update.payment_mode = "";
    else return reply({ fetchImpl, botToken, chatId, text: "Choose Cash, Online, or Not specified." });
  } else if (field === "notes") {
    if (text.length > 500) return reply({ fetchImpl, botToken, chatId, text: "Notes must be 500 characters or fewer." });
    update.notes = text.trim() === "-" ? "" : text.trim();
  } else if (field === "employee") {
    const code = text.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,64}$/.test(code)) return reply({ fetchImpl, botToken, chatId, text: "Send the exact active employee code." });
    const matches = await Promise.all(Object.entries(EMPLOYEE_TABLES).map(async ([employeeType, table]) => ({ employeeType, ...(await database.from(table).select("id,employee_code,full_name,status").eq("employee_code", code).eq("status", "active").maybeSingle()) })));
    if (matches.some(result => result.error)) throw new Error("telegram_employee_lookup_failed");
    const people = matches.filter(result => result.data);
    if (people.length !== 1) return reply({ fetchImpl, botToken, chatId, text: people.length ? "That employee code is ambiguous across roles. Ask an administrator to correct the directory." : "No active employee matches that code." });
    const employee = people[0].data; const employeeType = people[0].employeeType;
    if (!await currentAssignment(database, { ...employee, employee_type: employeeType }, pending.site_id)) return reply({ fetchImpl, botToken, chatId, text: "That employee is not currently assigned to the preview Site. No change was made." });
    update.employee_type = employeeType; update.guard_id = employeeType === "guard" ? employee.id : null;
    update.supervisor_id = employeeType === "supervisor" ? employee.id : null; update.field_officer_id = employeeType === "field_officer" ? employee.id : null;
  } else if (field === "site") {
    const value = text.trim().slice(0, 160);
    if (!value) return reply({ fetchImpl, botToken, chatId, text: "Send the exact active Site code or full Site name." });
    let siteResult;
    if (/^[A-Za-z0-9_-]{1,64}$/.test(value)) siteResult = await database.from("sites").select("id,title,site_code,status").eq("status", "active").eq("site_code", value.toUpperCase()).limit(2);
    else siteResult = await database.from("sites").select("id,title,site_code,status").eq("status", "active").ilike("title", value.replace(/[%_]/g, "")).limit(2);
    if (siteResult.error) throw new Error("telegram_site_lookup_failed");
    if (siteResult.data?.length !== 1) return reply({ fetchImpl, botToken, chatId, text: siteResult.data?.length ? "More than one Site matches. Send its exact Site code." : "No active Site matches that value." });
    const employeeId = pending.guard_id || pending.supervisor_id || pending.field_officer_id;
    if (!await currentAssignment(database, { id: employeeId, employee_type: pending.employee_type }, siteResult.data[0].id)) return reply({ fetchImpl, botToken, chatId, text: "That employee is not currently assigned to this Site. No change was made." });
    update.site_id = siteResult.data[0].id;
  }
  const { data: changed, error: updateError } = await database.from("telegram_pending_advances").update(update)
    .eq("id", pending.id).eq("status", "awaiting_confirmation").select("*").maybeSingle();
  if (updateError || !changed) throw new Error("telegram_pending_advance_update_failed");
  await database.from("telegram_wizard_sessions").delete().eq("telegram_user_id", senderId);
  await safeEvent(database, { actor_id: actorId, telegram_user_id: senderId, event_type: "advance_preview_edited", pending_id: pending.id, details: { field } });
  return sendPendingPreview({ database, pending: changed, fetchImpl, botToken, chatId });
}

async function handleNaturalEntry({ database, text, senderId, actorId, updateId, now, fetchImpl, botToken, chatId }) {
  const directory = await loadDirectory(database);
  const parsed = parseAdvanceMessage(text, { ...directory, now });
  if (parsed.status !== "ready") {
    const textReply = parsed.status === "ambiguous_employee"
      ? `More than one employee may match. Choose by sending the exact employee code:\n${parsed.candidates.map(row => `• ${row.full_name} · ${row.employee_code}`).join("\n")}`
      : parsed.status === "ambiguous_site"
        ? `More than one Site may match. Send the exact Site code:\n${parsed.candidates.map(row => `• ${row.title} · ${row.site_code || row.id}`).join("\n")}`
        : parsed.message;
    await reply({ fetchImpl, botToken, chatId, text: textReply || "I need a clearer employee, Site, and amount before I can prepare an advance." });
    return false;
  }
  const employee = directory.employees.find(row => row.id === parsed.advance.employee.id && row.employee_type === parsed.advance.employee.employee_type);
  const site = directory.sites.find(row => row.id === parsed.advance.site.id);
  if (!employee || !site) { await reply({ fetchImpl, botToken, chatId, text: "The employee or Site changed while this message was being checked. Send the entry again after refreshing the dashboard." }); return false; }
  return makePreview({ database, employee, site, parsed: parsed.advance, senderId, actorId, updateId, now, fetchImpl, botToken, chatId });
}

async function confirmPending({ database, pendingId, senderId, actorId, now, env, fetchImpl, botToken, chatId }) {
  const { data: pending, error } = await database.from("telegram_pending_advances").select("*").eq("id", pendingId)
    .eq("telegram_user_id", senderId).eq("actor_id", actorId).eq("status", "awaiting_confirmation").maybeSingle();
  if (error) throw new Error("telegram_pending_advance_lookup_failed");
  if (!pending || new Date(pending.expires_at).valueOf() <= now.valueOf()) {
    if (pending) await database.from("telegram_pending_advances").update({ status: "expired", updated_at: nowIso(now) }).eq("id", pendingId).eq("status", "awaiting_confirmation");
    return reply({ fetchImpl, botToken, chatId, text: "This advance preview has expired or was already handled. Send the entry again to create a fresh preview." });
  }
  const employeeId = pending.guard_id || pending.supervisor_id || pending.field_officer_id;
  const table = EMPLOYEE_TABLES[pending.employee_type];
  const { data: employee, error: employeeError } = await database.from(table).select("id,employee_code,full_name,status")
    .eq("id", employeeId).eq("status", "active").maybeSingle();
  const { data: site, error: siteError } = await database.from("sites").select("id,title,status")
    .eq("id", pending.site_id).eq("status", "active").maybeSingle();
  if (employeeError || siteError) throw new Error("telegram_confirmation_revalidation_failed");
  if (!employee || !site) return reply({ fetchImpl, botToken, chatId, text: "The employee or Site is no longer active. Nothing was saved." });
  if (!await currentAssignment(database, { ...employee, employee_type: pending.employee_type }, site.id)) {
    return reply({ fetchImpl, botToken, chatId, text: "The employee is no longer assigned to that Site. Nothing was saved. Start a new preview with the active Site." });
  }
  const amount = Number(pending.amount);
  const dateValue = new Date(pending.occurred_at);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000 || Number.isNaN(dateValue.valueOf()) || dateValue.valueOf() > now.valueOf() + 5 * 60 * 1000) {
    return reply({ fetchImpl, botToken, chatId, text: "The stored preview did not pass final validation. Nothing was saved; send the entry again." });
  }
  const externalReference = `telegram-pending-${pending.id}`;
  const payload = {
    employee_type: pending.employee_type,
    guard_id: pending.employee_type === "guard" ? employeeId : null,
    supervisor_id: pending.employee_type === "supervisor" ? employeeId : null,
    field_officer_id: pending.employee_type === "field_officer" ? employeeId : null,
    site_id: site.id, amount: Number(amount).toFixed(2), occurred_at: dateValue.toISOString(),
    payment_mode: pending.payment_mode || "", description: [pending.description, pending.notes].filter(Boolean).join(" · "),
    source: "telegram", external_reference: externalReference,
    enqueue_sheet_sync: isGoogleSheetsSyncConfigured(env),
  };
  const { data: advanceId, error: writeError } = await database.rpc("record_advance", { p_advance: payload, p_actor_id: actorId });
  if (writeError || !advanceId) throw new Error("telegram_advance_write_failed");
  await database.from("telegram_pending_advances").update({ status: "saved", saved_advance_id: advanceId, updated_at: nowIso(now) })
    .eq("id", pendingId).eq("status", "awaiting_confirmation");
  await safeEvent(database, { actor_id: actorId, telegram_user_id: senderId, event_type: "advance_saved", pending_id: pendingId, advance_id: advanceId, details: {} });
  return reply({ fetchImpl, botToken, chatId, text: `Advance ${formatMoney(amount)} was recorded for ${employee.full_name} at ${site.title}. Transaction ID: ${advanceId}.` });
}

async function handleCallback({ database, callback, senderId, actorId, now, env, fetchImpl, botToken }) {
  const chatId = callback.message.chat.id;
  const match = /^(confirm|cancel):([0-9a-f-]{36})$/i.exec(String(callback.data || ""));
  const editMatch = /^edit:(employee|site|amount|date|payment_mode|notes):([0-9a-f-]{36})$/i.exec(String(callback.data || ""));
  if (editMatch && isUuid(editMatch[2])) {
    await telegramApi({ fetchImpl, botToken, method: "answerCallbackQuery", payload: { callback_query_id: callback.id, text: "Opening a secure edit step…" } });
    await startPendingEdit({ database, pendingId: editMatch[2], field: editMatch[1].toLowerCase(), senderId, actorId, now, fetchImpl, botToken, chatId });
    return { status: 200, body: { ok: true } };
  }
  if (!match || !isUuid(match[2])) {
    await telegramApi({ fetchImpl, botToken, method: "answerCallbackQuery", payload: { callback_query_id: callback.id, text: "This action is invalid." } });
    return { status: 200, body: { ok: true } };
  }
  await telegramApi({ fetchImpl, botToken, method: "answerCallbackQuery", payload: { callback_query_id: callback.id, text: match[1] === "confirm" ? "Rechecking authorization and advance details…" : "Cancelling preview…" } });
  if (match[1] === "cancel") {
    const { data, error } = await database.from("telegram_pending_advances").update({ status: "cancelled", updated_at: nowIso(now) })
      .eq("id", match[2]).eq("telegram_user_id", senderId).eq("actor_id", actorId).eq("status", "awaiting_confirmation")
      .gt("expires_at", nowIso(now)).select("id").maybeSingle();
    if (error) throw new Error("telegram_pending_advance_cancel_failed");
    await database.from("telegram_wizard_sessions").delete().eq("telegram_user_id", senderId);
    await safeEvent(database, { actor_id: actorId, telegram_user_id: senderId, event_type: "advance_preview_cancelled", pending_id: match[2], details: {} });
    await reply({ fetchImpl, botToken, chatId, text: data ? "Advance preview cancelled. Nothing was saved." : "This preview was already handled or expired." });
    return { status: 200, body: { ok: true } };
  }
  await confirmPending({ database, pendingId: match[2], senderId, actorId, now, env, fetchImpl, botToken, chatId });
  await database.from("telegram_wizard_sessions").delete().eq("telegram_user_id", senderId);
  return { status: 200, body: { ok: true } };
}

async function startNewAdvanceWizard({ database, senderId, actorId, now, fetchImpl, botToken, chatId }) {
  const { error } = await database.from("telegram_wizard_sessions").upsert({
    telegram_user_id: senderId, actor_id: actorId, step: "amount", draft: {},
    expires_at: new Date(now.valueOf() + 15 * 60 * 1000).toISOString(), updated_at: nowIso(now),
  }, { onConflict: "telegram_user_id" });
  if (error) throw new Error("telegram_wizard_start_failed");
  return reply({ fetchImpl, botToken, chatId, text: "New advance · Step 1 of 2\nSend the advance amount only, for example 1000 or 1000.50. This is still not saved." });
}

async function continueWizard({ database, senderId, actorId, text, updateId, now, env, fetchImpl, botToken, chatId }) {
  const { data: session, error } = await database.from("telegram_wizard_sessions").select("step,draft,expires_at")
    .eq("telegram_user_id", senderId).eq("actor_id", actorId).maybeSingle();
  if (error) throw new Error("telegram_wizard_lookup_failed");
  if (!session) return false;
  if (new Date(session.expires_at).valueOf() <= now.valueOf()) {
    await database.from("telegram_wizard_sessions").delete().eq("telegram_user_id", senderId);
    await reply({ fetchImpl, botToken, chatId, text: "That guided entry expired. Start again with /newadvance." });
    return true;
  }
  if (session.step === "amount") {
    const parsed = parseTelegramAmount(text);
    if (parsed.error) { await reply({ fetchImpl, botToken, chatId, text: parsed.error }); return true; }
    const { error: saveError } = await database.from("telegram_wizard_sessions").update({ step: "details", draft: { amount: parsed.amount }, updated_at: nowIso(now), expires_at: new Date(now.valueOf() + 15 * 60 * 1000).toISOString() }).eq("telegram_user_id", senderId);
    if (saveError) throw new Error("telegram_wizard_update_failed");
    await reply({ fetchImpl, botToken, chatId, text: "New advance · Step 2 of 2\nSend the employee name or code, active Site name or code, and optional purpose/payment mode. Example: Srikant VK Enclave food cash.\nI will prepare a preview before saving." });
    return true;
  }
  if (session.step === "details") {
    const staged = await handleNaturalEntry({ database, text: `${session.draft?.amount || ""} ${text}`, senderId, actorId, updateId, now, fetchImpl, botToken, chatId });
    if (staged) await database.from("telegram_wizard_sessions").delete().eq("telegram_user_id", senderId);
    return true;
  }
  if (String(session.step).startsWith("edit_")) {
    await applyPendingEdit({ database, session, text, senderId, actorId, now, fetchImpl, botToken, chatId });
    return true;
  }
  await database.from("telegram_wizard_sessions").delete().eq("telegram_user_id", senderId);
  return false;
}

async function handleReadCommand({ database, command, args, fetchImpl, botToken, chatId }) {
  if (command === "/help" || command === "/start") return reply({ fetchImpl, botToken, chatId, text: HELP });
  if (command === "/newadvance") return reply({ fetchImpl, botToken, chatId, text: "Guided advance entry\nSend one message with amount, employee name or code, and active Site name or code. Example: 1000 Srikant VK Enclave food cash.\nI will show a review card; nothing is written until you tap Confirm & Save. Use /cancel only before a preview is created." });
  if (command === "/dashboard") {
    const counts = await Promise.all(["guards", "supervisors", "field_officers", "sites"].map(async table => {
      const { count, error } = await database.from(table).select("id", { count: "exact", head: true }).eq("status", "active");
      if (error) throw new Error("telegram_dashboard_lookup_failed");
      return count || 0;
    }));
    return reply({ fetchImpl, botToken, chatId, text: `Active dashboard summary\nGuards: ${counts[0]}\nSupervisors: ${counts[1]}\nField Officers: ${counts[2]}\nSites: ${counts[3]}` });
  }
  if (command === "/guards" || command === "/sites") {
    const isSite = command === "/sites";
    const table = isSite ? "sites" : "guards";
    const columns = isSite ? "id,title,site_code" : "id,full_name,employee_code";
    const { data, error } = await database.from(table).select(columns).eq("status", "active").order(isSite ? "title" : "full_name").limit(40);
    if (error) throw new Error("telegram_directory_lookup_failed");
    const rows = (data || []).map(row => isSite ? `• ${row.title} (${row.site_code || row.id})` : `• ${row.full_name} (${row.employee_code})`);
    return reply({ fetchImpl, botToken, chatId, text: `${isSite ? "Active Sites" : "Active Security Guards"}${rows.length ? `\n${rows.join("\n")}` : "\nNo active records."}${(data || []).length === 40 ? "\nShowing first 40." : ""}` });
  }
  if (command === "/search") {
    const term = args.trim().slice(0, 80);
    if (!term) return reply({ fetchImpl, botToken, chatId, text: "Use /search followed by an employee name, employee code, or Site name." });
    const pattern = `%${term.replace(/[%_\\]/g, "")}%`;
    const results = await Promise.all([...Object.entries(EMPLOYEE_TABLES).map(async ([type, table]) => {
      const matches = await Promise.all(["full_name", "employee_code"].map(column => database.from(table).select("id,full_name,employee_code,status").ilike(column, pattern).limit(10)));
      return { type, data: [...new Map(matches.flatMap(result => result.data || []).map(row => [String(row.id), row])).values()], error: matches.find(result => result.error)?.error };
    }),
      (async () => {
        const matches = await Promise.all(["title", "site_code"].map(column => database.from("sites").select("id,title,site_code,status").ilike(column, pattern).limit(10)));
        return { type: "site", data: [...new Map(matches.flatMap(result => result.data || []).map(row => [String(row.id), row])).values()], error: matches.find(result => result.error)?.error };
      })()]);
    if (results.some(result => result.error)) throw new Error("telegram_search_failed");
    const output = results.flatMap(result => (result.data || []).map(row => result.type === "site" ? `• Site ${row.title} (${row.site_code || row.id}) · ${row.status}` : `• ${result.type.replace("_", " ")} ${row.full_name} (${row.employee_code}) · ${row.status}`));
    return reply({ fetchImpl, botToken, chatId, text: output.length ? `${output.slice(0, 15).join("\n")}${output.length > 15 ? "\nShowing the first 15 matches." : ""}` : "No matching employee or Site was found." });
  }
  if (command === "/salary") {
    const code = args.trim().toUpperCase();
    if (!code) return reply({ fetchImpl, botToken, chatId, text: "Use /salary followed by an exact employee code." });
    const matches = await Promise.all(Object.entries(EMPLOYEE_TABLES).map(async ([type, table]) => ({ type, ...(await database.from(table).select("id,full_name,employee_code,salary_amount,salary_frequency,status").eq("employee_code", code).maybeSingle()) })));
    if (matches.some(result => result.error)) throw new Error("telegram_salary_lookup_failed");
    const person = matches.find(result => result.data)?.data;
    if (!person) return reply({ fetchImpl, botToken, chatId, text: "No employee matches that code." });
    let salary = person.salary_amount;
    if (salary == null && person.employee_type !== "guard") {
      const employeeType = matches.find(result => result.data)?.type;
      const { data, error } = await database.from("employee_compensation").select("gross_monthly_salary,salary_frequency,effective_from")
        .eq("employee_type", employeeType).eq(`${employeeType}_id`, person.id).order("effective_from", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error("telegram_salary_lookup_failed");
      salary = data?.gross_monthly_salary;
    }
    if (salary == null) return reply({ fetchImpl, botToken, chatId, text: `${person.full_name}: configured salary is unavailable. Actual paid and pending amounts are not available in the ledger.` });
    return reply({ fetchImpl, botToken, chatId, text: `${person.full_name} (${person.employee_code})\nConfigured monthly salary estimate: ${formatMoney(salary)}\nActual paid and pending amounts: unavailable without a salary payment ledger.` });
  }
  if (command === "/report") {
    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: "Asia/Kolkata" }).formatToParts(now).map(part => [part.type, part.value]));
    const nextMonth = new Date(Date.UTC(Number(parts.year), Number(parts.month), 1));
    const nextParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: "Asia/Kolkata" }).formatToParts(nextMonth).map(part => [part.type, part.value]));
    const monthStart = `${parts.year}-${parts.month}-01T00:00:00+05:30`;
    const monthEnd = `${nextParts.year}-${nextParts.month}-01T00:00:00+05:30`;
    const { data, error } = await database.from("advances").select("amount").gte("occurred_at", monthStart).lt("occurred_at", monthEnd).eq("source", "telegram").limit(5000);
    if (error) throw new Error("telegram_report_lookup_failed");
    const totalPaise = (data || []).reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
    return reply({ fetchImpl, botToken, chatId, text: `Telegram advances this month: ${(data || []).length}\nTotal: ${formatMoney(totalPaise / 100)}\nThis total counts original Telegram ledger rows; recoveries and reversals are handled separately in the dashboard.` });
  }
  if (command === "/unlink") return reply({ fetchImpl, botToken, chatId, text: "Unlink is available after identity verification in the dashboard. Use Telegram Integration → Revoke link." });
  return null;
}

export async function handleTelegramWebhook({ body, secretToken, database, env = process.env, fetchImpl = fetch, now = new Date() }) {
  const botToken = String(env.TELEGRAM_BOT_TOKEN || "");
  const expectedSecret = String(env.TELEGRAM_WEBHOOK_SECRET || "");
  if (!database || !botToken || expectedSecret.length < 32) return { status: 503, body: { error: "Telegram integration is not configured." } };
  if (!safeEqual(secretToken, expectedSecret)) return { status: 401, body: { error: "Webhook authentication failed." } };
  const updateId = body?.update_id;
  const callback = body?.callback_query;
  const message = callback?.message || body?.message;
  const sender = callback?.from || message?.from;
  const senderId = String(sender?.id ?? "");
  if (!Number.isSafeInteger(updateId) || updateId < 0 || !/^\d{1,20}$/.test(senderId) || message?.chat?.type !== "private" || String(message?.chat?.id ?? "") !== senderId) {
    return { status: 403, body: { error: "Only verified private Telegram chats are allowed." } };
  }
  if (!callback && (!Number.isSafeInteger(message.date) || message.date <= 0 || message.date * 1000 > now.valueOf() + 5 * 60 * 1000)) {
    return { status: 400, body: { error: "Telegram message timestamp is invalid." } };
  }

  let claimedReceipt = false;
  try {
    const text = String(message?.text || "").trim();
    const linkMatch = /^\/link(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]+)\s*$/i.exec(text);
    if (!callback && linkMatch) {
      await handleLinkCommand({ database, code: linkMatch[1], senderId, fetchImpl, botToken, chatId: message.chat.id, now });
      return { status: 200, body: { ok: true } };
    }
    if (!callback && /^\/(?:start|help)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
      await reply({ fetchImpl, botToken, chatId: message.chat.id, text: `${HELP}\nTo link: sign in to the admin dashboard, generate a one-time code, then send /link CODE here.` });
      return { status: 200, body: { ok: true } };
    }

    const actorId = await activeLink(database, senderId);
    if (!actorId) return { status: 403, body: { error: "Sender is not linked to the verified owner administrator." } };
    const { error: receiptError } = await database.from("telegram_update_receipts").insert({ update_id: updateId, expires_at: new Date(now.valueOf() + 30 * 24 * 60 * 60 * 1000).toISOString() });
    if (receiptError?.code === "23505") {
      await reply({ fetchImpl, botToken, chatId: message.chat.id, text: "This Telegram update was already handled. Check the dashboard before retrying." }).catch(() => {});
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    if (receiptError) throw new Error("telegram_update_claim_failed");
    claimedReceipt = true;
    if (callback) return await handleCallback({ database, callback, senderId, actorId, now, env, fetchImpl, botToken });

    const commandMatch = /^\/([A-Za-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text);
    const command = commandMatch ? `/${commandMatch[1].toLowerCase()}` : "";
    const args = commandMatch?.[2] || "";
    if (command === "/unlink") {
      const { error } = await database.from("telegram_admin_links").update({ revoked_at: nowIso(now), revoked_by: actorId })
        .eq("admin_user_id", actorId).eq("telegram_user_id", senderId).is("revoked_at", null);
      if (error) throw new Error("telegram_unlink_failed");
      await safeEvent(database, { actor_id: actorId, telegram_user_id: senderId, event_type: "admin_unlinked", details: {} });
      await reply({ fetchImpl, botToken, chatId: message.chat.id, text: "Telegram link revoked. Generate a new one-time code in the admin dashboard to link again." });
      return { status: 200, body: { ok: true } };
    }
    if (command === "/cancel") {
      const { data, error } = await database.from("telegram_pending_advances").update({ status: "cancelled", updated_at: nowIso(now) })
        .eq("telegram_user_id", senderId).eq("actor_id", actorId).eq("status", "awaiting_confirmation").gt("expires_at", nowIso(now)).select("id");
      if (error) throw new Error("telegram_cancel_failed");
      await database.from("telegram_wizard_sessions").delete().eq("telegram_user_id", senderId);
      await reply({ fetchImpl, botToken, chatId: message.chat.id, text: data?.length ? "Pending advance previews cancelled. Nothing was saved." : "There are no pending advance previews." });
      return { status: 200, body: { ok: true } };
    }
    if (command === "/newadvance") {
      await startNewAdvanceWizard({ database, senderId, actorId, now, fetchImpl, botToken, chatId: message.chat.id });
      return { status: 200, body: { ok: true } };
    }
    if (!command) {
      const inWizard = await continueWizard({ database, senderId, actorId, text, updateId, now, env, fetchImpl, botToken, chatId: message.chat.id });
      if (inWizard) return { status: 200, body: { ok: true } };
    }
    const readReply = command ? await handleReadCommand({ database, command, args, fetchImpl, botToken, chatId: message.chat.id }) : null;
    if (readReply) return { status: 200, body: { ok: true } };
    if (command && !["/advance"].includes(command)) {
      await reply({ fetchImpl, botToken, chatId: message.chat.id, text: `Unknown command.\n${HELP}` });
      return { status: 200, body: { ok: true } };
    }
    const entryText = command === "/advance" ? args : text;
    await handleNaturalEntry({ database, text: entryText, senderId, actorId, updateId, now, fetchImpl, botToken, chatId: message.chat.id });
    return { status: 200, body: { ok: true } };
  } catch {
    if (claimedReceipt) { try { await database.from("telegram_update_receipts").delete().eq("update_id", updateId); } catch { /* Keep the original safe webhook error. */ } }
    return { status: 503, body: { error: "Telegram could not verify or save this request. No success was confirmed; retry safely or use the dashboard." } };
  }
}
