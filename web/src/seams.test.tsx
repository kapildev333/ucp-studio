import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OrdersTable, shipThenReload } from "./Merchant";
import { ErrorBoundary } from "./ErrorBoundary";
import { editQty, fulfillmentStatus, mergeCaps, normalize, parseResponse } from "./api";
import { conformanceToMarkdown, rpcLabel, toCurl, traceToMarkdown } from "./export";

const order = (id: string, status: string) => ({ id, created_at: "2026-10-09T10:00:00.000Z", totals: [{ type: "total", amount: 1234 }], line_items: [{ id: "l", status }] });

describe("OrdersTable", () => {
  const html = renderToStaticMarkup(<OrdersTable orders={[order("ord_a", "processing"), order("ord_b", "fulfilled")]} onShip={() => {}} />);
  it("is a real table with id, created, total and status", () => {
    expect(html).toContain("<table");
    for (const t of ["ord_a", "2026-10-09T10:00:00.000Z", "$12.34", "unfulfilled", "fulfilled"]) expect(html).toContain(t);
  });
  it("offers Ship only for unfulfilled orders", () => {
    expect(html).toContain('aria-label="Ship ord_a"');
    expect(html).not.toContain('aria-label="Ship ord_b"');
  });
  it("tolerates an order without totals or line items", () => {
    expect(() => renderToStaticMarkup(<OrdersTable orders={[{ id: "x" }]} onShip={() => {}} />)).not.toThrow();
  });
});

describe("fulfillmentStatus", () => {
  it("derives from line items", () => {
    expect(fulfillmentStatus({ line_items: [{ status: "processing" }] })).toBe("unfulfilled");
    expect(fulfillmentStatus({ line_items: [{ status: "fulfilled" }, { status: "processing" }] })).toBe("partial");
    expect(fulfillmentStatus({ line_items: [{ status: "fulfilled" }] })).toBe("fulfilled");
    expect(fulfillmentStatus({})).toBe("unfulfilled");
  });
});

describe("editQty", () => {
  it("lets the field be empty while editing, so backspace then 3 gives 3", () => {
    expect(editQty("")).toBe("");
    expect(editQty("3")).toBe(3);
    expect(editQty("13")).toBe(13);
    expect(editQty("0")).toBe("");
    expect(editQty("2.7")).toBe(2);
  });
});

describe("mergeCaps", () => {
  const a = { name: "a", version: "v" }, b = { name: "b", version: "v" };
  it("accumulates the union by name and ignores junk", () => {
    const one = mergeCaps([], [a]);
    expect(mergeCaps(one, [b])).toEqual([a, b]);
    expect(mergeCaps(mergeCaps(one, [b]), [a])).toEqual([a, b]);
    expect(mergeCaps(one, "nope")).toBe(one);
    expect(mergeCaps(one, [null, { x: 1 }])).toBe(one);
  });
});

describe("normalize / parseResponse", () => {
  it("replaces non-array lists and drops null entries at any depth", () => {
    const out = normalize({ messages: "oops", totals: [null, { type: "total", amount: 1 }], fulfillment: { methods: [{ groups: [{ options: null }, null] }] } });
    expect(out.messages).toEqual([]);
    expect(out.totals).toEqual([{ type: "total", amount: 1 }]);
    expect(out.fulfillment.methods[0].groups).toEqual([{ options: [] }]);
  });
  it("is applied to REST and MCP responses", () => {
    expect(parseResponse("rest", { status: 200, body: { id: "c", totals: {}, messages: [null] } })).toMatchObject({ totals: [], messages: [] });
    const r = { status: 200, body: { result: { structuredContent: { id: "c", messages: 5 } } } };
    expect(parseResponse("mcp", r).messages).toEqual([]);
  });
});

describe("ErrorBoundary", () => {
  it("turns a thrown error into state the fallback renders", () => {
    // ponytail: no DOM test env is installed (no jsdom), so the render-time catch itself is not exercised; only the state mapping is.
    expect((ErrorBoundary as any).getDerivedStateFromError(new Error("boom"))).toEqual({ error: new Error("boom") });
  });
});

const rpc = (method: string, params?: object) => ({ jsonrpc: "2.0", id: 1, method, ...(params && { params }) });
const mcpTrace = (body: object) => ({
  id: 1, method: "POST" as const, url: "http://m/ucp/mcp", status: 200, duration_ms: 3,
  request: { method: "POST", url: "http://m/ucp/mcp", headers: { "Content-Type": "application/json" }, body },
  response: { status: 200, headers: {}, body: {} },
});

describe("MCP exchanges", () => {
  it("rpcLabel names the method, and the tool for tools/call", () => {
    expect(rpcLabel(mcpTrace(rpc("tools/call", { name: "create_checkout" })).request)).toBe("tools/call create_checkout");
    expect(rpcLabel(mcpTrace(rpc("initialize")).request)).toBe("initialize");
    expect(rpcLabel({ method: "POST", body: { a: 1 } })).toBeUndefined();
  });
  it("toCurl adds the Accept header MCP requires, without duplicating it", () => {
    const c = toCurl(mcpTrace(rpc("tools/list")));
    expect(c).toContain("-H 'Accept: application/json, text/event-stream'");
    expect(c).toContain("--data-raw '{\"jsonrpc\":\"2.0\"");
    const t = mcpTrace(rpc("tools/list"));
    (t.request.headers as any).accept = "application/json";
    expect(toCurl(t).match(/ccept/gi)).toHaveLength(1);
  });
  it("trace markdown headings carry the JSON-RPC method and tool", () => {
    expect(traceToMarkdown([mcpTrace(rpc("tools/call", { name: "get_order" }))])).toContain("## 1. POST http://m/ucp/mcp (tools/call get_order) → 200");
  });
  it("conformance markdown names the transport, labels calls, explains skips and status 0", () => {
    const ex = (body: object, status: number) => ({ request: mcpTrace(body).request, response: { status, headers: {}, body: status ? {} : "POST http://m/ucp/mcp: ECONNREFUSED" }, duration_ms: 1 });
    const md = conformanceToMarkdown({
      origin: "http://m", transport: "mcp", started_at: "t", duration_ms: 5, summary: { pass: 1, fail: 1, warn: 0, skip: 1 },
      steps: [
        { id: "create", title: "Create", status: "pass", detail: "ok", exchanges: [ex(rpc("tools/call", { name: "create_checkout" }), 200)] },
        { id: "update", title: "Update", status: "fail", detail: "down", exchanges: [ex(rpc("tools/call", { name: "update_checkout" }), 0)] },
        { id: "agent_header", title: "Missing header", status: "skip", detail: "REST only: not run over MCP", exchanges: [] },
      ],
    });
    expect(md).toContain("- Transport: mcp (JSON-RPC 2.0");
    expect(md).toContain("(tools/call create_checkout) → 200");
    expect(md).toContain("(tools/call update_checkout) → no response");
    expect(md).not.toContain("→ 0 ");
    expect(md).toContain("## Skipped\n\n- agent_header: REST only: not run over MCP");
  });
});

describe("shipThenReload", () => {
  it("reloads after a failed ship and still returns the error for display afterwards", async () => {
    const calls: string[] = [];
    const err = await shipThenReload("ord_a", async () => { calls.push("ship"); throw new Error("Order is already fulfilled"); }, async () => { calls.push("reload"); });
    expect(calls).toEqual(["ship", "reload"]);
    expect(err).toBe("Ship ord_a: Order is already fulfilled");
  });
  it("returns no error after a successful ship", async () => {
    expect(await shipThenReload("ord_a", async () => ({}), async () => {})).toBe("");
  });
});
