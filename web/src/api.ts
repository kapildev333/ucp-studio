// ponytail: wire JSON is left untyped; add typed schemas if the UI grows past a demo.
export type J = any;
export type Trace = { id: number; method: string; url: string; status: number | null; duration_ms: number; request: J; response: J; error?: string };
export type Step = "cart" | "buyer" | "shipping" | "pay";
export type Buyer = { first_name: string; last_name: string; email: string; phone_number: string };
export type Address = { street_address: string; address_locality: string; address_region: string; postal_code: string; address_country: string };

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (minor: number) => usd.format(minor / 100);

export const restEndpoint = (profile: J): string | undefined =>
  Object.values(profile?.ucp?.services ?? {})
    .flatMap((v) => (Array.isArray(v) ? v : []))
    .find((e: J) => e?.transport === "rest" && typeof e.endpoint === "string")?.endpoint;

// Which wizard step a checkout message (by JSON path) belongs next to.
export function stepOf(path?: string): Step {
  if (!path) return "pay";
  if (path.startsWith("$.line_items")) return "cart";
  if (path.startsWith("$.buyer") || path.includes("destinations")) return "buyer";
  if (path.includes("selected_option_id")) return "shipping";
  return "pay";
}

// Create/Update body. Update is full replacement on the server, so always rebuild from the whole form.
export function checkoutBody(cart: { id: string; qty: number }[], buyer: Buyer, addr: Address, optionId: string | undefined, withAddress: boolean) {
  const body: J = { line_items: cart.map((c) => ({ item: { id: c.id }, quantity: c.qty })) };
  if (Object.values(buyer).some((v) => v.trim())) body.buyer = buyer;
  const complete = addr.street_address.trim() && addr.address_locality.trim() && addr.postal_code.trim();
  if (withAddress && complete)
    body.fulfillment = { methods: [{ type: "shipping", destinations: [addr], ...(optionId && { groups: [{ selected_option_id: optionId }] }) }] };
  return body;
}

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function errorOf(res: Response, what: string): Promise<Error> {
  const d = await res.json().catch(() => null);
  return new Error(d?.content ?? `${what} returned HTTP ${res.status}`);
}

const UNREACHABLE = "Cannot reach the Studio API. Is the dev server running?";

// The one request path for Studio / back-office JSON calls: network failure and non-2xx become Errors.
async function request(send: Promise<Response>, what: string): Promise<J> {
  let res: Response;
  try {
    res = await send;
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!res.ok) throw await errorOf(res, what);
  return res.json();
}

export const inspect = (url: string): Promise<J> => request(post("/api/inspect", { url }), "Inspect");

let seq = 0;
// Sends one merchant call through /api/proxy and records it in the wire trace (also when it fails).
export async function call(onTrace: (t: Trace) => void, method: "GET" | "POST" | "PUT", url: string, body?: unknown): Promise<{ status: number; body: J }> {
  const failed = (error: string) => {
    onTrace({ id: ++seq, method, url, status: null, duration_ms: 0, request: { method, url, body }, response: null, error });
    return new Error(error);
  };
  let res: Response;
  try {
    res = await post("/api/proxy", { method, url, body });
  } catch {
    throw failed(UNREACHABLE);
  }
  if (!res.ok) throw failed((await errorOf(res, "Proxy")).message);
  const d = await res.json();
  onTrace({ id: ++seq, method, url, status: d.response.status, duration_ms: d.duration_ms, request: d.request, response: d.response });
  return d.response;
}

// ---- v2 transport layer (REST | MCP) ----
export type Transport = "rest" | "mcp";
export type Op = "create_checkout" | "get_checkout" | "update_checkout" | "complete_checkout" | "cancel_checkout" | "search_catalog" | "lookup_catalog" | "get_product" | "get_order";
export type OpCtx = { rpcId: number | string; idempotencyKey: string; agentProfile: string };

export class UcpError extends Error {
  constructor(message: string, public code?: string, public status?: number) {
    super(message);
    this.name = "UcpError";
  }
}

// First endpoint per transport across all services.
export const endpointsOf = (profile: J): { rest?: string; mcp?: string } => {
  const all = Object.values(profile?.ucp?.services ?? {}).flatMap((v) => (Array.isArray(v) ? v : []));
  const first = (t: Transport) => (all.find((e: J) => e?.transport === t && typeof e.endpoint === "string")?.endpoint as string | undefined)?.replace(/\/+$/, "");
  return { rest: first("rest"), mcp: first("mcp") };
};

const MUTATING: Op[] = ["create_checkout", "update_checkout", "complete_checkout", "cancel_checkout"];
const enc = encodeURIComponent;

