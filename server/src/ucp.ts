import type { ErrorRequestHandler, Response } from "express";
import { ZodError } from "zod";

export const UCP_VERSION = "2026-08-25";

export const protocolError = (res: Response, status: number, code: string, content: string) =>
  res.status(status).json({ code, content });

export const TOO_LARGE = "Request body is too large";

// Zod failures and bad JSON bodies become 400 invalid_request; a body over the parser's limit becomes 413 payload_too_large.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) return protocolError(res, 400, "invalid_request", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (err?.type === "entity.parse.failed") return protocolError(res, 400, "invalid_request", "Body is not valid JSON");
  if (err?.type === "entity.too.large") return protocolError(res, 413, "payload_too_large", TOO_LARGE);
  console.error(err);
  protocolError(res, 500, "internal_error", "Internal error");
};
