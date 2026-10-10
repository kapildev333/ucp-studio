import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

const baseUrl = "http://127.0.0.1:4000";
const AGENT = { "UCP-Agent": 'profile="http://127.0.0.1:4000/api/agent-profile"' };
const app = createApp({ dbPath: ":memory:", baseUrl });
const search = (body: object = {}) => request(app).post("/ucp/catalog/search").set(AGENT).send(body);

describe("discovery", () => {
  it("serves the profile", async () => {
    const res = await request(app).get("/.well-known/ucp");
    expect(res.status).toBe(200);
    expect(res.body.ucp.version).toBe("2026-08-25");
    expect(res.body.ucp.services["dev.ucp.shopping"][0]).toEqual({ version: "2026-08-25", transport: "rest", endpoint: `${baseUrl}/ucp` });
    expect(Object.keys(res.body.ucp.capabilities)).toEqual([
      "dev.ucp.shopping.checkout", "dev.ucp.shopping.catalog.search", "dev.ucp.shopping.catalog.lookup", "dev.ucp.shopping.fulfillment",
    ]);
    expect(res.body.ucp.capabilities["dev.ucp.shopping.fulfillment"][0].extends).toBe("dev.ucp.shopping.checkout");
    expect(res.body.ucp.payment_handlers["dev.ucpstudio.mock_pay"][0].id).toBe("mock_pay");
    expect(res.body.keys).toEqual([]);
  });
});

describe("common rules", () => {
  it("rejects missing UCP-Agent", async () => {
    const res = await request(app).post("/ucp/catalog/search").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_profile_url");
  });
  it("rejects malformed UCP-Agent", async () => {
    for (const v of ["nonsense", 'profile="not a url"', 'profile="ftp://x.com/p"', "profile=1"]) {
      const res = await request(app).post("/ucp/catalog/search").set("UCP-Agent", v).send({});
      expect(res.status, v).toBe(400);
      expect(res.body.code).toBe("invalid_profile_url");
    }
  });
  it("echoes and generates Request-Id", async () => {
    const a = await search().set("Request-Id", "abc-1");
    expect(a.headers["request-id"]).toBe("abc-1");
    const b = await search();
    expect(b.headers["request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("carries the ucp envelope", async () => {
    const res = await search();
    expect(res.body.ucp).toEqual({
      version: "2026-08-25",
      capabilities: [
        { name: "dev.ucp.shopping.catalog.search", version: "2026-08-25" },
        { name: "dev.ucp.shopping.catalog.lookup", version: "2026-08-25" },
      ],
    });
  });
  it("returns invalid_request on zod failure", async () => {
    const res = await search({ pagination: { limit: 999 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");
  });
});

describe("catalog search", () => {
  it("seeds 8 products with shape and a zero-stock variant", async () => {
    const res = await search();
    expect(res.body.products).toHaveLength(8);
    expect(res.body.pagination).toEqual({ has_next_page: false, total_count: 8 });
    const p = res.body.products[0];
    expect(p).toMatchObject({ description: { plain: expect.any(String) }, categories: expect.any(Array) });
    expect(p.price_range.min.currency).toBe("USD");
    expect(Number.isInteger(p.price_range.min.amount)).toBe(true);
    const variants = res.body.products.flatMap((x: any) => x.variants);
    expect(variants.some((v: any) => v.availability.available === false)).toBe(true);
    expect(variants[0]).toMatchObject({ id: expect.any(String), sku: expect.any(String), options: [{ name: expect.any(String), label: expect.any(String) }] });
  });
  it("filters by query case-insensitively", async () => {
    const res = await search({ query: "SNEAKER" });
    expect(res.body.products.length).toBeGreaterThan(0);
    for (const p of res.body.products) expect(`${p.title} ${p.description.plain}`.toLowerCase()).toContain("sneaker");
  });
  it("filters by category", async () => {
    const res = await search({ filters: { categories: ["Accessories"] } });
    expect(res.body.products.length).toBeGreaterThan(0);
    for (const p of res.body.products) expect(p.categories).toContain("Accessories");
  });
  it("filters by price against price_range.min", async () => {
    const res = await search({ filters: { price: { min: 2000, max: 5000 } } });
    expect(res.body.products.length).toBeGreaterThan(0);
    for (const p of res.body.products) expect(p.price_range.min.amount).toBeGreaterThanOrEqual(2000), expect(p.price_range.min.amount).toBeLessThanOrEqual(5000);
  });
  it("ANDs filters", async () => {
    const res = await search({ query: "sneaker", filters: { categories: ["Accessories"] } });
    expect(res.body.products).toEqual([]);
  });
  it("paginates with a cursor round-trip", async () => {
    const first = await search({ pagination: { limit: 3 } });
    expect(first.body.products).toHaveLength(3);
    expect(first.body.pagination).toMatchObject({ has_next_page: true, total_count: 8 });
    expect(Buffer.from(first.body.pagination.cursor, "base64").toString()).toBe("3");
    const second = await search({ pagination: { limit: 3, cursor: first.body.pagination.cursor } });
    const third = await search({ pagination: { limit: 3, cursor: second.body.pagination.cursor } });
    expect(third.body.products).toHaveLength(2);
    expect(third.body.pagination.has_next_page).toBe(false);
    expect(third.body.pagination.cursor).toBeUndefined();
    const ids = [...first.body.products, ...second.body.products, ...third.body.products].map((p: any) => p.id);
    expect(new Set(ids).size).toBe(8);
  });
});

describe("catalog lookup and product", () => {
  const lookup = (ids: string[]) => request(app).post("/ucp/catalog/lookup").set(AGENT).send({ ids });
  it("resolves product and variant ids, reports unknown", async () => {
    const all = (await search()).body.products;
    const prod = all[0], other = all[1];
    const res = await lookup([prod.id, other.variants[0].id, "nope"]);
    expect(res.status).toBe(200);
    expect(res.body.products.map((p: any) => p.id)).toEqual([prod.id, other.id]);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]).toMatchObject({ type: "info", code: "not_found" });
    expect(res.body.messages[0].content).toContain("nope");
  });
  it("omits messages when all found", async () => {
    const p = (await search()).body.products[0];
    const res = await lookup([p.id]);
    expect(res.body.messages).toBeUndefined();
  });
  it("lookup with only unknown ids", async () => {
    const res = await lookup(["zzz"]);
    expect(res.body.products).toEqual([]);
    expect(res.body.messages[0].code).toBe("not_found");
  });
  it("lookup rejects empty ids", async () => {
    expect((await lookup([])).body.code).toBe("invalid_request");
  });
  it("product found / 404", async () => {
    const p = (await search()).body.products[0];
    const ok = await request(app).post("/ucp/catalog/product").set(AGENT).send({ id: p.id });
    expect(ok.status).toBe(200);
    expect(ok.body.product.id).toBe(p.id);
    expect(ok.body.ucp.version).toBe("2026-08-25");
    const miss = await request(app).post("/ucp/catalog/product").set(AGENT).send({ id: "nope" });
    expect(miss.status).toBe(404);
    expect(miss.body.code).toBe("not_found");
    expect((await request(app).post("/ucp/catalog/product").set(AGENT).send({})).body.code).toBe("invalid_request");
  });
});
