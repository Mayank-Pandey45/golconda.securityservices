import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = Number(process.env.PORT || 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: "30kb" }));

// Demo storage only: submissions reset when the server restarts.
// Before public launch, replace with PostgreSQL, add rate limiting,
// spam protection, privacy notice/consent, and secure operational logging.
const contactSubmissions = [];
const applications = [];

function cleanString(value, max = 2000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "Golconda Security Services API" });
});

app.post("/api/contact", (req, res) => {
  const name = cleanString(req.body?.name, 120);
  const email = cleanString(req.body?.email, 254);
  const service = cleanString(req.body?.service, 100);
  const message = cleanString(req.body?.message, 2000);
  if (!name || !validEmail(email) || !message) {
    return res.status(400).json({ error: "Please provide a name, valid email and message." });
  }
  const item = { id: crypto.randomUUID(), name, email, service, message, receivedAt: new Date().toISOString() };
  contactSubmissions.push(item);
  console.info("Contact enquiry received:", { id: item.id, service: item.service });
  res.status(201).json({ ok: true, message: "Enquiry received.", id: item.id });
});

app.post("/api/applications", (req, res) => {
  const name = cleanString(req.body?.name, 120);
  const email = cleanString(req.body?.email, 254);
  const role = cleanString(req.body?.role, 100);
  const message = cleanString(req.body?.message, 2000);
  if (!name || !validEmail(email)) {
    return res.status(400).json({ error: "Please provide a name and valid email." });
  }
  const item = { id: crypto.randomUUID(), name, email, role, message, receivedAt: new Date().toISOString() };
  applications.push(item);
  console.info("Job interest received:", { id: item.id, role: item.role });
  res.status(201).json({ ok: true, message: "Application interest received.", id: item.id });
});

// This server intentionally does not expose submission lists or implement login yet.
// Add authenticated, role-based admin routes only alongside production auth + database.
app.use(express.static(path.resolve(__dirname, "../dist")));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API route not found." });
  res.sendFile(path.resolve(__dirname, "../dist/index.html"), (err) => err && next(err));
});

app.listen(PORT, () => console.log(`GSS server listening on http://localhost:${PORT}`));