import { createVercelRouteHandler } from "../vercelAdapter.js";

export default createVercelRouteHandler("/api/applications", ["POST"]);
