import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { protocolError, UCP_VERSION } from "../ucp.js";

export type Check = { id: string; title: string; status: "pass" | "fail" | "warn"; detail: string };
type Obj = Record<string, any>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isHttpUrl = (v: unknown) => {
  try {
    return typeof v === "string" && ["http:", "https:"].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};
const ucpOf = (p: Obj): Obj => (isObj(p.ucp) ? p.ucp : {});
const mk = (id: string, title: string, status: Check["status"], detail: string): Check => ({ id, title, status, detail });

// All service entries (any service name) offering the rest transport.
const restEntries = (p: Obj): Obj[] =>
  Object.values(ucpOf(p).services ?? {}).flatMap((v) => (Array.isArray(v) ? v : [])).filter((e) => isObj(e) && e.transport === "rest");
// Trailing slashes are stripped once here so callers can append "/path" safely.
export const restEndpoint = (p: Obj): string | undefined => restEntries(p).find((e) => isHttpUrl(e.endpoint))?.endpoint.replace(/\/+$/, "");

// Blocks DNS rebinding: a page that rebinds its hostname to 127.0.0.1 would otherwise reach the open forwarder same-origin.
// ponytail: hostname allowlist only; binding to a non-loopback address or a custom local hostname needs this list extended.
export const localHostOnly: RequestHandler = (req, res, next) =>
  ["127.0.0.1", "localhost", "[::1]", "::1"].includes(req.hostname) ? next() : protocolError(res, 403, "forbidden_host", "Studio API only answers on localhost");

export const checkVersion = (p: Obj): Check => {
  const v = ucpOf(p).version;
  if (!isDate(v)) return mk("version", "Protocol version", "fail", `ucp.version must be YYYY-MM-DD, got ${JSON.stringify(v)}`);
  return v === UCP_VERSION ? mk("version", "Protocol version", "pass", v) : mk("version", "Protocol version", "warn", `${v} differs from ${UCP_VERSION}`);
};

export const checkServices = (p: Obj): Check =>
  isObj(ucpOf(p).services) ? mk("services", "Services", "pass", `${Object.keys(ucpOf(p).services).length} service(s)`) : mk("services", "Services", "fail", "ucp.services must be an object");

export const checkPaymentHandlers = (p: Obj): Check =>
  isObj(ucpOf(p).payment_handlers)
    ? mk("payment_handlers", "Payment handlers", "pass", `${Object.keys(ucpOf(p).payment_handlers).length} handler(s)`)
    : mk("payment_handlers", "Payment handlers", "fail", "ucp.payment_handlers must be an object");

export const checkCapabilities = (p: Obj): Check => {
  const c = ucpOf(p).capabilities;
  if (c === undefined) return mk("capabilities", "Capabilities", "warn", "ucp.capabilities is absent");
  if (!isObj(c)) return mk("capabilities", "Capabilities", "fail", "ucp.capabilities must be an object");
  for (const [name, entries] of Object.entries(c)) {
    if (!/^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(name)) return mk("capabilities", "Capabilities", "fail", `"${name}" is not a reverse-domain name`);
    if (!Array.isArray(entries) || !entries.length || !entries.every((e) => isObj(e) && isDate(e.version)))
      return mk("capabilities", "Capabilities", "fail", `"${name}" must be a non-empty array of entries with a date version`);
  }
  return mk("capabilities", "Capabilities", "pass", `${Object.keys(c).length} capability(ies)`);
};

export const checkRestEndpoint = (p: Obj): Check => {
  const rest = restEntries(p);
  if (!rest.length) return mk("rest_endpoint", "REST endpoint", "warn", "No service offers the rest transport");
  const url = restEndpoint(p);
  return url ? mk("rest_endpoint", "REST endpoint", "pass", url) : mk("rest_endpoint", "REST endpoint", "fail", "rest transport offered without an absolute http(s) endpoint");
};

export const checkTransportSecurity = (p: Obj): Check | undefined => {
  const url = restEndpoint(p);
  if (!url) return undefined;
  return url.startsWith("https:") ? mk("transport_security", "Transport security", "pass", "REST endpoint uses https") : mk("transport_security", "Transport security", "warn", "REST endpoint uses http (expected for localhost)");
};

export const checkKeys = (p: Obj): Check => {
  const k = p.keys;
  if (k === undefined || (Array.isArray(k) && !k.length)) return mk("keys", "Signing keys", "warn", "No keys published");
  return Array.isArray(k) && k.every((x) => isObj(x) && x.kty) ? mk("keys", "Signing keys", "pass", `${k.length} key(s)`) : mk("keys", "Signing keys", "fail", "keys must be an array of objects with kty");
};

export async function checkReachable(origin: string): Promise<{ check: Check; profile: Obj | null }> {
  const title = "Profile reachable";
  try {
    const res = await fetch(`${origin}/.well-known/ucp`, { signal: AbortSignal.timeout(5000) });
    if (res.status !== 200) return { check: mk("reachable", title, "fail", `GET /.well-known/ucp returned ${res.status}`), profile: null };
    const body = await res.json().catch(() => null);
    if (!isObj(body)) return { check: mk("reachable", title, "fail", "Profile is not a JSON object"), profile: null };
    return { check: mk("reachable", title, "pass", `${origin}/.well-known/ucp`), profile: body };
  } catch (e) {
    return { check: mk("reachable", title, "fail", `Could not fetch profile: ${(e as Error).message}`), profile: null };
  }
}

export async function checkLiveCatalog(p: Obj, baseUrl: string): Promise<Check | undefined> {
  const endpoint = restEndpoint(p);
  if (!endpoint || !ucpOf(p).capabilities?.["dev.ucp.shopping.catalog.search"]) return undefined;
  const title = "Live catalog search";
  try {
    const res = await fetch(`${endpoint}/catalog/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "UCP-Agent": `profile="${baseUrl}/api/agent-profile"`, "Request-Id": crypto.randomUUID() },
      body: JSON.stringify({ pagination: { limit: 1 } }),
      signal: AbortSignal.timeout(5000),
    });
    const body: Obj = await res.json().catch(() => ({}));
    if (res.status === 200 && body?.ucp?.version && Array.isArray(body.products)) return mk("live_catalog", title, "pass", `${body.products.length} product(s) returned`);
    return mk("live_catalog", title, "fail", `Expected 200 with ucp.version and products[], got ${res.status}`);
  } catch (e) {
    return mk("live_catalog", title, "fail", `Request failed: ${(e as Error).message}`);
  }
}

export const inspectRouter = (baseUrl: string) => {
  const r = Router();
  r.use(localHostOnly);
  r.post("/inspect", async (req, res, next) => {
    try {
      const url = z.object({ url: z.string() }).parse(req.body).url;
      let origin: string;
      try {
        const u = new URL(url);
        if (!["http:", "https:"].includes(u.protocol)) throw 0;
        origin = u.origin;
      } catch {
        return protocolError(res, 400, "invalid_request", "url must be an absolute http(s) URL");
      }
      const { check, profile } = await checkReachable(origin);
      const checks: Check[] = [check];
      if (profile) {
        const live = await checkLiveCatalog(profile, baseUrl);
        checks.push(
          ...[checkVersion(profile), checkServices(profile), checkPaymentHandlers(profile), checkCapabilities(profile), checkRestEndpoint(profile), checkTransportSecurity(profile), checkKeys(profile), live].filter((c): c is Check => !!c),
        );
      }
      const summary = { pass: 0, fail: 0, warn: 0 };
      for (const c of checks) summary[c.status]++;
      res.json({ origin, profile, checks, summary });
    } catch (e) {
      next(e);
    }
  });
  return r;
};
