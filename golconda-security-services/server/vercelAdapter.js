import { createApp } from "./index.js";

// Vercel treats files inside api/ as serverless routes. Keep this shared
// adapter outside api/ so it cannot be discovered as a phantom endpoint.
// Vercel supplies Node request/response objects and parses JSON bodies before
// invoking a function. Express is used here only as a route adapter; Vercel
// serves the Vite build separately from its static output.
const app = createApp({ staticFiles: false, parseBody: false });

export function createVercelRouteHandler(routePath, methods, application = app, maxBodyBytes = 30 * 1024) {
  return (req, res) => {
    const method = String(req.method || "").toUpperCase();
    if (!methods.includes(method)) {
      res.setHeader("Allow", methods.join(", "));
      return res.status(405).json({ error: "Method not allowed." });
    }

    if (method === "POST") {
      const contentType = String(req.headers?.["content-type"] || "");
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        return res.status(415).json({ error: "Content-Type must be application/json." });
      }

      const declaredLength = Number(req.headers?.["content-length"]);
      const bodyText = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? "");
      const actualLength = Buffer.byteLength(bodyText || "", "utf8");
      if ((Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) || actualLength > maxBodyBytes) {
        return res.status(413).json({ error: `Request body must be ${Math.floor(maxBodyBytes / 1024)} KB or smaller.` });
      }
    }

    // Pin the Express path to the function's route. This works whether the
    // platform passes the original pathname or the function-relative path.
    const requestUrl = String(req.url || "");
    const query = requestUrl.includes("?") ? requestUrl.slice(requestUrl.indexOf("?")) : "";
    req.url = `${routePath}${query}`;
    return application(req, res);
  };
}
