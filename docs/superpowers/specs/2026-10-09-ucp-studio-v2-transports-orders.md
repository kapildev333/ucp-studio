# UCP Studio v2 — capability negotiation, orders + webhooks, MCP transport

Builds on `2026-10-09-ucp-studio-design.md` (v1), which stays binding wherever this spec is silent.
Where the two disagree, this one wins.

## Purpose

v1 is a REST-only merchant that trusts whatever agent calls it and forgets an order once it is placed.
v2 makes the reference merchant behave like a real UCP business in three ways a developer needs to see working:

1. **Capability negotiation** — the merchant fetches the calling platform's profile and answers with the intersection.
2. **Orders** — the `dev.ucp.shopping.order` capability: a real order object, `GET /orders/{id}`, and webhooks to the platform.
3. **MCP transport** — the same operations as MCP tools at `/ucp/mcp`, so an MCP client (including an LLM agent) can shop.

The web console gains a REST/MCP switch, the negotiated capabilities, and a live order + webhook view.

## Constraints

Unchanged from v1: free, localhost-only, Node 22, TypeScript strict, Express 4, better-sqlite3, zod, vitest, React 18 + Vite.
**No new runtime dependencies** — MCP is plain JSON-RPC over one POST route, written by hand. Money in minor units, `USD`,
UCP version `2026-08-25` from `server/src/ucp.ts`. Studio code still must not import merchant code.
Deliberate shortcuts carry a `// ponytail:` comment naming the ceiling.

`createApp` gains one optional test seam: `createApp({ dbPath, baseUrl, fetch? })`, defaulting to global `fetch`.
Every outbound HTTP call the **merchant** makes (platform profile, webhooks) goes through it.

## Part A — transport-independent services and capability negotiation

### A1. Service layer

Move operation logic out of the Express handlers so REST and MCP are thin adapters over the same functions:

```
server/src/merchant/
  errors.ts            class ProtocolError(status, code, content)
  negotiate.ts         fetch + cache platform profile, intersection (pure part unit-tested)
  catalog-service.ts   search, lookup, getProduct
  checkout-service.ts  create, get, update, complete, cancel   (uses checkout-logic.ts)
  order-service.ts     Part B
  rest.ts              Express routes: parse → service → respond   (replaces catalog.ts/checkout.ts route code)
  mcp.ts               Part C
```

A service function takes `(ctx, input)` where `ctx = { db, baseUrl, fetch, negotiated, idempotencyKey? }` and returns
`{ status: 200 | 201, body }` or throws `ProtocolError`. No `req`/`res` inside services. Idempotency moves into the
checkout service (keyed on operation name + checkout id + canonical input), so both transports share it.
All v1 tests keep passing, adjusted only for the negotiation seam below.

### A2. Negotiation

For every UCP operation (REST `/ucp/*` and MCP `tools/call`):

1. Take the platform profile URL from `UCP-Agent` (REST) or `meta["ucp-agent"].profile` (MCP). Missing or not an absolute
   http(s) URL → `invalid_profile_url` (REST 400).
2. Fetch it with `ctx.fetch`, 3 s timeout, `Accept: application/json`; cache successes in memory per URL for 5 minutes.
   - network error, timeout, or non-2xx → `profile_unreachable` (REST 424)
   - body is not a JSON object with `ucp.version` matching `^\d{4}-\d{2}-\d{2}$` → `profile_malformed` (REST 422)
   - `ucp.version` later than the merchant's → `version_unsupported` (REST 422)
3. Intersect (pure function `intersect(businessCaps, platformCaps)`):
   - keep each business capability whose name the platform also lists;
   - for each, pick the highest version date present in both arrays; none in common → drop it;
   - drop any capability with `extends` whose parent was dropped; repeat until stable.
   A platform profile with no `capabilities` object negotiates to the empty set.
4. Each operation has a root capability: checkout ops → `dev.ucp.shopping.checkout`; search → `…catalog.search`;
   lookup and product → `…catalog.lookup`; get order → `dev.ucp.shopping.order`.
   Root not negotiated → HTTP 200 with
   `{ "ucp": { "version", "status": "error", "capabilities": [] }, "messages": [{ "type": "error", "code": "capabilities_incompatible", "severity": "unrecoverable", "content": "..." }] }`.
5. The response envelope's `capabilities` lists the negotiated capabilities relevant to the operation
   (checkout responses: checkout + fulfillment if negotiated; catalog: the catalog pair as negotiated; order: order).
6. **Fulfillment is a real extension.** When `dev.ucp.shopping.fulfillment` is not negotiated, checkouts carry no
   `fulfillment`, ignore any sent, emit no fulfillment messages and no `fulfillment` total; `ready_for_complete` then needs only
   stock and `buyer.email`.

The merchant's own outbound fetch of arbitrary profile URLs is acceptable only because the server binds to `127.0.0.1`;
say so in a `ponytail:` comment.