// Pure: one UCP operation as the request /api/proxy should send.
export function opRequest(transport: Transport, endpoint: string, op: Op, args: J, ctx: OpCtx): { method: "GET" | "POST" | "PUT"; url: string; body?: J } {
  if (transport === "mcp") {
    const meta: J = { "ucp-agent": { profile: ctx.agentProfile }, ...(MUTATING.includes(op) && { "idempotency-key": ctx.idempotencyKey }) };
    return { method: "POST", url: endpoint, body: { jsonrpc: "2.0", id: ctx.rpcId, method: "tools/call", params: { name: op, arguments: { ...args, meta } } } };
  }
  const cs = `${endpoint}/checkout-sessions`;
  switch (op) {
    case "create_checkout": return { method: "POST", url: cs, body: args.checkout };
    case "get_checkout": return { method: "GET", url: `${cs}/${enc(args.id)}` };
    case "update_checkout": return { method: "PUT", url: `${cs}/${enc(args.id)}`, body: args.checkout };
    case "complete_checkout": return { method: "POST", url: `${cs}/${enc(args.id)}/complete`, body: args.checkout };
    case "cancel_checkout": return { method: "POST", url: `${cs}/${enc(args.id)}/cancel`, body: {} };
    case "search_catalog": return { method: "POST", url: `${endpoint}/catalog/search`, body: args };
    case "lookup_catalog": return { method: "POST", url: `${endpoint}/catalog/lookup`, body: args };
    case "get_product": return { method: "POST", url: `${endpoint}/catalog/product`, body: args };
    case "get_order": return { method: "GET", url: `${endpoint}/orders/${enc(args.id)}` };
  }
}

// ponytail: this client only speaks to stateless JSON-response MCP servers (no SSE, no Mcp-Session-Id, no notifications/initialized).
// Pure: the JSON-RPC error (checked first, so a 4xx keeps its data.code) or non-200 status as a UcpError, else undefined.
function rpcFailure(r: { status: number; body: J }): UcpError | undefined {
  const e = r.body?.error;
  if (e) {
    const code = e.data?.code ?? String(e.code);
    return new UcpError(`${code} ${e.message}`, code, r.status);
  }
  if (r.status !== 200) return new UcpError(`MCP endpoint returned HTTP ${r.status}`, undefined, r.status);
}

// Third-party merchants may send non-arrays or null entries where the UI maps/finds; fix them where responses enter the UI.
const LISTS = new Set(["messages", "totals", "line_items", "methods", "groups", "options"]);
export function normalize(v: J): J {
  if (Array.isArray(v)) return v.map(normalize);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, LISTS.has(k) ? (Array.isArray(x) ? x.filter((e) => e && typeof e === "object").map(normalize) : []) : normalize(x)]));
}

// Pure: proxy response -> UCP body, or throws UcpError.
export function parseResponse(transport: Transport, r: { status: number; body: J }): J {
  const b = r.body;
  let out: J = b;
  if (transport === "rest") {
    if (r.status >= 400) throw new UcpError(`${r.status} ${b?.code ?? ""} ${b?.content ?? ""}`.trim(), b?.code, r.status);
  } else {
    const f = rpcFailure(r);
    if (f) throw f;
    out = b?.result?.structuredContent;
    if (!out) throw new UcpError("MCP result has no structuredContent");
  }
  if (out?.ucp?.status === "error" && !out.id) {
    const ms: J[] = Array.isArray(out.messages) ? out.messages : [];
    throw new UcpError(ms.map((m) => `${m?.code ?? "error"} ${m?.content ?? ""}`.trim()).join("; ") || "error", ms[0]?.code);
  }
  return normalize(out);
}

export type Connection = { endpoints: { rest?: string; mcp?: string }; agentProfile: string };
export type Session = { transport: Transport; ucp: (op: Op, args: J) => Promise<J> };

// Reads /.well-known/ucp through the proxy (traced); the agent profile URL comes from the UCP-Agent header the proxy echoes.
export async function connect(onTrace: (t: Trace) => void, merchantUrl: string): Promise<Connection> {
  let echoed: J;
  const r = await call((t) => { echoed = t.request?.headers; onTrace(t); }, "GET", `${merchantUrl.replace(/\/+$/, "")}/.well-known/ucp`);
  if (r.status >= 400) throw new UcpError(`${r.status} ${r.body?.code ?? ""} ${r.body?.content ?? ""}`.trim(), r.body?.code, r.status);
  const h = Object.entries(echoed ?? {}).find(([k]) => k.toLowerCase() === "ucp-agent")?.[1];
  // ponytail: the origin fallback only resolves while the dev server runs; point UCP-Agent at a public profile otherwise.
  const agentProfile = /profile="([^"]*)"/.exec(String(h ?? ""))?.[1] ?? `${window.location.origin}/api/agent-profile`;
  return { endpoints: endpointsOf(r.body), agentProfile };
}

