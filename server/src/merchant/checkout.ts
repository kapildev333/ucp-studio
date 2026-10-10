import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { Db } from "../db.js";
import { envelope, protocolError } from "../ucp.js";
import { derive, unknownItems, type CheckoutRequest, type Message, type Variant } from "./checkout-logic.js";

const CAPS = ["dev.ucp.shopping.checkout", "dev.ucp.shopping.fulfillment"];
const HANDLERS = { "dev.ucpstudio.mock_pay": [{ id: "mock_pay", version: "2026-08-25" }] };
const TTL_MS = 6 * 60 * 60 * 1000;

const str = z.string().default("");
const requestBody = z.object({
  line_items: z.array(z.object({ item: z.object({ id: z.string() }), quantity: z.number().int().min(1) })).min(1),
  buyer: z.object({ first_name: z.string().optional(), last_name: z.string().optional(), email: z.string().optional(), phone_number: z.string().optional() }).optional(),
  fulfillment: z.object({
    methods: z.array(z.object({
      type: z.literal("shipping"),
      destinations: z.array(z.object({
        street_address: str, address_locality: str, address_region: str, postal_code: str, address_country: z.string().default("US"),
      })),
      groups: z.array(z.object({ selected_option_id: z.string().optional() })).optional(),
    })),
  }).optional(),
});
const completeBody = z.object({
  payment: z.object({
    instruments: z.array(z.object({ id: z.string(), handler_id: z.string(), type: z.string(), credential: z.object({ token: z.string() }) })).min(1),
  }),
});

const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v) ?? "null";

type Row = { id: string; request: string; status: string; canceled: number; order_id: string | null; created_at: string; expires_at: string };

