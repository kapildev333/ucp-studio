# UCP Studio v3 — conformance runner, merchant back-office, trace export

Builds on v1 (`2026-10-09-ucp-studio-design.md`) and v2 (`2026-10-09-ucp-studio-v2-transports-orders.md`), which stay
binding wherever this spec is silent. Where they disagree, this one wins.

## Purpose

v1/v2 let a developer *watch* UCP work against the built-in merchant. v3 turns the studio toward **their own** merchant:

1. **Conformance runner** — point it at any UCP merchant and get a step-by-step behavioural report (beyond the static profile checks).
2. **Merchant back-office** — load your own catalog into the reference merchant, see stock and orders, ship orders.
3. **Trace export** — take what you saw on the wire away as curl, JSON or a Markdown report.

## Constraints

Unchanged: free, localhost-only, no new runtime dependencies, Node 22, TypeScript strict, Express 4, better-sqlite3, zod,
vitest, React 18 + Vite, plain CSS. Studio code must not import merchant code. Shortcuts carry `// ponytail:` comments.

## Part A — conformance runner (studio)

`POST /api/conformance` body `{ url, transport?: "rest" | "mcp" (default "rest"), item_id?, allow_complete?: boolean (default false) }` →

```json
{ "origin": "...", "transport": "rest", "started_at": "<RFC 3339>", "duration_ms": 0,
  "steps": [ { "id": "create_checkout", "title": "...", "status": "pass" | "fail" | "warn" | "skip", "detail": "...",
               "exchanges": [ { "request": { "method", "url", "headers", "body" }, "response": { "status", "headers", "body" }, "duration_ms" } ] } ],
  "summary": { "pass": 0, "fail": 0, "warn": 0, "skip": 0 } }
```

Invalid body → `400 invalid_request`. Always HTTP 200 once the run starts, whatever the target does.

**Engine.** `server/src/studio/conformance.ts` holds an ordered array of steps `{ id, title, needs?: string[], run(ctx) }`.
The runner executes them in order; a step whose `needs` includes a step that did not `pass`/`warn` is recorded as `skip` with
the reason. A step that throws is `fail` with the error message. Each outbound call has a 10 s timeout and is recorded in the
step's `exchanges`. `ctx` carries a transport client with one method per UCP operation (REST or MCP mapping, same as the web
console's — duplicated on purpose, the studio server and the browser share no code), the profile, and values earlier steps
found (variant id, checkout id). Requests carry `UCP-Agent: profile="<baseUrl>/api/agent-profile"`, `Request-Id`, and
`Idempotency-Key` where required. Assertion helpers are pure functions and unit-tested without network.

**Steps, in order.** "MUST-level" failures are `fail`; "SHOULD-level" are `warn`.

| id | Checks | needs |
|---|---|---|
| `profile` | `/.well-known/ucp` is reachable and has `ucp.version`, `services`, `payment_handlers`; the chosen transport is offered with an absolute endpoint. (Detail points to the Inspector for the full static checklist.) | — |
| `agent_header` | REST only (`skip` on MCP): a catalog search or checkout GET sent **without** `UCP-Agent` is rejected with a 4xx. Accepted → `warn`. | profile |
| `catalog_search` | `skip` if the profile lacks `dev.ucp.shopping.catalog.search`. Search with `pagination.limit` 5 returns `ucp.version` and a `products` array whose items have `id`, `title`, `variants[]` with `id` and `price.amount` integer. Picks the first variant whose `availability.available` is not `false`. | profile |
| `create_checkout` | Uses `item_id`, else the variant found above; neither → `skip`. Create with quantity 1 returns (REST: 201) a body with `ucp.version`, `id`, `status` in the six-value enum, ISO-4217-shaped `currency`, non-empty `line_items`, `totals` containing exactly one `total`. Missing `links` → `warn`. | profile |
| `totals_arithmetic` | `total` = `subtotal` − `items_discount` − `discount` + `fulfillment` + `tax` + `fee` over the entries present; all amounts integers. A total type outside the well-known set without `display_text` → `warn` and the equation is not asserted. | create_checkout |
| `messages_shape` | Every message has `type` in `error\|warning\|info`, non-empty `code` and `content`; every error has `severity` in `recoverable\|requires_buyer_input\|requires_buyer_review\|unrecoverable`. | create_checkout |
| `status_consistency` | `incomplete` ⇒ at least one error message (`warn` otherwise); `requires_escalation` ⇒ `continue_url` present (`fail` otherwise); `ready_for_complete` ⇒ no error messages (`warn` otherwise). | create_checkout |
| `get_checkout` | Get returns the same `id` and a valid status. | create_checkout |
| `idempotent_replay` | REST only: repeating the Create with the same `Idempotency-Key` and body returns the same checkout `id`. Different id → `warn`. | create_checkout |
| `idempotency_conflict` | REST only: the same key with a different body (quantity 2) returns 409. Anything else → `warn`. | create_checkout |
| `unknown_checkout` | Get on id `ucp-studio-nonexistent` does not return a checkout: REST 4xx, MCP JSON-RPC error, or a body with `ucp.status: "error"`. | profile |
| `complete_purchase` | Only when `allow_complete` is true **and** the profile offers payment handler `dev.ucpstudio.mock_pay`; otherwise `skip` with the reason. Update with a test buyer + address and the first offered fulfillment option, expect `ready_for_complete`; Complete with `tok_success`, expect `completed` and `order.id` + `order.permalink_url`. | create_checkout |
| `get_order` | `skip` unless the profile has `dev.ucp.shopping.order` and `complete_purchase` passed. Returns the order with matching `id` and `checkout_id`. | complete_purchase |
| `cancel_checkout` | Skipped if `complete_purchase` passed. Cancel returns `status: "canceled"`; a following Get shows `canceled`; a following Update is rejected (REST 4xx, MCP error, or `ucp.status: "error"`). | create_checkout |

