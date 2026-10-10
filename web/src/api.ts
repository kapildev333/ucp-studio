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
