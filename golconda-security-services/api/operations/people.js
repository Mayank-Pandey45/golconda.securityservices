import { createVercelRouteHandler } from "../../server/vercelAdapter.js";

export default createVercelRouteHandler("/api/operations/people", ["POST"], undefined, 64 * 1024);
