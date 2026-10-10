import { describe, expect, it } from "vitest";
import { checkoutBody, money, restEndpoint, stepOf } from "./api";

const addr = { street_address: "1 Main St", address_locality: "Austin", address_region: "TX", postal_code: "78701", address_country: "US" };
const buyer = { first_name: "", last_name: "", email: "", phone_number: "" };

describe("money", () => {
  it("formats integer minor units as USD", () => {
    expect(money(3306)).toBe("$33.06");
    expect(money(500)).toBe("$5.00");
  });
});

describe("restEndpoint", () => {
  it("finds the first rest endpoint across services", () => {
    const p = { ucp: { services: { a: [{ transport: "mcp", endpoint: "x" }], b: [{ transport: "rest", endpoint: "http://h/ucp" }] } } };
    expect(restEndpoint(p)).toBe("http://h/ucp");
    expect(restEndpoint({ ucp: {} })).toBeUndefined();
  });
});

describe("stepOf", () => {
  it("routes message paths to the step they concern", () => {
    expect(stepOf("$.line_items[0].quantity")).toBe("cart");
    expect(stepOf("$.buyer.email")).toBe("buyer");
    expect(stepOf("$.fulfillment.methods[0].destinations")).toBe("buyer");
    expect(stepOf("$.fulfillment.methods[0].groups[0].selected_option_id")).toBe("shipping");
    expect(stepOf(undefined)).toBe("pay");
  });
});

describe("checkoutBody", () => {
  const cart = [{ id: "v1", qty: 2 }];
  it("sends only line items until buyer or address are filled", () => {
    expect(checkoutBody(cart, buyer, addr, undefined, false)).toEqual({ line_items: [{ item: { id: "v1" }, quantity: 2 }] });
  });
  it("includes buyer, destination and selected option when present", () => {
    const b = checkoutBody(cart, { ...buyer, email: "a@b.co" }, addr, "express", true);
    expect(b.buyer).toEqual({ ...buyer, email: "a@b.co" });
    expect(b.fulfillment).toEqual({ methods: [{ type: "shipping", destinations: [addr], groups: [{ selected_option_id: "express" }] }] });
  });
  it("omits an incomplete destination", () => {
    expect(checkoutBody(cart, buyer, { ...addr, street_address: "" }, undefined, true).fulfillment).toBeUndefined();
  });
});

import { endpointsOf, opRequest, parseResponse, UcpError, type Op } from "./api";

describe("endpointsOf", () => {
  it("takes the first endpoint per transport and strips trailing slashes", () => {
    const p = { ucp: { services: { a: [{ transport: "mcp", endpoint: "http://h/ucp/mcp/" }, { transport: "rest", endpoint: 5 }], b: [{ transport: "rest", endpoint: "http://h/ucp//" }, { transport: "rest", endpoint: "http://other" }] } } };
    expect(endpointsOf(p)).toEqual({ rest: "http://h/ucp", mcp: "http://h/ucp/mcp" });
    expect(endpointsOf({})).toEqual({});
  });
});

const ctx = { rpcId: 7, idempotencyKey: "k-1", agentProfile: "http://a/profile" };
const REST = "http://h/ucp";
const MCP = "http://h/ucp/mcp";
const co = { line_items: [] };
const cases: [Op, any, string, string, any][] = [
  ["create_checkout", { checkout: co }, "POST", "/checkout-sessions", co],
  ["get_checkout", { id: "a/b" }, "GET", "/checkout-sessions/a%2Fb", undefined],
  ["update_checkout", { id: "c1", checkout: co }, "PUT", "/checkout-sessions/c1", co],
  ["complete_checkout", { id: "c1", checkout: co }, "POST", "/checkout-sessions/c1/complete", co],
  ["cancel_checkout", { id: "c1" }, "POST", "/checkout-sessions/c1/cancel", {}],
  ["search_catalog", { query: "q", pagination: { limit: 2 } }, "POST", "/catalog/search", { query: "q", pagination: { limit: 2 } }],
  ["lookup_catalog", { ids: ["x"] }, "POST", "/catalog/lookup", { ids: ["x"] }],
  ["get_product", { id: "p1" }, "POST", "/catalog/product", { id: "p1" }],
  ["get_order", { id: "o 1" }, "GET", "/orders/o%201", undefined],
];
const MUTATING = ["create_checkout", "update_checkout", "complete_checkout", "cancel_checkout"];

describe("opRequest", () => {
  it.each(cases)("REST %s", (op, args, method, path, body) => {
    expect(opRequest("rest", REST, op, args, ctx)).toEqual({ method, url: REST + path, body });
  });
  it.each(cases)("MCP %s", (op, args) => {
    const meta: any = { "ucp-agent": { profile: ctx.agentProfile } };
    if (MUTATING.includes(op)) meta["idempotency-key"] = "k-1";
    expect(opRequest("mcp", MCP, op, args, ctx)).toEqual({
      method: "POST", url: MCP,
      body: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: op, arguments: { ...args, meta } } },
    });
  });
});

describe("parseResponse", () => {
  const rpc = (body: any, status = 200) => parseResponse("mcp", { status, body });
  const fails = (f: () => unknown) => { try { f(); } catch (e) { return e as UcpError; } throw new Error("did not throw"); };
  it("REST 4xx throws UcpError with the body code", () => {
    const e = fails(() => parseResponse("rest", { status: 404, body: { code: "not_found", content: "No such" } }));
    expect(e).toBeInstanceOf(UcpError);
    expect([e.code, e.status, e.message]).toEqual(["not_found", 404, "404 not_found No such"]);
  });
  it("REST 200 returns the body", () => {
    expect(parseResponse("rest", { status: 200, body: { id: "c1" } })).toEqual({ id: "c1" });
  });
  it("JSON-RPC error prefers data.code, else numeric code as string", () => {
    expect(fails(() => rpc({ error: { code: -32602, message: "bad", data: { code: "invalid" } } })).code).toBe("invalid");
    const e = fails(() => rpc({ error: { code: -32602, message: "bad" } }));
    expect([e.code, e.message]).toEqual(["-32602", "-32602 bad"]);
  });
  it("MCP non-200 throws; missing structuredContent throws", () => {
    expect(fails(() => rpc({}, 500))).toBeInstanceOf(UcpError);
    expect(fails(() => rpc({ result: {} })).message).toMatch(/structuredContent/);
  });
  it("returns structuredContent", () => {
    expect(rpc({ result: { structuredContent: { id: "c1" } } })).toEqual({ id: "c1" });
  });
  it("capabilities_incompatible body (no id) throws on both transports", () => {
    const b = { ucp: { status: "error" }, messages: [{ code: "capabilities_incompatible", content: "nope" }] };
    expect(fails(() => parseResponse("rest", { status: 200, body: b })).code).toBe("capabilities_incompatible");
    const e = fails(() => rpc({ result: { structuredContent: b } }));
    expect([e.code, e.message]).toEqual(["capabilities_incompatible", "capabilities_incompatible nope"]);
  });
  it("returns a checkout that carries messages and an id", () => {
    const b = { id: "c1", ucp: { status: "error" }, messages: [{ code: "x", content: "y" }] };
    expect(parseResponse("rest", { status: 200, body: b })).toBe(b);
  });
});
