import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import express from "express";
import request from "supertest";
import { createApp } from "../src/app.js";
import { checkTotals, checkAgentProbe, checkMessages, checkStatusConsistency, runSteps, STEPS, type Ctx, type Step } from "../src/studio/conformance.js";

const listen = async (handler: http.RequestListener) => {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
};
const ids = STEPS.map((s) => s.id);
const statuses = (body: { steps: { id: string; status: string }[] }) => Object.fromEntries(body.steps.map((s) => [s.id, s.status]));

describe("pure helpers", () => {
  const t = (...p: [string, number][]) => p.map(([type, amount]) => ({ type, amount }));
  it("totals equation incl. discounts", () => {
    expect(checkTotals(t(["subtotal", 1000], ["tax", 80], ["total", 1080])).status).toBe("pass");
    expect(checkTotals(t(["subtotal", 1000], ["items_discount", 100], ["discount", 50], ["fulfillment", 500], ["tax", 80], ["fee", 20], ["total", 1450])).status).toBe("pass");
    expect(checkTotals(t(["subtotal", 1000], ["discount", 50], ["total", 1000])).status).toBe("fail");
  });
  it("totals: integers, single total, unknown types", () => {
    expect(checkTotals(t(["subtotal", 10.5], ["total", 10.5])).status).toBe("fail");
    expect(checkTotals(t(["subtotal", 1])).status).toBe("fail");
    expect(checkTotals(t(["total", 1], ["total", 1])).status).toBe("fail");
    expect(checkTotals(t(["subtotal", 100], ["mystery", 5], ["total", 999])).status).toBe("warn");
    expect(checkTotals([...t(["subtotal", 100], ["total", 100]), { type: "mystery", amount: 5, display_text: "Mystery" }]).status).toBe("pass");
  });
  it("totals: unknown type with display_text is excluded but the equation is still asserted", () => {
    const x = { type: "mystery", amount: 5, display_text: "Mystery" };
    expect(checkTotals([...t(["subtotal", 100], ["total", 999]), x]).status).toBe("fail");
    expect(checkTotals([...t(["subtotal", 100], ["total", 100]), x]).status).toBe("pass");
    expect(checkTotals(t(["subtotal", 100], ["mystery", 5], ["total", 100])).status).toBe("warn");
  });
  it("agent probe: 5xx fails, 4xx passes, 2xx/3xx warns", () => {
    const f = checkAgentProbe(503);
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/server error.*503/);
    expect(checkAgentProbe(500).detail).not.toMatch(/accepted/);
    expect(checkAgentProbe(401).status).toBe("pass");
    expect(checkAgentProbe(200)).toMatchObject({ status: "warn", detail: expect.stringContaining("accepted") });
    expect(checkAgentProbe(302).status).toBe("warn");
  });
  it("message shape", () => {
    expect(checkMessages(undefined).status).toBe("pass");
    expect(checkMessages([{ type: "info", code: "x", content: "y" }, { type: "error", code: "x", content: "y", severity: "recoverable" }]).status).toBe("pass");
    expect(checkMessages([{ type: "error", code: "x", content: "y" }]).status).toBe("fail");
    expect(checkMessages([{ type: "error", code: "x", content: "y", severity: "bad" }]).status).toBe("fail");
    expect(checkMessages([{ type: "oops", code: "x", content: "y" }]).status).toBe("fail");
    expect(checkMessages([{ type: "info", code: "", content: "y" }]).status).toBe("fail");
    expect(checkMessages([{ type: "info", code: "x", content: "" }]).status).toBe("fail");
    expect(checkMessages("no").status).toBe("fail");
  });
  it("status consistency", () => {
    const err = [{ type: "error" }];
    expect(checkStatusConsistency({ status: "incomplete", messages: err }).status).toBe("pass");
    expect(checkStatusConsistency({ status: "incomplete", messages: [] }).status).toBe("warn");
    expect(checkStatusConsistency({ status: "requires_escalation" }).status).toBe("fail");
    expect(checkStatusConsistency({ status: "requires_escalation", continue_url: "https://x" }).status).toBe("pass");
    expect(checkStatusConsistency({ status: "ready_for_complete", messages: err }).status).toBe("warn");
    expect(checkStatusConsistency({ status: "ready_for_complete", messages: [] }).status).toBe("pass");
  });
  it("dependency skipping, throws and skips propagate", async () => {
    const steps: Step[] = [
      { id: "a", title: "A", run: async () => ({ status: "pass", detail: "ok" }) },
      { id: "b", title: "B", needs: ["a"], run: async () => { throw new Error("boom"); } },
      { id: "c", title: "C", needs: ["b"], run: async () => ({ status: "pass", detail: "never" }) },
      { id: "d", title: "D", needs: ["a"], run: async () => ({ status: "warn", detail: "meh" }) },
      { id: "e", title: "E", needs: ["d"], run: async () => ({ status: "skip", detail: "nah" }) },
      { id: "f", title: "F", needs: ["e"], run: async () => ({ status: "pass", detail: "never" }) },
    ];
    const r = await runSteps(steps, { state: { exchanges: [] } } as unknown as Ctx);
    expect(r.map((s) => s.status)).toEqual(["pass", "fail", "skip", "warn", "skip", "skip"]);
    expect(r[1].detail).toBe("boom");
    expect(r[2].detail).toContain("needs b");
  });
});

