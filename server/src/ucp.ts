import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { ZodError } from "zod";

export const UCP_VERSION = "2026-08-25";

export const envelope = (names: string[]) => ({
  version: UCP_VERSION,
  capabilities: names.map((name) => ({ name, version: UCP_VERSION })),
});

export const protocolError = (res: Response, status: number, code: string, content: string) =>
  res.status(status).json({ code, content });

// Echo or generate Request-Id, then require a UCP-Agent profile URL.
export const ucpHeaders: RequestHandler = (req, res, next) => {
  res.setHeader("Request-Id", req.header("Request-Id") || randomUUID());
  // ponytail: regex instead of a full RFC 8941 parser, and the platform profile is not fetched; add both when negotiation is needed
  const profile = /(?:^|,)\s*profile="([^"]*)"/.exec(req.header("UCP-Agent") ?? "")?.[1];
  let ok = false;
  try {
    ok = !!profile && ["http:", "https:"].includes(new URL(profile).protocol);
  } catch {}
  if (!ok) return protocolError(res, 400, "invalid_profile_url", "UCP-Agent must carry profile=\"<absolute http(s) URL>\"");
  next();
};

// Zod failures and bad JSON bodies become 400 invalid_request.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) return protocolError(res, 400, "invalid_request", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (err?.type === "entity.parse.failed") return protocolError(res, 400, "invalid_request", "Body is not valid JSON");
  console.error(err);
  protocolError(res, 500, "internal_error", "Internal error");
};
