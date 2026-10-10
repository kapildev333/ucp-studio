import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  checkVersion, checkServices, checkPaymentHandlers, checkCapabilities, checkRestEndpoint, checkTransportSecurity, checkKeys,
} from "../src/studio/inspect.js";

const p = (ucp: object, extra: object = {}) => ({ ucp, ...extra });
const cap = { "a.b": [{ version: "2026-08-25" }] };

describe("pure checks", () => {
  it("version", () => {
    expect(checkVersion(p({ version: "2026-08-25" })).status).toBe("pass");
    expect(checkVersion(p({ version: "2025-01-01" })).status).toBe("warn");
    expect(checkVersion(p({ version: "v1" })).status).toBe("fail");
    expect(checkVersion({}).status).toBe("fail");
  });
  it("services and payment_handlers", () => {
    expect(checkServices(p({ services: {} })).status).toBe("pass");
    expect(checkServices(p({ services: [] })).status).toBe("fail");
    expect(checkPaymentHandlers(p({ payment_handlers: {} })).status).toBe("pass");
    expect(checkPaymentHandlers(p({})).status).toBe("fail");
  });
  it("capabilities", () => {
    expect(checkCapabilities(p({ capabilities: cap })).status).toBe("pass");
    expect(checkCapabilities(p({})).status).toBe("warn");
    expect(checkCapabilities(p({ capabilities: { Bad: [{ version: "2026-08-25" }] } })).status).toBe("fail");
    expect(checkCapabilities(p({ capabilities: { "a.b": [] } })).status).toBe("fail");
    expect(checkCapabilities(p({ capabilities: { "a.b": [{ version: "x" }] } })).status).toBe("fail");
  });
  const svc = (e: object[]) => p({ services: { "x.y": e } });
  it("rest_endpoint and transport_security", () => {
    const ok = svc([{ transport: "rest", endpoint: "https://m.example/ucp" }]);
    expect(checkRestEndpoint(ok).status).toBe("pass");
    expect(checkTransportSecurity(ok)!.status).toBe("pass");
    expect(checkTransportSecurity(svc([{ transport: "rest", endpoint: "http://localhost/ucp" }]))!.status).toBe("warn");
    expect(checkRestEndpoint(svc([{ transport: "mcp", endpoint: "https://m.example" }])).status).toBe("warn");
    const bad = svc([{ transport: "rest", endpoint: "/relative" }]);
    expect(checkRestEndpoint(bad).status).toBe("fail");
    expect(checkTransportSecurity(bad)).toBeUndefined();
  });
  it("keys", () => {
    expect(checkKeys({ keys: [{ kty: "EC" }] }).status).toBe("pass");
    expect(checkKeys({ keys: [] }).status).toBe("warn");
    expect(checkKeys({}).status).toBe("warn");
    expect(checkKeys({ keys: [{}] }).status).toBe("fail");
    expect(checkKeys({ keys: "x" }).status).toBe("fail");
  });
});

describe("studio API end to end", () => {
  const server = http.createServer();
  let base: string;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    app = createApp({ dbPath: ":memory:", baseUrl: base });
    server.on("request", app);
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it("serves the agent profile", async () => {
    const res = await request(app).get("/api/agent-profile");
    expect(Object.keys(res.body.ucp.capabilities)).toHaveLength(4);
  });

  it("inspects the built-in merchant: no failures", async () => {
    const res = await request(app).post("/api/inspect").send({ url: `${base}/some/path` });
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe(base);
    expect(res.body.profile.ucp.version).toBe("2026-08-25");
    expect(res.body.summary.fail).toBe(0);
    expect(res.body.checks.map((c: { id: string }) => c.id)).toEqual([
      "reachable", "version", "services", "payment_handlers", "capabilities", "rest_endpoint", "transport_security", "keys", "live_catalog",
    ]);
    expect(res.body.checks.at(-1).status).toBe("pass");
  });

  it("unreachable origin gives a single failed reachable check", async () => {
    const res = await request(app).post("/api/inspect").send({ url: "http://127.0.0.1:1" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBeNull();
    expect(res.body.checks).toHaveLength(1);
    expect(res.body.checks[0]).toMatchObject({ id: "reachable", status: "fail" });
    expect(res.body.summary).toEqual({ pass: 0, fail: 1, warn: 0 });
  });

  it("rejects bad inspect urls", async () => {
    for (const url of ["ftp://x.com", "nope", 5]) {
      const res = await request(app).post("/api/inspect").send({ url });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_request");
    }
  });

  it("proxy injects headers and traces the call", async () => {
    const res = await request(app).post("/api/proxy").send({ method: "POST", url: `${base}/ucp/catalog/search`, body: { pagination: { limit: 1 } } });
    expect(res.status).toBe(200);
    const h = res.body.request.headers;
    expect(h["UCP-Agent"]).toBe(`profile="${base}/api/agent-profile"`);
    expect(h["Request-Id"]).toBeTruthy();
    expect(h["Idempotency-Key"]).toBeTruthy();
    expect(h["Content-Type"]).toBe("application/json");
    expect(res.body.response.status).toBe(200);
    expect(res.body.response.body.products).toHaveLength(1);
    expect(res.body.response.headers["request-id"]).toBe(h["Request-Id"]);
    expect(typeof res.body.duration_ms).toBe("number");
  });

  it("GET gets no Idempotency-Key; caller headers win case-insensitively", async () => {
    const res = await request(app).post("/api/proxy").send({ method: "GET", url: `${base}/orders/nope`, headers: { "request-id": "mine" } });
    expect(res.body.request.headers["Idempotency-Key"]).toBeUndefined();
    expect(res.body.request.headers["request-id"]).toBe("mine");
    expect(res.body.request.headers["Request-Id"]).toBeUndefined();
    const bad = await request(app).post("/api/proxy").send({ method: "POST", url: `${base}/ucp/catalog/search`, body: {}, headers: { "ucp-agent": "junk" } });
    expect(bad.status).toBe(200);
    expect(bad.body.response.status).toBe(400);
    expect(bad.body.response.body.code).toBe("invalid_profile_url");
  });

  it("returns upstream non-2xx as 200 and non-JSON as string", async () => {
    const res = await request(app).post("/api/proxy").send({ method: "GET", url: `${base}/terms` });
    expect(res.status).toBe(200);
    expect(typeof res.body.response.body).toBe("string");
    const nf = await request(app).post("/api/proxy").send({ method: "GET", url: `${base}/orders/nope` });
    expect(nf.status).toBe(200);
    expect(nf.body.response.status).toBe(404);
  });

  it("502 when upstream is unreachable, 400 on bad input", async () => {
    const down = await request(app).post("/api/proxy").send({ method: "GET", url: "http://127.0.0.1:1/x" });
    expect(down.status).toBe(502);
    expect(down.body.code).toBe("upstream_unreachable");
    for (const body of [{ method: "GET", url: "file:///etc/passwd" }, { method: "GET", url: "nope" }, { method: "DELETE", url: base }]) {
      const res = await request(app).post("/api/proxy").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_request");
    }
  });
});
