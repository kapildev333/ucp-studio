import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

import { AGENT, fakeFetch } from "./helpers.js";

const mk = () => createApp({ dbPath: ":memory:", baseUrl: "http://127.0.0.1:4000", fetch: fakeFetch() });
const catalog = async (app: any) => (await request(app).get("/merchant-admin/catalog")).body;
const imp = (app: any, body: any) => request(app).post("/merchant-admin/catalog/import").send(body);
const v = (sku: string, extra: object = {}) => ({ sku, title: "V", price: 100, stock: 3, ...extra });
const prod = (title = "Mug", variants: any[] = [v("MUG-1")], extra: object = {}) => ({ title, variants, ...extra });

describe("catalog GET", () => {
  it("has the documented shape", async () => {
    const { products } = await catalog(mk());
    expect(products).toHaveLength(8);
    expect(products[0]).toMatchObject({ id: "prod_1", title: "Trail Sneaker", description: "Grippy everyday sneaker for rough ground.", categories: ["Footwear"] });
    expect(products[0].variants[0]).toEqual({ id: "var_1_1", sku: "TRAIL-SNEAKER-1", title: "Trail Sneaker - Size 9", price: 8900, stock: 12, options: [{ name: "Size", label: "9" }] });
  });
  it("round-trips through import unchanged", async () => {
    const app = mk();
    await imp(app, { products: [prod("Mug", [v("A"), v("B", { options: [{ name: "Color", label: "Red" }] })], { description: "d", categories: ["Home"] })] });
    const before = await catalog(app);
    expect((await imp(app, before)).status).toBe(200);
    expect(await catalog(app)).toEqual(before);
    expect((await imp(app, { ...before, replace: true })).status).toBe(200);
    expect(await catalog(app)).toEqual(before);
  });
});

describe("catalog import", () => {
  it("creates with generated ids and defaults", async () => {
    const app = mk();
    const res = await imp(app, { products: [prod("Mug", [v("A"), v("B")])] });
    expect(res.body).toEqual({ imported: { products: 1, variants: 2 } });
    const p = (await catalog(app)).products.at(-1);
    expect(p.id).toMatch(/^prod_/);
    expect(p).toMatchObject({ title: "Mug", description: "", categories: [] });
    expect(p.variants.map((x: any) => x.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^var_/)]));
    expect(p.variants[0].options).toEqual([]);
  });
  it("upserts by product id and variant id, keeping unlisted variants", async () => {
    const app = mk();
    const res = await imp(app, { products: [{ id: "prod_3", title: "Rain Boot 2", variants: [v("NEW"), v("RB", { id: "var_3_1", price: 1 })] }] });
    expect(res.body.imported).toEqual({ products: 1, variants: 2 });
    const { products } = await catalog(app);
    expect(products).toHaveLength(8);
    const p = products.find((x: any) => x.id === "prod_3");
    expect(p.title).toBe("Rain Boot 2");
    expect(p.variants).toHaveLength(2);
    expect(p.variants.find((x: any) => x.id === "var_3_1")).toMatchObject({ price: 1, sku: "RB" });
    // variant id owned by another product moves to the requested product
    await imp(app, { products: [{ id: "prod_1", title: "T", variants: [v("MOVED", { id: "var_3_1" })] }] });
    const after = (await catalog(app)).products;
    expect(after.find((x: any) => x.id === "prod_1").variants.map((x: any) => x.id)).toContain("var_3_1");
    expect(after.find((x: any) => x.id === "prod_3").variants.map((x: any) => x.id)).not.toContain("var_3_1");
  });
  it("replace deletes everything else", async () => {
    const app = mk();
    await imp(app, { replace: true, products: [prod()] });
    const { products } = await catalog(app);
    expect(products.map((p: any) => p.title)).toEqual(["Mug"]);
  });

  const bad: [string, any, string][] = [
    ["0 products", { products: [] }, "products"],
    ["501 products", { products: Array.from({ length: 501 }, (_, i) => prod("P", [v(`S${i}`)])) }, "products"],
    ["empty title", { products: [prod("")] }, "products.0.title"],
    ["long title", { products: [prod("x".repeat(201))] }, "products.0.title"],
    ["0 variants", { products: [prod("Mug", [])] }, "products.0.variants"],
    ["51 variants", { products: [prod("Mug", Array.from({ length: 51 }, (_, i) => v(`S${i}`)))] }, "products.0.variants"],
    ["negative price", { products: [prod("Mug", [v("A", { price: -1 })])] }, "products.0.variants.0.price"],
    ["fractional price", { products: [prod("Mug", [v("A", { price: 1.5 })])] }, "products.0.variants.0.price"],
    ["negative stock", { products: [prod("Mug", [v("A", { stock: -1 })])] }, "products.0.variants.0.stock"],
    ["fractional stock", { products: [prod("Mug", [v("A", { stock: 0.5 })])] }, "products.0.variants.0.stock"],
    ["duplicate sku", { products: [prod("A", [v("X")]), prod("B", [v("Y"), v("X")])] }, "products.1.variants.1.sku"],
  ];
  it.each(bad)("rejects %s", async (_n, body, path) => {
    const res = await imp(mk(), body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");
    expect(res.body.content).toContain(path);
  });

  it("accepts a 500-product import larger than 100kb", async () => {
    const products = Array.from({ length: 500 }, (_, i) => prod(`P${i}`, [v(`S${i}`)], { description: "d".repeat(500) }));
    const res = await imp(mk(), { products });
    expect(res.status).toBe(200);
    expect(res.body.imported).toEqual({ products: 500, variants: 500 });
  });

  it("is atomic: a bad late row writes nothing", async () => {
    const app = mk();
    const before = await catalog(app);
    const res = await imp(app, { replace: true, products: [prod("Good"), prod("Bad", [v("Z", { price: -5 })])] });
    expect(res.status).toBe(400);
    expect(res.body.content).toContain("products.1.variants.0.price");
    expect(await catalog(app)).toEqual(before);
  });
});

