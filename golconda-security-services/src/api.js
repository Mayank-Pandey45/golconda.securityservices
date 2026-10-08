export function apiUrl(path) {
  const normalizedPath = String(path || "").replace(/^\/+/, "");
  return `/${normalizedPath}`;
}
