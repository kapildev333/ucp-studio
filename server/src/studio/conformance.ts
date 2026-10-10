import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { protocolError } from "../ucp.js";
import { restEndpoint } from "./inspect.js";

type Obj = Record<string, any>;
export type Status = "pass" | "fail" | "warn" | "skip";
export type Out = { status: Status; detail: string };
export type Exchange = {
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
  duration_ms: number;
};
export type StepResult = { id: string; title: string; status: Status; detail: string; exchanges: Exchange[] };
export type Res = { status: number; body: any };

// One method per UCP operation. Only the REST mapping exists; an MCP mapping would implement the same shape.
export type Client = {
  profile(): Promise<Res>;
  search(body: unknown, opts?: { noAgent?: boolean }): Promise<Res>;
  create(body: unknown, key: string): Promise<Res>;
  get(id: string, opts?: { noAgent?: boolean }): Promise<Res>;
  update(id: string, body: unknown, key: string): Promise<Res>;
  complete(id: string, body: unknown, key: string): Promise<Res>;
  cancel(id: string, key: string): Promise<Res>;
  getOrder(id: string): Promise<Res>;
};
export type Ctx = {
  client: Client;
  state: { exchanges: Exchange[]; endpoint?: string }; // exchanges is swapped per step by the runner
  profile?: Obj;
  variantId?: string;
  checkout?: Obj;
  createBody?: Obj;
  createKey?: string;
  orderId?: string;
  itemId?: string;
  allowComplete: boolean;
};
export type Step = { id: string; title: string; needs?: string[]; run(ctx: Ctx): Promise<Out> };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const out = (status: Status, detail: string): Out => ({ status, detail });

// ---- pure assertion helpers -------------------------------------------------------------------

const TOTAL_TYPES = ["subtotal", "items_discount", "discount", "fulfillment", "tax", "fee", "total"];
export const STATUSES = ["incomplete", "requires_escalation", "ready_for_complete", "complete_in_progress", "completed", "canceled"];
const SEVERITIES = ["recoverable", "requires_buyer_input", "requires_buyer_review", "unrecoverable"];

export function checkTotals(totals: unknown): Out {
  if (!Array.isArray(totals) || !totals.every((t) => isObj(t) && typeof t.type === "string")) return out("fail", "totals must be an array of {type, amount}");
  if (totals.filter((t) => t.type === "total").length !== 1) return out("fail", "totals must contain exactly one total");
  if (!totals.every((t) => Number.isInteger(t.amount))) return out("fail", "every total amount must be an integer (minor units)");
  const unknown = totals.filter((t) => !TOTAL_TYPES.includes(t.type) && !t.display_text);
  if (unknown.length) return out("warn", `Unknown total type(s) without display_text: ${unknown.map((t) => t.type).join(", ")}; equation not asserted`);
  const sum = (type: string) => totals.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);
  const expected = sum("subtotal") - sum("items_discount") - sum("discount") + sum("fulfillment") + sum("tax") + sum("fee");
  return sum("total") === expected ? out("pass", `total ${expected}`) : out("fail", `total is ${sum("total")}, expected ${expected} (subtotal - discounts + fulfillment + tax + fee)`);
}

export function checkMessages(messages: unknown): Out {
  if (messages === undefined) return out("pass", "No messages");
  if (!Array.isArray(messages)) return out("fail", "messages must be an array");
  for (const [i, m] of messages.entries()) {
    if (!isObj(m)) return out("fail", `messages[${i}] is not an object`);
    if (!["error", "warning", "info"].includes(m.type)) return out("fail", `messages[${i}].type must be error|warning|info`);
    if (typeof m.code !== "string" || !m.code) return out("fail", `messages[${i}].code must be a non-empty string`);
    if (typeof m.content !== "string" || !m.content) return out("fail", `messages[${i}].content must be a non-empty string`);
    if (m.type === "error" && !SEVERITIES.includes(m.severity)) return out("fail", `messages[${i}].severity must be one of ${SEVERITIES.join("|")}`);
  }
  return out("pass", `${messages.length} message(s)`);
}

