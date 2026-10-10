# UCP Studio

A free, localhost-only developer toolkit for the [Universal Commerce Protocol](https://ucp.dev) (UCP, version `2026-08-25`):
a reference merchant (REST and MCP, SQLite), a studio API (profile inspector, tracing proxy, conformance runner, webhook receiver),
a merchant back-office API, and a web console with four tabs that drives all of it.

## Quick start

```
npm install
npm run dev     # server on 127.0.0.1:4000, web on http://127.0.0.1:5173
npm test        # server and web tests
npm run build   # type-check both, build the web app
```

Open http://127.0.0.1:5173. The web app relies on the Vite proxy, so it only works while `npm run dev` is running. The proxy forwards `/api`, `/ucp`, `/.well-known`, `/orders`, `/merchant-admin` and `/track` to the server.

### Ports and environment

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `4000` | Port the server listens on (always on `127.0.0.1`). The Vite proxy follows it, so `PORT=4100 npm run dev` is enough. |
| `WEB_PORT` | `5173` | Port of the Vite dev server (`127.0.0.1`). |
| `UCP_SERVER` | `http://127.0.0.1:$PORT` | Server origin the Vite proxy targets. Set it only to point the web app at a server started some other way; it wins over `PORT`. |
| `BASE_URL` | `http://127.0.0.1:$PORT` | Origin the merchant puts in its profile, permalinks and tracking URLs. |

The SQLite database is `server/data.db` (created on first run, git-ignored).

## Features

- **Inspector** - point it at any merchant origin; it fetches `/.well-known/ucp` and runs a checklist (version, services, payment handlers, capabilities, REST endpoint, transport security, keys, live catalog search, live MCP check) with pass/warn/fail results and the raw profile.
- **Agent Console** - a guided purchase (connect, search, cart, checkout, buyer and address, shipping, pay) over REST or MCP, with a switch between them when the profile offers both. Every call lands in a wire trace: MCP rows show the JSON-RPC method and tool, each entry has Copy as curl, and the trace downloads as JSON or Markdown. The chips show the union of capabilities negotiated so far in the session. After a purchase an Order panel shows the order, fulfillment events and webhooks received. Works against any UCP merchant, not just the built-in one.
- **Conformance** - runs a scripted checkout against any merchant over REST or MCP and asserts each step against the UCP spec (pass/fail/warn/skip, with the wire exchanges). A run creates and then cancels one checkout on the target; the optional test purchase only uses the mock payment handler. Over MCP, steps that are REST-only come back `skip` with the reason; a call that got no response is shown as an error, not an HTTP status. The report downloads as Markdown.
- **Merchant** - back-office for the built-in merchant only: catalog table (price, stock), import, reset to the sample catalog, download of the current catalog, and an Orders table (id, created, total, fulfillment) with a Ship button for unfulfilled orders. No auth.

The built-in merchant offers `/.well-known/ucp` discovery, catalog search/lookup/product, checkout sessions (create, get, update, complete, cancel) with idempotency keys, stock checks, a flat tax, two shipping options, orders with webhooks and a mock payment handler (`tok_success`, `tok_decline`).

## MCP endpoint

`http://127.0.0.1:4000/ucp/mcp` is JSON-RPC 2.0 over one POST per call, stateless. An MCP client that speaks plain JSON-response HTTP can be pointed at that URL.

```
curl -s http://127.0.0.1:4000/ucp/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Tools: `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout`, `cancel_checkout`, `search_catalog`, `lookup_catalog`, `get_product`, `get_order`. The caller's identity goes in `meta["ucp-agent"].profile` and the idempotency key (required for `complete_checkout` and `cancel_checkout`) in `meta["idempotency-key"]`. The checkout tool names follow the UCP MCP binding; the catalog and order tool names are this project's own choice.

## Capability negotiation, orders and webhooks

- The merchant fetches the platform profile named in the `UCP-Agent` header (REST) or `meta["ucp-agent"].profile` (MCP) and answers with the intersection of both sides' capabilities and versions. Failures are protocol errors: `invalid_profile_url`, `profile_unreachable`, `profile_malformed`, `version_unsupported`. `capabilities_incompatible` is an HTTP 200 body with `ucp.status: "error"` (an MCP result with `isError: true`). The capabilities returned are those relevant to the operation, so they differ between calls.
- `GET /ucp/orders/:id` returns an order; `/orders/:id` returns the same JSON (it is the order's `permalink_url`).
- `GET /merchant-admin/orders` lists orders (newest first, at most 100, each with `created_at`). `POST /merchant-admin/orders/:id/ship` marks every line fulfilled and appends a `shipped` event with a tracking URL under `/track/`; it returns 409 `invalid_state` when already fulfilled.
- When the platform profile's order capability sets `config.webhook_url`, the merchant POSTs the order there on checkout complete and on ship, with `Webhook-Id`, `Webhook-Timestamp` and `UCP-Agent` headers. The studio receives them at `GET/POST/DELETE /api/webhooks/orders`, the URL its own agent profile advertises.
- An unknown `/api/*` path returns `404 {"code":"not_found","content":...}`.

## Catalog import

Paste or upload JSON in the Merchant tab, or `POST` it to `/merchant-admin/catalog/import`. `price` is an integer in minor units (cents):

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

Back-office writes are rejected with 403 when the browser marks them `Sec-Fetch-Site: cross-site` or `same-site`. The web app's own requests are same-origin and pass.

## Tests

`npm test` runs the server suite (vitest + supertest, in-memory or temp SQLite) and the web suite (vitest, node environment: pure functions and server-rendered markup; there is no browser or DOM test environment). `npm run build` type-checks both packages and builds the web app.

## Deliberate simplifications

Out of scope, from the three design specs: signatures and `Content-Digest` (request and webhook), a durable webhook queue, MCP sessions, SSE, resources and prompts, identity linking, refunds and adjustments, the cart capability, discounts, A2A and embedded transports, auth (including on the back-office), deployment, CSV import, product images, scheduled or CI conformance runs, a public conformance badge.

Ceilings in the code:

- The tax rate is a flat 8%.
- `/api/proxy` is an open forwarder and the merchant fetches whatever profile URL the caller names; acceptable only because the server binds to `127.0.0.1` (the Studio API also checks the `Host` against a localhost allowlist, so a custom local hostname needs that list extended).
- `/merchant-admin` has no auth; its only protection is the `Sec-Fetch-Site` check above.
- The platform profile cache is in memory, shared by REST and MCP, unbounded, with a 5 minute TTL on read.
- The database has no migrations: bumping the schema version drops and recreates orders, checkouts and idempotency records.
- Webhooks are unsigned, retried in-process 3 times (1 s, then 5 s), and a restart loses pending retries. The studio's received-webhook list is in memory, capped at 200.
- MCP: no batching, request bodies over 100 kb are rejected. The console and conformance clients speak plain JSON-RPC POST only (no `initialize` for conformance, no session id, no SSE), so an MCP merchant that needs those fails.
- The catalog is loaded whole per request and filtered in JS.
- An expired checkout nobody canceled reads as canceled but is never written.
- `UCP-Agent` is parsed with a regex, not a full RFC 8941 parser.
- Conformance: without the catalog capability, a GET of a nonexistent checkout stands in for a probe, so a 4xx there may be a plain 404. REST-only probes are skipped over MCP.
- Web: wire JSON is untyped; the Agent Console falls back to `<origin>/api/agent-profile` as the agent profile when the proxy does not echo one, which only resolves while the dev server runs; it uses a fresh idempotency key per call, so the UI cannot retry idempotently; catalog import errors split on `"; "`, so a message containing it splits too.