describe("conformance over REST", () => {
  let s: Awaited<ReturnType<typeof listen>>;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    s = await listen((req, res) => app(req, res));
    app = createApp({ dbPath: ":memory:", baseUrl: s.base });
  });
  afterAll(() => new Promise((r) => s.server.close(r)));

  const run = (body: object) => request(app).post("/api/conformance").send(body);

  it("built-in merchant, no allow_complete", async () => {
    const res = await run({ url: `${s.base}/x/y` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ origin: s.base, transport: "rest" });
    expect(typeof res.body.started_at).toBe("string");
    expect(res.body.steps.map((x: { id: string }) => x.id)).toEqual(ids);
    expect(statuses(res.body)).toEqual({
      profile: "pass", agent_header: "pass", catalog_search: "pass", create_checkout: "pass", totals_arithmetic: "pass",
      messages_shape: "pass", status_consistency: "pass", get_checkout: "pass", idempotent_replay: "pass", idempotency_conflict: "pass",
      unknown_checkout: "pass", complete_purchase: "skip", get_order: "skip", cancel_checkout: "pass",
    });
    expect(res.body.summary).toEqual({ pass: 12, fail: 0, warn: 0, skip: 2 });
    const create = res.body.steps.find((x: { id: string }) => x.id === "create_checkout");
    expect(create.exchanges[0].request).toMatchObject({ method: "POST", body: { line_items: [{ quantity: 1 }] } });
    expect(create.exchanges[0].request.headers["UCP-Agent"]).toBe(`profile="${s.base}/api/agent-profile"`);
    expect(create.exchanges[0].response.status).toBe(201);
    expect(typeof create.exchanges[0].duration_ms).toBe("number");
  });

  // v2 merged: the built-in merchant now offers dev.ucp.shopping.order, so get_order runs instead of skipping.
  it("built-in merchant, allow_complete: purchase and order pass, cancel skips", async () => {
    const res = await run({ url: s.base, allow_complete: true });
    expect(res.status).toBe(200);
    expect(statuses(res.body)).toMatchObject({ complete_purchase: "pass", get_order: "pass", cancel_checkout: "skip", create_checkout: "pass" });
    expect(res.body.summary).toEqual({ pass: 13, fail: 0, warn: 0, skip: 1 });
  });

  it("honours item_id", async () => {
    const res = await run({ url: s.base, item_id: "var_4_1" });
    const create = res.body.steps.find((x: { id: string }) => x.id === "create_checkout");
    expect(create.exchanges[0].request.body.line_items[0].item.id).toBe("var_4_1");
  });

  it("rejects invalid bodies and unknown transports with 400 invalid_request", async () => {
    for (const body of [{}, { url: "nope" }, { url: "ftp://x.com" }, { url: s.base, transport: "soap" }, { url: s.base, allow_complete: "yes" }]) {
      const res = await run(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_request");
    }
  });

  it("unreachable target: 200, profile fails, everything else skips", async () => {
    // port 1 is blocked by fetch itself ("bad port"), so use a just-closed ephemeral port for a real ECONNREFUSED
    const dead = await listen(() => {});
    await new Promise((r) => dead.server.close(r));
    const res = await run({ url: dead.base });
    expect(res.status).toBe(200);
    const st = statuses(res.body);
    expect(st.profile).toBe("fail");
    for (const id of ids.slice(1)) expect(st[id]).toBe("skip");
    expect(res.body.summary).toEqual({ pass: 0, fail: 1, warn: 0, skip: 13 });
    const prof = res.body.steps.find((s: any) => s.id === "profile");
    expect(prof.detail).toContain(`GET ${dead.base}/.well-known/ucp`);
    expect(prof.detail).toContain("ECONNREFUSED");
    expect(prof.exchanges).toHaveLength(1);
    expect(prof.exchanges[0].response.status).toBe(0);
    expect(prof.exchanges[0].response.body).toBe(prof.detail);
    expect(prof.exchanges[0].request.headers["UCP-Agent"]).toContain("/api/agent-profile");
  });
});

