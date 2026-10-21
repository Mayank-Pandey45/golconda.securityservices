import { createVercelRouteHandler } from "../../server/vercelAdapter.js";

export default createVercelRouteHandler("/api/integrations/telegram", ["POST"], undefined, 32 * 1024);
