import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AGENT, AGENT_URL, CAPS, fakeFetch, profileOf } from "./helpers.js";

const baseUrl = "http://127.0.0.1:4000";
const addr = { street_address: "1 Main St", address_locality: "Springfield", address_region: "CA", postal_code: "94000", address_country: "US" };
const pay = { payment: { instruments: [{ id: "i1", handler_id: "mock_pay", type: "card", credential: { token: "tok_ok" } }] } };

const setup = () => {
  const app = createApp({ dbPath: ":memory:", baseUrl, fetch: fakeFetch(profileOf([...CAPS, "dev.ucp.shopping.order"])) });
  let n = 0;
  const rpc = (method: string, params?: object, id: number | string | null = ++n) => request(app).post("/ucp/mcp").send({ jsonrpc: "2.0", id, method, params });
  const meta = (key?: string) => ({ "ucp-agent": { profile: AGENT_URL }, ...(key && { "idempotency-key": key }) });
  const call = (name: string, args: object = {}, key?: string) => rpc("tools/call", { name, arguments: { meta: meta(key), ...args } });
  return { app, rpc, call };
};

describe("MCP transport", () => {
  it("initialize echoes supported versions, else falls back", async () => {
    const { rpc } = setup();
    const a = await rpc("initialize", { protocolVersion: "2025-03-26" });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ucp-studio-merchant", version: "0.2.0" } } });
    expect((await rpc("initialize", { protocolVersion: "2025-06-18" })).body.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc("initialize")).body.result.protocolVersion).toBe("2025-06-18");
  });

  it("notification gets 202 with empty body; ping is {}", async () => {
    const { app, rpc } = setup();
    const r = await request(app).post("/ucp/mcp").send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r.status).toBe(202);
    expect(r.text).toBe("");
    expect((await rpc("ping")).body.result).toEqual({});
  });

  it("GET and DELETE are 405", async () => {
    const { app } = setup();
    expect((await request(app).get("/ucp/mcp")).status).toBe(405);
    expect((await request(app).delete("/ucp/mcp")).status).toBe(405);
  });

  it("JSON-RPC error codes", async () => {
    const { app, rpc, call } = setup();
    const raw = (body: string) => request(app).post("/ucp/mcp").set("Content-Type", "application/json").send(body);
    const bad = await raw("{nope");
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect((await raw("[]")).body.error.code).toBe(-32600);
    expect((await raw(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]))).body.error.code).toBe(-32600);
    expect((await raw(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }))).body.error.code).toBe(-32600);
    const nf = await rpc("nope");
    expect(nf.body.error.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "nope", arguments: {} })).body.error.code).toBe(-32602);
    expect((await call("get_checkout", { id: 5 })).body.error.code).toBe(-32602);
    expect((await call("create_checkout", { checkout: { line_items: [] } })).body.error.code).toBe(-32602);
  });

  it("tools/list names all nine tools with loose input schemas", async () => {
    const { rpc } = setup();
    const { tools } = (await rpc("tools/list")).body.result;
    expect(tools.map((t: any) => t.name)).toEqual([
      "create_checkout", "get_checkout", "update_checkout", "complete_checkout", "cancel_checkout", "search_catalog", "lookup_catalog", "get_product", "get_order",
    ]);
    expect(tools.find((t: any) => t.name === "complete_checkout").inputSchema.required).toEqual(["meta", "id", "checkout"]);
  });

  it("profile advertises the mcp transport", async () => {
    const { app } = setup();
    const s = (await request(app).get("/.well-known/ucp")).body.ucp.services["dev.ucp.shopping"];
    expect(s).toContainEqual({ version: "2026-08-25", transport: "mcp", endpoint: `${baseUrl}/ucp/mcp` });
  });

  it("full purchase over MCP", async () => {
    const { call } = setup();
    const s = await call("search_catalog", { query: "", pagination: { limit: 1 } });
    expect(s.body.result.isError).toBe(false);
    const variant = s.body.result.structuredContent.products[0].variants[0].id;
    expect(s.body.result.content).toEqual([{ type: "text", text: JSON.stringify(s.body.result.structuredContent) }]);
    const c = (await call("create_checkout", { checkout: { line_items: [{ item: { id: variant }, quantity: 1 }], buyer: { email: "a@b.co" } } })).body.result.structuredContent;
    expect(c.status).toBe("incomplete");
    const u = (await call("update_checkout", { id: c.id, checkout: { line_items: [{ item: { id: variant }, quantity: 1 }], buyer: { email: "a@b.co" }, fulfillment: { methods: [{ type: "shipping", destinations: [addr], groups: [{ selected_option_id: "standard" }] }] } } })).body.result.structuredContent;
    expect((await call("get_checkout", { id: c.id })).body.result.structuredContent.id).toBe(c.id);
    const done = (await call("complete_checkout", { id: u.id, checkout: pay }, "k1")).body.result.structuredContent;
    expect(done.status).toBe("completed");
    const order = (await call("get_order", { id: done.order.id })).body.result.structuredContent;
    expect(order.id).toBe(done.order.id);
  });

  it("missing meta gives -32001 even with other bad arguments", async () => {
    const { rpc } = setup();
    const r = await rpc("tools/call", { name: "get_checkout", arguments: { id: 5 } });
    expect(r.body.error).toMatchObject({ code: -32001, data: { code: "invalid_profile_url" } });
  });

  it("missing idempotency key on complete/cancel is -32602", async () => {
    const { call } = setup();
    expect((await call("complete_checkout", { id: "x", checkout: pay })).body.error.code).toBe(-32602);
    expect((await call("cancel_checkout", { id: "x" })).body.error.code).toBe(-32602);
  });

  it("not_found maps to -32000 with data.code", async () => {
    const { call } = setup();
    expect((await call("get_checkout", { id: "nope" })).body.error).toMatchObject({ code: -32000, data: { code: "not_found" } });
  });

  it("capabilities_incompatible is a result with isError", async () => {
    const app = createApp({ dbPath: ":memory:", baseUrl, fetch: (async (u: any) => String(u) === AGENT_URL ? new Response(JSON.stringify({ ucp: { version: "2026-08-25", capabilities: {} } })) : new Response("", { status: 404 })) as typeof fetch });
    const r = await request(app).post("/ucp/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: { meta: { "ucp-agent": { profile: AGENT_URL } } } } });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.structuredContent.ucp.status).toBe("error");
  });

  it("idempotent replay is shared across transports", async () => {
    const { app, call } = setup();
    const lines = [{ item: { id: "var_4_1" }, quantity: 1 }];
    const c = (await call("create_checkout", { checkout: { line_items: lines, buyer: { email: "a@b.co" }, fulfillment: { methods: [{ type: "shipping", destinations: [addr], groups: [{ selected_option_id: "standard" }] }] } } })).body.result.structuredContent;
    const first = (await call("complete_checkout", { id: c.id, checkout: pay }, "same")).body.result.structuredContent;
    const again = (await call("complete_checkout", { id: c.id, checkout: pay }, "same")).body.result.structuredContent;
    expect(again).toEqual(first);
    const rest = await request(app).post(`/ucp/checkout-sessions/${c.id}/complete`).set({ ...AGENT, "Idempotency-Key": "same" }).send(pay);
    expect(rest.body).toEqual(first);
  });

  it("F4: a non-string profile is invalid_profile_url", async () => {
    const { rpc } = setup();
    const r = await rpc("tools/call", { name: "get_checkout", arguments: { meta: { "ucp-agent": { profile: [AGENT_URL] } }, id: "x" } });
    expect(r.body.error).toMatchObject({ code: -32001, data: { code: "invalid_profile_url" } });
  });

  it("F5: REST and MCP share one profile cache", async () => {
    const f = fakeFetch(profileOf([...CAPS, "dev.ucp.shopping.order"]));
    const app = createApp({ dbPath: ":memory:", baseUrl, fetch: f });
    await request(app).post("/ucp/catalog/search").set(AGENT).send({});
    await request(app).post("/ucp/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: { meta: { "ucp-agent": { profile: AGENT_URL } } } } });
    expect(f.calls).toEqual([AGENT_URL]);
  });
});
