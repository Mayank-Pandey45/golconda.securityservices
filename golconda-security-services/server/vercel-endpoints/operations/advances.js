import { createVercelRouteHandler } from "../../vercelAdapter.js";

export default createVercelRouteHandler("/api/operations/advances", ["GET", "POST"], undefined, 64 * 1024);
