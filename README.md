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

Open http://127.0.0.1:5173. The web dev server proxies `/api`, `/ucp`, `/.well-known` and `/orders` to the server.

## Features

1. **Reference merchant** - `/.well-known/ucp` discovery, catalog search/lookup/product, and checkout sessions
   (create, get, update, complete, cancel) with idempotency keys, stock checks, a flat tax, two shipping options and a mock payment handler (`tok_success`, `tok_decline`).
2. **Inspector** - point it at any merchant origin; it fetches the profile and runs a checklist (version, services, payment handlers, capabilities, REST endpoint, transport security, keys, live catalog search) with pass/warn/fail results.
3. **Agent Console** - a guided purchase (connect, search, cart, checkout, buyer and address, shipping, pay) driven through a tracing proxy, with a live wire trace of every request and response. Works against any UCP merchant, not just the built-in one.

## Deliberate simplifications

Out of scope for v1: signatures and `Content-Digest`, fetching the platform profile and real capability negotiation,
MCP/A2A/embedded transports, identity linking, order webhooks, the cart capability, discounts, auth, and deployment.
Also: the tax rate is a flat 8%, the merchant does not fetch the platform profile named in `UCP-Agent`, and `/api/proxy` is an open
forwarder, which is why the server binds to `127.0.0.1` only.
