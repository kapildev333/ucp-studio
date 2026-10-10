import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AGENT, AGENT_URL, CAPS, profileOf } from "./helpers.js";

const baseUrl = "http://127.0.0.1:4000";
const HOOK = "http://platform.test/hook";
const ORDER = "dev.ucp.shopping.order";
const withHook = (url: unknown = HOOK, names = [...CAPS, ORDER]) => {
  const p = profileOf(names) as any;
  if (p.ucp.capabilities[ORDER]) p.ucp.capabilities[ORDER][0].config = { webhook_url: url };
  return p;
};

// Serves the platform profile and records webhook POSTs; `hookStatus` controls the reply (or throws when "throw").
function setup(profile: unknown = withHook()) {
  const hooks: { headers: Record<string, string>; body: any }[] = [];
  const state = { hookStatus: 200 as number | "throw" };
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === AGENT_URL) return new Response(JSON.stringify(profile));
    if (String(url) !== HOOK) return new Response("nope", { status: 404 });
    hooks.push({ headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) });
    if (state.hookStatus === "throw") throw new Error("connection refused");
    return new Response("", { status: state.hookStatus });
  }) as typeof globalThis.fetch;
  return { app: createApp({ dbPath: ":memory:", baseUrl, fetch }), hooks, state };
}

const addr = { street_address: "1 Main St", address_locality: "Springfield", address_region: "CA", postal_code: "94000", address_country: "US" };
let n = 0;
async function buy(app: any, lines = [{ item: { id: "var_4_1" }, quantity: 2 }], fulfillment = true) {
  const k = () => ({ ...AGENT, "Idempotency-Key": `k-${++n}` });
  const body = {
    line_items: lines, buyer: { email: "a@b.co" },
    ...(fulfillment && { fulfillment: { methods: [{ type: "shipping", destinations: [addr], groups: [{ selected_option_id: "standard" }] }] } }),
  };
  const c = await request(app).post("/ucp/checkout-sessions").set(k()).send(body);
  const done = await request(app).post(`/ucp/checkout-sessions/${c.body.id}/complete`).set(k())
    .send({ payment: { instruments: [{ id: "i1", handler_id: "mock_pay", type: "card", credential: { token: "tok_ok" } }] } });
  return { checkout: c.body, done: done.body, id: done.body.order?.id as string };
}
const ship = (app: any, id: string) => request(app).post(`/merchant-admin/orders/${id}/ship`).set("X-UCP-Studio", "1");
afterEach(() => vi.useRealTimers());