export function checkStatusConsistency(c: Obj): Out {
  const errors = Array.isArray(c.messages) ? c.messages.filter((m: Obj) => m?.type === "error") : [];
  if (c.status === "incomplete" && !errors.length) return out("warn", "status incomplete but no error message explains why");
  if (c.status === "requires_escalation" && !c.continue_url) return out("fail", "status requires_escalation needs continue_url");
  if (c.status === "ready_for_complete" && errors.length) return out("warn", "status ready_for_complete but error messages are present");
  return out("pass", `status ${c.status} is consistent with messages`);
}

// The header-less probe: 4xx is the right answer, 5xx means the merchant broke on it, anything else accepted it.
export const checkAgentProbe = (status: number): Out =>
  status >= 500 ? out("fail", `Request without UCP-Agent got a server error (${status})`)
  : status >= 400 ? out("pass", `Rejected with ${status}`)
  : out("warn", `Request without UCP-Agent was accepted (${status})`);

// Rejected = 4xx, or a 200-style body whose ucp.status is "error".
const rejected = (r: Res) => (r.status >= 400 && r.status < 500) || r.body?.ucp?.status === "error";

// ---- runner -----------------------------------------------------------------------------------

export async function runSteps(steps: Step[], ctx: Ctx): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const s of steps) {
    const exchanges: Exchange[] = [];
    ctx.state.exchanges = exchanges;
    const blocker = (s.needs ?? []).map((n) => results.find((r) => r.id === n)).find((r) => r && r.status !== "pass" && r.status !== "warn");
    let o: Out;
    if (blocker) o = out("skip", `Skipped: needs ${blocker.id}, which was ${blocker.status}`);
    else {
      try {
        o = await s.run(ctx);
      } catch (e) {
        o = out("fail", (e as Error).message);
      }
    }
    results.push({ id: s.id, title: s.title, ...o, exchanges });
  }
  return results;
}

// ---- REST client ------------------------------------------------------------------------------

export function restClient(origin: string, baseUrl: string, state: Ctx["state"]): Client {
  const call = async (method: string, url: string, opts: { body?: unknown; key?: string; noAgent?: boolean } = {}): Promise<Res> => {
    const headers: Record<string, string> = {
      ...(!opts.noAgent && { "UCP-Agent": `profile="${baseUrl}/api/agent-profile"` }),
      "Request-Id": randomUUID(),
      ...(opts.body !== undefined && { "Content-Type": "application/json" }),
      ...(opts.key && { "Idempotency-Key": opts.key }),
    };
    const t0 = performance.now();
    const request = { method, url, headers, body: opts.body };
    let res: Response, text: string;
    try {
      res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(10000) });
      text = await res.text();
    } catch (e: any) {
      const msg = `${method} ${url}: ${e?.cause?.code ?? (e?.name === "TimeoutError" ? "timeout after 10s" : e?.message ?? e)}`;
      state.exchanges.push({ request, response: { status: 0, headers: {}, body: msg }, duration_ms: Math.round(performance.now() - t0) });
      throw new Error(msg);
    }
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    state.exchanges.push({
      request,
      response: { status: res.status, headers: Object.fromEntries(res.headers), body },
      duration_ms: Math.round(performance.now() - t0),
    });
    return { status: res.status, body };
  };
  const ep = () => {
    if (!state.endpoint) throw new Error("No REST endpoint known");
    return state.endpoint;
  };
  const co = (id?: string, sub = "") => `${ep()}/checkout-sessions${id ? `/${encodeURIComponent(id)}` : ""}${sub}`;
  return {
    profile: () => call("GET", `${origin}/.well-known/ucp`),
    search: (body, o) => call("POST", `${ep()}/catalog/search`, { body, noAgent: o?.noAgent }),
    create: (body, key) => call("POST", co(), { body, key }),
    get: (id, o) => call("GET", co(id), { noAgent: o?.noAgent }),
    update: (id, body, key) => call("PUT", co(id), { body, key }),
    complete: (id, body, key) => call("POST", co(id, "/complete"), { body, key }),
    cancel: (id, key) => call("POST", co(id, "/cancel"), { body: {}, key }),
    getOrder: (id) => call("GET", `${ep()}/orders/${encodeURIComponent(id)}`),
  };
}

