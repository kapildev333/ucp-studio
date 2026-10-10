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

export async function inspect(url: string): Promise<J> {
  let res: Response;
  try {
    res = await post("/api/inspect", { url });
  } catch {
    throw new Error("Cannot reach the Studio API. Is the server running on 127.0.0.1:4000?");
  }
  if (!res.ok) throw await errorOf(res, "Inspect");
  return res.json();
}

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
    throw failed("Cannot reach the Studio API. Is the server running on 127.0.0.1:4000?");
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

// Pure: proxy response -> UCP body, or throws UcpError.
export function parseResponse(transport: Transport, r: { status: number; body: J }): J {
  const b = r.body;
  let out: J = b;
  if (transport === "rest") {
    if (r.status >= 400) throw new UcpError(`${r.status} ${b?.code ?? ""} ${b?.content ?? ""}`.trim(), b?.code, r.status);
  } else {
    if (r.status !== 200) throw new UcpError(`MCP endpoint returned HTTP ${r.status}`, undefined, r.status);
    if (b?.error) {
      const code = b.error.data?.code ?? String(b.error.code);
      throw new UcpError(`${code} ${b.error.message}`, code);
    }
    out = b?.result?.structuredContent;
    if (!out) throw new UcpError("MCP result has no structuredContent");
  }
  if (out?.ucp?.status === "error" && !out.id) {
    const m = out.messages?.[0];
    throw new UcpError(`${m?.code ?? "error"} ${m?.content ?? ""}`.trim(), m?.code);
  }
  return out;
}

export type Connection = { endpoints: { rest?: string; mcp?: string }; agentProfile: string };
export type Session = { transport: Transport; ucp: (op: Op, args: J) => Promise<J> };

// Reads /.well-known/ucp through the proxy (traced); the agent profile URL comes from the UCP-Agent header the proxy echoes.
export async function connect(onTrace: (t: Trace) => void, merchantUrl: string): Promise<Connection> {
  let echoed: J;
  const r = await call((t) => { echoed = t.request?.headers; onTrace(t); }, "GET", `${merchantUrl.replace(/\/+$/, "")}/.well-known/ucp`);
  if (r.status >= 400) throw new UcpError(`${r.status} ${r.body?.code ?? ""} ${r.body?.content ?? ""}`.trim(), r.body?.code, r.status);
  const h = Object.entries(echoed ?? {}).find(([k]) => k.toLowerCase() === "ucp-agent")?.[1];
  const agentProfile = /profile="([^"]*)"/.exec(String(h ?? ""))?.[1] ?? `${window.location.origin}/api/agent-profile`;
  return { endpoints: endpointsOf(r.body), agentProfile };
}

let rpcSeq = 0;
// Opens a session on one transport; MCP sends a single initialize first.
export async function openSession(onTrace: (t: Trace) => void, conn: Connection, transport: Transport): Promise<Session> {
  const endpoint = conn.endpoints[transport];
  if (!endpoint) throw new UcpError(`This profile offers no ${transport.toUpperCase()} endpoint.`);
  if (transport === "mcp") {
    const r = await call(onTrace, "POST", endpoint, {
      jsonrpc: "2.0", id: ++rpcSeq, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ucp-studio-console", version: "0.2.0" } },
    });
    if (r.status !== 200 || r.body?.error || !r.body?.result?.protocolVersion)
      throw new UcpError(r.body?.error ? `${r.body.error.data?.code ?? r.body.error.code} ${r.body.error.message}` : "MCP initialize failed: no protocolVersion in result", r.body?.error?.data?.code ?? (r.body?.error ? String(r.body.error.code) : undefined), r.status);
  }
  return {
    transport,
    ucp: async (op, args) => {
      const q = opRequest(transport, endpoint, op, args, { rpcId: ++rpcSeq, idempotencyKey: crypto.randomUUID(), agentProfile: conn.agentProfile });
      return parseResponse(transport, await call(onTrace, q.method, q.url, q.body));
    },
  };
}
