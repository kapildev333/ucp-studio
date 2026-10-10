import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AGENT, AGENT_URL, CAPS, fakeFetch, profileOf } from "./helpers.js";

// Cross-lane behaviour: v2's checkout/order/MCP services against v3's back-office catalog.
const baseUrl = "http://127.0.0.1:4000";
const mk = (dbPath = ":memory:") => createApp({ dbPath, baseUrl, fetch: fakeFetch(profileOf([...CAPS, "dev.ucp.shopping.order"])) });
const addr = { street_address: "1 Main St", address_locality: "Springfield", address_region: "CA", postal_code: "94000", address_country: "US" };
const full = {
  line_items: [{ item: { id: "var_4_1" }, quantity: 2 }], buyer: { email: "a@b.co" },
  fulfillment: { methods: [{ type: "shipping", destinations: [addr], groups: [{ selected_option_id: "standard" }] }] },
};
const pay = { payment: { instruments: [{ id: "i1", handler_id: "mock_pay", type: "card", credential: { token: "tok_ok" } }] } };
let n = 0;
const k = () => ({ ...AGENT, "Idempotency-Key": `int-${++n}` });
const create = async (app: any) => (await request(app).post("/ucp/checkout-sessions").set(k()).send(full)).body;
const get = async (app: any, id: string) => (await request(app).get(`/ucp/checkout-sessions/${id}`).set(AGENT)).body;
const imp = (app: any, body: object) => request(app).post("/merchant-admin/catalog/import").set("X-UCP-Studio", "1").send(body);
const mcp = async (app: any, name: string, args: object, key?: string) =>
  (await request(app).post("/ucp/mcp").send({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: { meta: { "ucp-agent": { profile: AGENT_URL }, ...(key && { "idempotency-key": key }) }, ...args } },
  })).body.result.structuredContent;
const other = { replace: true, products: [{ title: "Mug", variants: [{ sku: "MUG-1", title: "V", price: 100, stock: 3 }] }] };

describe("finished checkouts are frozen", () => {
  it("completed: a later price/title upsert changes nothing, replays included", async () => {
    const app = mk();
    const c = await create(app);
    const key = k();
    const done = await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(key).send(pay);
    expect(done.body.status).toBe("completed");
    const r = await imp(app, { products: [{ id: "prod_4", title: "Renamed Tee", variants: [{ id: "var_4_1", sku: "TEE-X", title: "Renamed", price: 5, stock: 0 }] }] });
    expect(r.status).toBe(200);
    expect(await get(app, c.id)).toEqual(done.body);
    expect((await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(key).send(pay)).body).toEqual(done.body);
    expect(await mcp(app, "get_checkout", { id: c.id })).toEqual(done.body);
  });
  it("completed: survives replace:true and reset with totals, line items and order", async () => {
    const app = mk();
    const c = await create(app);
    const done = (await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(k()).send(pay)).body;
    await imp(app, other);
    const after = await get(app, c.id);
    expect(after).toEqual(done);
    expect(after).toMatchObject({ status: "completed", totals: c.totals, line_items: c.line_items, order: { id: done.order.id } });
    expect((await request(app).put(`/ucp/checkout-sessions/${c.id}`).set(k()).send(full)).body.code).toBe("invalid_state");
    expect((await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(k()).send(pay)).body.code).toBe("invalid_state");
    expect((await request(app).post(`/ucp/checkout-sessions/${c.id}/cancel`).set(k())).body.code).toBe("invalid_state");
    await request(app).post("/merchant-admin/catalog/reset").set("X-UCP-Studio", "1");
    expect(await mcp(app, "get_checkout", { id: c.id })).toEqual(done);
  });
  it("canceled: survives upsert and replace:true on both transports; re-cancel replays the frozen body", async () => {
    const app = mk();
    const c = await create(app);
    const x = (await request(app).post(`/ucp/checkout-sessions/${c.id}/cancel`).set(k())).body;
    expect(x).toMatchObject({ status: "canceled", totals: c.totals, line_items: c.line_items });
    await imp(app, { products: [{ id: "prod_4", title: "T", variants: [{ id: "var_4_1", sku: "TEE-X", title: "Renamed", price: 5, stock: 0 }] }] });
    expect(await get(app, c.id)).toEqual(x);
    await imp(app, other);
    expect(await get(app, c.id)).toEqual(x);
    expect(await mcp(app, "get_checkout", { id: c.id })).toEqual(x);
    expect(await mcp(app, "cancel_checkout", { id: c.id }, "int-recancel")).toEqual(x);
    expect((await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(k()).send(pay)).body.code).toBe("invalid_state");
  });
  it("open: still re-derives, and answers item_not_found (200) once its variant is gone", async () => {
    const app = mk();
    const c = await create(app);
    await imp(app, { products: [{ id: "prod_4", title: "T", variants: [{ id: "var_4_1", sku: "TEE-X", title: "Renamed", price: 5, stock: 9 }] }] });
    expect((await get(app, c.id)).line_items[0].item).toEqual({ id: "var_4_1", title: "Renamed", price: 5 });
    await imp(app, other);
    const g = await request(app).get(`/ucp/checkout-sessions/${c.id}`).set(AGENT);
    expect(g.status).toBe(200);
    expect(g.body.ucp.status).toBe("error");
    expect(g.body.messages).toMatchObject([{ code: "item_not_found", path: "$.line_items[0].item.id" }]);
    expect(await mcp(app, "get_checkout", { id: c.id })).toEqual(g.body);
    const done = await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(k()).send(pay);
    expect(done.status).toBe(200);
    expect(done.body).toEqual(g.body);
    expect(await mcp(app, "complete_checkout", { id: c.id, checkout: pay }, "int-gone")).toEqual(g.body);
    expect((await request(app).put(`/ucp/checkout-sessions/${c.id}`).set(k()).send(full)).body).toEqual(g.body);
    const x = await request(app).post(`/ucp/checkout-sessions/${c.id}/cancel`).set(k());
    expect(x.status).toBe(200);
    expect(x.body).toEqual(g.body);
  });
  it("a v2 data.db is rebuilt for the snapshot column and keeps its catalog", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ucp-")), "data.db");
    mk(dbPath); // seeds the catalog
    const old = new Database(dbPath);
    old.exec("UPDATE variants SET price = 4242 WHERE id = 'var_4_1'; DROP TABLE checkouts; CREATE TABLE checkouts (id TEXT PRIMARY KEY, request TEXT NOT NULL, status TEXT NOT NULL, canceled INTEGER NOT NULL DEFAULT 0, order_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)");
    old.pragma("user_version = 2");
    old.close();
    const app = mk(dbPath);
    const c = await create(app);
    expect(c.line_items[0].item.price).toBe(4242);
    expect((await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(k()).send(pay)).body.status).toBe("completed");
  });
});

