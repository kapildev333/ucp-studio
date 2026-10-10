import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AGENT, fakeFetch } from "./helpers.js";

const STUDIO = { "X-UCP-Studio": "1" };
const one = { replace: true, products: [{ title: "Mug", variants: [{ sku: "MUG-1", title: "V", price: 100, stock: 3 }] }] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("C1: server-side fetches cannot reach back-office writes", () => {
  const victim = http.createServer();
  const evil = http.createServer();
  let base: string, evilBase: string, app: ReturnType<typeof createApp>;
  const seen: Record<string, string | string[] | undefined>[] = [];
  const reset = () => `${base}/merchant-admin/catalog/reset`;
  const products = async () => (await request(base).get("/merchant-admin/catalog")).body.products.length;

  beforeAll(async () => {
    await new Promise<void>((r) => victim.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => evil.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(victim.address() as { port: number }).port}`;
    evilBase = `http://127.0.0.1:${(evil.address() as { port: number }).port}`;
    app = createApp({ dbPath: ":memory:", baseUrl: base });
    victim.on("request", app);
    evil.on("request", (req, res) => {
      seen.push(req.headers);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/agent") {
        return void res.end(JSON.stringify({ ucp: { version: "2026-08-25", capabilities: {
          "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }],
          "dev.ucp.shopping.order": [{ version: "2026-08-25", config: { webhook_url: reset() } }],
        } } }));
      }
      const cap = { "dev.ucp.shopping.catalog.search": [{ version: "2026-08-25" }] };
      res.end(JSON.stringify({ ucp: { version: "2026-08-25", payment_handlers: {}, capabilities: cap, services: {
        x: [{ version: "2026-08-25", transport: "rest", endpoint: `${reset()}?x=` }, { version: "2026-08-25", transport: "mcp", endpoint: reset() }],
      } } }));
    });
  });
  afterAll(async () => {
    await new Promise((r) => victim.close(r));
    await new Promise((r) => evil.close(r));
  });
  const importOne = () => request(base).post("/merchant-admin/catalog/import").set(STUDIO).send(one);

  it("inspect does not reset the catalog", async () => {
    await importOne();
    expect(await products()).toBe(1);
    await request(base).post("/api/inspect").send({ url: evilBase });
    expect(await products()).toBe(1);
  });

  it("conformance does not reset the catalog", async () => {
    await importOne();
    for (const transport of ["rest", "mcp"]) await request(base).post("/api/conformance").send({ url: evilBase, transport });
    expect(await products()).toBe(1);
  });

  it("webhook delivery does not reset the catalog", async () => {
    await importOne();
    // a checkout completed by the evil platform: webhook_url is the reset URL
    const pay = { payment: { instruments: [{ id: "i1", handler_id: "mock_pay", type: "card", credential: { token: "t" } }] } };
    const h = { "UCP-Agent": `profile="${evilBase}/agent"` };
    const sku = (await request(base).get("/merchant-admin/catalog")).body.products[0].variants[0].id;
    const body2 = { line_items: [{ item: { id: sku }, quantity: 1 }], buyer: { email: "a@b.co" } };
    const c = await request(base).post("/ucp/checkout-sessions").set(h).set("Idempotency-Key", "c1").send(body2);
    // fulfillment extension not negotiated by the evil platform, so no address is needed
    const done = await request(base).post(`/ucp/checkout-sessions/${c.body.id}/complete`).set(h).set("Idempotency-Key", "c2").send(pay);
    expect(done.body.status).toBe("completed");
    await wait(300);
    expect(await products()).toBe(1);
  });

  it("proxy never forwards X-UCP-Studio, even when the caller supplies it", async () => {
    await importOne();
    seen.length = 0;
    await request(base).post("/api/proxy").send({ method: "POST", url: reset(), headers: { "x-ucp-studio": "1", "X-UCP-Studio": "1" }, body: {} });
    expect(await products()).toBe(1);
    await request(base).post("/api/proxy").send({ method: "GET", url: `${evilBase}/p`, headers: { "X-UCP-Studio": "1" } });
    expect(seen.at(-1)!["x-ucp-studio"]).toBeUndefined();
  });

  it("back-office writes need the header: missing -> 403, present -> 200", async () => {
    const a = createApp({ dbPath: ":memory:", baseUrl: "http://127.0.0.1:4000", fetch: fakeFetch() });
    const no = await request(a).post("/merchant-admin/catalog/reset");
    expect([no.status, no.body.code]).toEqual([403, "forbidden"]);
    expect((await request(a).post("/merchant-admin/catalog/import").send(one)).status).toBe(403);
    expect((await request(a).get("/merchant-admin/catalog")).status).toBe(200);
    expect((await request(a).post("/merchant-admin/catalog/import").set(STUDIO).send(one)).status).toBe(200);
    expect((await request(a).post("/merchant-admin/catalog/reset").set(STUDIO)).status).toBe(200);
  });
});

describe("I1: Host allowlist everywhere, MCP is JSON-only", () => {
  const mk = () => createApp({ dbPath: ":memory:", baseUrl: "http://127.0.0.1:4000", fetch: fakeFetch() });
  it("non-local Host is refused on /ucp/*, /orders and /.well-known/ucp", async () => {
    const app = mk();
    const host = "evil.example";
    for (const r of [
      request(app).get("/.well-known/ucp"),
      request(app).get("/orders/ord_x"),
      request(app).post("/ucp/catalog/search").set(AGENT).send({}),
      request(app).post("/ucp/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ]) {
      const res = await r.set("Host", host);
      expect([res.status, res.body.code]).toEqual([403, "forbidden_host"]);
    }
    expect((await request(app).get("/.well-known/ucp")).status).toBe(200);
  });
  it("text/plain POST to /ucp/mcp is rejected (-32700) and creates nothing", async () => {
    const app = mk();
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "create_checkout", arguments: { meta: { "ucp-agent": { profile: "http://127.0.0.1:4000/api/agent-profile" } }, checkout: { line_items: [{ item: { id: "var_4_1" }, quantity: 1 }] } } },
    });
    const res = await request(app).post("/ucp/mcp").set("Content-Type", "text/plain").send(body);
    expect(res.body.error.code).toBe(-32700);
    const ok = await request(app).post("/ucp/mcp").set("Content-Type", "application/json").send(body);
    expect(ok.body.result.structuredContent.status).toBeDefined();
  });
});
