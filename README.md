# UCP Studio

A free, localhost-only developer toolkit for the [Universal Commerce Protocol](https://ucp.dev) (UCP, version `2026-08-25`):
a reference merchant, a profile inspector, and an agent console that shows every call on the wire.

## Run

```
npm install
npm run dev     # server on 127.0.0.1:4000, web on http://127.0.0.1:5173
npm test        # server and web tests
npm run build   # type-check both, build the web app
```

Open http://127.0.0.1:5173. The web app (including the Agent Console's default merchant URL) only works while `npm run dev` is running, because it relies on the Vite proxy. The web dev server proxies `/api`, `/ucp`, `/.well-known`, `/orders`, `/merchant-admin` and `/track` to the server.

## Features

1. **Reference merchant** - `/.well-known/ucp` discovery, catalog search/lookup/product, and checkout sessions
   (create, get, update, complete, cancel) with idempotency keys, stock checks, a flat tax, two shipping options and a mock payment handler (`tok_success`, `tok_decline`).
2. **Inspector** - point it at any merchant origin; it fetches the profile and runs a checklist (version, services, payment handlers, capabilities, REST endpoint, transport security, keys, live catalog search) with pass/warn/fail results.
3. **Agent Console** - a guided purchase (connect, search, cart, checkout, buyer and address, shipping, pay) driven through a tracing proxy, with a live wire trace of every request and response. Works against any UCP merchant, not just the built-in one.

## v3: conformance, back-office, export

4. **Conformance** - runs a scripted checkout against any merchant and asserts each step against the UCP spec (pass/fail/warn/skip per step, with the wire exchanges). A run creates and then cancels one checkout session on the target. The optional test purchase only happens with the mock payment handler. The UI offers an MCP transport, but the server does not support it yet; use REST. The report downloads as Markdown.
5. **Merchant back-office** - the Merchant tab operates on the built-in merchant only: catalog table (stock, price), import, reset to the sample catalog, and download of the current catalog. No auth, localhost demo.
6. **Trace export** - in the Agent Console trace: Copy as curl (per entry), Download JSON and Download report (.md).

### Catalog import

Paste or upload JSON in the Merchant tab, or `POST` it. `price` is an integer in minor units (cents):

```json
{
  "products": [
    {
      "title": "Canvas Tote",
      "description": "Heavy cotton tote bag",
      "categories": ["bags"],
      "variants": [
        { "sku": "TOTE-NAT", "title": "Natural", "price": 1800, "stock": 25, "options": [{ "name": "color", "label": "Natural" }] },
        { "sku": "TOTE-BLK", "title": "Black", "price": 1800, "stock": 0 }
      ]
    }
  ]
}
```

- 1-500 products, 1-50 variants each, `title` up to 200 characters, `sku` unique within the request. `id` (product and variant), `description`, `categories` and `options` are optional.
- A missing `id` is generated; an `id` that already exists updates that row instead of adding one.
- `replace: true` deletes the existing catalog first (default `false`: merge). In the web form the "Replace existing catalog" checkbox decides and a `replace` key in the pasted JSON is ignored; a bare array of products is also accepted there.
- Invalid input returns HTTP 400 listing each failing path.

```bash
curl -X POST http://127.0.0.1:4000/merchant-admin/catalog/import \
  -H 'Content-Type: application/json' -d '{"replace":false,"products":[{"title":"Canvas Tote","variants":[{"sku":"TOTE-NAT","title":"Natural","price":1800,"stock":25}]}]}'
```

## Deliberate simplifications

Out of scope for v1: signatures and `Content-Digest`, fetching the platform profile and real capability negotiation,
MCP/A2A/embedded transports, identity linking, order webhooks, the cart capability, discounts, auth, and deployment.
Also: the tax rate is a flat 8%, the merchant does not fetch the platform profile named in `UCP-Agent`, and `/api/proxy` is an open
forwarder, which is why the server binds to `127.0.0.1` only.

## v2

v2 adds capability negotiation, orders with webhooks, an MCP transport and the matching Agent Console pieces. This section supersedes the v1 sentences above that say the merchant does not fetch the platform profile and that MCP and order webhooks are out of scope.

### Capability negotiation

The merchant fetches the platform profile named in the `UCP-Agent` header (REST) or `meta["ucp-agent"].profile` (MCP) and answers with the intersection of both sides' capabilities and versions. Failures are protocol errors with these codes: `invalid_profile_url`, `profile_unreachable`, `profile_malformed` and `version_unsupported`. `capabilities_incompatible` (no shared version of a root capability) is not a protocol error: it is an HTTP 200 body with `ucp.status: "error"` (an MCP result with `isError: true`). Fulfillment is a real extension of checkout, so it is only offered when both sides support it.

### Orders and webhooks

- `GET /ucp/orders/:id` returns the order; `/orders/:id` returns the same order JSON (it is the order's `permalink_url`).
- The demo back office `POST /merchant-admin/orders/:id/ship` marks every line fulfilled and appends a `shipped` fulfillment event with a tracking URL under `/track/`. It returns 409 `invalid_state` when the order is already fulfilled.
- When the platform profile's order capability sets `config.webhook_url`, the merchant POSTs the order there on checkout complete and on ship, with headers `Webhook-Id`, `Webhook-Timestamp` and `UCP-Agent`.
- The studio receives them at `GET/POST/DELETE /api/webhooks/orders` (the URL its own agent profile advertises).

### MCP transport

The endpoint is `http://127.0.0.1:4000/ucp/mcp`: JSON-RPC 2.0 over a single POST per call, stateless. The console client only speaks to stateless JSON-response MCP servers (no SSE, no `Mcp-Session-Id`, no `notifications/initialized`).

```
curl -s http://127.0.0.1:4000/ucp/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Tools: `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout`, `cancel_checkout`, `search_catalog`, `lookup_catalog`, `get_product`, `get_order`. The caller's identity goes in `meta["ucp-agent"].profile` and the idempotency key (required for `complete_checkout` and `cancel_checkout`) in `meta["idempotency-key"]`. The checkout tool names follow the UCP MCP binding; the catalog and order tool names (`search_catalog`, `lookup_catalog`, `get_product`, `get_order`) are this project's own choice.

### Agent Console

A REST | MCP switch runs the same guided purchase over either transport, with chips for the negotiated capabilities. After a purchase an Order panel shows the order, its line items, fulfillment events and totals, with Refresh. **Simulate shipment** calls the demo back office and is shown only when the merchant URL is the console's own origin. **Webhooks received** polls the studio receiver every 2 s while the panel is mounted and the tab is visible, lists the events for this order newest first (expand a row for the JSON) and has a Clear all button (it clears every order's webhooks on the studio).

### New simplifications

- Webhooks are unsigned (no RFC 9421 signatures).
- Delivery retries in-process, 3 attempts (1 s then 5 s later), with no durable queue; a restart loses pending retries.
- The studio's webhook list is in memory, capped at 200 events.
- MCP has no sessions, no SSE and no batching.
- `/merchant-admin` has no auth.
- The platform profile cache is in memory (5 minutes).
- The merchant fetches whatever profile URL the caller names; that is acceptable only because the server binds to `127.0.0.1`.

### Dev server

The Vite dev proxy now covers `/api`, `/ucp`, `/.well-known`, `/orders`, `/merchant-admin` and `/track`. Optional environment variables: `UCP_SERVER` (server origin, default `http://127.0.0.1:4000`; the server itself always listens on 4000, so this only helps when it is started some other way) and `WEB_PORT` (default `5173`).