export const checkoutRouter = (db: Db, baseUrl: string) => {
  const lookup = (id: string) => db.prepare("SELECT id, title, price, stock FROM variants WHERE id = ?").get(id) as Variant | undefined;
  const find = (id: string) => db.prepare("SELECT * FROM checkouts WHERE id = ?").get(id) as Row | undefined;
  const live = (row: Row) => !row.order_id && !row.canceled && row.expires_at > new Date().toISOString();

  const view = (row: Row, extra: Message[] = []) => {
    const req = JSON.parse(row.request) as CheckoutRequest;
    const d = derive(req, lookup as (id: string) => Variant);
    const done = !!row.order_id;
    return {
      ucp: envelope(CAPS), id: row.id,
      status: done ? "completed" : live(row) ? d.status : "canceled",
      currency: "USD", line_items: d.line_items,
      ...(req.buyer && { buyer: req.buyer }),
      ...(d.fulfillment && { fulfillment: d.fulfillment }),
      totals: d.totals,
      messages: done ? [] : [...d.messages, ...extra],
      links: [{ type: "terms_of_service", url: `${baseUrl}/terms` }, { type: "privacy_policy", url: `${baseUrl}/privacy` }],
      payment: { instruments: [] }, payment_handlers: HANDLERS, expires_at: row.expires_at,
      ...(row.order_id && { order: { id: row.order_id, permalink_url: `${baseUrl}/orders/${row.order_id}` } }),
    };
  };
  const errorBody = (messages: Message[]) => ({ ucp: { ...envelope(CAPS), status: "error" }, messages });

  // Requires Idempotency-Key; replays stored 200/201 responses, 409s on a reused key with a different request.
  const idempotent: RequestHandler = (req, res, next) => {
    const key = req.header("Idempotency-Key");
    if (!key) return protocolError(res, 400, "idempotency_key_required", "Idempotency-Key header is required");
    const fingerprint = `${req.method} ${req.originalUrl} ${canon(req.body)}`;
    const hit = db.prepare("SELECT * FROM idempotency WHERE key = ?").get(key) as { fingerprint: string; status: number; body: string } | undefined;
    if (hit) {
      if (hit.fingerprint !== fingerprint) return protocolError(res, 409, "idempotency_conflict", "Idempotency-Key was used with a different request");
      return void res.status(hit.status).json(JSON.parse(hit.body));
    }
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 300) db.prepare("INSERT INTO idempotency VALUES (?,?,?,?)").run(key, fingerprint, res.statusCode, JSON.stringify(body));
      return json(body);
    };
    next();
  };

  const r = Router();

  r.post("/", idempotent, (req, res) => {
    const body = requestBody.parse(req.body) as CheckoutRequest;
    const unknown = unknownItems(body, (id) => !!lookup(id));
    if (unknown.length) return void res.json(errorBody(unknown));
    const now = Date.now();
    const id = `chk_${randomUUID()}`;
    db.prepare("INSERT INTO checkouts (id, request, status, created_at, expires_at) VALUES (?,?,?,?,?)")
      .run(id, JSON.stringify(body), derive(body, lookup as (id: string) => Variant).status, new Date(now).toISOString(), new Date(now + TTL_MS).toISOString());
    res.status(201).json(view(find(id)!));
  });

  r.get("/:id", (req, res) => {
    const row = find(req.params.id);
    if (!row) return protocolError(res, 404, "not_found", "Checkout not found");
    res.json(view(row));
  });

  r.put("/:id", idempotent, (req, res) => {
    const body = requestBody.parse(req.body) as CheckoutRequest;
    const row = find(req.params.id);
    if (!row) return protocolError(res, 404, "not_found", "Checkout not found");
    if (!live(row)) return protocolError(res, 409, "invalid_state", "Checkout is completed or canceled");
    const unknown = unknownItems(body, (id) => !!lookup(id));
    if (unknown.length) return void res.json(errorBody(unknown));
    db.prepare("UPDATE checkouts SET request = ?, status = ? WHERE id = ?")
      .run(JSON.stringify(body), derive(body, lookup as (id: string) => Variant).status, row.id);
    res.json(view(find(row.id)!));
  });

  r.post("/:id/complete", idempotent, (req, res) => {
    const { payment } = completeBody.parse(req.body);
    const row = find(req.params.id);
    if (!row) return protocolError(res, 404, "not_found", "Checkout not found");
    if (!live(row) || row.status !== "ready_for_complete") return protocolError(res, 409, "invalid_state", "Checkout is not ready for complete");
    const inst = payment.instruments[0];
    if (inst.handler_id !== "mock_pay") return protocolError(res, 400, "invalid_request", `Unsupported payment handler ${inst.handler_id}`);
    const request = JSON.parse(row.request) as CheckoutRequest;
    const d = derive(request, lookup as (id: string) => Variant);
    if (d.status !== "ready_for_complete") { // stock changed since the last write; nothing charged
      db.prepare("UPDATE checkouts SET status = 'incomplete' WHERE id = ?").run(row.id);
      return void res.json(view(find(row.id)!));
    }
    if (inst.credential.token === "tok_decline") {
      return void res.json(view(row, [{ type: "error", code: "payment_declined", content: "Payment was declined", severity: "recoverable" }]));
    }
    const orderId = `ord_${randomUUID()}`;
    db.transaction(() => {
      for (const l of request.line_items) db.prepare("UPDATE variants SET stock = stock - ? WHERE id = ?").run(l.quantity, l.item.id);
      db.prepare("INSERT INTO orders VALUES (?,?,?,?,?)")
        .run(orderId, row.id, d.totals.at(-1)!.amount, "USD", new Date().toISOString());
      db.prepare("UPDATE checkouts SET order_id = ?, status = 'completed' WHERE id = ?").run(orderId, row.id);
    })();
    res.json(view(find(row.id)!));
  });

  r.post("/:id/cancel", idempotent, (req, res) => {
    const row = find(req.params.id);
    if (!row) return protocolError(res, 404, "not_found", "Checkout not found");
    if (row.order_id) return protocolError(res, 409, "invalid_state", "Checkout is already completed");
    db.prepare("UPDATE checkouts SET canceled = 1, status = 'canceled' WHERE id = ?").run(row.id);
    res.json(view(find(row.id)!));
  });

  return r;
};

// Plain pages outside /ucp: no UCP headers required.
export const orderRouter = (db: Db) => {
  const r = Router();
  r.get("/orders/:id", (req, res) => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return protocolError(res, 404, "not_found", "Order not found");
    res.json(order);
  });
  r.get("/terms", (_req, res) => void res.type("text/plain").send("UCP Studio demo terms of service: placeholder.\n"));
  r.get("/privacy", (_req, res) => void res.type("text/plain").send("UCP Studio demo privacy policy: placeholder.\n"));
  return r;
};
