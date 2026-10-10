import { randomUUID } from "node:crypto";
import express, { Router, type Request, type RequestHandler, type Response } from "express";
import type { Db } from "../db.js";
import { protocolError } from "../ucp.js";
import * as catalog from "./catalog-service.js";
import * as checkout from "./checkout-service.js";
import * as orders from "./order-service.js";
import { ProtocolError, type Ctx, type Result } from "./errors.js";
import { negotiate, type ProfileCache } from "./negotiate.js";

// ponytail: regex instead of a full RFC 8941 parser; add one if UCP-Agent grows other params with quoted commas
const profileUrl = (req: Request) => /(?:^|,)\s*profile="([^"]*)"/.exec(req.header("UCP-Agent") ?? "")?.[1];

const fail = (res: Response, next: (e?: unknown) => void, e: unknown) =>
  e instanceof ProtocolError ? void protocolError(res, e.status, e.code, e.content) : next(e);

export const restRouter = (deps: { db: Db; baseUrl: string; fetch: typeof fetch }) => {
  const cache: ProfileCache = new Map(); // per app instance so tests don't leak into each other
  const r = Router();

  // Request-Id first, then negotiate before the body is parsed so a missing UCP-Agent is reported ahead of bad JSON.
  r.use(async (req, res, next) => {
    res.setHeader("Request-Id", req.header("Request-Id") || randomUUID());
    try {
      res.locals.negotiated = await negotiate(profileUrl(req), { fetch: deps.fetch, cache });
      next();
    } catch (e) {
      fail(res, next, e);
    }
  });

  // parse -> service -> respond; `needKey` operations require Idempotency-Key as in v1.
  const op = (fn: (ctx: Ctx, req: Request) => Result, needKey = false): RequestHandler => (req, res, next) => {
    try {
      const idempotencyKey = req.header("Idempotency-Key");
      if (needKey && !idempotencyKey) throw new ProtocolError(400, "idempotency_key_required", "Idempotency-Key header is required");
      const { status, body } = fn({ ...deps, negotiated: res.locals.negotiated, idempotencyKey }, req);
      res.status(status).json(body);
    } catch (e) {
      fail(res, next, e);
    }
  };

  r.use(express.json());
  r.post("/catalog/search", op((c, q) => catalog.search(c, q.body)));
  r.post("/catalog/lookup", op((c, q) => catalog.lookup(c, q.body)));
  r.post("/catalog/product", op((c, q) => catalog.getProduct(c, q.body)));
  r.post("/checkout-sessions", op((c, q) => checkout.create(c, q.body), true));
  r.get("/checkout-sessions/:id", op((c, q) => checkout.get(c, q.params.id)));
  r.put("/checkout-sessions/:id", op((c, q) => checkout.update(c, q.params.id, q.body), true));
  r.post("/checkout-sessions/:id/complete", op((c, q) => checkout.complete(c, q.params.id, q.body), true));
  r.post("/checkout-sessions/:id/cancel", op((c, q) => checkout.cancel(c, q.params.id), true));
  r.get("/orders/:id", op((c, q) => orders.get(c, q.params.id)));
  r.use((_req, res) => protocolError(res, 404, "not_found", "No such UCP endpoint"));
  return r;
};

// Plain pages outside /ucp: no UCP headers required.
export const orderRouter = (db: Db) => {
  const r = Router();
  r.get("/orders/:id", (req, res) => {
    const order = orders.find(db, req.params.id);
    if (!order) return protocolError(res, 404, "not_found", "Order not found");
    res.json(order);
  });
  r.get("/track/:number", (req, res) => void res.type("text/plain").send(`Tracking ${req.params.number}: shipped with MockShip (placeholder).\n`));
  r.get("/terms", (_req, res) => void res.type("text/plain").send("UCP Studio demo terms of service: placeholder.\n"));
  r.get("/privacy", (_req, res) => void res.type("text/plain").send("UCP Studio demo privacy policy: placeholder.\n"));
  return r;
};

// Demo-only back office, not UCP. ponytail: no auth (localhost demo); add real authn before exposing beyond 127.0.0.1
export const adminRouter = (deps: { db: Db; baseUrl: string; fetch: typeof fetch }) => {
  const r = Router();
  r.post("/orders/:id/ship", (req, res, next) => {
    try {
      const { status, body } = orders.ship(deps, req.params.id);
      res.status(status).json(body);
    } catch (e) {
      fail(res, next, e);
    }
  });
  return r;
};
