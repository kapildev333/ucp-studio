import express, { Router } from "express";
import { z } from "zod";
import type { Db } from "../db.js";
import * as catalog from "./catalog-service.js";
import * as checkout from "./checkout-service.js";
import * as orders from "./order-service.js";
import { ProtocolError, type Ctx, type Result } from "./errors.js";
import { negotiate, type ProfileCache } from "./negotiate.js";

type Args = Record<string, any>;
// Loose JSON Schema (top-level keys and types only); the services' zod schemas do the real validation.
const obj = { type: "object" };
const str = { type: "string" };
const tool = (
  name: string, description: string, properties: Record<string, object>, required: string[], needKey: boolean,
  run: (c: Ctx, a: Args) => Result,
) => ({ name, description, inputSchema: { type: "object", properties: { meta: obj, ...properties }, required: ["meta", ...required] }, needKey, run });

const id = z.string();
const TOOLS = [
  tool("create_checkout", "Create a checkout session", { checkout: obj }, ["checkout"], false, (c, a) => checkout.create(c, a.checkout)),
  tool("get_checkout", "Get a checkout session", { id: str }, ["id"], false, (c, a) => checkout.get(c, id.parse(a.id))),
  tool("update_checkout", "Update a checkout session", { id: str, checkout: obj }, ["id", "checkout"], false, (c, a) => checkout.update(c, id.parse(a.id), a.checkout)),
  tool("complete_checkout", "Complete a checkout session with payment", { id: str, checkout: obj }, ["id", "checkout"], true, (c, a) => checkout.complete(c, id.parse(a.id), a.checkout)),
  tool("cancel_checkout", "Cancel a checkout session", { id: str }, ["id"], true, (c, a) => checkout.cancel(c, id.parse(a.id))),
  tool("search_catalog", "Search the catalog", { query: str, filters: obj, pagination: obj }, [], false, (c, a) => catalog.search(c, { query: a.query, filters: a.filters, pagination: a.pagination })),
  tool("lookup_catalog", "Look up catalog items by id", { ids: { type: "array" } }, ["ids"], false, (c, a) => catalog.lookup(c, { ids: a.ids })),
  tool("get_product", "Get a product", { id: str }, ["id"], false, (c, a) => catalog.getProduct(c, { id: a.id })),
  tool("get_order", "Get an order", { id: str }, ["id"], false, (c, a) => orders.get(c, id.parse(a.id))),
];

class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}
const PROFILE_CODES = ["invalid_profile_url", "profile_unreachable", "profile_malformed", "version_unsupported"];

const isObj = (v: unknown): v is Args => typeof v === "object" && v !== null && !Array.isArray(v);

export const mcpRouter = ({ cache, ...deps }: { db: Db; baseUrl: string; fetch: typeof fetch; cache: ProfileCache }) => {
  async function callTool(params: Args) {
    const t = TOOLS.find((x) => x.name === params.name);
    if (!t) throw new RpcError(-32602, `Unknown tool: ${params.name}`);
    const args = params.arguments ?? {};
    if (!isObj(args)) throw new RpcError(-32602, "arguments must be an object");
    const meta = isObj(args.meta) ? args.meta : {};
    const negotiated = await negotiate(meta["ucp-agent"]?.profile, { fetch: deps.fetch, cache });
    const idempotencyKey = typeof meta["idempotency-key"] === "string" && meta["idempotency-key"] ? meta["idempotency-key"] : undefined;
    if (t.needKey && !idempotencyKey) throw new RpcError(-32602, "meta.idempotency-key is required");
    const { body } = t.run({ ...deps, negotiated, idempotencyKey }, args);
    return { structuredContent: body, content: [{ type: "text", text: JSON.stringify(body) }], isError: (body as any)?.ucp?.status === "error" };
  }

  async function dispatch(method: string, params: Args) {
    switch (method) {
      case "initialize": {
        const v = params.protocolVersion;
        return {
          protocolVersion: v === "2025-03-26" || v === "2025-06-18" ? v : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "ucp-studio-merchant", version: "0.2.0" },
        };
      }
      case "ping": return {};
      case "tools/list": return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case "tools/call": return callTool(params);
      default: throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  const r = Router();
  // ponytail: 100kb default body limit and no batch support; raise/loop if a client needs it
  r.post("/mcp", express.text({ type: () => true }), async (req, res) => {
    const reply = (id: unknown, e: RpcError) => void res.json({ jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data !== undefined && { data: e.data }) } });
    let msg: unknown;
    try {
      if (typeof req.body !== "string") throw 0;
      msg = JSON.parse(req.body);
    } catch {
      return reply(null, new RpcError(-32700, "Parse error"));
    }
    const m = msg as Args;
    const idOk = m?.id === undefined || typeof m.id === "string" || typeof m.id === "number";
    if (!isObj(m) || m.jsonrpc !== "2.0" || typeof m.method !== "string" || !idOk || (m.params !== undefined && !isObj(m.params)))
      return reply(isObj(m) && idOk ? m.id ?? null : null, new RpcError(-32600, "Invalid Request"));
    if (m.id === undefined) return void res.status(202).end();
    try {
      res.json({ jsonrpc: "2.0", id: m.id, result: await dispatch(m.method, m.params ?? {}) });
    } catch (e) {
      if (e instanceof RpcError) return reply(m.id, e);
      if (e instanceof z.ZodError) return reply(m.id, new RpcError(-32602, e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
      if (e instanceof ProtocolError) return reply(m.id, new RpcError(PROFILE_CODES.includes(e.code) ? -32001 : -32000, e.content, { code: e.code, content: e.content }));
      console.error(e);
      reply(m.id, new RpcError(-32603, "Internal error"));
    }
  });
  r.all("/mcp", (_req, res) => void res.status(405).set("Allow", "POST").end());
  return r;
};
