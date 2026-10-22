export function apiUrl(path) {
  const normalizedPath = String(path || "").replace(/^\/+/, "");
  return `/${normalizedPath}`;
}

// Display structured API messages, never raw HTML or proxy response bodies.
function safeApiText(value) {
  if (typeof value !== "string" || /<[^>]*>|\bBearer\s|eyJ[a-zA-Z0-9_-]+\.|sb_secret_|service_role|sk_live_|sk_test_|(?:password|secret|api[_ -]?key)\s*[:=]/i.test(value)) return "";
  return value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 300);
}

export async function readApiResponse(response, fallback = "The request could not be completed.") {
  const result = await response.json().catch(() => null);
  const structured = result && typeof result === "object" && !Array.isArray(result);
  if (!response.ok) {
    const rows = structured && Array.isArray(result.details?.rows) ? result.details.rows.slice(0, 5).map(row => {
      const message = safeApiText(row?.message);
      return message ? `Row ${Number.isSafeInteger(Number(row.row)) ? Number(row.row) : "?"}: ${message}` : "";
    }) : [];
    const matches = structured && Array.isArray(result.details?.matches) ? result.details.matches.slice(0, 5).map(match => safeApiText(match?.message)) : [];
    const message = (structured && safeApiText(result.error)) || (response.status === 404 ? "API route not found. The server deployment may need updating." : fallback);
    const error = new Error(`HTTP ${response.status}: ${[message, ...rows, ...matches].filter(Boolean).join(" ")}`);
    error.status = response.status;
    throw error;
  }
  if (!structured) throw new Error(`HTTP ${response.status}: The server returned an invalid API response. Please retry or contact the administrator.`);
  return result;
}