let rpcSeq = 0; // ponytail: module-level counter shared by all sessions; ids only need to be unique per page load.
// Opens a session on one transport; MCP sends a single initialize first.
export async function openSession(onTrace: (t: Trace) => void, conn: Connection, transport: Transport): Promise<Session> {
  const endpoint = conn.endpoints[transport];
  if (!endpoint) throw new UcpError(`This profile offers no ${transport.toUpperCase()} endpoint.`);
  if (transport === "mcp") {
    const r = await call(onTrace, "POST", endpoint, {
      jsonrpc: "2.0", id: ++rpcSeq, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ucp-studio-console", version: "0.2.0" } },
    });
    const f = rpcFailure(r);
    if (f) throw f;
    if (!r.body?.result?.protocolVersion) throw new UcpError("MCP initialize failed: no protocolVersion in result", undefined, r.status);
  }
  return {
    transport,
    ucp: async (op, args) => {
      const q = opRequest(transport, endpoint, op, args, { rpcId: ++rpcSeq, idempotencyKey: crypto.randomUUID() /* ponytail: fresh key per call, so the UI cannot retry idempotently */, agentProfile: conn.agentProfile });
      return parseResponse(transport, await call(onTrace, q.method, q.url, q.body));
    },
  };
}

// ---- v2 order panel helpers ----
// Pure: "ord_1 · 2/2 fulfilled · shipped" from an order (or webhook body); tolerant of missing fields.
export function orderSummary(o: J): string {
  const lines: J[] = Array.isArray(o?.line_items) ? o.line_items : [];
  const n = (k: string) => lines.reduce((s, l) => s + (Number(l?.quantity?.[k]) || 0), 0);
  const events: J[] = Array.isArray(o?.fulfillment?.events) ? o.fulfillment.events : [];
  return `${o?.id ?? "?"} · ${n("fulfilled")}/${n("total")} fulfilled · ${events.at(-1)?.type ?? lines[0]?.status ?? "processing"}`;
}

// Pure: true when merchantUrl parses and has the same origin as `origin`.
export function sameOrigin(merchantUrl: string, origin: string): boolean {
  try {
    return new URL(merchantUrl).origin === origin;
  } catch {
    return false;
  }
}

// Pure: the url when it is http(s), else undefined (blocks javascript: and friends in merchant-supplied hrefs).
export const safeHttpUrl = (u: unknown): string | undefined => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : undefined);

export const runConformance = (body: { url: string; transport: "rest" | "mcp"; allow_complete: boolean }): Promise<J> => request(post("/api/conformance", body), "Conformance");

export const getCatalog = (): Promise<J> => request(fetch("/merchant-admin/catalog"), "Catalog");
export const importCatalog = (body: { replace: boolean; products: J[] }): Promise<J> => request(post("/merchant-admin/catalog/import", body), "Import");
export const resetCatalog = (): Promise<J> => request(post("/merchant-admin/catalog/reset", {}), "Reset");
export const getOrders = (): Promise<J> => request(fetch("/merchant-admin/orders"), "Orders");
export const shipOrder = (id: string): Promise<J> => request(post(`/merchant-admin/orders/${enc(id)}/ship`, {}), "Ship");

// Pure: "unfulfilled" | "partial" | "fulfilled" from an order's line items (tolerates missing fields).
export function fulfillmentStatus(o: J): "unfulfilled" | "partial" | "fulfilled" {
  const lines: J[] = Array.isArray(o?.line_items) ? o.line_items.filter(Boolean) : [];
  const done = lines.filter((l) => l.status === "fulfilled").length;
  return lines.length && done === lines.length ? "fulfilled" : done ? "partial" : "unfulfilled";
}

// Pure: quantity field text -> positive integer, or "" so the field can be empty while typing (validated on blur / submit).
export const editQty = (raw: string): number | "" => {
  const n = Math.floor(Number(raw));
  return raw.trim() !== "" && n >= 1 ? n : "";
};

// Pure: capabilities seen so far plus any new ones (by name), so the chip row does not flip per operation.
export const mergeCaps = (prev: { name: string; version: string }[], next: unknown): { name: string; version: string }[] => {
  const add = (Array.isArray(next) ? next : []).filter((c) => c && typeof c.name === "string" && !prev.some((p) => p.name === c.name));
  return add.length ? [...prev, ...add] : prev;
};
