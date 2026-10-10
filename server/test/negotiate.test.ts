import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { intersect } from "../src/merchant/negotiate.js";
import { AGENT, AGENT_URL, CAPS, fakeFetch, profileOf } from "./helpers.js";

const baseUrl = "http://127.0.0.1:4000";
const v = (...vs: string[]) => vs.map((version) => ({ version }));
const mk = (f: typeof fetch) => createApp({ dbPath: ":memory:", baseUrl, fetch: f });
const search = (app: ReturnType<typeof createApp>, headers: Record<string, string> = AGENT) => request(app).post("/ucp/catalog/search").set(headers).send({});
const ADDR = { street_address: "1 Main St", address_locality: "Springfield", address_region: "CA", postal_code: "94000", address_country: "US" };

describe("intersect", () => {
  const biz = { a: v("2026-01-01", "2026-08-25"), b: v("2026-08-25"), c: [{ version: "2026-08-25", extends: "b" }] };
  it("keeps names listed by both", () => {
    expect(intersect(biz, { a: v("2026-08-25"), b: v("2026-08-25") })).toEqual([
      { name: "a", version: "2026-08-25" }, { name: "b", version: "2026-08-25" },
    ]);
  });
  it("picks the highest common version", () => {
    expect(intersect(biz, { a: v("2026-01-01", "2026-03-03", "2026-08-25") })).toEqual([{ name: "a", version: "2026-08-25" }]);
    expect(intersect(biz, { a: v("2026-01-01", "2026-03-03") })).toEqual([{ name: "a", version: "2026-01-01" }]);
  });
  it("drops a capability with no common version", () => {
    expect(intersect(biz, { a: v("2025-01-01") })).toEqual([]);
  });
  it("prunes extensions whose parent was dropped, transitively", () => {
    expect(intersect(biz, { c: v("2026-08-25") })).toEqual([]);
    const chain = { x: v("2026-08-25"), y: [{ version: "2026-08-25", extends: "x" }], z: [{ version: "2026-08-25", extends: "y" }] };
    expect(intersect(chain, { y: v("2026-08-25"), z: v("2026-08-25") })).toEqual([]);
    expect(intersect(chain, { x: v("2026-08-25"), y: v("2026-08-25"), z: v("2026-08-25") })).toHaveLength(3);
  });
  it("a platform without capabilities negotiates to the empty set", () => {
    expect(intersect(biz, {})).toEqual([]);
  });
});

describe("negotiation over REST", () => {
  it("invalid_profile_url -> 400 without fetching", async () => {
    const f = fakeFetch();
    const res = await search(mk(f), { "UCP-Agent": 'profile="ftp://x"' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_profile_url");
    expect(f.calls).toEqual([]);
  });
  it("profile_unreachable -> 424 on network error, non-2xx and timeout", async () => {
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const timeout = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as typeof fetch;
    const notFound = (async () => new Response("", { status: 404 })) as typeof fetch;
    for (const f of [down, timeout, notFound]) {
      const res = await search(mk(f));
      expect(res.status).toBe(424);
      expect(res.body.code).toBe("profile_unreachable");
    }
  });
  it("profile_malformed -> 422", async () => {
    for (const body of ["not json", "[]", "{}", '{"ucp":{}}', '{"ucp":{"version":"v1"}}']) {
      const res = await search(mk((async () => new Response(body)) as typeof fetch));
      expect(res.status, body).toBe(422);
      expect(res.body.code).toBe("profile_malformed");
    }
  });
  it("version_unsupported -> 422 when the platform is newer", async () => {
    const res = await search(mk(fakeFetch(profileOf(CAPS, "2026-09-01"))));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("version_unsupported");
    expect((await search(mk(fakeFetch(profileOf(CAPS, "2025-01-01"))))).status).toBe(200);
  });
  it("sends Accept: application/json", async () => {
    let accept: string | undefined;
    const f = (async (_u: string, init?: RequestInit) => {
      accept = (init?.headers as Record<string, string>).Accept;
      return new Response(JSON.stringify(profileOf()));
    }) as unknown as typeof fetch;
    await search(mk(f));
    expect(accept).toBe("application/json");
  });
  it("caches the profile: one fetch for two calls", async () => {
    const f = fakeFetch();
    const app = mk(f);
    await search(app);
    await search(app);
    expect(f.calls).toEqual([AGENT_URL]);
  });
  it("does not cache failures", async () => {
    let n = 0;
    const f = (async () => (++n === 1 ? new Response("", { status: 500 }) : new Response(JSON.stringify(profileOf())))) as typeof fetch;
    const app = mk(f);
    expect((await search(app)).status).toBe(424);
    expect((await search(app)).status).toBe(200);
  });
  it("root capability not negotiated -> 200 capabilities_incompatible", async () => {
    const app = mk(fakeFetch(profileOf(["dev.ucp.shopping.checkout"])));
    const res = await search(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ucp: { version: "2026-08-25", status: "error", capabilities: [] },
      messages: [{ type: "error", code: "capabilities_incompatible", severity: "unrecoverable", content: expect.any(String) }],
    });
    const co = await request(app).post("/ucp/checkout-sessions").set(AGENT).set("Idempotency-Key", "k").send({ line_items: [{ item: { id: "var_4_1" }, quantity: 1 }] });
    expect(co.status).toBe(201);
    const none = await search(mk(fakeFetch({ ucp: { version: "2026-08-25" } })));
    expect(none.body.messages[0].code).toBe("capabilities_incompatible");
  });
  it("envelope lists only the negotiated capabilities", async () => {
    const res = await search(mk(fakeFetch(profileOf(["dev.ucp.shopping.catalog.search"]))));
    expect(res.body.ucp.capabilities).toEqual([{ name: "dev.ucp.shopping.catalog.search", version: "2026-08-25" }]);
  });
  it("without the fulfillment extension a checkout is ready on email alone", async () => {
    const app = mk(fakeFetch(profileOf(CAPS.filter((c) => !c.endsWith("fulfillment")))));
    const res = await request(app).post("/ucp/checkout-sessions").set(AGENT).set("Idempotency-Key", "k1").send({
      line_items: [{ item: { id: "var_4_1" }, quantity: 1 }], buyer: { email: "a@b.co" },
      fulfillment: { methods: [{ type: "shipping", destinations: [ADDR], groups: [{ selected_option_id: "standard" }] }] },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("ready_for_complete");
    expect(res.body.fulfillment).toBeUndefined();
    expect(res.body.messages).toEqual([]);
    expect(res.body.totals.map((t: any) => t.type)).toEqual(["subtotal", "tax", "total"]);
    expect(res.body.ucp.capabilities.map((c: any) => c.name)).toEqual(["dev.ucp.shopping.checkout"]);
    const done = await request(app).post(`/ucp/checkout-sessions/${res.body.id}/complete`).set(AGENT).set("Idempotency-Key", "k2")
      .send({ payment: { instruments: [{ id: "i", handler_id: "mock_pay", type: "token", credential: { token: "tok_success" } }] } });
    expect(done.body.status).toBe("completed");
  });
});