The runner never completes a purchase on a merchant that does not offer the studio's mock handler, so it cannot place a
real order. It does create (and then cancel) one checkout session on the target; the UI says so before running.

Tests: unit tests for the pure helpers (totals equation incl. discounts and unknown types, message shape, status
consistency, dependency skipping); end-to-end against the app itself on an ephemeral port for REST and for MCP, with and
without `allow_complete`, asserting every step id's status; a deliberately broken tiny fake merchant (an Express app in the
test) that returns a wrong `total` and accepts a missing `UCP-Agent`, asserting `totals_arithmetic: fail` and `agent_header: warn`.

## Part B — merchant back-office (demo, not UCP)

All under `/merchant-admin` (v2 already has `orders/:id/ship`). No auth: localhost demo, `ponytail:` comment.

- `GET /merchant-admin/catalog` → `{ products: [{ id, title, description, categories, variants: [{ id, sku, title, price, stock, options: [{ name, label }] }] }] }` (`price` integer minor units, `description` plain string).
- `POST /merchant-admin/catalog/import` body `{ replace?: boolean (default false), products: [same shape, ids optional] }`.
  Validation (zod): 1–500 products; title 1–200 chars; 1–50 variants each; `price` integer ≥ 0; `stock` integer ≥ 0;
  `sku` unique within the request. Missing ids are generated (`prod_…`, `var_…`); a supplied id that already exists updates
  that row (upsert). `replace: true` deletes all products and variants first. One transaction — any invalid product rejects the
  whole import with `400 invalid_request` and a `content` naming the first failing path. Returns `{ imported: { products, variants } }`.
  Open checkouts referring to deleted variants answer later reads with the existing `item_not_found` outcome instead of crashing.
- `POST /merchant-admin/catalog/reset` → restores the seed catalog (and seed stock) → `{ imported: {...} }`. Orders and checkouts are kept.
- `GET /merchant-admin/orders` → `{ orders: [<v2 order object>…] }`, newest first, max 100.

Tests: import create, upsert, replace, each validation failure, atomicity (nothing written on a bad row), reset; imported
products appear in `/ucp/catalog/search` and can be bought end to end; a checkout whose variant was deleted; orders list ordering.

## Part C — web

Two new tabs after Inspector and Agent Console: **Conformance** and **Merchant**.

- **Conformance** — merchant URL (prefilled with the origin), transport select, an "Also complete a test purchase (mock
  payment only)" checkbox, a one-line notice that a run creates and cancels one checkout session on the target, and "Run".
  Results: summary counts; one row per step with status icon + text label, title, detail; rows expand to their exchanges
  (reusing the trace entry renderer). "Download report (.md)".
- **Merchant** — operates on the built-in merchant only.
  - Catalog table: product, variant, SKU, price, stock (stock 0 visibly flagged). "Reset to sample catalog" with a confirm step.
  - Import: a JSON file input and a textarea, a "Replace existing catalog" checkbox, "Import"; validation errors shown inline;
    a "Download current catalog (.json)" link producing a file that can be re-imported unchanged.
  - Orders table: id, created time, total, fulfillment status, "Ship" for unfulfilled orders.
- **Trace export** (Agent Console wire trace): per entry "Copy as curl"; for the whole trace "Download JSON" and "Download
  report (.md)". Pure functions in `web/src/export.ts` — `toCurl(entry)`, `traceToMarkdown(entries)`,
  `conformanceToMarkdown(result)` — unit-tested. `toCurl` single-quotes safely (escaping embedded single quotes) and emits the
  **upstream** request (method, url, headers, body), not the `/api/proxy` call. Downloads use a Blob + temporary `<a download>`.
- Accessibility as in v1; tables are real `<table>`s with header cells.
- README: document the three features and the import JSON shape with a small example.

Verification: `tsc --noEmit`, `vite build`, vitest for `export.ts`; a recorded real run with `npm run dev` + `curl`:
`POST /api/conformance` against the built-in merchant for REST and MCP with `allow_complete`, showing the summaries; an import of
one product followed by a catalog search that finds it; then `catalog/reset`.

## Work breakdown

One worker, in this order; each task ends green (`npm test`, `npm run build`) and committed.

### Task 1: Conformance engine, REST transport, all steps (Part A)
### Task 2: Conformance over MCP and the broken-merchant tests (Part A)
### Task 3: Merchant back-office API (Part B)
### Task 4: Web — Conformance tab, Merchant tab, trace export, README (Part C)

## Out of scope

CSV import, product images, auth on the back-office, scheduled or CI conformance runs, a public conformance badge, signature checks.
