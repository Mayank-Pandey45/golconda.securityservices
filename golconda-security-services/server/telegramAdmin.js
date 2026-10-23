import { createHash, randomBytes } from "node:crypto";
import { normalizeTelegramText } from "./telegramParser.js";

export class TelegramAdminError extends Error {
  constructor(message, status = 400) { super(message); this.name = "TelegramAdminError"; this.status = status; }
}

async function requireOwner(database, actorId) {
  const { data, error } = await database.from("admin_users").select("user_id").eq("user_id", actorId).maybeSingle();
  if (error) throw new TelegramAdminError("Administrator access could not be verified.", 503);
  if (!data) throw new TelegramAdminError("Only authorized administrators can manage Telegram integration.", 403);
  const count = await database.from("admin_users").select("user_id", { count: "exact", head: true });
  if (count.error) throw new TelegramAdminError("Owner administrator access could not be verified.", 503);
  if (count.count !== 1) throw new TelegramAdminError("Telegram owner linking is disabled because this application has multiple administrator accounts.", 403);
}

async function event(database, actorId, telegramUserId, eventType, details = {}) {
  const { error } = await database.from("telegram_bot_events").insert({ actor_id: actorId, telegram_user_id: telegramUserId || null, event_type: eventType, details });
  if (error) throw new TelegramAdminError("Telegram activity could not be audited.", 503);
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new TelegramAdminError(`${label} is invalid.`);
  return id;
}

export async function handleTelegramAdmin({ database, actorId, input, env = process.env, now = new Date() }) {
  await requireOwner(database, actorId);
  const action = String(input?.action || "status");
  if (action === "status") {
    const [link, aliases, audit, guards, supervisors, officers, sites] = await Promise.all([
      database.from("telegram_admin_links").select("telegram_user_id,linked_at,revoked_at").eq("admin_user_id", actorId).is("revoked_at", null).maybeSingle(),
      database.from("telegram_aliases").select("id,alias,entity_type,guard_id,supervisor_id,field_officer_id,site_id,replacement,created_at").order("created_at", { ascending: false }).limit(100),
      database.from("telegram_bot_events").select("id,event_type,telegram_user_id,advance_id,created_at").order("created_at", { ascending: false }).limit(50),
      database.from("guards").select("id,employee_code,full_name").eq("status", "active").limit(1000),
      database.from("supervisors").select("id,employee_code,full_name").eq("status", "active").limit(1000),
      database.from("field_officers").select("id,employee_code,full_name").eq("status", "active").limit(1000),
      database.from("sites").select("id,site_code,title").eq("status", "active").limit(1000),
    ]);
    if ([link, aliases, audit, guards, supervisors, officers, sites].some(result => result.error)) throw new TelegramAdminError("Telegram settings could not be loaded.", 503);
    return { configured: Boolean(env.TELEGRAM_BOT_TOKEN && String(env.TELEGRAM_WEBHOOK_SECRET || "").length >= 32), linked: link.data || null, aliases: aliases.data || [], activity: audit.data || [], directory: { guards: guards.data || [], supervisors: supervisors.data || [], field_officers: officers.data || [], sites: sites.data || [] } };
  }
  if (action === "generate_link") {
    const code = randomBytes(18).toString("base64url");
    const expiresAt = new Date(now.valueOf() + 10 * 60 * 1000).toISOString();
    const { error } = await database.from("telegram_link_codes").insert({
      admin_user_id: actorId, code_hash: createHash("sha256").update(code).digest("hex"), expires_at: expiresAt, created_by: actorId,
    });
    if (error) throw new TelegramAdminError("A one-time Telegram link code could not be generated.", 503);
    await event(database, actorId, null, "link_code_generated", {});
    return { ok: true, code, expires_at: expiresAt };
  }
  if (action === "revoke_link") {
    const { data: current, error: lookupError } = await database.from("telegram_admin_links").select("telegram_user_id")
      .eq("admin_user_id", actorId).is("revoked_at", null).maybeSingle();
    if (lookupError) throw new TelegramAdminError("Telegram link could not be checked.", 503);
    if (!current) return { ok: true, revoked: false };
    const { error } = await database.from("telegram_admin_links").update({ revoked_at: now.toISOString(), revoked_by: actorId })
      .eq("admin_user_id", actorId).is("revoked_at", null);
    if (error) throw new TelegramAdminError("Telegram link could not be revoked.", 503);
    await event(database, actorId, current.telegram_user_id, "admin_link_revoked", {});
    return { ok: true, revoked: true };
  }
  if (action === "add_alias") {
    const alias = String(input?.alias || "").trim();
    const normalizedAlias = normalizeTelegramText(alias);
    const entityType = String(input?.entity_type || "");
    if (alias.length > 100 || normalizedAlias.length < 2 || !["guard", "supervisor", "field_officer", "site", "note"].includes(entityType)) throw new TelegramAdminError("Enter a valid alias and target.");
    const row = { alias, normalized_alias: normalizedAlias, entity_type: entityType, created_by: actorId };
    if (entityType === "note") {
      row.replacement = String(input?.replacement || "").trim();
      if (!row.replacement || row.replacement.length > 100) throw new TelegramAdminError("Add a meaning of 1 to 100 characters for this abbreviation.");
    } else if (entityType === "site") {
      row.site_id = positiveId(input?.site_id, "Site");
      const { data, error } = await database.from("sites").select("id").eq("id", row.site_id).eq("status", "active").maybeSingle();
      if (error) throw new TelegramAdminError("Site could not be verified.", 503);
      if (!data) throw new TelegramAdminError("Choose an active Site.");
    } else {
      const idField = `${entityType}_id`;
      row[idField] = positiveId(input?.employee_id, "Employee");
      const table = entityType === "guard" ? "guards" : entityType === "supervisor" ? "supervisors" : "field_officers";
      const { data, error } = await database.from(table).select("id").eq("id", row[idField]).eq("status", "active").maybeSingle();
      if (error) throw new TelegramAdminError("Employee could not be verified.", 503);
      if (!data) throw new TelegramAdminError("Choose an active employee.");
    }
    const { data, error } = await database.from("telegram_aliases").insert(row).select("id,alias,entity_type,guard_id,supervisor_id,field_officer_id,site_id,replacement,created_at").single();
    if (error?.code === "23505") throw new TelegramAdminError("That alias is already configured.", 409);
    if (error || !data) throw new TelegramAdminError("Alias could not be saved.", 503);
    await event(database, actorId, null, "alias_added", { entity_type: entityType });
    return { ok: true, alias: data };
  }
  if (action === "delete_alias") {
    const id = positiveId(input?.alias_id, "Alias");
    const { error, count } = await database.from("telegram_aliases").delete({ count: "exact" }).eq("id", id);
    if (error) throw new TelegramAdminError("Alias could not be deleted.", 503);
    await event(database, actorId, null, "alias_removed", {});
    return { ok: true, deleted: count !== 0 };
  }
  throw new TelegramAdminError("Unknown Telegram integration action.");
}
