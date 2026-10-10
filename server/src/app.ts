import express, { Router } from "express";
import { openDb } from "./db.js";
import { errorHandler, protocolError, ucpHeaders } from "./ucp.js";
import { profileRouter } from "./merchant/profile.js";
import { catalogRouter } from "./merchant/catalog.js";
import { inspectRouter } from "./studio/inspect.js";
import { proxyRouter } from "./studio/proxy.js";
import { conformanceRouter } from "./studio/conformance.js";
import { merchantAdminRouter } from "./merchant-admin/catalog.js";
import { checkoutRouter, orderRouter } from "./merchant/checkout.js";

export function createApp({ dbPath, baseUrl }: { dbPath: string; baseUrl: string }) {
  const db = openDb(dbPath);
  const app = express();
  app.use(profileRouter(baseUrl));
  app.use(orderRouter(db));
  const ucp = Router();
  ucp.use(ucpHeaders);
  ucp.use(express.json()); // after ucpHeaders so bad bodies still get Request-Id and the UCP-Agent check
  ucp.use("/catalog", catalogRouter(db));
  ucp.use("/checkout-sessions", checkoutRouter(db, baseUrl));
  ucp.use((_req, res) => protocolError(res, 404, "not_found", "No such UCP endpoint"));
  app.use("/ucp", ucp);
  app.use("/api", express.json(), inspectRouter(baseUrl), proxyRouter(baseUrl), conformanceRouter(baseUrl));
  app.use("/merchant-admin", express.json({ limit: "10mb" }), merchantAdminRouter(db));
  app.use(errorHandler);
  return app;
}
