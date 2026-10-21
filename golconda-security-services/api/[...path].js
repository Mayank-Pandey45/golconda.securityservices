import { createApp } from "../server/index.js";

const app = createApp({ staticFiles: false, parseBody: false });

const routeLimits = {
  "/api/health": { methods: ["GET"], maxBodyBytes: 30 * 1024 },
  "/api/profile": { methods: ["GET"], maxBodyBytes: 30 * 1024 },
  "/api/integrations/sheets-sync": { methods: ["GET"], maxBodyBytes: 30 * 1024 },
  "/api/integrations/telegram": { methods: ["POST"], maxBodyBytes: 32 * 1024 },
  "/api/guards/import": { methods: ["POST"], maxBodyBytes: 4 * 1024 * 1024 },
  "/api/operations/sites": { methods: ["POST"], maxBodyBytes: 64 * 1024 },
  "/api/operations/site-import": { methods: ["POST"], maxBodyBytes: 4 * 1024 * 1024 },
  "/api/operations/people": { methods: ["POST"], maxBodyBytes: 64 * 1024 },
  "/api/operations/guards": { methods: ["POST"], maxBodyBytes: 30 * 1024 },
  "/api/operations/advances": { methods: ["GET", "POST"], maxBodyBytes: 64 * 1024 },
  "/api/operations/payroll": { methods: ["GET"], maxBodyBytes: 30 * 1024 },
  "/api/contact": { methods: ["POST"], maxBodyBytes: 30 * 1024 },
  "/api/applications": { methods: ["POST"], maxBodyBytes: 30 * 1024 },
  "/api/complaints": { methods: ["POST"], maxBodyBytes: 30 * 1024 }
};

export function createCatchAllHandler(application = app) {
  return function handler(req, res) {
    const originalUrl = String(req.url || "/");
    const queryIndex = originalUrl.indexOf("?");
    const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : "";
    let pathname = queryIndex >= 0
      ? originalUrl.slice(0, queryIndex)
      : originalUrl;

    if (!pathname.startsWith("/api/")) {
      const rawPath = req.query?.path;
      const segments = Array.isArray(rawPath)
        ? rawPath
        : rawPath == null ? [] : [rawPath];

      if (!segments.length) {
        return res.status(404).json({ error: "API route not found." });
      }
      pathname = "/api/" + segments.map(String).join("/");
    }

    const route = routeLimits[pathname];
    if (!route) {
      return res.status(404).json({ error: "API route not found." });
    }

    const method = String(req.method || "GET").toUpperCase();
    if (!route.methods.includes(method)) {
      res.setHeader("Allow", route.methods.join(", "));
      return res.status(405).json({ error: "Method not allowed." });
    }

    if (method === "POST") {
      const contentType = String(req.headers?.["content-type"] || "");
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        return res.status(415).json({
          error: "Content-Type must be application/json."
        });
      }

      // Vercel parses JSON lazily: reading body can throw for malformed JSON.
      let requestBody;
      try { requestBody = req.body; }
      catch { return res.status(400).json({ error: "Invalid JSON request body." }); }
      const declaredLength = Number(req.headers?.["content-length"]);
      const bodyText = Buffer.isBuffer(requestBody) ? requestBody.toString("utf8")
        : typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody ?? "");
      const actualLength = Buffer.byteLength(bodyText || "", "utf8");

      if (
        (Number.isFinite(declaredLength) && declaredLength > route.maxBodyBytes) ||
        actualLength > route.maxBodyBytes
      ) {
        return res.status(413).json({
          error: `Request body must be ${Math.floor(route.maxBodyBytes / 1024)} KB or smaller.`
        });
      }
    }

    if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
      try { req.body = JSON.parse(req.body.toString()); }
      catch { return res.status(400).json({ error: "Invalid JSON request body." }); }
    }

    req.url = pathname + query;
    return application(req, res);
  };
}

export default createCatchAllHandler();
