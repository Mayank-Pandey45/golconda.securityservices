import { createVercelRouteHandler } from "../../vercelAdapter.js";

export default createVercelRouteHandler("/api/guards/import", ["POST"], undefined, 4 * 1024 * 1024);