// ---- steps ------------------------------------------------------------------------------------

const hasCap = (ctx: Ctx, name: string) => !!ctx.profile?.ucp?.capabilities?.[name];
const MOCK = "dev.ucpstudio.mock_pay";
const isMoney = (v: unknown) => Number.isInteger(v);

export const STEPS: Step[] = [
  {
    id: "profile", title: "Profile reachable and well-formed",
    async run(ctx) {
      const r = await ctx.client.profile();
      if (r.status !== 200 || !isObj(r.body)) return out("fail", `GET /.well-known/ucp returned ${r.status} without a JSON object`);
      const u = r.body.ucp;
      if (!isObj(u) || typeof u.version !== "string") return out("fail", "ucp.version is missing");
      if (!isObj(u.services)) return out("fail", "ucp.services must be an object");
      if (!isObj(u.payment_handlers)) return out("fail", "ucp.payment_handlers must be an object");
      const endpoint = restEndpoint(r.body);
      if (!endpoint) return out("fail", "No service offers the rest transport with an absolute http(s) endpoint");
      ctx.profile = r.body;
      ctx.state.endpoint = endpoint.replace(/\/+$/, "");
      return out("pass", `rest endpoint ${ctx.state.endpoint}. Use the Inspector for the full static checklist.`);
    },
  },
  {
    id: "agent_header", title: "Missing UCP-Agent is rejected", needs: ["profile"],
    async run(ctx) {
      // ponytail: without the catalog capability, a GET of a nonexistent checkout stands in; 4xx there may be a plain 404, upgrade by probing another operation
      const r = hasCap(ctx, "dev.ucp.shopping.catalog.search")
        ? await ctx.client.search({ pagination: { limit: 1 } }, { noAgent: true })
        : await ctx.client.get("ucp-studio-nonexistent", { noAgent: true });
      return checkAgentProbe(r.status);
    },
  },
  {
    id: "catalog_search", title: "Catalog search", needs: ["profile"],
    async run(ctx) {
      if (!hasCap(ctx, "dev.ucp.shopping.catalog.search")) return out("skip", "Profile lacks dev.ucp.shopping.catalog.search");
      const r = await ctx.client.search({ pagination: { limit: 5 } });
      if (r.status !== 200) return out("fail", `Search returned ${r.status}`);
      if (!r.body?.ucp?.version) return out("fail", "Response lacks ucp.version");
      if (!Array.isArray(r.body.products)) return out("fail", "Response lacks products[]");
      for (const [i, p] of r.body.products.entries()) {
        if (!p?.id || !p?.title || !Array.isArray(p.variants)) return out("fail", `products[${i}] needs id, title and variants[]`);
        for (const v of p.variants) if (!v?.id || !isMoney(v.price?.amount)) return out("fail", `products[${i}] has a variant without id or integer price.amount`);
      }
      const v = r.body.products.flatMap((p: Obj) => p.variants).find((x: Obj) => x.availability?.available !== false);
      ctx.variantId = v?.id;
      return out("pass", `${r.body.products.length} product(s)${v ? `, using variant ${v.id}` : ", none available"}`);
    },
  },
  {
    id: "create_checkout", title: "Create checkout", needs: ["profile"],
    async run(ctx) {
      const item = ctx.itemId ?? ctx.variantId;
      if (!item) return out("skip", "No item_id given and no available variant found");
      const body = { line_items: [{ item: { id: item }, quantity: 1 }] };
      const key = randomUUID();
      const r = await ctx.client.create(body, key);
      if (r.status !== 201) return out("fail", `Create returned ${r.status}, expected 201`);
      const c = r.body;
      if (!c?.ucp?.version) return out("fail", "Response lacks ucp.version");
      if (typeof c.id !== "string" || !c.id) return out("fail", "Response lacks id");
      if (!STATUSES.includes(c.status)) return out("fail", `status ${JSON.stringify(c.status)} is not one of ${STATUSES.join("|")}`);
      if (typeof c.currency !== "string" || !/^[A-Z]{3}$/.test(c.currency)) return out("fail", `currency ${JSON.stringify(c.currency)} is not ISO-4217 shaped`);
      if (!Array.isArray(c.line_items) || !c.line_items.length) return out("fail", "line_items must be non-empty");
      if (!Array.isArray(c.totals) || c.totals.filter((t: Obj) => t?.type === "total").length !== 1) return out("fail", "totals must contain exactly one total");
      ctx.checkout = c;
      ctx.createBody = body;
      ctx.createKey = key;
      return !Array.isArray(c.links) || !c.links.length ? out("warn", `Created ${c.id} but links is missing`) : out("pass", `Created ${c.id} (${c.status})`);
    },
  },
  { id: "totals_arithmetic", title: "Totals add up", needs: ["create_checkout"], run: async (ctx) => checkTotals(ctx.checkout!.totals) },
  { id: "messages_shape", title: "Messages are well-formed", needs: ["create_checkout"], run: async (ctx) => checkMessages(ctx.checkout!.messages) },
  { id: "status_consistency", title: "Status matches messages", needs: ["create_checkout"], run: async (ctx) => checkStatusConsistency(ctx.checkout!) },
  {
    id: "get_checkout", title: "Get checkout", needs: ["create_checkout"],
    async run(ctx) {
      const r = await ctx.client.get(ctx.checkout!.id);
      if (r.status !== 200) return out("fail", `Get returned ${r.status}`);
      if (r.body?.id !== ctx.checkout!.id) return out("fail", `Got id ${JSON.stringify(r.body?.id)}, expected ${ctx.checkout!.id}`);
      return STATUSES.includes(r.body.status) ? out("pass", `status ${r.body.status}`) : out("fail", `status ${JSON.stringify(r.body.status)} is invalid`);
    },
  },
  {
    id: "idempotent_replay", title: "Idempotent replay", needs: ["create_checkout"],
    async run(ctx) {
      const r = await ctx.client.create(ctx.createBody, ctx.createKey!);
      return r.body?.id === ctx.checkout!.id ? out("pass", "Replay returned the same checkout") : out("warn", `Replay returned ${r.status} with id ${JSON.stringify(r.body?.id)}, expected ${ctx.checkout!.id}`);
    },
  },
  {
    id: "idempotency_conflict", title: "Idempotency key conflict", needs: ["create_checkout"],
    async run(ctx) {
      const other = { line_items: [{ item: ctx.createBody!.line_items[0].item, quantity: 2 }] };
      const r = await ctx.client.create(other, ctx.createKey!);
      return r.status === 409 ? out("pass", "Reused key with a different body returned 409") : out("warn", `Expected 409, got ${r.status}`);
    },
  },
  {
    id: "unknown_checkout", title: "Unknown checkout is not found", needs: ["profile"],
    async run(ctx) {
      const r = await ctx.client.get("ucp-studio-nonexistent");
      if (rejected(r)) return out("pass", `Rejected (${r.status})`);
      return out("fail", `Expected a 4xx or ucp.status "error", got ${r.status}${r.body?.id ? " with a checkout" : ""}`);
    },
  },
  {
    id: "complete_purchase", title: "Complete a test purchase", needs: ["create_checkout"],
    async run(ctx) {
      if (!ctx.allowComplete) return out("skip", "allow_complete was not set");
      const handler = ctx.profile?.ucp?.payment_handlers?.[MOCK];
      if (!handler) return out("skip", `Profile does not offer payment handler ${MOCK}`);
      const id = ctx.checkout!.id;
      const addr = { street_address: "1 Test St", address_locality: "Testville", address_region: "CA", postal_code: "94000", address_country: "US" };
      const base = {
        ...ctx.createBody,
        buyer: { first_name: "Test", last_name: "Buyer", email: "test@example.com", phone_number: "5550100" },
      };
      const withDest = { ...base, fulfillment: { methods: [{ type: "shipping", destinations: [addr] }] } };
      const u1 = await ctx.client.update(id, withDest, randomUUID());
      if (u1.status !== 200) return out("fail", `Update with buyer and address returned ${u1.status}`);
      const option = u1.body?.fulfillment?.methods?.[0]?.groups?.[0]?.options?.[0]?.id;
      if (!option) return out("fail", "No fulfillment option offered after adding an address");
      const withOpt = { ...base, fulfillment: { methods: [{ type: "shipping", destinations: [addr], groups: [{ selected_option_id: option }] }] } };
      const u2 = await ctx.client.update(id, withOpt, randomUUID());
      if (u2.body?.status !== "ready_for_complete") return out("fail", `Expected ready_for_complete, got ${u2.status} ${JSON.stringify(u2.body?.status)}`);
      const handlerId = Array.isArray(handler) && handler[0]?.id ? handler[0].id : "mock_pay";
      const done = await ctx.client.complete(id, { payment: { instruments: [{ id: "i1", handler_id: handlerId, type: "token", credential: { token: "tok_success" } }] } }, randomUUID());
      if (done.body?.status !== "completed") return out("fail", `Expected completed, got ${done.status} ${JSON.stringify(done.body?.status)}`);
      if (!done.body.order?.id || !done.body.order?.permalink_url) return out("fail", "Completed checkout lacks order.id and order.permalink_url");
      ctx.orderId = done.body.order.id;
      return out("pass", `Order ${ctx.orderId}`);
    },
  },
  {
    id: "get_order", title: "Get order", needs: ["complete_purchase"],
    async run(ctx) {
      if (!hasCap(ctx, "dev.ucp.shopping.order")) return out("skip", "Profile lacks dev.ucp.shopping.order");
      const r = await ctx.client.getOrder(ctx.orderId!);
      if (r.status !== 200) return out("fail", `Get order returned ${r.status}`);
      if (r.body?.id !== ctx.orderId) return out("fail", `Order id ${JSON.stringify(r.body?.id)} does not match ${ctx.orderId}`);
      if (r.body?.checkout_id !== ctx.checkout!.id) return out("fail", `checkout_id ${JSON.stringify(r.body?.checkout_id)} does not match ${ctx.checkout!.id}`);
      return out("pass", `Order ${ctx.orderId}`);
    },
  },
  {
    id: "cancel_checkout", title: "Cancel checkout", needs: ["create_checkout"],
    async run(ctx) {
      if (ctx.orderId) return out("skip", "Checkout was completed; nothing to cancel");
      const id = ctx.checkout!.id;
      const c = await ctx.client.cancel(id, randomUUID());
      if (c.body?.status !== "canceled") return out("fail", `Cancel returned ${c.status} with status ${JSON.stringify(c.body?.status)}`);
      const g = await ctx.client.get(id);
      if (g.body?.status !== "canceled") return out("fail", `Get after cancel shows ${JSON.stringify(g.body?.status)}`);
      const u = await ctx.client.update(id, ctx.createBody, randomUUID());
      return rejected(u) ? out("pass", "Canceled; get confirms; update rejected") : out("fail", `Update after cancel was not rejected (${u.status})`);
    },
  },
];

