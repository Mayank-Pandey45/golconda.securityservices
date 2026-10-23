import { OperationsRequestError, requireAdmin } from "./operations.js";
import { recordModules, intakeStates, confirmationPhrase } from "../shared/recordLifecycle.js";

const editFields = {
  services: ["title", "description", "image_url", "tag", "icon_key", "sort_order"],
  events: ["title", "description", "event_date", "image_url", "event_type", "display_status", "sort_order"],
  notifications: ["title", "message", "notification_type", "display_date", "sort_order", "notification_severity", "starts_at", "expires_at", "is_active", "is_published", "dismissible", "button_label", "button_url"],
  profileDocs: ["title", "description", "file_url", "storage_path", "mime_type", "media_type", "category", "is_public", "sort_order"],
  contactSubmissions: ["admin_notes", "status"],
  jobApplications: ["admin_notes", "status"],
  complaints: ["admin_notes", "status"],
};
export function validateRecordRequest(input) {
  const config = Object.hasOwn(recordModules, input?.module) ? recordModules[input.module] : null;
  if (!config) throw new OperationsRequestError("Choose a supported record module.");
  const action = input.action;
  if (!["save", "archive", "restore", "activate", "deactivate", "hide", "close", "reopen", "delete"].includes(action)) throw new OperationsRequestError("Choose a supported record action.");
  const id = input.id == null ? null : Number(input.id);
  if ((id !== null && (!Number.isSafeInteger(id) || id <= 0)) || (id === null && action !== "save")) throw new OperationsRequestError("Record ID must be a positive integer.");
  if (action === "delete" && config.kind === "intake") throw new OperationsRequestError("Retention policy is not configured. Archive this submission instead.", 409);
  if (action === "delete" && input.confirmation !== confirmationPhrase(action, id)) throw new OperationsRequestError("Type DELETE followed by the exact record ID to confirm permanent deletion.");
  if (action === "save") {
    if (!editFields[input.module]) throw new OperationsRequestError("Use the employee or site editor to preserve assignments and compensation.");
    if (config.kind === "intake" && id === null) throw new OperationsRequestError("Submissions must originate from the intake form.");
    if (!input.patch || typeof input.patch !== "object" || Array.isArray(input.patch) || !Object.keys(input.patch).length) throw new OperationsRequestError("Provide record fields to save.");
    if (Object.keys(input.patch).some(key => !editFields[input.module].includes(key))) throw new OperationsRequestError("The request includes fields that cannot be changed.");
    for (const [key, value] of Object.entries(input.patch)) {
      if (key === "title" && (typeof value !== "string" || value.trim().length > 160)) throw new OperationsRequestError("Title must contain at most 160 characters.");
      if (value !== null && !["sort_order","is_public","is_active","is_published","dismissible"].includes(key) && typeof value !== "string") throw new OperationsRequestError("Text fields must contain text.");
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new OperationsRequestError("Record fields must be scalar values.");
      if (typeof value === "string" && value.length > (["description", "message", "admin_notes"].includes(key) ? 5000 : 500)) throw new OperationsRequestError("A record field is too long.");
      if (["title"].includes(key) && (typeof value !== "string" || !value.trim())) throw new OperationsRequestError("Title is required.");
      if (key === "sort_order" && (!Number.isInteger(value) || value < 0 || value > 10000)) throw new OperationsRequestError("Display order must be between 0 and 10000.");
      if (["is_public", "is_active", "is_published", "dismissible"].includes(key) && typeof value !== "boolean") throw new OperationsRequestError("Choose a valid visibility option.");
      if (["file_url", "image_url", "button_url"].includes(key) && value) {
        const local = ["button_url", "image_url"].includes(key) && (/^\/(?!\/)[^\\\s]*$/.test(value) || (key === "button_url" && /^#[A-Za-z0-9_-]+$/.test(value)));
        try {
          const url = new URL(value);
          if (!local && (url.protocol !== "https:" || url.username || url.password)) throw new Error();
        } catch { if (!local) throw new OperationsRequestError("Use a secure HTTPS or safe same-site button URL."); }
      }
    }
    if (input.module === "notifications") {
      if (input.patch.notification_severity && !["information","announcement","warning","urgent"].includes(input.patch.notification_severity)) throw new OperationsRequestError("Choose a supported notification severity.");
      const start = input.patch.starts_at ? Date.parse(input.patch.starts_at) : null;
      const end = input.patch.expires_at ? Date.parse(input.patch.expires_at) : null;
      if ((input.patch.starts_at && !Number.isFinite(start)) || (input.patch.expires_at && !Number.isFinite(end)) || (start !== null && end !== null && end <= start)) throw new OperationsRequestError("Notification expiry must follow a valid start time.");
    }
    if (intakeStates[input.module] && input.patch.status && !intakeStates[input.module].includes(input.patch.status)) throw new OperationsRequestError("Choose a valid workflow status.");
  }
  return { config, action, id, patch: input.patch || {} };
}
export function rpcFailure(error) {
  if (error.code === "55000" && /audit history/.test(error.message || "")) return new OperationsRequestError("Permanent deletion is blocked by retained operational audit history. Keep this record archived; no history was removed.", 409);
  if (error.code === "55000" && /Compliance retention/.test(error.message || "")) return new OperationsRequestError("Compliance-document retention requires owner review. Archive this document instead.", 409);
  if (error.code === "55000" && /Restore/.test(error.message || "")) return new OperationsRequestError("Restore the archived record before editing or activating it.", 409);
  if (error.code === "55000" && /employment end date/.test(error.message || "")) return new OperationsRequestError("Review the employee end date before activating this record. Employment dates were not changed.", 409);
  if (["PGRST202", "42883", "42703", "42P01"].includes(error.code)) return new OperationsRequestError("Record-management migration is not installed. This action is unavailable until the approved migration is applied.", 503);
  if (error.code === "P0002") return new OperationsRequestError("The record no longer exists. Refresh the list.", 404);
  if (error.code === "42501") return new OperationsRequestError("Administrator permission is required.", 403);
  if (["23503", "23505", "P0001", "55000", "40P01", "40001"].includes(error.code)) return new OperationsRequestError(error.code === "23505" ? "A conflicting record already exists. Refresh and review duplicates." : "This record is archived, retained, or linked to assignments, compensation, advances, audit history or stored files. Use Archive / Deactivate, or resolve the reported dependency without deleting history.", 409, { reason: error.hint || "Retained dependencies prevent this action." });
  if (["22023", "22007", "23514", "22P02", "23502"].includes(error.code)) return new OperationsRequestError("Record values or confirmation are invalid. Review the form.", 400);
  return new OperationsRequestError("The record action could not be completed. Retry after refreshing.", 500);
}
export async function manageRecord(database, authorization, input) {
  const actor = await requireAdmin(database, authorization);
  const { config, action, id, patch } = validateRecordRequest(input);
  const { data, error } = await database.rpc("manage_admin_record", { p_table: config.table, p_id: id, p_action: action, p_patch: patch, p_confirmation: input.confirmation || "", p_actor_id: actor });
  if (error) throw rpcFailure(error);
  if (!data?.id) throw new OperationsRequestError("The database did not confirm this action.", 500);
  return { ok: true, ...data };
}

const buckets = new Set(["company-profile", "employee-private"]);
export async function enqueueMediaCleanup(database, authorization, input) {
  const actor = await requireAdmin(database, authorization);
  if (!buckets.has(input.bucket) || typeof input.path !== "string" || !input.path || input.path.length > 500 || /[\\\x00-\x1f]/.test(input.path) || input.path.startsWith("/") || input.path.split("/").some(x => !x || x === ".." || x === ".")) throw new OperationsRequestError("Choose a valid private storage object.");
  const { data, error } = await database.rpc("queue_media_cleanup", { p_bucket: input.bucket, p_path: input.path, p_actor_id: actor });
  if (error) throw rpcFailure(error);
  return { ok: true, cleanup_id: data };
}
export async function cleanupMedia(database, authorization, input) {
  const actor = await requireAdmin(database, authorization);
  const id = Number(input.id);
  if (!Number.isSafeInteger(id) || id <= 0 || input.confirmation !== confirmationPhrase("cleanup", id)) throw new OperationsRequestError("Type DELETE FILE followed by the cleanup record ID.");
  const { data: job, error } = await database.rpc("claim_media_cleanup", { p_id: id, p_actor_id: actor });
  if (error) throw rpcFailure(error);
  if (job?.blocked) throw new OperationsRequestError("File retained: a current/archived record or employee audit history still references it. No file was removed.", 409);
  if (!job || typeof job.claim !== "string" || !job.claim || !buckets.has(job.bucket) || typeof job.path !== "string" || !job.path || job.path.length > 500 || /[\\\x00-\x1f]/.test(job.path) || job.path.startsWith("/") || job.path.split("/").some(x => !x || x === "." || x === "..")) throw new OperationsRequestError("No safe cleanup job was confirmed.", 409);
  let failed = false;
  try { const removed = await database.storage.from(job.bucket).remove([job.path]); failed = Boolean(removed.error); } catch { failed = true; }
  const completed = await database.rpc("complete_media_cleanup", { p_id: id, p_claim: job.claim, p_failed: failed, p_actor_id: actor });
  if (completed.error) throw new OperationsRequestError("Storage cleanup result needs reconciliation. The reserved object cannot be attached while this job is processing.", 500);
  if (failed) throw new OperationsRequestError("File removal failed. The private orphan remains queued for a safe retry.", 500);
  return { ok: true, id };
}
