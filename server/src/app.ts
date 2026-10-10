import express from "express";
import { openDb } from "./db.js";
import { errorHandler, protocolError } from "./ucp.js";
import { profileRouter } from "./merchant/profile.js";
import { mcpRouter } from "./merchant/mcp.js";
import { adminRouter, orderRouter, restRouter } from "./merchant/rest.js";
import { inspectRouter, localHostOnly } from "./studio/inspect.js";
import { proxyRouter } from "./studio/proxy.js";
import { conformanceRouter } from "./studio/conformance.js";
import { crossSiteGuard, merchantAdminRouter } from "./merchant-admin/catalog.js";
import type { ProfileCache } from "./merchant/negotiate.js";
import { webhookRouter } from "./studio/webhooks.js";

export function createApp({ dbPath, baseUrl, fetch = globalThis.fetch }: { dbPath: string; baseUrl: string; fetch?: typeof globalThis.fetch }) {
  const db = openDb(dbPath);
  const app = express();
  // ponytail: one profile cache shared by REST and MCP, unbounded and never invalidated (5 min TTL on read); LRU / explicit refresh if it matters
  const deps = { db, baseUrl, fetch, cache: new Map() as ProfileCache };
  app.use(profileRouter(baseUrl));
  app.use(orderRouter(db));
  // Both guards sit on the mount, before the body parser, so they cover every admin route including orders/:id/ship.
  app.use("/merchant-admin", localHostOnly, crossSiteGuard, express.json({ limit: "10mb" }), merchantAdminRouter(db), adminRouter({ db, baseUrl, fetch }));
  app.use("/ucp", mcpRouter(deps));
  app.use("/ucp", restRouter(deps));
  app.use("/api", express.json(), inspectRouter(baseUrl), proxyRouter(baseUrl), conformanceRouter(baseUrl), webhookRouter(), (_req, res) => protocolError(res, 404, "not_found", "No such Studio API route"));
  app.use(errorHandler);
  return app;
}