describe("order snapshot", () => {
  it("is built at Complete from the checkout", async () => {
    const { app } = setup();
    const { checkout, id, done } = await buy(app);
    expect(done.order).toEqual({ id, permalink_url: `${baseUrl}/orders/${id}` });
    const res = await request(app).get(`/ucp/orders/${id}`).set(AGENT);
    expect(res.status).toBe(200);
    expect(res.body.ucp.capabilities).toEqual([{ name: ORDER, version: "2026-08-25" }]);
    expect(res.body).toMatchObject({
      id, checkout_id: checkout.id, permalink_url: `${baseUrl}/orders/${id}`, currency: "USD", adjustments: [],
      line_items: [{ id: "li_1", item: { id: "var_4_1", title: "Classic Tee - Small", price: 1999 }, quantity: { original: 2, total: 2, fulfilled: 0 }, status: "processing" }],
      fulfillment: {
        expectations: [{ id: "exp_1", line_items: [{ id: "li_1", quantity: 2 }], method_type: "shipping", destination: addr, description: "Standard (5-7 days)" }],
        events: [],
      },
    });
    expect(res.body.line_items[0].totals).toEqual([{ type: "subtotal", amount: 3998 }, { type: "total", amount: 3998 }]);
    expect(res.body.totals).toEqual(done.totals);
  });
  it("has no expectations without fulfillment, and the permalink drops ucp", async () => {
    const { app } = setup(withHook(HOOK, [...CAPS.filter((c) => !c.endsWith("fulfillment")), ORDER]));
    const { id } = await buy(app, undefined, false);
    const res = await request(app).get(`/orders/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.fulfillment).toEqual({ expectations: [], events: [] });
    expect(res.body.ucp).toBeUndefined();
    expect((await request(app).get("/orders/ord_x")).status).toBe(404);
  });
  it("is unaffected by a later stock change", async () => {
    const { app } = setup();
    const { id } = await buy(app);
    const before = (await request(app).get(`/orders/${id}`)).body;
    await buy(app, [{ item: { id: "var_4_1" }, quantity: 5 }]); // drains more stock and changes what catalog shows
    expect((await request(app).get(`/orders/${id}`)).body).toEqual(before);
  });
  it("GET /ucp/orders/:id requires the order capability and a known order", async () => {
    const { app } = setup();
    const { id } = await buy(app);
    expect((await request(app).get("/ucp/orders/ord_nope").set(AGENT)).body.code).toBe("not_found");
    expect((await request(app).get(`/ucp/orders/${id}`)).body.code).toBe("invalid_profile_url");
    const { app: noOrder } = setup(profileOf());
    const r = await request(noOrder).get(`/ucp/orders/${id}`).set(AGENT);
    expect(r.status).toBe(200);
    expect(r.body.messages[0].code).toBe("capabilities_incompatible");
  });
  it("is still created when order is not negotiated, with no webhook", async () => {
    const { app, hooks } = setup(profileOf());
    const { id } = await buy(app);
    expect(id).toMatch(/^ord_/);
    expect((await request(app).get(`/orders/${id}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(hooks).toEqual([]);
  });
});

describe("ship", () => {
  it("fulfils every line, appends one shipped event, then 409s", async () => {
    const { app } = setup();
    const { id } = await buy(app, [{ item: { id: "var_4_1" }, quantity: 2 }, { item: { id: "var_4_2" }, quantity: 1 }]);
    const res = await ship(app, id);
    expect(res.status).toBe(200);
    expect(res.body.line_items.map((l: any) => [l.quantity.fulfilled, l.status])).toEqual([[2, "fulfilled"], [1, "fulfilled"]]);
    expect(res.body.fulfillment.events).toHaveLength(1);
    const ev = res.body.fulfillment.events[0];
    expect(ev).toMatchObject({ type: "shipped", carrier: "MockShip", description: "Shipped", line_items: [{ id: "li_1", quantity: 2 }, { id: "li_2", quantity: 1 }] });
    expect(ev.id).toMatch(/^evt_/);
    expect(ev.tracking_number).toMatch(/^UCPS\d{10}$/);
    expect(ev.tracking_url).toBe(`${baseUrl}/track/${ev.tracking_number}`);
    expect(Date.parse(ev.occurred_at)).not.toBeNaN();
    expect((await request(app).get(`/ucp/orders/${id}`).set(AGENT)).body.fulfillment.events).toEqual([ev]);
    const again = await ship(app, id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("invalid_state");
    expect((await ship(app, "ord_nope")).status).toBe(404);
  });
  it("serves a track placeholder", async () => {
    const { app } = setup();
    const res = await request(app).get("/track/UCPS0000000001");
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/plain");
  });
});

describe("webhooks", () => {
  it("is sent on complete and on ship with the headers", async () => {
    const { app, hooks } = setup();
    const { id } = await buy(app);
    await vi.waitFor(() => expect(hooks).toHaveLength(1));
    const [h] = hooks;
    expect(h.headers["Content-Type"]).toBe("application/json");
    expect(h.headers["Webhook-Id"]).toBe(h.body.event_id);
    expect(h.body.event_id).toMatch(/^evt_/);
    expect(Number(h.headers["Webhook-Timestamp"])).toBeGreaterThan(Date.now() / 1000 - 10);
    expect(h.headers["UCP-Agent"]).toBe(`profile="${baseUrl}/.well-known/ucp"`);
    expect(Date.parse(h.body.created_time)).not.toBeNaN();
    expect(h.body).toMatchObject({ id, currency: "USD", fulfillment: { events: [] } });
    expect(h.body.created_at).toMatch(/^\d{4}-\d\d-\d\dT/);

    await ship(app, id);
    await vi.waitFor(() => expect(hooks).toHaveLength(2));
    expect(hooks[1].body.fulfillment.events[0].type).toBe("shipped");
    expect(hooks[1].body.created_at).toBe(h.body.created_at);
    expect(hooks[1].body.event_id).not.toBe(h.body.event_id);
  });
  it("is not sent without a usable webhook_url", async () => {
    for (const url of [null, "not a url", "ftp://x.test/h", 5]) {
      const { app, hooks } = setup(withHook(url));
      const { id } = await buy(app);
      await ship(app, id);
      await new Promise((r) => setTimeout(r, 20));
      expect(hooks, String(url)).toEqual([]);
    }
  });
  it("retries with 1 s then 5 s waits, then gives up", async () => {
    const { app, hooks, state } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.hookStatus = 500;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { id } = await buy(app);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(hooks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4999);
    expect(hooks).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(" ")).toContain(id);
    expect(warn.mock.calls[0].join(" ")).toContain(HOOK);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hooks).toHaveLength(3);
    expect(new Set(hooks.map((x) => x.body.event_id)).size).toBe(1);
    warn.mockRestore();
  });
  it("stops retrying after a success", async () => {
    const { app, hooks, state } = setup();
    state.hookStatus = "throw";
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await buy(app);
    await vi.advanceTimersByTimeAsync(0);
    state.hookStatus = 200;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hooks).toHaveLength(2);
  });
  it("failure does not change the Complete or ship response", async () => {
    const { app, state } = setup();
    state.hookStatus = "throw";
    const { done, id } = await buy(app);
    expect(done.status).toBe("completed");
    expect((await ship(app, id)).status).toBe(200);
  });
});

