import express from "express";
import { openDb } from "./db.js";
import { errorHandler } from "./ucp.js";
import { profileRouter } from "./merchant/profile.js";
import { orderRouter, restRouter } from "./merchant/rest.js";
import { inspectRouter } from "./studio/inspect.js";
import { proxyRouter } from "./studio/proxy.js";

export function createApp({ dbPath, baseUrl, fetch = globalThis.fetch }: { dbPath: string; baseUrl: string; fetch?: typeof globalThis.fetch }) {
  const db = openDb(dbPath);
  const app = express();
  app.use(profileRouter(baseUrl));
  app.use(orderRouter(db));
  app.use("/ucp", restRouter({ db, baseUrl, fetch }));
  app.use("/api", express.json(), inspectRouter(baseUrl), proxyRouter(baseUrl));
  app.use(errorHandler);
  return app;
}
