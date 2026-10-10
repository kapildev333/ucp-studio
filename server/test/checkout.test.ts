import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

const baseUrl = "http://127.0.0.1:4000";
const AGENT = { "UCP-Agent": 'profile="http://127.0.0.1:4000/api/agent-profile"' };
const app = createApp({ dbPath: ":memory:", baseUrl });
const BASE = "/ucp/checkout-sessions";
let n = 0;
const key = () => `k-${++n}`;
const post = (path: string, body: object = {}, k: string | null = key()) => {
  const r = request(app).post(path).set(AGENT);
  return (k ? r.set("Idempotency-Key", k) : r).send(body);
};
const put = (id: string, body: object, k: string | null = key()) => {
  const r = request(app).put(`${BASE}/${id}`).set(AGENT);
  return (k ? r.set("Idempotency-Key", k) : r).send(body);
};
const get = (id: string) => request(app).get(`${BASE}/${id}`).set(AGENT);
const stockOf = async (variantId: string) => {
  const res = await request(app).post("/ucp/catalog/search").set(AGENT).send({});
  const v = res.body.products.flatMap((p: any) => p.variants).find((x: any) => x.id === variantId);
  return v.availability.available;
};

const addr = { street_address: "1 Main St", address_locality: "Springfield", address_region: "CA", postal_code: "94000", address_country: "US" };
const ready = (item = "var_4_1", quantity = 2, option = "standard") => ({
  line_items: [{ item: { id: item }, quantity }],
  buyer: { first_name: "A", last_name: "B", email: "a@b.co", phone_number: "555" },
  fulfillment: { methods: [{ type: "shipping", destinations: [addr], groups: [{ selected_option_id: option }] }] },
});
const pay = (token = "tok_success", handler_id = "mock_pay") => ({
  payment: { instruments: [{ id: "i1", handler_id, type: "token", credential: { token } }] },
});
const create = async (body: object = ready()) => (await post(BASE, body)).body;

afterEach(() => vi.useRealTimers());

describe("ucp plumbing fixes", () => {
  it("malformed JSON on /ucp gets Request-Id and invalid_request", async () => {
    const res = await request(app).post("/ucp/catalog/search").set(AGENT).set("Request-Id", "r-1").set("Content-Type", "application/json").send("{nope");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");
    expect(res.headers["request-id"]).toBe("r-1");
  });
  it("malformed JSON without UCP-Agent reports the header first", async () => {
    const res = await request(app).post("/ucp/catalog/search").set("Content-Type", "application/json").send("{nope");
    expect(res.body.code).toBe("invalid_profile_url");
    expect(res.headers["request-id"]).toBeTruthy();
  });
  it("unmatched /ucp path is a JSON 404", async () => {
    const res = await request(app).get("/ucp/nothing/here").set(AGENT);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "not_found", content: expect.any(String) });
    expect(res.headers["request-id"]).toBeTruthy();
  });
});