describe("conformance end to end, both transports", () => {
  let s: Awaited<ReturnType<typeof listen>>;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    s = await listen((req, res) => app(req, res));
    app = createApp({ dbPath: ":memory:", baseUrl: s.base });
  });
  afterAll(() => new Promise((r) => s.server.close(r)));

  const base = {
    profile: "pass", agent_header: "pass", catalog_search: "pass", create_checkout: "pass", totals_arithmetic: "pass",
    messages_shape: "pass", status_consistency: "pass", get_checkout: "pass", idempotent_replay: "pass", idempotency_conflict: "pass",
    unknown_checkout: "pass", complete_purchase: "skip", get_order: "skip", cancel_checkout: "pass",
  };
  const done = { complete_purchase: "pass", get_order: "pass", cancel_checkout: "skip" };
  const restOnly = { agent_header: "skip", idempotent_replay: "skip", idempotency_conflict: "skip" };
  const count = (m: Record<string, string>) => {
    const c = { pass: 0, fail: 0, warn: 0, skip: 0 } as Record<string, number>;
    for (const v of Object.values(m)) c[v]++;
    return c;
  };
  const cases: [string, "rest" | "mcp", boolean, Record<string, string>][] = [
    ["REST", "rest", false, base],
    ["REST + allow_complete", "rest", true, { ...base, ...done }],
    ["MCP", "mcp", false, { ...base, ...restOnly }],
    ["MCP + allow_complete", "mcp", true, { ...base, ...restOnly, ...done }],
  ];
  it.each(cases)("%s: every step", async (_n, transport, allow_complete, expected) => {
    const res = await request(app).post("/api/conformance").send({ url: s.base, transport, allow_complete });
    expect(res.status).toBe(200);
    expect(res.body.transport).toBe(transport);
    expect(statuses(res.body)).toEqual(expected);
    expect(res.body.summary).toEqual(count(expected));
    if (transport === "mcp") {
      const create = res.body.steps.find((x: { id: string }) => x.id === "create_checkout");
      expect(create.exchanges[0].request).toMatchObject({ method: "POST", url: `${s.base}/ucp/mcp`, body: { jsonrpc: "2.0", method: "tools/call", params: { name: "create_checkout" } } });
      expect(create.exchanges[0].request.body.params.arguments.meta["ucp-agent"].profile).toBe(`${s.base}/api/agent-profile`);
      expect(create.exchanges[0].response.body.result.structuredContent.id).toMatch(/\S/);
    }
  });
});

describe("deliberately broken merchant", () => {
  let fake: Awaited<ReturnType<typeof listen>>;
  let app: ReturnType<typeof createApp>;
  let host: Awaited<ReturnType<typeof listen>>;
  beforeAll(async () => {
    const f = express();
    f.use(express.json());
    f.get("/.well-known/ucp", (_req, res) =>
      res.json({ ucp: { version: "2026-08-25", services: { "dev.ucp.shopping": [{ transport: "rest", endpoint: `${fake.base}/ucp` }] }, capabilities: { "dev.ucp.shopping.catalog.search": [{ version: "2026-08-25" }] }, payment_handlers: {} } }));
    // never checks UCP-Agent
    f.post("/ucp/catalog/search", (_req, res) =>
      res.json({ ucp: { version: "2026-08-25" }, products: [{ id: "p1", title: "P", variants: [{ id: "v1", title: "V", price: { amount: 100, currency: "USD" } }] }] }));
    f.post("/ucp/checkout-sessions", (_req, res) =>
      res.status(201).json({
        ucp: { version: "2026-08-25" }, id: "c1", status: "ready_for_complete", currency: "USD", line_items: [{ id: "l1" }],
        totals: [{ type: "subtotal", amount: 100 }, { type: "total", amount: 999 }], links: [],
      }));
    f.use((_req, res) => res.status(500).send("broken"));
    fake = await listen(f);
    host = await listen((req, res) => app(req, res));
    app = createApp({ dbPath: ":memory:", baseUrl: host.base });
  });
  afterAll(async () => {
    await new Promise((r) => fake.server.close(r));
    await new Promise((r) => host.server.close(r));
  });

  it("flags the wrong total and the missing agent check, still answers 200", async () => {
    const res = await request(app).post("/api/conformance").send({ url: fake.base });
    expect(res.status).toBe(200);
    const st = statuses(res.body);
    expect(st).toMatchObject({ profile: "pass", agent_header: "warn", catalog_search: "pass", create_checkout: "warn", totals_arithmetic: "fail", messages_shape: "pass", status_consistency: "pass" });
    expect(st.get_checkout).toBe("fail");
    expect(st.unknown_checkout).toBe("fail");
  });
});

