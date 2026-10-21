import { createVercelRouteHandler } from "../../vercelAdapter.js";

export default createVercelRouteHandler("/api/operations/people", ["POST"], undefined, 64 * 1024);
