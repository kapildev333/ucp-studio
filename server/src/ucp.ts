import type { ErrorRequestHandler, Response } from "express";
import { ZodError } from "zod";

export const UCP_VERSION = "2026-08-25";

export const protocolError = (res: Response, status: number, code: string, content: string) =>
  res.status(status).json({ code, content });

// Zod failures and bad JSON bodies become 400 invalid_request.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) return protocolError(res, 400, "invalid_request", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (err?.type === "entity.parse.failed") return protocolError(res, 400, "invalid_request", "Body is not valid JSON");
  console.error(err);
  protocolError(res, 500, "internal_error", "Internal error");
};
