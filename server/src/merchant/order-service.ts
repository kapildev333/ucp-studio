import { randomInt, randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { ProtocolError, type Ctx, type Result } from "./errors.js";
import { envelopeFor, incompatible } from "./negotiate.js";
import type { derive } from "./checkout-logic.js";

const ORDER = "dev.ucp.shopping.order";
type Deps = Pick<Ctx, "db" | "baseUrl" | "fetch">;
type Row = { id: string; snapshot: string; webhook_url: string | null };
type Order = { id: string; line_items: { id: string; quantity: { total: number; fulfilled: number }; status: string }[]; fulfillment: { events: unknown[] } };

export const find = (db: Db, id: string): Order | undefined => {
  const row = db.prepare("SELECT snapshot FROM orders WHERE id = ?").get(id) as Row | undefined;
  return row && JSON.parse(row.snapshot);
};

// Called inside Complete's transaction: stores the snapshot (and the platform's webhook_url when order was negotiated).
export function place(ctx: Ctx, id: string, checkoutId: string, d: ReturnType<typeof derive>) {
  const method = d.fulfillment?.methods[0];
  const group = method?.groups?.[0];
  const option = group?.options.find((o) => o.id === group.selected_option_id);
  const order = {
    id, checkout_id: checkoutId, permalink_url: `${ctx.baseUrl}/orders/${id}`, currency: "USD",
    line_items: d.line_items.map((l) => ({
      id: l.id, item: l.item, quantity: { original: l.quantity, total: l.quantity, fulfilled: 0 }, totals: l.totals, status: "processing",
    })),
    fulfillment: {
      expectations: method && option ? [{
        id: "exp_1", line_items: d.line_items.map((l) => ({ id: l.id, quantity: l.quantity })), method_type: "shipping",
        destination: method.destinations[0], description: option.title,
      }] : [],
      events: [],
    },
    adjustments: [],
    totals: d.totals,
  };
  ctx.db.prepare("INSERT INTO orders VALUES (?,?,?,?,?)").run(id, checkoutId, JSON.stringify(order), webhookUrl(ctx), new Date().toISOString());
}

// The platform's order entry at the negotiated version; only absolute http(s) URLs are kept.
function webhookUrl(ctx: Ctx): string | null {
  const version = ctx.negotiated.capabilities.find((c) => c.name === ORDER)?.version;
  const entries = ctx.negotiated.platformCapabilities[ORDER];
  const url = (Array.isArray(entries) ? entries : []).find((e) => e?.version === version)?.config?.webhook_url;
  try {
    return typeof url === "string" && ["http:", "https:"].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

export const get = (ctx: Ctx, id: string): Result => {
  const bad = incompatible(ctx.negotiated, ORDER);
  if (bad) return bad;
  const order = find(ctx.db, id);
  if (!order) throw new ProtocolError(404, "not_found", "Order not found");
  return { status: 200, body: { ucp: envelopeFor(ctx.negotiated, [ORDER]), ...order } };
};

export function ship(ctx: Deps, id: string): Result {
  const order = find(ctx.db, id);
  if (!order) throw new ProtocolError(404, "not_found", "Order not found");
  if (order.line_items.every((l) => l.status === "fulfilled")) throw new ProtocolError(409, "invalid_state", "Order is already fulfilled");
  const number = `UCPS${String(randomInt(1e10)).padStart(10, "0")}`;
  order.fulfillment.events.push({
    id: `evt_${randomUUID()}`, occurred_at: new Date().toISOString(), type: "shipped",
    line_items: order.line_items.map((l) => ({ id: l.id, quantity: l.quantity.total })),
    tracking_number: number, tracking_url: `${ctx.baseUrl}/track/${number}`, carrier: "MockShip", description: "Shipped",
  });
  for (const l of order.line_items) [l.quantity.fulfilled, l.status] = [l.quantity.total, "fulfilled"];
  ctx.db.prepare("UPDATE orders SET snapshot = ? WHERE id = ?").run(JSON.stringify(order), id);
  notify(ctx, id);
  return { status: 200, body: order };
}

const WAITS = [1000, 5000]; // before attempts 2 and 3

// POSTs the current order to the stored webhook_url after the response has gone out (next timer tick); never throws into the caller.
// ponytail: in-process retries (3 attempts, 1 s then 5 s) and unsigned; a durable queue and RFC 9421 signatures are the upgrade.
export function notify(ctx: Deps, id: string) {
  const row = ctx.db.prepare("SELECT snapshot, webhook_url FROM orders WHERE id = ?").get(id) as Row | undefined;
  if (!row?.webhook_url) return;
  const event_id = `evt_${randomUUID()}`;
  const body = JSON.stringify({ ...JSON.parse(row.snapshot), event_id, created_time: new Date().toISOString() });
  const send = async (attempt: number) => {
    let ok = false;
    try {
      ok = (await ctx.fetch(row.webhook_url!, {
        method: "POST", body, signal: AbortSignal.timeout(5000),
        headers: {
          "Content-Type": "application/json", "Webhook-Id": event_id, "Webhook-Timestamp": String(Math.floor(Date.now() / 1000)),
          "UCP-Agent": `profile="${ctx.baseUrl}/.well-known/ucp"`,
        },
      })).ok;
    } catch {}
    if (!ok && attempt < WAITS.length) setTimeout(() => void send(attempt + 1), WAITS[attempt]).unref();
  };
  setTimeout(() => void send(0), 0).unref();
}
