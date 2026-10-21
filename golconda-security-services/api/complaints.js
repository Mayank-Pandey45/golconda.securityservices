import { createVercelRouteHandler } from "../server/vercelAdapter.js";

export default createVercelRouteHandler("/api/complaints", ["POST"]);