// ---- route ------------------------------------------------------------------------------------

const schema = z.object({
  url: z.string().refine((u) => {
    try {
      return ["http:", "https:"].includes(new URL(u).protocol);
    } catch {
      return false;
    }
  }, "url must be an absolute http(s) URL"),
  transport: z.enum(["rest", "mcp"]).default("rest"),
  item_id: z.string().min(1).optional(),
  allow_complete: z.boolean().default(false),
});

export const conformanceRouter = (baseUrl: string) => {
  const r = Router();
  r.post("/conformance", async (req, res, next) => {
    try {
      const body = schema.parse(req.body);
      if (body.transport === "mcp") return protocolError(res, 400, "invalid_request", "MCP conformance is not available yet");
      const origin = new URL(body.url).origin;
      const started = new Date();
      const t0 = performance.now();
      const state: Ctx["state"] = { exchanges: [] };
      const ctx: Ctx = { client: restClient(origin, baseUrl, state), state, itemId: body.item_id, allowComplete: body.allow_complete };
      const steps = await runSteps(STEPS, ctx);
      const summary = { pass: 0, fail: 0, warn: 0, skip: 0 };
      for (const s of steps) summary[s.status]++;
      res.json({ origin, transport: "rest", started_at: started.toISOString(), duration_ms: Math.round(performance.now() - t0), steps, summary });
    } catch (e) {
      next(e);
    }
  });
  return r;
};
