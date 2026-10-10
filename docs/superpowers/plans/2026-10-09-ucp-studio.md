# UCP Studio — implementation plan

**Spec:** `docs/superpowers/specs/2026-10-09-ucp-studio-design.md` — the binding authority. Each task names the spec
sections it implements; read those sections in full, they hold the exact shapes, codes and values.

## Global Constraints

- No paid dependency or service. Localhost only. Server binds `127.0.0.1:4000`.
- Node 22, TypeScript (strict), ESM, npm workspaces `server/` and `web/`.
- Server deps: express@4, better-sqlite3, zod; dev: typescript, tsx, vitest, supertest, @types/*. Nothing else without need.
- Web deps: react@18, react-dom@18; dev: vite, @vitejs/plugin-react, typescript, vitest. No UI/router/state library.
- Money is integer minor units. Currency `USD`. UCP version constant `2026-08-25`, defined once in `server/src/ucp.ts`.
- The studio router (`server/src/studio/*`) must not import from `server/src/merchant/*`; it reaches merchants over HTTP only.
- File layout as in the spec's Architecture section.
- TDD: write the failing test first. Tests use `createApp({ dbPath: ":memory:", baseUrl })`.
- Minimal code: no abstraction with one user, no speculative config. Deliberate shortcuts get a `// ponytail:` comment naming the ceiling.
- Commit at the end of each task with a conventional-commit message. Do not push.

## Task 1: Workspace scaffold, database, discovery and catalog

Implements spec sections: Constraints, Architecture, Merchant → Discovery, Common rules, Catalog.

- Root `package.json` (private, workspaces `server`, `web`; scripts `dev` → `concurrently` running both workspaces' `dev`,
  `test` → `npm test --workspaces --if-present`, `build` likewise), `.gitignore` (`node_modules`, `dist`, `*.db`, `.superpowers`).
  Only the `server` workspace is created in this task; `web` arrives in Task 4 (the root scripts must tolerate its absence).
- `server/`: `package.json` (scripts `dev` = `tsx watch src/index.ts`, `test` = `vitest run`, `build` = `tsc --noEmit`), `tsconfig.json`.
- `src/db.ts`: `openDb(path)` creates tables `products`, `variants` (with `stock`), `checkouts`, `idempotency`, `orders` and seeds
  the catalog when `products` is empty. Store checkout request state as a JSON column — derived values are computed, not stored.
- `src/ucp.ts`: `UCP_VERSION`, `envelope(capabilityNames)`, `protocolError(res, status, code, content)`, and the middleware
  enforcing `UCP-Agent` and handling `Request-Id`.
- `src/app.ts`: `createApp({ dbPath, baseUrl })`; `src/index.ts`: listen on `127.0.0.1:4000`, `baseUrl` from `BASE_URL` env
  defaulting to `http://127.0.0.1:4000`, db file `server/data.db`.
- `src/merchant/profile.ts`, `src/merchant/catalog.ts`.
- Tests (`server/test/`): profile shape; UCP-Agent missing/malformed → 400; Request-Id echo/generation; search by query, by
  category, by price, pagination cursor round-trip; lookup with product id, variant id and unknown id; product found / 404; zod 400.

Done when `npm test` passes at the root and `npm run build -w server` type-checks.

## Task 2: Checkout sessions

Implements spec section: Merchant → Checkout (all of it), plus `/orders/:id`, `/terms`, `/privacy`.

- `src/merchant/checkout-logic.ts`: pure functions taking the stored request state plus a variant lookup and returning
  line items, fulfillment, totals, messages and status. No Express, no db handle.
- `src/merchant/checkout.ts`: the five routes, idempotency (table from Task 1), expiry, the complete transaction.
- Tests: unit tests for `checkout-logic` (totals arithmetic incl. tax rounding, each message and its order, status);
  route tests for the happy path create → update → complete → get, `tok_decline`, unknown item on create and on update,
  out-of-stock, update-is-full-replacement, idempotency replay and conflict and missing key, every `invalid_state` case,
  cancel (incl. idempotent re-cancel), expiry, 404s, stock decrement after completion, `/orders/:id`.

Done when `npm test` passes and `npm run build -w server` type-checks.

## Task 3: Studio API — inspector and tracing proxy

Implements spec section: Studio API.

- `src/studio/inspect.ts`: one pure function per check (`profile → check`), the two I/O checks, and `POST /api/inspect`.
- `src/studio/proxy.ts`: `GET /api/agent-profile`, `POST /api/proxy`.
- Use Node's global `fetch` with `AbortSignal.timeout`. No HTTP client dependency.
- Tests: each pure check for pass / fail / warn with hand-written profiles; `/api/inspect` and `/api/proxy` end to end
  against the app itself listening on an ephemeral port (`app.listen(0)`), covering: all-pass-or-warn result for the built-in
  merchant, unreachable origin → single failed `reachable` check, proxy header injection, caller headers winning, upstream
  non-2xx still returned as 200 with the upstream status inside, unreachable upstream → 502, non-http URL → 400.

Done when `npm test` passes and `npm run build -w server` type-checks.

## Task 4: Web app

Implements spec section: Web, and the web half of Testing.

- `web/`: `package.json` (scripts `dev` = `vite`, `build` = `tsc --noEmit && vite build`, `test` = `vitest run --passWithNoTests`),
  `vite.config.ts` with the dev proxy for `/api`, `/ucp`, `/.well-known`, `/orders` → `http://127.0.0.1:4000`, `index.html`, `tsconfig.json`.
- `src/api.ts` (inspect + proxy helpers, trace entry type), `src/App.tsx` (tabs via `location.hash`), `src/Inspector.tsx`,
  `src/AgentConsole.tsx`, `src/Trace.tsx`, `src/styles.css`. Split a file only when it passes ~250 lines.
- Format money with `Intl.NumberFormat`. Render JSON with `JSON.stringify(x, null, 2)` in `<pre>`.
- Add `concurrently` at the root so `npm run dev` runs server and web together, and a root `README.md`: what this is, how to
  run, the three features, the list of deliberate simplifications from the spec's Out of scope section.
- Verify for real: start `npm run dev`, and with `curl` through the Vite port confirm `/.well-known/ucp` and an `/api/proxy`
  catalog search respond; then stop the servers. Record the commands and output in the report.

Done when root `npm test` and `npm run build` pass and the manual verification above is recorded.
