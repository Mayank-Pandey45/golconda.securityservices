import { createVercelRouteHandler } from "../../vercelAdapter.js";

export default createVercelRouteHandler("/api/operations/site-import", ["POST"], undefined, 4 * 1024 * 1024);