Tests: `intersect` unit tests (same-name match, highest common version, no common version, orphaned extension pruned
transitively); route tests with an injected `fetch` for each error code, the incompatible-root outcome, cache hit (one fetch for
two calls), and a checkout without the fulfillment extension reaching `ready_for_complete` on email alone.

## Part B — orders and webhooks

### B1. Order object

Profile adds capability `"dev.ucp.shopping.order": [{ "version": "2026-08-25" }]`.
On a successful Complete the merchant stores an immutable-except-fulfillment **snapshot** (JSON column) of:

```json
{
  "id": "ord_...", "checkout_id": "chk_...", "permalink_url": "<baseUrl>/orders/ord_...", "currency": "USD",
  "line_items": [ { "id": "li_1", "item": { "id": "<variant>", "title": "...", "price": 1299 },
                    "quantity": { "original": 2, "total": 2, "fulfilled": 0 },
                    "totals": [ ...as on the checkout line... ], "status": "processing" } ],
  "fulfillment": {
    "expectations": [ { "id": "exp_1", "line_items": [ { "id": "li_1", "quantity": 2 } ], "method_type": "shipping",
                        "destination": { ...checkout destination... }, "description": "Standard (5-7 days)" } ],
    "events": []
  },
  "adjustments": [],
  "totals": [ ...checkout totals... ]
}
```

`expectations` is `[]` when the checkout had no fulfillment. The checkout's `order` stays `{ id, permalink_url }`.

- `GET /ucp/orders/:id` — UCP headers + negotiation (root `dev.ucp.shopping.order`) → `{ ucp, ...order }`; unknown → `404 not_found`.
- `GET /orders/:id` (the permalink, no UCP headers) now returns the same order object without `ucp`.

### B2. Back-office action (demo only, not UCP)

`POST /merchant-admin/orders/:id/ship` → every line becomes `quantity.fulfilled = total`, `status: "fulfilled"`, and one event is
appended: `{ id: "evt_...", occurred_at, type: "shipped", line_items: [{ id, quantity }], tracking_number: "UCPS" + 10 digits, tracking_url: "<baseUrl>/track/<number>", carrier: "MockShip", description: "Shipped" }`.
Returns the order. Already fulfilled → `409 invalid_state`; unknown → 404. No auth (localhost demo; `ponytail:` comment).

### B3. Webhooks

At Complete, if the platform's profile entry for `dev.ucp.shopping.order` (the negotiated version) has
`config.webhook_url` that is an absolute http(s) URL, store it on the order row.
After the order is created, and again after `ship`, POST to it:

- body: the full order object plus `event_id` (`evt_…`, unique per delivery event) and `created_time` (RFC 3339)
- headers: `Content-Type: application/json`, `Webhook-Id: <event_id>`, `Webhook-Timestamp: <unix seconds>`,
  `UCP-Agent: profile="<baseUrl>/.well-known/ucp"`
- delivery happens after the HTTP response is sent; a non-2xx or network error is retried up to 3 attempts total with
  1 s then 5 s waits, then dropped. In-process only, unsigned — both marked `ponytail:` (ceilings: durable queue; RFC 9421 signatures).

Webhook failure never affects the Complete or ship response.

Tests (injected `fetch`, fake timers for retry): snapshot contents; snapshot unaffected by a later catalog/stock change;
`GET /ucp/orders/:id` negotiated and not; ship transitions and 409; webhook sent on complete and on ship with the headers
above; no webhook without `webhook_url`; retry then give up; failure does not change the HTTP response.

### B4. Studio side

- `GET /api/agent-profile` adds `"dev.ucp.shopping.order": [{ "version": "2026-08-25", "config": { "webhook_url": "<baseUrl>/api/webhooks/orders" } }]`.
- `POST /api/webhooks/orders` stores `{ received_at, headers: { webhook-id, webhook-timestamp, ucp-agent }, body }` in an
  in-memory list capped at 200 (newest first; `ponytail:` comment) and returns 204. Body must be a JSON object, else 400.
- `GET /api/webhooks/orders` → `{ events: [...] }`, newest first. `DELETE /api/webhooks/orders` clears it → 204.

## Part C — MCP transport

`POST /ucp/mcp`, JSON-RPC 2.0, one request object per POST, JSON response (no SSE, no sessions — stateless).
Mounted outside the REST UCP-header middleware: identity arrives in `meta`. `GET`/`DELETE /ucp/mcp` → 405.

| Method | Result |
|---|---|
| `initialize` | `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ucp-studio-merchant", version: "0.2.0" } }` — `protocolVersion` echoes the client's if it is `2025-06-18` or `2025-03-26`, else `2025-06-18` |
| any notification (no `id`), e.g. `notifications/initialized` | HTTP 202, empty body |
| `ping` | `{}` |
| `tools/list` | `{ tools: [{ name, description, inputSchema }] }` |
| `tools/call` | below |

