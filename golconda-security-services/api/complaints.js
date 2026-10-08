import { createVercelRouteHandler } from "./_express.js";

export default createVercelRouteHandler("/api/complaints", ["POST"]);
