import express from "express";
import { rateLimit } from "express-rate-limit";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  normalizeApplication,
  normalizeComplaint,
  normalizeContact,
  ValidationError,
} from "./validation.js";
import { GuardImportRequestError, importGuardRows } from "./guardImport.js";
import { getPublicProfileDocuments } from "./publicProfile.js";
import { handleTelegramWebhook } from "./telegramIntegration.js";
import { hasCronAuthorization, isGoogleSheetsSyncConfigured, SheetsSyncError, syncAdvanceSheetOutbox } from "./googleSheetsIntegration.js";
import { adjustAdvance, createSalaryAdjustment, deleteGuard, getPayrollSummary, importSiteRows, listAdvances, OperationsRequestError, recordAdvance, recoverAdvance, requireAdmin, saveEmployee, saveGuard, saveSite } from "./operations.js";

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

function submissionResponse(res, record, label) {
  return res.status(201).json({
    ok: true,
    id: record.id,
    created_at: record.created_at,
    message: `Your ${label} has been received successfully.`,
  });
}

function insertRow(database, table, row) {
  return database.from(table).insert(row).select("id, created_at").single();
}

export function createApp({
  env = process.env,
  database = createServerSupabaseClient(env),
  fetchImpl = fetch,
  intakeLimiter = createIntakeRateLimiter(),
  guardImportLimiter = createIntakeRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 }),
  operationsLimiter = createIntakeRateLimiter({ limit: 30, windowMs: 15 * 60 * 1000 }),
  staticFiles = true,
  parseBody = true,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.NODE_ENV === "production" ? 1 : false);
  if (parseBody) {
    app.use((req, res, next) => {
      if (["/api/contact", "/api/applications", "/api/complaints"].includes(req.path)) {
        const declaredLength = Number(req.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > 30 * 1024) {
          return res.status(413).json({ error: "Request body must be 30 KB or smaller." });
        }
      }
      return next();
    });
    app.use(express.json({ limit: "4mb" }));
  }

  app.get("/api/health", async (_req, res) => {
    if (!database) {
      return res.status(503).json({
        status: "degraded",
        service: "Golconda Security Services API",
        databaseConfigured: false,
        databaseReachable: false,
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
      });
    } catch (error) {
      console.error("Supabase health check failed:", error.code || error.name || "Error");
      return res.status(503).json({
        status: "degraded",
        service: "Golconda Security Services API",
        databaseConfigured: true,
        databaseReachable: false,
      });
    }
  });

  app.post("/api/integrations/telegram", async (req, res) => {
    const result = await handleTelegramWebhook({
      body: req.body,
      secretToken: req.headers["x-telegram-bot-api-secret-token"],
      database,
      env,
      fetchImpl,
    });
    return res.status(result.status).json(result.body);
  });

  app.get("/api/integrations/sheets-sync", async (req, res) => {
    if (!isGoogleSheetsSyncConfigured(env)) {
      return res.status(503).json({ error: "Google Sheets sync is disabled or not fully configured." });
    }
    if (!hasCronAuthorization(req.headers.authorization, env.CRON_SECRET)) {
      return res.status(401).json({ error: "Worker authentication failed." });
    }
    try {
      const result = await syncAdvanceSheetOutbox({ database, env, fetchImpl });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const code = error instanceof SheetsSyncError ? error.code : "sheets_sync_failed";
      return res.status(503).json({ error: code });
    }
  });

  app.get("/api/profile", async (_req, res, next) => {
    if (!database) return res.status(503).json({ error: "Public profile content is not available." });
    try {
      const documents = await getPublicProfileDocuments(database);
      res.set("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=60");
      return res.json({ documents });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/guards/import", guardImportLimiter, async (req, res, next) => {
    if (!database) return res.status(503).json({ error: "Guard import is not configured." });
    const authorization = String(req.headers.authorization || "");
    const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
    if (!token) return res.status(401).json({ error: "Administrator authentication is required." });

    try {
      const { data: userData, error: userError } = await database.auth.getUser(token);
      const user = userData?.user;
      if (userError || !user?.id) return res.status(401).json({ error: "Administrator authentication is invalid or expired." });

      const { data: admin, error: adminError } = await database.from("admin_users")
        .select("user_id").eq("user_id", user.id).maybeSingle();
      if (adminError) return res.status(503).json({ error: "Administrator access could not be verified." });
      if (!admin) return res.status(403).json({ error: "Only authorized administrators can import guard records." });

      const result = await importGuardRows(database, req.body?.rows, user.id);
      return res.json(result);
    } catch (error) {
      if (error instanceof GuardImportRequestError) return res.status(error.status).json({ error: error.message });
      return next(error);
    }
  });

  app.post("/api/operations/sites", operationsLimiter, async (req, res, next) => {
    if (!database) return res.status(503).json({ error: "Operations storage is not configured." });
    try {
      const actorId = await requireAdmin(database, req.headers.authorization);
      if (req.body?.action === "save") return res.json(await saveSite(database, req.body, actorId));
      if (req.body?.action === "delete") {
        const siteId = Number(req.body.site_id);
        if (!Number.isSafeInteger(siteId) || siteId < 1) return res.status(400).json({ error: "Site ID is invalid." });
        const { data, error } = await database.rpc("delete_site_if_unassigned", { p_site_id: siteId, p_actor_id: actorId });
        if (error) {
          if (/history|must be deactivated/i.test(error.message || "")) return res.status(409).json({ error: "This site has assignment or financial history. Deactivate it to preserve those records." });
          return res.status(500).json({ error: "Site could not be deleted safely." });
        }
        if (!data) return res.status(404).json({ error: "Site was not found." });
        return res.json({ ok: true, site_id: siteId });
      }
      return res.status(400).json({ error: "Unknown site operation." });
    } catch (error) {
      if (error instanceof OperationsRequestError) return res.status(error.status).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
      return next(error);
    }
  });

  app.post("/api/operations/site-import", operationsLimiter, async (req, res, next) => {
    if (!database) return res.status(503).json({ error: "Operations storage is not configured." });
    try {
      const actorId = await requireAdmin(database, req.headers.authorization);
      const result = await importSiteRows(database, req.body?.rows, actorId);
      return res.json(result);
    } catch (error) {
      if (error instanceof OperationsRequestError) return res.status(error.status).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
      return next(error);
    }
  });

  app.post("/api/operations/people", operationsLimiter, async (req, res, next) => {
    if (!database) return res.status(503).json({ error: "Operations storage is not configured." });
    try {
      const actorId = await requireAdmin(database, req.headers.authorization);
      if (req.body?.action === "save") return res.json(await saveEmployee(database, req.body, actorId));
      if (req.body?.action === "delete") {
        const employeeType = req.body.employee_type;
        const employeeId = Number(req.body.employee_id);
        if (!new Set(["supervisor", "field_officer"]).has(employeeType) || !Number.isSafeInteger(employeeId) || employeeId < 1) {
          return res.status(400).json({ error: "Employee reference is invalid." });
        }
        const { data, error } = await database.rpc("delete_employee_if_unreferenced", { p_employee_type: employeeType, p_employee_id: employeeId, p_actor_id: actorId });
        if (error) {
          if (/history|deactivated/i.test(error.message || "")) return res.status(409).json({ error: "This employee has assignment, payroll, or advance history. Deactivate the record to preserve it." });
          return res.status(500).json({ error: "Employee record could not be deleted safely." });
        }
        if (!data) return res.status(404).json({ error: "Employee record was not found." });
        return res.json({ ok: true, employee_id: employeeId });
      }
      return res.status(400).json({ error: "Unknown employee operation." });
    } catch (error) {
      if (error instanceof OperationsRequestError) return res.status(error.status).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
      return next(error);
    }
  });

  app.post("/api/operations/guards", operationsLimiter, async (req, res, next) => {
    if (!database) return res.status(503).json({ error: "Operations storage is not configured." });
    try {
      const actorId = await requireAdmin(database, req.headers.authorization);
      if (req.body?.action === "save") return res.json(await saveGuard(database, req.body, actorId));
      if (req.body?.action === "delete") {
        const deleted = await deleteGuard(database, req.body.guard_id, actorId);
        if (!deleted) return res.status(404).json({ error: "Guard record was not found." });
        return res.json({ ok: true, guard_id: Number(req.body.guard_id) });
      }
      return res.status(400).json({ error: "Unknown guard operation." });
    } catch (error) {
      if (error instanceof OperationsRequestError) return res.status(error.status).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
      if (/history|deactivated/i.test(error.message || "")) return res.status(409).json({ error: error.message });
      return next(error);
    }
  });

  app.get("/api/operations/advances", operationsLimiter, async (req, res, next) => {
    if (!database) return res.status(503).json({ error: "Operations storage is not configured." });
    try {
      const actorId = await requireAdmin(database, req.headers.authorization);
      const result = await listAdvances(database, req.query, actorId);
      res.set("Cache-Control", "private, no-store");
      return res.json(result);
    } catch (error) {
      if (error instanceof OperationsRequestError) return res.status(error.status).json({ error: error.message });
      return next(error);
    }
  });

  app.post("/api/operations/advances", operationsLimiter, async (req, res, next) => {
    if (!database) return res.status(503).json({ error: "Operations storage is not configured." });
    try {
      const actorId = await requireAdmin(database, req.headers.authorization);
      if (req.body?.action === "record") return res.status(201).json(await recordAdvance(database, req.body, actorId, env));
      if (req.body?.action === "adjust") return res.status(201).json(await adjustAdvance(database, req.body, actorId));
      if (req.body?.action === "recover") return res.status(201).json(await recoverAdvance(database, req.body, actorId));
      if (req.body?.action === "salary-adjustment") return res.status(201).json(await createSalaryAdjustment(database, req.body, actorId));
      if (req.body?.action === "approve-adjustment") {
        const adjustmentId = Number(req.body.adjustment_id);
        if (!Number.isSafeInteger(adjustmentId) || adjustmentId < 1) return res.status(400).json({ error: "Salary adjustment reference is invalid." });
        const { data, error } = await database.rpc("approve_salary_adjustment", { p_adjustment_id: adjustmentId, p_actor_id: actorId });
        if (error) return res.status(503).json({ error: "Salary adjustment could not be approved." });
        if (!data) return res.status(409).json({ error: "Salary adjustment was already approved or no longer exists." });
        return res.json({ ok: true, adjustment_id: adjustmentId });
      }
      return res.status(400).json({ error: "Unknown advance operation." });
    } catch (error) {
      if (error instanceof OperationsRequestError) return res.status(error.status).json({ error: error.message });
      return next(error);
    }
  });

  app.get("/api/operations/payroll", operationsLimiter, async (req, res, next) => {
    if (!database) return res.status(503).json({ error: "Operations storage is not configured." });
    try {
      const actorId = await requireAdmin(database, req.headers.authorization);
      const result = await getPayrollSummary(database, req.query.period, actorId);
      res.set("Cache-Control", "private, no-store");
      return res.json(result);
    } catch (error) {
      if (error instanceof OperationsRequestError) return res.status(error.status).json({ error: error.message });
      return next(error);
    }
  });

  app.post("/api/contact", intakeLimiter, async (req, res, next) => {
    try {
      const input = normalizeContact(req.body);
      if (!database) return res.status(503).json({ error: "Submission storage is not configured." });
      const { data, error } = await insertRow(database, "contact_submissions", input);
      if (error) throw error;
      return submissionResponse(res, data, "enquiry");
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
      return submissionResponse(res, data, "application");
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
      return submissionResponse(res, data, "complaint");
    } catch (error) {
      if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
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
  app.listen(port, "0.0.0.0");
}