describe("fake merchants, probes", () => {
  let host: Awaited<ReturnType<typeof listen>>;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    host = await listen((req, res) => app(req, res));
    app = createApp({ dbPath: ":memory:", baseUrl: host.base });
  });
  afterAll(() => new Promise((r) => host.server.close(r)));
  const profile = (base: string, transport: string, endpoint: string) => ({
    ucp: { version: "2026-08-25", services: { "dev.ucp.shopping": [{ transport, endpoint }] }, capabilities: { "dev.ucp.shopping.catalog.search": [{ version: "2026-08-25" }] }, payment_handlers: {} },
  });
  const conf = async (f: express.Express, transport: string) => {
    const fake = await listen(f);
    try {
      return (await request(app).post("/api/conformance").send({ url: fake.base, transport })).body;
    } finally {
      await new Promise((r) => fake.server.close(r));
    }
  };

  it("REST: a 500 on the header-less probe is fail", async () => {
    const f = express();
    f.get("/.well-known/ucp", (req, res) => res.json(profile("", "rest", `http://${req.headers.host}/ucp`)));
    f.use((_req, res) => res.status(500).send("broken"));
    const body = await conf(f, "rest");
    const step = body.steps.find((x: { id: string }) => x.id === "agent_header");
    expect(step.status).toBe("fail");
    expect(step.detail).toMatch(/server error \(500\)/);
  });

  it("MCP: a JSON-RPC error on the unknown checkout is a pass; an error where a body was expected fails the step", async () => {
    const f = express();
    f.get("/.well-known/ucp", (req, res) => res.json(profile("", "mcp", `http://${req.headers.host}/mcp`)));
    f.post("/mcp", express.json(), (req, res) => {
      const { id, params } = req.body;
      if (params.name === "get_checkout") return res.json({ jsonrpc: "2.0", id, error: { code: -32000, message: "Checkout not found" } });
      res.json({ jsonrpc: "2.0", id, error: { code: -32603, message: "kaput" } });
    });
    const body = await conf(f, "mcp");
    const st = statuses(body);
    expect(st.unknown_checkout).toBe("pass");
    expect(st).toMatchObject({ profile: "pass", agent_header: "skip", catalog_search: "fail" });
    const cat = body.steps.find((x: { id: string }) => x.id === "catalog_search");
    expect(cat.detail).toContain("-32603");
    expect(cat.detail).toContain("kaput");
  });

  // A third-party-style MCP merchant: `reply(name)` supplies each tool's result; records the Accept header.
  const mcpMerchant = (reply: (name: string, id: number) => object, seen: string[] = []) => {
    const f = express();
    f.get("/.well-known/ucp", (req, res) => res.json(profile("", "mcp", `http://${req.headers.host}/mcp`)));
    f.post("/mcp", express.json(), (req, res) => {
      seen.push(String(req.headers.accept));
      res.json({ jsonrpc: "2.0", id: req.body.id, ...reply(req.body.params.name, req.body.id) });
    });
    return f;
  };
  const text = (o: unknown, isError = false) => ({ result: { content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) }], isError } });
  const find = (b: any, id: string) => b.steps.find((x: { id: string }) => x.id === id);

  it("MCP: a text-only isError tool result is a rejection (unknown_checkout)", async () => {
    const body = await conf(mcpMerchant((n) => (n === "get_checkout" ? text("Checkout not found", true) : text("boom", true))), "mcp");
    expect(statuses(body).unknown_checkout).toBe("pass");
    expect(find(body, "catalog_search").status).toBe("fail");
  });

  it("MCP: a body only in content[0].text is read like structuredContent; Accept is sent", async () => {
    const seen: string[] = [];
    const body = await conf(mcpMerchant((n) => (n === "search_catalog" ? text({ ucp: { version: "2026-08-25" }, products: [] }) : text("nope", true)), seen), "mcp");
    expect(find(body, "catalog_search").detail).not.toMatch(/structuredContent|ucp\.version/);
    expect(find(body, "catalog_search").status).toBe("pass");
    expect(seen.every((a) => a === "application/json, text/event-stream")).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("MCP: a result with no object body fails with a clear message; a string error is not undefined", async () => {
    const body = await conf(mcpMerchant((n) => (n === "search_catalog" ? text("plain words") : { error: "nope" })), "mcp");
    expect(find(body, "catalog_search").detail).toBe("search_catalog: result has no structuredContent");
    const body2 = await conf(mcpMerchant(() => ({ error: "nope" })), "mcp");
    const d = find(body2, "catalog_search").detail;
    expect(d).toContain("nope");
    expect(d).not.toContain("undefined");
  });
});

