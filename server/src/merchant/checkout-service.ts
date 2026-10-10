import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProtocolError, type Ctx, type Result } from "./errors.js";
import { envelopeFor, has, incompatible } from "./negotiate.js";
import { notify, place } from "./order-service.js";
import { derive, unknownItems, type CheckoutRequest, type Message, type Variant } from "./checkout-logic.js";

const CHECKOUT = "dev.ucp.shopping.checkout";
const FULFILLMENT = "dev.ucp.shopping.fulfillment";
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
        street_address: z.string().min(1), address_locality: z.string().min(1), address_region: str, postal_code: z.string().min(1), address_country: z.string().default("US"),
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

const lookup = (ctx: Ctx) => (id: string) => ctx.db.prepare("SELECT id, title, price, stock FROM variants WHERE id = ?").get(id) as Variant;
const find = (ctx: Ctx, id: string) => ctx.db.prepare("SELECT * FROM checkouts WHERE id = ?").get(id) as Row | undefined;
const mustFind = (ctx: Ctx, id: string) => find(ctx, id) ?? (() => { throw new ProtocolError(404, "not_found", "Checkout not found"); })();
const live = (row: Row) => !row.order_id && !row.canceled && row.expires_at > new Date().toISOString();
const derived = (ctx: Ctx, req: CheckoutRequest) => derive(req, lookup(ctx), has(ctx.negotiated, FULFILLMENT));
const ok = (body: unknown, status: 200 | 201 = 200): Result => ({ status, body });
const invalidState = (content: string) => new ProtocolError(409, "invalid_state", content);

const view = (ctx: Ctx, row: Row, extra: Message[] = []) => {
  const req = JSON.parse(row.request) as CheckoutRequest;
  const d = derived(ctx, req);
  const done = !!row.order_id;
  return {
    ucp: envelopeFor(ctx.negotiated, [CHECKOUT, FULFILLMENT]), id: row.id,
    status: done ? "completed" : live(row) ? d.status : "canceled",
    currency: "USD", line_items: d.line_items,
    ...(req.buyer && { buyer: req.buyer }),
    ...(d.fulfillment && { fulfillment: d.fulfillment }),
    totals: d.totals,
    messages: done ? [] : [...d.messages, ...extra],
    links: [{ type: "terms_of_service", url: `${ctx.baseUrl}/terms` }, { type: "privacy_policy", url: `${ctx.baseUrl}/privacy` }],
    payment: { instruments: [] }, payment_handlers: HANDLERS, expires_at: row.expires_at,
    ...(row.order_id && { order: { id: row.order_id, permalink_url: `${ctx.baseUrl}/orders/${row.order_id}` } }),
  };
};
const errorBody = (ctx: Ctx, messages: Message[]) => ({ ucp: { ...envelopeFor(ctx.negotiated, [CHECKOUT, FULFILLMENT]), status: "error" }, messages });

// Keyed on operation + checkout id + canonical input; replays stored responses, 409s on a reused key with a different request.
// Without a key (MCP may omit it) the operation just runs.
function idempotent(ctx: Ctx, op: string, id: string, input: unknown, run: () => Result): Result {
  const key = ctx.idempotencyKey;
  if (!key) return run();
  const fingerprint = `${op} ${id} ${canon(input)}`;
  const hit = ctx.db.prepare("SELECT * FROM idempotency WHERE key = ?").get(key) as { fingerprint: string; status: 200 | 201; body: string } | undefined;
  if (hit) {
    if (hit.fingerprint !== fingerprint) throw new ProtocolError(409, "idempotency_conflict", "Idempotency-Key was used with a different request");
    return { status: hit.status, body: JSON.parse(hit.body) };
  }
  const result = run();
  ctx.db.prepare("INSERT INTO idempotency VALUES (?,?,?,?)").run(key, fingerprint, result.status, JSON.stringify(result.body));
  return result;
}