describe("checkout happy path", () => {
  it("create -> update -> complete -> get", async () => {
    const created = await post(BASE, { line_items: [{ item: { id: "var_4_1" }, quantity: 2 }] });
    expect(created.status).toBe(201);
    const c = created.body;
    expect(c.id).toMatch(/^chk_/);
    expect(c.status).toBe("incomplete");
    expect(c.ucp.capabilities.map((x: any) => x.name)).toEqual(["dev.ucp.shopping.checkout", "dev.ucp.shopping.fulfillment"]);
    expect(c.currency).toBe("USD");
    expect(c.messages.map((m: any) => m.path)).toEqual(["$.buyer.email", "$.fulfillment.methods[0].destinations"]);
    expect(c.buyer).toBeUndefined();
    expect(c.fulfillment).toBeUndefined();
    expect(c.order).toBeUndefined();
    expect(c.links).toEqual([{ type: "terms_of_service", url: `${baseUrl}/terms` }, { type: "privacy_policy", url: `${baseUrl}/privacy` }]);
    expect(c.payment).toEqual({ instruments: [] });
    expect(c.payment_handlers["dev.ucpstudio.mock_pay"][0].id).toBe("mock_pay");
    expect(Date.parse(c.expires_at) - Date.now()).toBeGreaterThan(5.9 * 3600e3);
    expect(c.totals).toEqual([{ type: "subtotal", amount: 3998 }, { type: "tax", amount: 320 }, { type: "total", amount: 4318 }]);

    const updated = await put(c.id, ready());
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe("ready_for_complete");
    expect(updated.body.totals.map((t: any) => t.amount)).toEqual([3998, 500, 320, 4818]);
    expect(updated.body.fulfillment.methods[0].groups[0]).toMatchObject({ selected_option_id: "standard", line_item_ids: ["li_1"] });

    const done = await post(`${BASE}/${c.id}/complete`, pay());
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("completed");
    expect(done.body.order.id).toMatch(/^ord_/);
    expect(done.body.order.permalink_url).toBe(`${baseUrl}/orders/${done.body.order.id}`);

    const again = await get(c.id);
    expect(again.body.status).toBe("completed");
    expect(again.body.order).toEqual(done.body.order);
    expect(again.body.messages).toEqual([]);

    const order = await request(app).get(`/orders/${done.body.order.id}`);
    expect(order.status).toBe(200);
    expect(order.body).toMatchObject({ id: done.body.order.id, checkout_id: c.id, total: 4818, currency: "USD" });
    expect(order.body.created_at).toBeTruthy();
  });
  it("update is full replacement", async () => {
    const c = await create();
    const u = await put(c.id, { line_items: [{ item: { id: "var_4_1" }, quantity: 1 }] });
    expect(u.body.status).toBe("incomplete");
    expect(u.body.buyer).toBeUndefined();
    expect(u.body.fulfillment).toBeUndefined();
    expect(u.body.line_items[0].quantity).toBe(1);
  });
  it("selecting an unknown option leaves none selected", async () => {
    const c = await create(ready("var_4_1", 1, "teleport"));
    expect(c.status).toBe("incomplete");
    expect(c.messages.map((m: any) => m.path)).toEqual(["$.fulfillment.methods[0].groups[0].selected_option_id"]);
  });
  it("decrements stock after completion", async () => {
    const c = await create(ready("var_1_3", 5)); // stock 5
    expect(await stockOf("var_1_3")).toBe(true);
    await post(`${BASE}/${c.id}/complete`, pay());
    expect(await stockOf("var_1_3")).toBe(false);
  });
});

