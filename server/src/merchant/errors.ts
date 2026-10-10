import type { Db } from "../db.js";
import type { Negotiated } from "./negotiate.js";

export class ProtocolError extends Error {
  constructor(public status: number, public code: string, public content: string) {
    super(content);
  }
}

// What every service function takes first; services return a Result or throw ProtocolError. No req/res in services.
export type Ctx = { db: Db; baseUrl: string; fetch: typeof fetch; negotiated: Negotiated; idempotencyKey?: string };
export type Result = { status: 200 | 201; body: unknown };
