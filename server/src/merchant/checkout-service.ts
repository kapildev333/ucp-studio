import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProtocolError, type Ctx, type Result } from "./errors.js";
import { envelopeFor, has, incompatible } from "./negotiate.js";
import { PAYMENT_HANDLERS } from "./profile.js";
import { notify, place } from "./order-service.js";
import { derive, unknownItems, type CheckoutRequest, type Message, type Variant } from "./checkout-logic.js";

const CHECKOUT = "dev.ucp.shopping.checkout";
const FULFILLMENT = "dev.ucp.shopping.fulfillment";
const TTL_MS = 6 * 60 * 60 * 1000;

const str = z.string().default("");
const requestBody = z.object({
  line_items: z.array(z.object({ item: z.object({ id: z.string() }), quantity: z.number().int().min(1).max(10_000) })).min(1),
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

type Row = { id: string; request: string; status: string; total: number; canceled: number; order_id: string | null; created_at: string; expires_at: string; snapshot: string | null };

const lookup = (ctx: Ctx) => (id: string) => ctx.db.prepare("SELECT id, title, price, stock FROM variants WHERE id = ?").get(id) as Variant;
const find = (ctx: Ctx, id: string) => ctx.db.prepare("SELECT * FROM checkouts WHERE id = ?").get(id) as Row | undefined;
const mustFind = (ctx: Ctx, id: string) => find(ctx, id) ?? (() => { throw new ProtocolError(404, "not_found", "Checkout not found"); })();
const live = (row: Row) => !row.order_id && !row.canceled && row.expires_at > new Date().toISOString();
// Line items whose variant no longer exists (deleted by a catalog import since the last write).
const gone = (ctx: Ctx, req: CheckoutRequest) => unknownItems(req, (id) => !!lookup(ctx)(id));
const derived = (ctx: Ctx, req: CheckoutRequest) => derive(req, lookup(ctx), has(ctx.negotiated, FULFILLMENT));
const totalOf = (d: { totals: { type: string; amount: number }[] }) => d.totals.find((t) => t.type === "total")!.amount;
const ok = (body: unknown, status: 200 | 201 = 200): Result => ({ status, body });
const invalidState = (content: string) => new ProtocolError(409, "invalid_state", content);

const errorBody = (ctx: Ctx, messages: Message[]) => ({ ucp: { ...envelopeFor(ctx.negotiated, [CHECKOUT, FULFILLMENT]), status: "error" }, messages });
const view = (ctx: Ctx, row: Row, extra: Message[] = []) => {
  const ucp = envelopeFor(ctx.negotiated, [CHECKOUT, FULFILLMENT]);
  if (row.snapshot) return { ucp, ...(JSON.parse(row.snapshot) as { id: string }) }; // finished: frozen, never re-derived from the live catalog
  const req = JSON.parse(row.request) as CheckoutRequest;
  const missing = gone(ctx, req);
  if (missing.length) return errorBody(ctx, missing);
  const d = derived(ctx, req);
  const done = !!row.order_id;
  return {
    ucp, id: row.id,
    status: done ? "completed" : live(row) ? d.status : "canceled",
    currency: "USD", line_items: d.line_items,
    ...(req.buyer && { buyer: req.buyer }),
    ...(d.fulfillment && { fulfillment: d.fulfillment }),
    totals: d.totals,
    messages: done ? [] : [...d.messages, ...extra],
    links: [{ type: "terms_of_service", url: `${ctx.baseUrl}/terms` }, { type: "privacy_policy", url: `${ctx.baseUrl}/privacy` }],
    payment: { instruments: [] }, payment_handlers: PAYMENT_HANDLERS, expires_at: row.expires_at,
    ...(row.order_id && { order: { id: row.order_id, permalink_url: `${ctx.baseUrl}/orders/${row.order_id}` } }),
  };
};

// Run right after the completing/canceling write: stores the response body minus `ucp` (that stays per-request, from the caller's negotiation)
// so later catalog changes (price, title, stock, deletion, reset) cannot alter a finished checkout.
// A checkout canceled after its variant vanished has nothing to snapshot and keeps answering item_not_found.
// ponytail: an expired checkout nobody canceled reads as "canceled" but is never written, so it still re-derives; freeze lazily on read if that matters.
const freeze = (ctx: Ctx, id: string) => {
  const body = view(ctx, find(ctx, id)!);
  if ("id" in body) {
    const { ucp: _, ...rest } = body;
    ctx.db.prepare("UPDATE checkouts SET snapshot = ? WHERE id = ?").run(JSON.stringify(rest), id);
  }
  return body;
};

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
  // One transaction with the operation itself, so a crash cannot leave the effect without its replay record.
  return ctx.db.transaction(() => {
    const result = run();
    ctx.db.prepare("INSERT INTO idempotency VALUES (?,?,?,?)").run(key, fingerprint, result.status, JSON.stringify(result.body));
    return result;
  })();
}

export const create = (ctx: Ctx, input: unknown): Result =>
  incompatible(ctx.negotiated, CHECKOUT) ?? idempotent(ctx, "create", "", input, () => {
    const body = requestBody.parse(input) as CheckoutRequest;
    const unknown = gone(ctx, body);
    if (unknown.length) return ok(errorBody(ctx, unknown));
    const now = Date.now();
    const id = `chk_${randomUUID()}`;
    const d = derived(ctx, body);
    ctx.db.prepare("INSERT INTO checkouts (id, request, status, total, created_at, expires_at) VALUES (?,?,?,?,?,?)")
      .run(id, JSON.stringify(body), d.status, totalOf(d), new Date(now).toISOString(), new Date(now + TTL_MS).toISOString());
    return ok(view(ctx, find(ctx, id)!), 201);
  });

export const get = (ctx: Ctx, id: string): Result =>
  incompatible(ctx.negotiated, CHECKOUT) ?? ok(view(ctx, mustFind(ctx, id)));

export const update = (ctx: Ctx, id: string, input: unknown): Result =>
  incompatible(ctx.negotiated, CHECKOUT) ?? idempotent(ctx, "update", id, input, () => {
    const body = requestBody.parse(input) as CheckoutRequest;
    const row = mustFind(ctx, id);
    if (!live(row)) throw invalidState("Checkout is completed or canceled");
    const unknown = gone(ctx, body);
    if (unknown.length) return ok(errorBody(ctx, unknown));
    const d = derived(ctx, body);
    ctx.db.prepare("UPDATE checkouts SET request = ?, status = ?, total = ? WHERE id = ?").run(JSON.stringify(body), d.status, totalOf(d), id);
    return ok(view(ctx, find(ctx, id)!));
  });

export const complete = (ctx: Ctx, id: string, input: unknown): Result =>
  incompatible(ctx.negotiated, CHECKOUT) ?? idempotent(ctx, "complete", id, input, () => {
    const { payment } = completeBody.parse(input);
    const row = mustFind(ctx, id);
    const request = JSON.parse(row.request) as CheckoutRequest;
    if (!live(row)) throw invalidState("Checkout is not ready for complete"); // before deriving: a finished checkout's variants may be gone
    const missing = gone(ctx, request);
    if (missing.length) return ok(errorBody(ctx, missing));
    const d = derived(ctx, request); // gate on the fresh status: the stored one may predate this platform's negotiation
    if (row.status !== "ready_for_complete" && d.status !== "ready_for_complete") throw invalidState("Checkout is not ready for complete");
    const inst = payment.instruments[0];
    if (inst.handler_id !== "mock_pay") throw new ProtocolError(400, "invalid_request", `Unsupported payment handler ${inst.handler_id}`);
    if (d.status !== "ready_for_complete") { // stock changed since the last write; nothing charged
      ctx.db.prepare("UPDATE checkouts SET status = 'incomplete', total = ? WHERE id = ?").run(totalOf(d), id);
      return ok(view(ctx, find(ctx, id)!));
    }
    // Repriced since the last write: the buyer never saw this total. Nothing charged; the new total is stored so the next Complete goes through.
    // ponytail: only writes (and this branch) record the shown total, so a GET that already showed the new price still bounces the first Complete once.
    if (totalOf(d) !== row.total) {
      ctx.db.prepare("UPDATE checkouts SET total = ? WHERE id = ?").run(totalOf(d), id);
      return ok(view(ctx, find(ctx, id)!, [{
        type: "warning", code: "price_changed", severity: "requires_buyer_review",
        content: `Prices changed since your last update: the total is now ${(totalOf(d) / 100).toFixed(2)} USD (was ${(row.total / 100).toFixed(2)}). Nothing was charged; review and complete again.`,
      }]));
    }
    if (inst.credential.token === "tok_decline") {
      return ok(view(ctx, row, [{ type: "error", code: "payment_declined", content: "Payment was declined", severity: "recoverable" }]));
    }
    const orderId = `ord_${randomUUID()}`;
    const body = ctx.db.transaction(() => {
      for (const l of request.line_items) ctx.db.prepare("UPDATE variants SET stock = stock - ? WHERE id = ?").run(l.quantity, l.item.id);
      place(ctx, orderId, id, d);
      ctx.db.prepare("UPDATE checkouts SET order_id = ?, status = 'completed' WHERE id = ?").run(orderId, id);
      return freeze(ctx, id);
    })();
    notify(ctx, orderId);
    return ok(body);
  });

export const cancel = (ctx: Ctx, id: string): Result =>
  incompatible(ctx.negotiated, CHECKOUT) ?? idempotent(ctx, "cancel", id, null, () => {
    const row = mustFind(ctx, id);
    if (row.order_id) throw invalidState("Checkout is already completed");
    ctx.db.prepare("UPDATE checkouts SET canceled = 1, status = 'canceled' WHERE id = ?").run(id);
    return ok(freeze(ctx, id));
  });
