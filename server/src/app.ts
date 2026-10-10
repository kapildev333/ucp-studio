import express from "express";
import { openDb } from "./db.js";
import { errorHandler } from "./ucp.js";
import { profileRouter } from "./merchant/profile.js";
import { mcpRouter } from "./merchant/mcp.js";
import { adminRouter, orderRouter, restRouter } from "./merchant/rest.js";
import { inspectRouter } from "./studio/inspect.js";
import { proxyRouter } from "./studio/proxy.js";
import { conformanceRouter } from "./studio/conformance.js";
import { merchantAdminRouter } from "./merchant-admin/catalog.js";
import type { ProfileCache } from "./merchant/negotiate.js";
import { webhookRouter } from "./studio/webhooks.js";

export function createApp({ dbPath, baseUrl, fetch = globalThis.fetch }: { dbPath: string; baseUrl: string; fetch?: typeof globalThis.fetch }) {
  const db = openDb(dbPath);
  const app = express();
  // ponytail: one profile cache shared by REST and MCP, unbounded and never invalidated (5 min TTL on read); LRU / explicit refresh if it matters
  const deps = { db, baseUrl, fetch, cache: new Map() as ProfileCache };
  app.use(profileRouter(baseUrl));
  app.use(orderRouter(db));
  app.use("/merchant-admin", adminRouter({ db, baseUrl, fetch }));
  app.use("/merchant-admin", express.json({ limit: "10mb" }), merchantAdminRouter(db));
  app.use("/ucp", mcpRouter(deps));
  app.use("/ucp", restRouter(deps));
  app.use("/api", express.json(), inspectRouter(baseUrl), proxyRouter(baseUrl), conformanceRouter(baseUrl), webhookRouter());
  app.use(errorHandler);
  return app;
}
