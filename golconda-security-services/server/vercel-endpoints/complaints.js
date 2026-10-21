import { createVercelRouteHandler } from "../vercelAdapter.js";

export default createVercelRouteHandler("/api/complaints", ["POST"]);
