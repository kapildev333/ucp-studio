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

Open http://127.0.0.1:5173. The web app (including the Agent Console's default merchant URL) only works while `npm run dev` is running, because it relies on the Vite proxy. The web dev server proxies `/api`, `/ucp`, `/.well-known`, `/orders` and `/merchant-admin` to the server.

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