describe("catalog reset", () => {
  it("restores the seed and keeps orders and checkouts", async () => {
    const app = mk();
    const seed = await catalog(app);
    const ship = { street_address: "1 Main St", address_locality: "X", address_region: "CA", postal_code: "94000", address_country: "US" };
    const body = {
      line_items: [{ item: { id: "var_4_1" }, quantity: 1 }], buyer: { first_name: "A", last_name: "B", email: "a@b.co", phone_number: "555" },
      fulfillment: { methods: [{ type: "shipping", destinations: [ship], groups: [{ selected_option_id: "standard" }] }] },
    };
    const c = (await request(app).post("/ucp/checkout-sessions").set(AGENT).set("Idempotency-Key", "r1").send(body)).body;
    await request(app).put(`/ucp/checkout-sessions/${c.id}`).set(AGENT).set("Idempotency-Key", "r2").send(body);
    const done = await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(AGENT).set("Idempotency-Key", "r3")
      .send({ payment: { instruments: [{ id: "i", handler_id: "mock_pay", type: "token", credential: { token: "tok_success" } }] } });
    const orderId = done.body.order.id;
    await imp(app, { replace: true, products: [prod()] });
    const res = await request(app).post("/merchant-admin/catalog/reset");
    expect(res.body).toEqual({ imported: { products: 8, variants: 15 } });
    expect(await catalog(app)).toEqual(seed);
    expect((await request(app).get(`/orders/${orderId}`)).status).toBe(200);
    expect((await request(app).get(`/ucp/checkout-sessions/${c.id}`).set(AGENT)).status).toBe(200);
  });
});