export const create = (ctx: Ctx, input: unknown): Result =>
  incompatible(ctx.negotiated, CHECKOUT) ?? idempotent(ctx, "create", "", input, () => {
    const body = requestBody.parse(input) as CheckoutRequest;
    const unknown = unknownItems(body, (id) => !!lookup(ctx)(id));
    if (unknown.length) return ok(errorBody(ctx, unknown));
    const now = Date.now();
    const id = `chk_${randomUUID()}`;
    ctx.db.prepare("INSERT INTO checkouts (id, request, status, created_at, expires_at) VALUES (?,?,?,?,?)")
      .run(id, JSON.stringify(body), derived(ctx, body).status, new Date(now).toISOString(), new Date(now + TTL_MS).toISOString());
    return ok(view(ctx, find(ctx, id)!), 201);
  });

export const get = (ctx: Ctx, id: string): Result =>
  incompatible(ctx.negotiated, CHECKOUT) ?? ok(view(ctx, mustFind(ctx, id)));

export const update = (ctx: Ctx, id: string, input: unknown): Result =>
  incompatible(ctx.negotiated, CHECKOUT) ?? idempotent(ctx, "update", id, input, () => {
    const body = requestBody.parse(input) as CheckoutRequest;
    const row = mustFind(ctx, id);
    if (!live(row)) throw invalidState("Checkout is completed or canceled");
    const unknown = unknownItems(body, (i) => !!lookup(ctx)(i));
    if (unknown.length) return ok(errorBody(ctx, unknown));
    ctx.db.prepare("UPDATE checkouts SET request = ?, status = ? WHERE id = ?").run(JSON.stringify(body), derived(ctx, body).status, id);
    return ok(view(ctx, find(ctx, id)!));
  });

export const complete = (ctx: Ctx, id: string, input: unknown): Result =>
  incompatible(ctx.negotiated, CHECKOUT) ?? idempotent(ctx, "complete", id, input, () => {
    const { payment } = completeBody.parse(input);
    const row = mustFind(ctx, id);
    if (!live(row) || row.status !== "ready_for_complete") throw invalidState("Checkout is not ready for complete");
    const inst = payment.instruments[0];
    if (inst.handler_id !== "mock_pay") throw new ProtocolError(400, "invalid_request", `Unsupported payment handler ${inst.handler_id}`);
    const request = JSON.parse(row.request) as CheckoutRequest;
    const d = derived(ctx, request);
    if (d.status !== "ready_for_complete") { // stock changed since the last write; nothing charged
      ctx.db.prepare("UPDATE checkouts SET status = 'incomplete' WHERE id = ?").run(id);
      return ok(view(ctx, find(ctx, id)!));
    }
    if (inst.credential.token === "tok_decline") {
      return ok(view(ctx, row, [{ type: "error", code: "payment_declined", content: "Payment was declined", severity: "recoverable" }]));
    }
    const orderId = `ord_${randomUUID()}`;
    ctx.db.transaction(() => {
      for (const l of request.line_items) ctx.db.prepare("UPDATE variants SET stock = stock - ? WHERE id = ?").run(l.quantity, l.item.id);
      place(ctx, orderId, id, d);
      ctx.db.prepare("UPDATE checkouts SET order_id = ?, status = 'completed' WHERE id = ?").run(orderId, id);
    })();
    notify(ctx, orderId);
    return ok(view(ctx, find(ctx, id)!));
  });

export const cancel = (ctx: Ctx, id: string): Result =>
  incompatible(ctx.negotiated, CHECKOUT) ?? idempotent(ctx, "cancel", id, null, () => {
    const row = mustFind(ctx, id);
    if (row.order_id) throw invalidState("Checkout is already completed");
    ctx.db.prepare("UPDATE checkouts SET canceled = 1, status = 'canceled' WHERE id = ?").run(id);
    return ok(view(ctx, find(ctx, id)!));
  });