describe("business outcomes", () => {
  it("flags out_of_stock", async () => {
    const c = await create(ready("var_1_2", 1)); // stock 0
    expect(c.status).toBe("incomplete");
    expect(c.messages[0]).toMatchObject({ type: "error", code: "out_of_stock", path: "$.line_items[0].quantity", severity: "recoverable" });
  });
  it("unknown item on create creates nothing", async () => {
    const res = await post(BASE, { line_items: [{ item: { id: "var_4_1" }, quantity: 1 }, { item: { id: "nope" }, quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.ucp.status).toBe("error");
    expect(res.body.ucp.version).toBe("2026-08-25");
    expect(res.body.messages[0]).toMatchObject({ type: "error", code: "item_not_found", path: "$.line_items[1].item.id", severity: "unrecoverable" });
    expect(res.body.id).toBeUndefined();
  });
  it("unknown item on update leaves the checkout unchanged", async () => {
    const c = await create();
    const res = await put(c.id, { line_items: [{ item: { id: "nope" }, quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.messages[0].code).toBe("item_not_found");
    const after = await get(c.id);
    expect(after.body.status).toBe("ready_for_complete");
    expect(after.body.line_items[0].item.id).toBe("var_4_1");
  });
  it("tok_decline keeps ready_for_complete with payment_declined", async () => {
    const c = await create();
    const res = await post(`${BASE}/${c.id}/complete`, pay("tok_decline"));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready_for_complete");
    expect(res.body.messages).toEqual([expect.objectContaining({ type: "error", code: "payment_declined", severity: "recoverable" })]);
    expect(res.body.order).toBeUndefined();
    expect((await get(c.id)).body.messages).toEqual([]);
    expect((await post(`${BASE}/${c.id}/complete`, pay())).body.status).toBe("completed");
  });
  it("sums duplicate lines of one variant against stock", async () => {
    const body = ready("var_5_2", 4); // stock 7
    body.line_items.push({ item: { id: "var_5_2" }, quantity: 4 });
    const c = await create(body);
    expect(c.status).toBe("incomplete");
    expect(c.messages.filter((m: any) => m.code === "out_of_stock").map((m: any) => m.path)).toEqual(["$.line_items[0].quantity", "$.line_items[1].quantity"]);
    const ok = ready("var_5_2", 3);
    ok.line_items.push({ item: { id: "var_5_2" }, quantity: 3 });
    const a = await create(ok);
    const b = await create(ok); // each fits alone (6 <= 7), together oversell
    await post(`${BASE}/${a.id}/complete`, pay());
    const res = await post(`${BASE}/${b.id}/complete`, pay());
    expect(res.body.status).toBe("incomplete");
    expect(res.body.messages.filter((m: any) => m.code === "out_of_stock")).toHaveLength(2);
  });
  it("re-checks stock at complete", async () => {
    const a = await create(ready("var_2_2", 8)); // stock 8
    const b = await create(ready("var_2_2", 8));
    expect(b.status).toBe("ready_for_complete");
    expect((await post(`${BASE}/${a.id}/complete`, pay())).body.status).toBe("completed");
    const res = await post(`${BASE}/${b.id}/complete`, pay());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("incomplete");
    expect(res.body.messages[0].code).toBe("out_of_stock");
    expect(res.body.order).toBeUndefined();
  });
});

describe("protocol errors and state", () => {
  it("validates bodies", async () => {
    for (const body of [{}, { line_items: [] }, { line_items: [{ item: { id: "var_4_1" }, quantity: 0 }] }]) {
      const res = await post(BASE, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_request");
    }
  });
  it("rejects destinations missing street, locality or postal code", async () => {
    for (const k of ["street_address", "address_locality", "postal_code"]) {
      const body = ready();
      body.fulfillment.methods[0].destinations[0] = { ...addr, [k]: "" };
      expect((await post(BASE, body)).body.code, k).toBe("invalid_request");
    }
    const body = ready();
    body.fulfillment.methods[0].destinations[0] = {} as any;
    expect((await post(BASE, body)).status).toBe(400);
    body.fulfillment.methods[0].destinations[0] = { ...addr, address_region: "" };
    expect((await post(BASE, body)).status).toBe(201);
  });
  it("404s on unknown ids for every op", async () => {
    expect((await get("chk_x")).status).toBe(404);
    expect((await put("chk_x", ready())).body.code).toBe("not_found");
    expect((await post(`${BASE}/chk_x/complete`, pay())).status).toBe(404);
    const res = await post(`${BASE}/chk_x/cancel`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
    expect((await request(app).get("/orders/ord_x")).status).toBe(404);
  });
  it("complete rejects non-ready checkouts and bad handlers", async () => {
    const incomplete = await create({ line_items: [{ item: { id: "var_4_1" }, quantity: 1 }] });
    const res = await post(`${BASE}/${incomplete.id}/complete`, pay());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("invalid_state");
    const c = await create();
    const bad = await post(`${BASE}/${c.id}/complete`, pay("tok_success", "other_pay"));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_request");
    expect((await post(`${BASE}/${c.id}/complete`, {})).body.code).toBe("invalid_request");
  });
  it("update and complete on completed/canceled checkouts are 409", async () => {
    const done = await create();
    await post(`${BASE}/${done.id}/complete`, pay());
    expect((await put(done.id, ready())).body.code).toBe("invalid_state");
    expect((await post(`${BASE}/${done.id}/complete`, pay())).status).toBe(409);
    expect((await post(`${BASE}/${done.id}/cancel`)).body.code).toBe("invalid_state");
    const canceled = await create();
    await post(`${BASE}/${canceled.id}/cancel`);
    expect((await put(canceled.id, ready())).status).toBe(409);
    expect((await post(`${BASE}/${canceled.id}/complete`, pay())).status).toBe(409);
  });
  it("cancel works and is idempotent on already-canceled", async () => {
    const c = await create();
    const a = await post(`${BASE}/${c.id}/cancel`);
    expect(a.status).toBe(200);
    expect(a.body.status).toBe("canceled");
    const b = await post(`${BASE}/${c.id}/cancel`); // new key, already canceled
    expect(b.status).toBe(200);
    expect(b.body.status).toBe("canceled");
    expect((await get(c.id)).body.status).toBe("canceled");
  });
  it("expired checkouts read as canceled", async () => {
    const c = await create();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 3600e3 + 1000);
    expect((await get(c.id)).body.status).toBe("canceled");
    expect((await put(c.id, ready())).status).toBe(409);
    expect((await post(`${BASE}/${c.id}/complete`, pay())).status).toBe(409);
    expect((await post(`${BASE}/${c.id}/cancel`)).body.status).toBe("canceled");
  });
});

describe("idempotency", () => {
  it("requires the header on all four mutations", async () => {
    const c = await create();
    const results = [
      await post(BASE, ready(), null), await put(c.id, ready(), null),
      await post(`${BASE}/${c.id}/complete`, pay(), null), await post(`${BASE}/${c.id}/cancel`, {}, null),
    ];
    for (const r of results) {
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("idempotency_key_required");
    }
  });
  it("replays the stored response, even after state changed", async () => {
    const k = key();
    const first = await post(BASE, ready(), k);
    const second = await post(BASE, ready(), k);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const id = first.body.id;
    const ck = key();
    const done = await post(`${BASE}/${id}/complete`, pay(), ck);
    const replay = await post(`${BASE}/${id}/complete`, pay(), ck);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(done.body);
  });
  it("treats key order in the body as the same request", async () => {
    const k = key();
    const a = await post(BASE, { line_items: [{ item: { id: "var_4_1" }, quantity: 1 }], buyer: { email: "x@y.z" } }, k);
    const b = await post(BASE, { buyer: { email: "x@y.z" }, line_items: [{ quantity: 1, item: { id: "var_4_1" } }] }, k);
    expect(b.body.id).toBe(a.body.id);
  });
  it("conflicts on a different body or path", async () => {
    const k = key();
    await post(BASE, ready(), k);
    const body = await post(BASE, ready("var_4_1", 3), k);
    expect(body.status).toBe(409);
    expect(body.body.code).toBe("idempotency_conflict");
    const c = await create();
    const path = await post(`${BASE}/${c.id}/cancel`, {}, k);
    expect(path.status).toBe(409);
    expect(path.body.code).toBe("idempotency_conflict");
    expect((await put(c.id, ready(), k)).status).toBe(409);
  });
  it("does not store protocol errors", async () => {
    const k = key();
    expect((await post(`${BASE}/chk_later/cancel`, {}, k)).status).toBe(404);
    expect((await post(`${BASE}/chk_later/cancel`, {}, k)).status).toBe(404); // not a replay or conflict artifact
    const bad = await post(BASE, {}, k);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_request");
  });
});

describe("static pages", () => {
  it("serves terms and privacy as plain text", async () => {
    for (const p of ["/terms", "/privacy"]) {
      const res = await request(app).get(p);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
    }
  });
});