describe("catalog hardening", () => {
  it("rejects cross-site writes, allows same-site", async () => {
    const app = mk();
    await imp(app, { replace: true, products: [prod()] });
    const before = await catalog(app);
    const bad = await request(app).post("/merchant-admin/catalog/reset").set("Sec-Fetch-Site", "cross-site");
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe("forbidden");
    expect(await catalog(app)).toEqual(before);
    expect((await request(app).post("/merchant-admin/catalog/reset").set("Sec-Fetch-Site", "same-site")).status).toBe(200);
  });
  it("rejects duplicate product ids and duplicate variant ids", async () => {
    const app = mk();
    const before = await catalog(app);
    const dp = await imp(app, { products: [prod("A", [v("S1")], { id: "dup" }), prod("B", [v("S2")], { id: "dup" })] });
    expect(dp.status).toBe(400);
    expect(dp.body.code).toBe("invalid_request");
    expect(dp.body.content).toContain("products.1.id");
    const dv = await imp(app, { products: [prod("A", [v("S1", { id: "vd" })]), prod("B", [v("S2", { id: "vd" })])] });
    expect(dv.status).toBe(400);
    expect(dv.body.content).toContain("products.1.variants.0.id");
    expect(await catalog(app)).toEqual(before);
  });
});

describe("imported products in UCP", () => {
  const buy = { line_items: [{ item: { id: "var_mug" }, quantity: 2 }] };
  const ship = { street_address: "1 Main St", address_locality: "X", address_region: "CA", postal_code: "94000", address_country: "US" };
  const full = {
    ...buy, buyer: { first_name: "A", last_name: "B", email: "a@b.co", phone_number: "555" },
    fulfillment: { methods: [{ type: "shipping", destinations: [ship], groups: [{ selected_option_id: "standard" }] }] },
  };
  const setup = async () => {
    const app = mk();
    await imp(app, { products: [{ id: "prod_mug", title: "Zebra Mug", variants: [v("MUG", { id: "var_mug", price: 1000 })] }] });
    return app;
  };
  it("is searchable and buyable end to end", async () => {
    const app = await setup();
    const s = await request(app).post("/ucp/catalog/search").set(AGENT).send({ query: "zebra" });
    expect(s.body.products.map((p: any) => p.id)).toEqual(["prod_mug"]);
    const c = (await request(app).post("/ucp/checkout-sessions").set(AGENT).set("Idempotency-Key", "a").send(buy)).body;
    const u = await request(app).put(`/ucp/checkout-sessions/${c.id}`).set(AGENT).set("Idempotency-Key", "b").send(full);
    expect(u.body.status).toBe("ready_for_complete");
    const done = await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(AGENT).set("Idempotency-Key", "c")
      .send({ payment: { instruments: [{ id: "i", handler_id: "mock_pay", type: "token", credential: { token: "tok_success" } }] } });
    expect(done.body.status).toBe("completed");
    expect((await catalog(app)).products.find((p: any) => p.id === "prod_mug").variants[0].stock).toBe(1);
  });
  it("answers item_not_found for a checkout whose variant was deleted", async () => {
    const app = await setup();
    const c = (await request(app).post("/ucp/checkout-sessions").set(AGENT).set("Idempotency-Key", "a").send(buy)).body;
    await request(app).put(`/ucp/checkout-sessions/${c.id}`).set(AGENT).set("Idempotency-Key", "b").send(full);
    await imp(app, { replace: true, products: [prod()] });
    const g = await request(app).get(`/ucp/checkout-sessions/${c.id}`).set(AGENT);
    expect(g.status).toBe(200);
    expect(g.body.messages[0]).toMatchObject({ code: "item_not_found", path: "$.line_items[0].item.id" });
    const done = await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set(AGENT).set("Idempotency-Key", "c")
      .send({ payment: { instruments: [{ id: "i", handler_id: "mock_pay", type: "token", credential: { token: "tok_success" } }] } });
    expect(done.status).toBeLessThan(500);
    expect(done.body.messages[0].code).toBe("item_not_found");
    const x = await request(app).post(`/ucp/checkout-sessions/${c.id}/cancel`).set(AGENT).set("Idempotency-Key", "d").send({});
    expect(x.status).toBeLessThan(500);
  });
});
