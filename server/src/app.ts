import express, { Router } from "express";
import { openDb } from "./db.js";
import { errorHandler, ucpHeaders } from "./ucp.js";
import { profileRouter } from "./merchant/profile.js";
import { catalogRouter } from "./merchant/catalog.js";

export function createApp({ dbPath, baseUrl }: { dbPath: string; baseUrl: string }) {
  const db = openDb(dbPath);
  const app = express();
  app.use(express.json());
  app.use(profileRouter(baseUrl));
  const ucp = Router();
  ucp.use(ucpHeaders);
  ucp.use("/catalog", catalogRouter(db));
  app.use("/ucp", ucp);
  app.use(errorHandler);
  return app;
}
