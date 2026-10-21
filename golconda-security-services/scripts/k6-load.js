import http from "k6/http";
import { check } from "k6";

const baseUrl = String(__ENV.BASE_URL || "").replace(/\/+$/, "");
const targetEnvironment = String(__ENV.TARGET_ENV || "").toLowerCase();
const allowSubmissions = __ENV.ALLOW_SYNTHETIC_SUBMISSIONS === "YES";
const adminToken = String(__ENV.ADMIN_BEARER_TOKEN || "");

if (!baseUrl) throw new Error("Set BASE_URL to a local or staging origin.");
if (!["local", "staging"].includes(targetEnvironment)) throw new Error("Set TARGET_ENV=local or TARGET_ENV=staging. Production targets are not allowed.");
if (baseUrl.includes("golconda-securityservices.vercel.app")) throw new Error("The canonical production host is blocked by this script.");
if (allowSubmissions && __ENV.CONFIRM_NONPRODUCTION_DATA !== "YES") throw new Error("Synthetic form submissions require CONFIRM_NONPRODUCTION_DATA=YES.");

const vus = Math.max(1, Math.min(100, Number(__ENV.VUS) || 5));
const steadyDuration = /^\d+[smh]$/.test(__ENV.STEADY_DURATION || "") ? __ENV.STEADY_DURATION : "2m";

export const options = {
  stages: [
    { duration: "30s", target: vus },
    { duration: steadyDuration, target: vus },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<1500"],
  },
};

function checkResponse(response, expectedStatus, label) {
  check(response, {
    [`${label} returns HTTP ${expectedStatus}`]: result => result.status === expectedStatus,
  });
}

function submit(path, payload, label) {
  const response = http.post(`${baseUrl}${path}`, JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    tags: { endpoint: path },
  });
  checkResponse(response, 201, label);
  check(response, {
    [`${label} confirms a saved record`]: result => {
      try {
        const body = result.json();
        return body.ok === true && Boolean(body.id);
      } catch { return false; }
    },
  });
}

export default function () {
  const home = http.get(`${baseUrl}/`, { tags: { endpoint: "/" } });
  checkResponse(home, 200, "Homepage");

  const health = http.get(`${baseUrl}/api/health`, { tags: { endpoint: "/api/health" } });
  check(health, {
    "Health endpoint reports reachable database": result => {
      try { const body = result.json(); return result.status === 200 && body.databaseReachable === true; }
      catch { return false; }
    },
  });

  const profile = http.get(`${baseUrl}/api/profile`, { tags: { endpoint: "/api/profile" } });
  check(profile, {
    "Public profile endpoint returns document list": result => {
      try { const body = result.json(); return result.status === 200 && Array.isArray(body.documents); }
      catch { return false; }
    },
  });

  if (adminToken) {
    const advances = http.get(`${baseUrl}/api/operations/advances?page=1&page_size=20`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      tags: { endpoint: "/api/operations/advances" },
    });
    check(advances, {
      "Admin advance API responds with a paginated result": result => {
        try { const body = result.json(); return result.status === 200 && Array.isArray(body.advances); }
        catch { return false; }
      },
    });
  }

  if (allowSubmissions) {
    const marker = `LOAD-TEST-${__VU}-${__ITER}-${Date.now()}`;
    const choice = (__VU + __ITER) % 3;
    if (choice === 0) submit("/api/contact", { name: marker, email: `${marker.toLowerCase()}@example.invalid`, service: "Load test", message: marker }, "Contact submission");
    if (choice === 1) submit("/api/applications", { full_name: marker, email: `${marker.toLowerCase()}@example.invalid`, role: "Load test", message: marker }, "Application submission");
    if (choice === 2) submit("/api/complaints", { complainant_name: marker, role: "Load test", phone: "9000000000", subject: marker, details: marker }, "Complaint submission");
  }
}
