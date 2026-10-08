import express from "express";
import { rateLimit } from "express-rate-limit";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "./email.js";
import {
  normalizeApplication,
  normalizeComplaint,
  normalizeContact,
  normalizeMessage,
  ValidationError,
} from "./validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

export function createServerSupabaseClient(env = process.env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

export function createIntakeRateLimiter({ limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many submissions. Please wait before trying again." },
  });
}

async function sendNotificationEmail(emailSender, payload) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM || !process.env.NOTIFICATION_EMAIL) {
    return { sent: false, reason: "Email notifications are not configured." };
  }
  try {
    await emailSender({
      from: process.env.EMAIL_FROM,
      to: [process.env.NOTIFICATION_EMAIL],
      ...payload,
    });
    return { sent: true };
  } catch (error) {
    console.error("Email notification failed:", error.code || error.name || "Error");
    return { sent: false, reason: "The record was saved, but the email notification failed." };
  }
}

function submissionResponse(res, record, emailResult, label) {
  const message = emailResult.sent
    ? `${label} saved and notification email sent.`
    : `${label} saved. ${emailResult.reason}`;
  return res.status(201).json({
    ok: true,
    id: record.id,
    created_at: record.created_at,
    emailSent: emailResult.sent,
    message,
    ...(emailResult.sent ? {} : { emailWarning: emailResult.reason }),
  });
}

function insertRow(database, table, row) {
  return database.from(table).insert(row).select("id, created_at").single();
}

export function createApp({
  database = createServerSupabaseClient(),
  emailSender = sendEmail,
  intakeLimiter = createIntakeRateLimiter(),
  staticFiles = true,
  parseBody = true,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);
  if (parseBody) app.use(express.json({ limit: "30kb" }));

  app.get("/api/health", async (_req, res) => {
    const emailConfigured = Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.NOTIFICATION_EMAIL);
    if (!database) {
      return res.status(503).json({
        status: "degraded",
        service: "Golconda Security Services API",
        databaseConfigured: false,
        databaseReachable: false,
        emailConfigured,
      });
    }

    try {
      const { error } = await database.from("services").select("id").limit(1).maybeSingle();
      if (error) throw error;
      return res.json({
        status: "ok",
        service: "Golconda Security Services API",
        databaseConfigured: true,
        databaseReachable: true,
        emailConfigured,
      });
    } catch (error) {
      console.error("Supabase health check failed:", error.code || error.name || "Error");
      return res.status(503).json({
        status: "degraded",
        service: "Golconda Security Services API",
        databaseConfigured: true,
        databaseReachable: false,
        emailConfigured,
      });
    }
  });

  app.post("/api/contact", intakeLimiter, async (req, res, next) => {
    try {
      const input = normalizeContact(req.body);
      if (!database) return res.status(503).json({ error: "Submission storage is not configured." });
      const { data, error } = await insertRow(database, "contact_submissions", input);
      if (error) throw error;
      const emailResult = await sendNotificationEmail(emailSender, {
        subject: `New website enquiry: ${input.service || "General enquiry"}`,
        text: `Name: ${input.name}\nEmail: ${input.email}\nService: ${input.service || "General enquiry"}\n\n${input.message}`,
      });
      return submissionResponse(res, data, emailResult, "Enquiry");
    } catch (error) {
      if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
      return next(error);
    }
  });

  app.post("/api/applications", intakeLimiter, async (req, res, next) => {
    try {
      const input = normalizeApplication(req.body);
      if (!database) return res.status(503).json({ error: "Submission storage is not configured." });
      const { data, error } = await insertRow(database, "job_applications", input);
      if (error) throw error;
      const emailResult = await sendNotificationEmail(emailSender, {
        subject: `New job application: ${input.role || "General interest"}`,
        text: `Name: ${input.full_name}\nEmail: ${input.email}\nRole: ${input.role || "General interest"}\n\n${input.message}`,
      });
      return submissionResponse(res, data, emailResult, "Application");
    } catch (error) {
      if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
      return next(error);
    }
  });

  app.post("/api/complaints", intakeLimiter, async (req, res, next) => {
    try {
      const input = normalizeComplaint(req.body);
      if (!database) return res.status(503).json({ error: "Complaint storage is not configured." });
      const { data, error } = await insertRow(database, "complaints", input);
      if (error) throw error;
      const emailResult = await sendNotificationEmail(emailSender, {
        subject: `New complaint: ${input.subject}`,
        text: `Name: ${input.complainant_name}\nRole: ${input.role}\nPhone: ${input.phone}\nSubject: ${input.subject}\n\n${input.details}`,
      });
      return submissionResponse(res, data, emailResult, "Complaint");
    } catch (error) {
      if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
      return next(error);
    }
  });

  app.post("/api/send-message", async (req, res, next) => {
    try {
      if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
        return res.status(503).json({ error: "Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM." });
      }
      const message = normalizeMessage(req.body, process.env.NOTIFICATION_EMAIL);
      if (!database) return res.status(503).json({ error: "Admin messaging is not configured." });
      const authorization = req.get("authorization") || "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
      if (!token) return res.status(401).json({ error: "Admin authentication is required." });

      const { data: authData, error: authError } = await database.auth.getUser(token);
      if (authError || !authData?.user) return res.status(401).json({ error: "Admin session is invalid or expired." });
      const { data: admin, error: adminError } = await database
        .from("admin_users")
        .select("user_id")
        .eq("user_id", authData.user.id)
        .maybeSingle();
      if (adminError) throw adminError;
      if (!admin) return res.status(403).json({ error: "This account is not authorized to send messages." });

      await emailSender({
        from: process.env.EMAIL_FROM,
        to: message.recipients,
        subject: message.title,
        text: message.message,
      });
      return res.json({ ok: true, emailSent: true, message: "Message sent." });
    } catch (error) {
      if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
      if (error.code === "EMAIL_NOT_CONFIGURED") return res.status(503).json({ error: error.message });
      if (error.code === "EMAIL_PROVIDER_ERROR") return res.status(502).json({ error: "The email provider rejected the message." });
      return next(error);
    }
  });

  if (staticFiles) {
    const dist = path.join(projectRoot, "dist");
    if (existsSync(dist)) app.use(express.static(dist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API route not found." });
      const index = path.join(dist, "index.html");
      if (!existsSync(index)) return res.status(404).send("Frontend build not found. Run npm run build.");
      return res.sendFile(index, (error) => error && next(error));
    });
  } else {
    app.use((req, res) => res.status(404).json({ error: "Route not found." }));
  }

  app.use((error, _req, res, _next) => {
    console.error("API request failed:", error.code || error.name || "Error");
    if (res.headersSent) return;
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
    return res.status(status).json({ error: status === 500 ? "The request could not be completed." : error.message });
  });
  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createApp();
  const port = Number(process.env.PORT || 4000);
  app.listen(port, "0.0.0.0", () => console.log(`GSS server listening on port ${port}`));
}
