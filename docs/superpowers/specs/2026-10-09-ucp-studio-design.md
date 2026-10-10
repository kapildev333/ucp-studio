# UCP Studio — design spec

## Purpose

A free, local developer toolkit for the Universal Commerce Protocol (https://ucp.dev, spec version `2026-08-25`).
Someone evaluating or implementing UCP can, with one `npm run dev`:

1. **Run a reference merchant** that speaks UCP over REST (discovery, catalog, checkout).
2. **Inspect any merchant**: fetch its `/.well-known/ucp` profile and get a conformance checklist.
3. **Drive a purchase as an agent** in a web console and watch every protocol message on the wire.

No LLM, no paid service, no account. Payment is a mock handler.

## Constraints

- Zero paid dependencies or services. Everything runs on localhost.
- Node 22, TypeScript, npm workspaces: `server/` and `web/`.
- Server: Express 4, better-sqlite3, zod, vitest + supertest. Web: Vite + React 18 + TypeScript, plain CSS, no UI library, no router, no state library.
- Server listens on `127.0.0.1:4000`. Web dev server on `5173`, proxying `/api`, `/ucp`, `/.well-known`, `/orders` to the server.
- All money is integer minor units (cents). Currency `USD`.
- UCP version constant: `2026-08-25`.

## Architecture

```
web (React)  ──/api/inspect, /api/proxy──▶  studio router ──HTTP──▶ any UCP merchant
                                                                       │ (default: itself)
                                            merchant router  ◀─────────┘
                                            /.well-known/ucp, /ucp/*
                                                  │
                                              SQLite (products, variants, checkouts, idempotency, orders)
```

One Express process, two independent routers. The studio router never imports merchant
code: it talks to merchants only over HTTP, so it works identically against a third-party
merchant. `server/src/app.ts` exports `createApp({ dbPath, baseUrl })` (no listen) for tests;
`server/src/index.ts` listens.

Server layout:

```
server/src/
  app.ts            createApp
  index.ts          listen
  db.ts             open db, schema, seed
  ucp.ts            UCP_VERSION, envelope helper, error helper, header middleware
  merchant/profile.ts   GET /.well-known/ucp
  merchant/catalog.ts   /ucp/catalog/*
  merchant/checkout.ts  /ucp/checkout-sessions/*  (routes)
  merchant/checkout-logic.ts  pure functions: totals, status, messages
  studio/inspect.ts     checks (pure) + route
  studio/proxy.ts       tracing proxy route + agent profile
```

## Merchant

### Discovery — `GET /.well-known/ucp`

```json
{
  "ucp": {
    "version": "2026-08-25",
    "services": { "dev.ucp.shopping": [ { "version": "2026-08-25", "transport": "rest", "endpoint": "<baseUrl>/ucp" } ] },
    "capabilities": {
      "dev.ucp.shopping.checkout":       [ { "version": "2026-08-25" } ],
      "dev.ucp.shopping.catalog.search": [ { "version": "2026-08-25" } ],
      "dev.ucp.shopping.catalog.lookup": [ { "version": "2026-08-25" } ],
      "dev.ucp.shopping.fulfillment":    [ { "version": "2026-08-25", "extends": "dev.ucp.shopping.checkout" } ]
    },
    "payment_handlers": { "dev.ucpstudio.mock_pay": [ { "id": "mock_pay", "version": "2026-08-25" } ] }
  },
  "keys": []
}
```

### Common rules for every `/ucp/*` request

- `UCP-Agent` header required, RFC 8941 dictionary with a `profile` string that parses as an
  absolute http(s) URL, e.g. `UCP-Agent: profile="http://127.0.0.1:4000/api/agent-profile"`.
  Missing or malformed → `400 {"code":"invalid_profile_url","content":"..."}`.
  The merchant does not fetch the platform profile (simplification, marked `ponytail:` in code).
- `Request-Id`: echoed on the response; generated (uuid) if absent.
- Every success body carries `"ucp": { "version": "2026-08-25", "capabilities": [ { "name": "...", "version": "2026-08-25" } ] }`.
  Catalog responses list the two catalog capabilities; checkout responses list checkout + fulfillment.
- Protocol errors: HTTP status + `{ "code", "content" }`. Invalid JSON shape (zod failure) → `400 {"code":"invalid_request",...}`.
- Business outcomes: HTTP 200/201 with `messages: [{ type: "error"|"warning"|"info", code, content, path?, severity? }]`.

### Catalog

Seed: 8 products across categories `Footwear`, `Apparel`, `Accessories`, each with 1–3 variants
(options like Size/Color), a `stock` integer per variant, and one variant with stock 0.

Product: `{ id, handle, title, description: { plain }, categories: [string], price_range: { min: {amount,currency}, max: {amount,currency} }, variants: [Variant] }`.
Variant: `{ id, sku, title, description: { plain }, price: { amount, currency }, availability: { available: boolean }, options: [{ name, label }] }`.

- `POST /ucp/catalog/search` body `{ query?, filters?: { categories?: string[], price?: { min?, max? } }, pagination?: { limit?: 1..50 (default 20), cursor? } }`
  → `{ ucp, products, pagination: { cursor?, has_next_page, total_count } }`. `query` is a case-insensitive
  substring match over title + description. Filters AND together; price filters compare against `price_range.min`.
  Cursor is base64 of the numeric offset.
- `POST /ucp/catalog/lookup` body `{ ids: string[] (1..50) }` → `{ ucp, products, messages? }`. Ids may be product or variant ids
  (a variant id returns its parent product). Unknown ids are omitted and reported in one `info` message, code `not_found`.
- `POST /ucp/catalog/product` body `{ id }` → `{ ucp, product }`, or `404 {"code":"not_found",...}`.

### Checkout

Endpoints (relative to `/ucp`):

| Op | Method | Path | Success |
|---|---|---|---|
| Create | POST | `/checkout-sessions` | 201 |
| Get | GET | `/checkout-sessions/:id` | 200 |
| Update | PUT | `/checkout-sessions/:id` | 200 |
| Complete | POST | `/checkout-sessions/:id/complete` | 200 |
| Cancel | POST | `/checkout-sessions/:id/cancel` | 200 |

**Idempotency.** `Idempotency-Key` header is required on all four mutating operations
(missing → `400 {"code":"idempotency_key_required"}`). Same key + same method/path/body → the stored
status and body are replayed. Same key + different method/path/body → `409 {"code":"idempotency_conflict"}`.

**Checkout object:**

```json
{
  "ucp": { "version": "2026-08-25", "capabilities": [ ... ] },
  "id": "chk_...",
  "status": "incomplete",
  "currency": "USD",
  "line_items": [ { "id": "li_1", "item": { "id": "<variant id>", "title": "...", "price": 1299 }, "quantity": 2,
                    "totals": [ { "type": "subtotal", "amount": 2598 }, { "type": "total", "amount": 2598 } ] } ],
  "buyer": { "first_name": "", "last_name": "", "email": "", "phone_number": "" },
  "fulfillment": { "methods": [ {
      "id": "shipping", "type": "shipping",
      "destinations": [ { "id": "dest_1", "street_address": "", "address_locality": "", "address_region": "", "postal_code": "", "address_country": "US" } ],
      "selected_destination_id": "dest_1",
      "groups": [ { "id": "grp_1", "line_item_ids": ["li_1"],
                    "options": [ { "id": "standard", "title": "Standard (5-7 days)", "totals": [ { "type": "total", "amount": 500 } ] },
                                 { "id": "express",  "title": "Express (2 days)",    "totals": [ { "type": "total", "amount": 1500 } ] } ],
                    "selected_option_id": "standard" } ] } ] },
  "totals": [ { "type": "subtotal", "amount": 2598 }, { "type": "fulfillment", "amount": 500 }, { "type": "tax", "amount": 208 }, { "type": "total", "amount": 3306 } ],
  "messages": [],
  "links": [ { "type": "terms_of_service", "url": "<baseUrl>/terms" }, { "type": "privacy_policy", "url": "<baseUrl>/privacy" } ],
  "payment": { "instruments": [] },
  "payment_handlers": { "dev.ucpstudio.mock_pay": [ { "id": "mock_pay", "version": "2026-08-25" } ] },
  "expires_at": "<created + 6h, RFC 3339>",
  "order": { "id": "ord_...", "permalink_url": "<baseUrl>/orders/ord_..." }
}
```

The `fulfillment` shape is modelled on the UCP fulfillment extension, simplified to a single
shipping method and a single group. `buyer`, `fulfillment`, `order` are omitted when absent.

**Request bodies.** Create and Update accept `{ line_items: [{ item: { id }, quantity (int ≥ 1) }] (≥ 1 item), buyer?, fulfillment? }`
where request `fulfillment` is `{ methods: [{ type: "shipping", destinations: [{ street_address, address_locality, address_region, postal_code, address_country }], groups?: [{ selected_option_id }] }] }`.
Update is full replacement: fields not resent are dropped. The server assigns all ids and always
offers the `standard` (500) and `express` (1500) options once a destination exists; an unknown or absent
`selected_option_id` leaves no option selected.

**Derived values** (pure functions in `checkout-logic.ts`):

- line subtotal = price × quantity; `subtotal` = sum of lines.
- `fulfillment` total = selected option amount; the entry is omitted when none is selected.
- `tax` = `Math.round(subtotal * 0.08)` (flat demo rate, marked `ponytail:`).
- `total` = subtotal + fulfillment + tax.
- messages, in this order:
  - quantity exceeds variant stock → `error`, code `out_of_stock`, path `$.line_items[i].quantity`, severity `recoverable`
  - no `buyer.email` → `error`, `field_required`, `$.buyer.email`, `recoverable`
  - no destination → `error`, `field_required`, `$.fulfillment.methods[0].destinations`, `recoverable`
  - destination but no selected option → `error`, `field_required`, `$.fulfillment.methods[0].groups[0].selected_option_id`, `recoverable`
- status = `ready_for_complete` when there are no error messages, else `incomplete`.

**Create with an unknown item id** creates nothing: `200` with
`{ "ucp": { "version", "capabilities", "status": "error" }, "messages": [{ "type":"error", "code":"item_not_found", "path":"$.line_items[i].item.id", "severity":"unrecoverable", "content": ... }] }`.
The same on Update leaves the stored checkout unchanged.

**State machine.**

- Get/Update/Complete/Cancel on an unknown id → `404 {"code":"not_found"}`.
- A checkout past `expires_at` becomes `canceled` when next read.
- Update on `completed` or `canceled` → `409 {"code":"invalid_state"}`.
- Complete body: `{ payment: { instruments: [{ id, handler_id: "mock_pay", type: "token", credential: { token } }] } }`.
  - status is not `ready_for_complete` → `409 {"code":"invalid_state"}`.
  - handler other than `mock_pay` → `400 {"code":"invalid_request"}`.
  - stock re-checked; insufficient → 200, status `incomplete`, `out_of_stock` message, nothing charged.
  - token `tok_decline` → 200, status stays `ready_for_complete`, message `error` / `payment_declined` / `recoverable`.
  - any other token → stock decremented and order row created in one transaction; 200, status `completed`, `order` present.
- Cancel: any status except `completed` → `canceled` (idempotent on already-canceled). `completed` → `409 {"code":"invalid_state"}`.

`GET /orders/:id` returns the order JSON `{ id, checkout_id, total, currency, created_at }` or 404 (outside `/ucp`, no UCP headers needed).
`GET /terms` and `GET /privacy` return a one-line plain-text placeholder.

## Studio API

- `GET /api/agent-profile` → the platform profile advertised in `UCP-Agent`:
  `{ "ucp": { "version": "2026-08-25", "capabilities": { <same four capability names, each [{ "version": "2026-08-25" }]> } } }`.
- `POST /api/inspect` body `{ url }` (any http(s) URL; only its origin is used) → `{ origin, profile | null, checks: [{ id, title, status: "pass"|"fail"|"warn", detail }], summary: { pass, fail, warn } }`.
  Checks, in order. If `reachable` fails the rest are skipped and `checks` holds that single entry:
  1. `reachable` — `GET <origin>/.well-known/ucp` returns 200 with a JSON object body (5 s timeout).
  2. `version` — `ucp.version` matches `^\d{4}-\d{2}-\d{2}$`; `warn` if valid but ≠ `2026-08-25`.
  3. `services` — `ucp.services` is an object (may be empty).
  4. `payment_handlers` — `ucp.payment_handlers` is an object (may be empty).
  5. `capabilities` — if present: every key is a reverse-domain name (`^[a-z0-9]+(\.[a-z0-9_]+)+$`) and every entry is a non-empty array whose items have a date `version`; `warn` if `capabilities` is absent.
  6. `rest_endpoint` — some service entry has `transport: "rest"` and an absolute URL `endpoint`; `warn` if no REST transport is offered; `fail` if offered with a bad endpoint.
  7. `transport_security` — `pass` if the REST endpoint is https, `warn` if http (expected for localhost).
  8. `keys` — `warn` if `keys` is missing or empty; `fail` if present but not an array of objects with `kty`; else `pass`.
  9. `live_catalog` — only when capability `dev.ucp.shopping.catalog.search` and a REST endpoint exist: `POST <endpoint>/catalog/search` with `{ "pagination": { "limit": 1 } }` and UCP headers returns 200 with `ucp.version` and a `products` array. Omitted from `checks` when not applicable.
  The check functions are pure (`profile → check`) and unit-tested without network; only `reachable` and `live_catalog` do I/O.
  Invalid `url` → `400 {"code":"invalid_request"}`.
- `POST /api/proxy` body `{ method: "GET"|"POST"|"PUT", url, body?, headers? }` → forwards to `url` adding
  `UCP-Agent: profile="<baseUrl>/api/agent-profile"`, `Request-Id` (uuid), `Content-Type: application/json`, and, for POST/PUT,
  `Idempotency-Key` (uuid) — caller-supplied `headers` win. Returns
  `{ request: { method, url, headers, body }, response: { status, headers, body }, duration_ms }` with HTTP 200 whenever the
  upstream answered (whatever its status); upstream unreachable → `502 {"code":"upstream_unreachable"}`. Non-JSON upstream bodies are returned as a string.
  Only `http:`/`https:` URLs; 10 s timeout. This is an open forwarder by design, which is why the server binds to `127.0.0.1` only.

## Web

Single page, two tabs in a top bar (state in `location.hash`): **Inspector** and **Agent Console**. Dark, dense, developer-tool look.

- **Inspector** — URL input prefilled with `window.location.origin`, "Inspect" button. Shows the summary counts, the checklist
  (status icon + text label, title, detail) and the raw profile JSON in a collapsible `<details>`.
- **Agent Console** — two columns.
  - Left, a guided purchase in steps: merchant URL (prefilled `window.location.origin`) + "Connect" (fetches the profile through the proxy and reads the REST endpoint from it) → search box +
    product cards with variant picker and "Add" (out-of-stock variants disabled) → cart with quantities → "Start checkout" (Create) → buyer
    + address form ("Update") → shipping option radios (Update on change) → token select (`tok_success` / `tok_decline`) + "Pay"
    (Complete) → confirmation with order id and permalink. "Cancel checkout" available while a session is open.
    A state-machine strip shows `incomplete → ready_for_complete → completed` plus `canceled`, current status highlighted.
    Checkout `messages` render next to the step they concern; totals render from `totals`.
  - Right, the **wire trace**: every proxied call, newest first: method, path, status badge, duration; click to expand request and
    response headers + pretty JSON. A "Clear" button.
- All merchant calls go through `POST /api/proxy`. One `api.ts` holds the fetch helpers; the trace is React state fed by them.
- Accessibility basics: labelled inputs, real buttons, visible focus, status conveyed by text as well as colour.
- Fetch failures surface as an inline error banner, never a blank screen.

## Testing

- Server: vitest + supertest against `createApp({ dbPath: ":memory:" })`. Unit tests for `checkout-logic` and inspect checks;
  route tests for discovery, catalog, the full checkout happy path, decline, idempotency replay/conflict, state errors.
  Proxy and `live_catalog` are tested by pointing them at the app itself listening on an ephemeral port.
- Web: `tsc --noEmit` and `vite build` must pass; one vitest unit test for any non-trivial pure helper. No component-test framework.
- Root `npm test` runs both workspaces; root `npm run dev` starts both (`concurrently`).

## Out of scope

Signatures/`Content-Digest`, fetching the platform profile and real capability negotiation, MCP/A2A/embedded transports,
identity linking, order webhooks, cart capability, discounts, auth, deployment.
