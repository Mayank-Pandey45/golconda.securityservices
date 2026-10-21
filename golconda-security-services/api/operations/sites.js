import { createVercelRouteHandler } from "../../server/vercelAdapter.js";

export default createVercelRouteHandler("/api/operations/sites", ["POST"], undefined, 64 * 1024);