describe("variant order is insertion order", () => {
  it("back office and UCP return variants as imported; export -> replace-import -> export is identical", async () => {
    const app = mk();
    const ids = ["var_z", "var_a", "var_m"];
    await imp(app, { products: [{ id: "prod_o", title: "Ordered", variants: ids.map((id, i) => ({ id, sku: ["S9", "S1", "S5"][i], title: id, price: 100, stock: 1 })) }] });
    const exported = (await request(app).get("/merchant-admin/catalog")).body;
    expect(exported.products.at(-1).variants.map((v: any) => v.id)).toEqual(ids);
    const s = await request(app).post("/ucp/catalog/search").set(AGENT).send({ query: "ordered" });
    expect(s.body.products[0].variants.map((v: any) => v.id)).toEqual(ids);
    const p = await request(app).post("/ucp/catalog/product").set(AGENT).send({ id: "prod_o" });
    expect(p.body.product.variants.map((v: any) => v.id)).toEqual(ids);
    expect((await mcp(app, "get_product", { id: "prod_o" })).product.variants.map((v: any) => v.id)).toEqual(ids);
    expect((await imp(app, { ...exported, replace: true })).status).toBe(200);
    expect((await request(app).get("/merchant-admin/catalog")).body).toEqual(exported);
  });
});

describe("oversized JSON bodies", () => {
  const big = (n: number) => "x".repeat(n);
  it("REST mounts answer 413 payload_too_large", async () => {
    const app = mk();
    const ucp = await request(app).post("/ucp/catalog/search").set(AGENT).send({ query: big(150_000) });
    expect(ucp.status).toBe(413);
    expect(ucp.body).toEqual({ code: "payload_too_large", content: "Request body is too large" });
    expect(ucp.headers["request-id"]).toBeTruthy();
    const api = await request(app).post("/api/inspect").send({ url: big(150_000) });
    expect([api.status, api.body.code]).toEqual([413, "payload_too_large"]);
    const admin = await imp(app, { products: [{ title: "Mug", description: big(11 * 1024 * 1024), variants: [{ sku: "A", title: "V", price: 1, stock: 1 }] }] });
    expect([admin.status, admin.body.code]).toEqual([413, "payload_too_large"]);
  });
  it("MCP answers a JSON-RPC -32600 error with HTTP 200", async () => {
    const res = await request(mk()).post("/ucp/mcp").send({ jsonrpc: "2.0", id: 7, method: "ping", params: { pad: big(150_000) } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      jsonrpc: "2.0", id: null,
      error: { code: -32600, message: "Request body is too large", data: { code: "payload_too_large", content: "Request body is too large" } },
    });
  });
});