describe("final fixes", () => {
  it("F1: a v1 data.db is rebuilt so a full purchase works", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ucp-")), "data.db");
    const old = new Database(dbPath);
    old.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, checkout_id TEXT, total INTEGER, currency TEXT, created_at TEXT)");
    old.close();
    const fetch = (async (url: string | URL | Request) => String(url) === AGENT_URL ? new Response(JSON.stringify(withHook())) : new Response("", { status: 200 })) as typeof globalThis.fetch;
    const { done, id } = await buy(createApp({ dbPath, baseUrl, fetch }));
    expect(done.status).toBe("completed");
    expect(id).toMatch(/^ord_/);
  });
  it("F3: no webhook when order was not negotiated, even if the platform entry has no version", async () => {
    const p = withHook(HOOK, CAPS) as any;
    p.ucp.capabilities[ORDER] = [{ config: { webhook_url: HOOK } }];
    const { app, hooks } = setup(p);
    const { done } = await buy(app);
    expect(done.status).toBe("completed");
    await new Promise((r) => setTimeout(r, 20));
    expect(hooks).toEqual([]);
  });
});

describe("GET /merchant-admin/orders", () => {
  const list = (app: any) => request(app).get("/merchant-admin/orders");
  it("is empty before any purchase", async () => {
    const res = await list(setup().app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orders: [] });
  });
  it("lists newest first, shows shipments, and each element equals GET /orders/:id", async () => {
    const { app } = setup();
    const ids = [(await buy(app)).id, (await buy(app)).id, (await buy(app)).id];
    await ship(app, ids[1]);
    const { orders } = (await list(app)).body;
    expect(orders.map((o: any) => o.id)).toEqual([...ids].reverse());
    const shipped = orders[1];
    expect(shipped.fulfillment.events[0].type).toBe("shipped");
    expect(shipped.line_items[0].status).toBe("fulfilled");
    for (const o of orders) expect(o).toEqual((await request(app).get(`/orders/${o.id}`)).body);
    expect(orders[0]).not.toHaveProperty("ucp");
    expect(orders[0]).not.toHaveProperty("webhook_url");
  });
  it("caps at 100, newest first, deterministic within one millisecond", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ucp-")), "data.db");
    const app = createApp({ dbPath, baseUrl });
    const db = new Database(dbPath);
    const ins = db.prepare("INSERT INTO orders VALUES (?,?,?,?,?)");
    for (let i = 0; i < 105; i++) ins.run(`ord_${i}`, `chk_${i}`, JSON.stringify({ id: `ord_${i}` }), null, "2026-01-01T00:00:00.000Z");
    db.close();
    const { orders } = (await list(app)).body;
    expect(orders).toHaveLength(100);
    expect(orders[0].id).toBe("ord_104");
    expect(orders[99].id).toBe("ord_5");
  });
  it("is unchanged by a catalog replace", async () => {
    const { app } = setup();
    await buy(app);
    const before = (await list(app)).body;
    expect(before.orders).toHaveLength(1);
    const rep = await request(app).post("/merchant-admin/catalog/import").set("X-UCP-Studio", "1").send({ replace: true, products: [{ title: "X", variants: [{ sku: "X", title: "V", price: 1, stock: 1 }] }] });
    expect(rep.status).toBe(200);
    expect((await list(app)).body).toEqual(before);
  });
});
