import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { protocolError, UCP_VERSION } from "../ucp.js";

const schema = z.object({
  method: z.enum(["GET", "POST", "PUT"]),
  url: z.string().refine((u) => {
    try {
      return ["http:", "https:"].includes(new URL(u).protocol);
    } catch {
      return false;
    }
  }, "url must be an absolute http(s) URL"),
  body: z.unknown().optional(),
  headers: z.record(z.string()).optional(),
});

export const proxyRouter = (baseUrl: string) => {
  const r = Router();
  const cap = [{ version: UCP_VERSION }];
  r.get("/agent-profile", (_req, res) => {
    res.json({
      ucp: {
        version: UCP_VERSION,
        capabilities: Object.fromEntries(
          ["checkout", "catalog.search", "catalog.lookup", "fulfillment"].map((c) => [`dev.ucp.shopping.${c}`, cap]),
        ),
      },
    });
  });
  r.post("/proxy", async (req, res, next) => {
    try {
      const { method, url, body, headers } = schema.parse(req.body);
      const defaults: Record<string, string> = {
        "UCP-Agent": `profile="${baseUrl}/api/agent-profile"`,
        "Request-Id": randomUUID(),
        "Content-Type": "application/json",
        ...(method !== "GET" && { "Idempotency-Key": randomUUID() }),
      };
      // Header names compare case-insensitively; the caller's spelling and value win.
      const merged = new Map(Object.entries(defaults).map(([k, v]) => [k.toLowerCase(), [k, v] as const]));
      for (const [k, v] of Object.entries(headers ?? {})) merged.set(k.toLowerCase(), [k, v]);
      const sent = Object.fromEntries(merged.values());
      const payload = method === "GET" || body === undefined ? undefined : JSON.stringify(body);
      const t0 = performance.now();
      let up: Response, text: string;
      try {
        up = await fetch(url, { method, headers: sent, body: payload, signal: AbortSignal.timeout(10000) });
        text = await up.text();
      } catch (e) {
        return protocolError(res, 502, "upstream_unreachable", `Could not reach ${url}: ${(e as Error).message}`);
      }
      const duration_ms = Math.round(performance.now() - t0);
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      res.json({
        request: { method, url, headers: sent, body },
        response: { status: up.status, headers: Object.fromEntries(up.headers), body: parsed },
        duration_ms,
      });
    } catch (e) {
      next(e);
    }
  });
  return r;
};
