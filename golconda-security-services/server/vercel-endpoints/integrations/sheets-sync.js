import { createVercelRouteHandler } from "../../vercelAdapter.js";

export default createVercelRouteHandler("/api/integrations/sheets-sync", ["GET"]);
