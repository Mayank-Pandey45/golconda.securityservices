import { apiUrl, readApiResponse } from "../api.js";
import { supabase } from "../supabase.js";
export async function recordRequest(body) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("Your administrator session has expired. Sign in again.");
  const response = await fetch(apiUrl("/api/operations/records"), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + data.session.access_token },
    body: JSON.stringify(body),
  });
  const result = await readApiResponse(response);
  if (result.ok !== true) throw new Error("The server did not confirm the record action. Refresh before retrying.");
  return result;
}
export async function queueOrphan(bucket, path) {
  if (!path) return "";
  try {
    const result = await recordRequest({ action: "queue_media", bucket, path });
    return "Private file retained for reviewed cleanup (job " + result.cleanup_id + ").";
  } catch {
    return "Private orphan retained. Cleanup could not be queued; reconcile Storage before any removal: " + bucket + "/" + path;
  }
}
