import { createVercelRouteHandler } from "../../server/vercelAdapter.js";

export default createVercelRouteHandler("/api/integrations/sheets-sync", ["GET"]);