describe("ship is behind the back-office cross-site guard", () => {
  it("rejects cross-site without shipping; allows same-origin", async () => {
    const app = mk();
    const order = async () => {
      const c = await create(app);
      return (await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(k()).send(pay)).body.order.id as string;
    };
    const ship = (id: string) => request(app).post(`/merchant-admin/orders/${id}/ship`).set("X-UCP-Studio", "1");
    const [a, b] = [await order(), await order()];
    const bad = await ship(a).set("Sec-Fetch-Site", "cross-site");
    expect([bad.status, bad.body.code]).toEqual([403, "forbidden"]);
    expect((await request(app).get(`/orders/${a}`)).body.fulfillment.events).toEqual([]);
    expect((await ship(a).set("Sec-Fetch-Site", "same-origin")).status).toBe(200);
    expect((await ship(b)).status).toBe(200);
    expect((await ship(b)).status).toBe(409); // exactly one ship route: the second call sees the first one's write
  });
});

describe("/merchant-admin Host check", () => {
  it("rejects a non-local Host on every admin route and changes nothing", async () => {
    const app = mk();
    const c = await create(app);
    const id = (await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(k()).send(pay)).body.order.id as string;
    const host = "evil.example:4000";
    const before = (await request(app).get("/merchant-admin/catalog")).body;
    const res = [
      await request(app).get("/merchant-admin/orders").set("Host", host),
      await request(app).get("/merchant-admin/catalog").set("Host", host),
      await request(app).post("/merchant-admin/catalog/reset").set("X-UCP-Studio", "1").set("Host", host),
      await request(app).post("/merchant-admin/catalog/import").set("X-UCP-Studio", "1").set("Host", host).send(other),
      await request(app).post(`/merchant-admin/orders/${id}/ship`).set("X-UCP-Studio", "1").set("Host", host),
    ];
    expect(res.map((r) => [r.status, r.body.code])).toEqual(res.map(() => [403, "forbidden_host"]));
    expect((await request(app).get("/merchant-admin/catalog")).body).toEqual(before);
    expect((await request(app).get(`/orders/${id}`)).body.fulfillment.events).toEqual([]);
  });
});

describe("body-parser client errors", () => {
  const bogus = { "Content-Type": "application/json; charset=bogus" };
  it("REST: 400 invalid_request, no 500", async () => {
    const res = await request(mk()).post("/ucp/catalog/search").set(AGENT).set(bogus).send("{}");
    expect([res.status, res.body.code]).toEqual([400, "invalid_request"]);
  });
  it("MCP: HTTP 200 JSON-RPC -32600; unparseable JSON stays -32700", async () => {
    const app = mk();
    const res = await request(app).post("/ucp/mcp").set(bogus).send("{}");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    const bad = await request(app).post("/ucp/mcp").set("Content-Type", "application/json").send("{nope");
    expect(bad.body.error.code).toBe(-32700);
  });
});

describe("products without variants", () => {
  it("are omitted from the UCP catalog but stay in the back-office catalog", async () => {
    const app = mk();
    // var_8_1 is the only variant of prod_8; re-parent it onto prod_7.
    expect((await imp(app, { products: [{ id: "prod_7", title: "Leather Belt", variants: [{ id: "var_8_1", sku: "WS", title: "V", price: 1200, stock: 1 }] }] })).status).toBe(200);
    expect((await request(app).get("/merchant-admin/catalog")).body.products.find((p: any) => p.id === "prod_8").variants).toEqual([]);
    const s = await request(app).post("/ucp/catalog/search").set(AGENT).send({ pagination: { limit: 50 } });
    expect(s.body.products.map((p: any) => p.id)).not.toContain("prod_8");
    expect(JSON.stringify(s.body)).not.toContain("null");
    expect((await request(app).post("/ucp/catalog/product").set(AGENT).send({ id: "prod_8" })).status).toBe(404);
    expect((await request(app).post("/ucp/catalog/lookup").set(AGENT).send({ ids: ["prod_8"] })).body.products).toEqual([]);
  });
});

describe("order created_at", () => {
  const rfc = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
  it("is on every surface, stable across ship, and the list element equals GET /orders/:id", async () => {
    const app = mk();
    const c = await create(app);
    const id = (await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(k()).send(pay)).body.order.id as string;
    const ucp = (await request(app).get(`/ucp/orders/${id}`).set(AGENT)).body.created_at;
    const plain = (await request(app).get(`/orders/${id}`)).body.created_at;
    const listed = (await request(app).get("/merchant-admin/orders")).body.orders[0];
    expect(ucp).toMatch(rfc);
    expect([plain, listed.created_at]).toEqual([ucp, ucp]);
    const shipped = await request(app).post(`/merchant-admin/orders/${id}/ship`).set("X-UCP-Studio", "1");
    expect(shipped.body.created_at).toBe(ucp);
    expect((await request(app).get(`/ucp/orders/${id}`).set(AGENT)).body.created_at).toBe(ucp);
    expect((await request(app).get("/merchant-admin/orders")).body.orders[0]).toEqual((await request(app).get(`/orders/${id}`)).body);
  });
});
