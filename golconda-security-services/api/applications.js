import { createVercelRouteHandler } from "../server/vercelAdapter.js";

export default createVercelRouteHandler("/api/applications", ["POST"]);