JSON-RPC errors: unparseable body `-32700`; not a single valid request object (incl. batch arrays) `-32600`;
unknown method `-32601`; unknown tool or arguments failing validation `-32602`.

**Tools.** Checkout names and argument shapes follow the UCP MCP binding; the catalog and order tool names are this
project's choice (say so in the README):

| Tool | Arguments (besides `meta`) | Service |
|---|---|---|
| `create_checkout` | `checkout` (v1 create body) | checkout create |
| `get_checkout` | `id` | checkout get |
| `update_checkout` | `id`, `checkout` | checkout update |
| `complete_checkout` | `id`, `checkout: { payment }` | checkout complete |
| `cancel_checkout` | `id` | checkout cancel |
| `search_catalog` | `query?`, `filters?`, `pagination?` | catalog search |
| `lookup_catalog` | `ids` | catalog lookup |
| `get_product` | `id` | catalog product |
| `get_order` | `id` | order get |

- `meta["ucp-agent"].profile` is required on every tool call; negotiation runs exactly as in A2.
- `meta["idempotency-key"]` is required for `complete_checkout` and `cancel_checkout`, optional for create/update
  (the REST adapter keeps requiring it on all four, as in v1).
- Success and business outcomes (anything a service *returns*) →
  `result: { structuredContent: <body>, content: [{ type: "text", text: JSON.stringify(body) }], isError: false }`;
  `isError` is `true` when `body.ucp.status === "error"`.
- A thrown `ProtocolError` → JSON-RPC `error`: code `-32001` for `invalid_profile_url`, `profile_unreachable`,
  `profile_malformed`, `version_unsupported`; `-32000` for everything else; `message` = content; `data: { code, content }`.
- `inputSchema` is hand-written JSON Schema, kept loose: required top-level keys and their types only; zod does the real validation.

Profile `services["dev.ucp.shopping"]` gains `{ "version": "2026-08-25", "transport": "mcp", "endpoint": "<baseUrl>/ucp/mcp" }`.

Inspector gets one more check, after `live_catalog`, present only when an `mcp` transport entry with an absolute URL exists:
`live_mcp` — `initialize` returns a result with `protocolVersion`, and `tools/list` contains `create_checkout`.

Tests: each JSON-RPC error code; initialize version echo and fallback; notification → 202; tools/list names; a full purchase
over MCP (search → create → update → complete → get_order) asserting `structuredContent`; missing meta → `-32001`;
missing idempotency key on complete → `-32602`; idempotent replay shared across transports (complete over MCP, then the same
key and input over MCP again replays); `not_found` → `-32000` with `data.code`; `live_mcp` check pass and absent.

## Part D — web

- `web/src/api.ts`: one `ucp(op, args)` function per session that maps an operation to either a REST request or an MCP
  `tools/call`, both through `POST /api/proxy`, and returns the UCP body either way (`structuredContent` for MCP; a JSON-RPC
  `error` surfaces as an error with `data.code`). Components never branch on transport.
- **Agent Console**
  - After Connect, a transport switch **REST | MCP** (radio group) listing only transports the profile offers; switching resets
    the session. With MCP the console sends `initialize` once on connect.
  - A "Negotiated capabilities" chip row from the latest response's `ucp.capabilities`.
  - After a completed purchase: an **Order** panel fetched via `get order` — line statuses, fulfillment events, totals — with
    a **Simulate shipment** button (shown only when the merchant origin equals `window.location.origin`; it calls
    `/merchant-admin/orders/:id/ship` directly and refreshes), and a **Webhooks received** list polling
    `GET /api/webhooks/orders` every 2 s while the panel is mounted and the document is visible, showing time, `webhook-id`
    and the order status summary, expandable to the JSON.
  - `capabilities_incompatible` and JSON-RPC errors render in the existing inline error banner.
- The wire trace needs no change beyond showing JSON-RPC bodies as it already shows JSON.
- Vite dev proxy adds `/merchant-admin` and `/track`. `GET /track/:number` on the server returns a one-line plain-text placeholder.
- README: document the three new features, the MCP endpoint with a `curl` `tools/list` example, and the new simplifications.

Verification: `tsc --noEmit` + `vite build`; one vitest unit test for the op → request mapping in `api.ts`; and a recorded
real run with `npm run dev` + `curl`: an MCP `tools/list`, and a full purchase through `/api/proxy` followed by
`GET /api/webhooks/orders` showing the delivered event.

## Work breakdown

One worker, in this order; each task ends green (`npm test`, `npm run build`) and committed.

### Task 1: Service layer and capability negotiation (Part A)
### Task 2: Orders, back-office ship, webhooks, studio webhook receiver (Part B)
### Task 3: MCP transport and `live_mcp` inspector check (Part C)
### Task 4: Web console v2 and README (Part D)

## Out of scope

Webhook and request signatures, durable webhook queue, MCP sessions/SSE/resources/prompts, identity linking, refunds and
adjustments, cart capability, discounts, A2A and embedded transports, deployment.
