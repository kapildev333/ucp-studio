import { z } from "zod";
import type { Db } from "../db.js";
import { ProtocolError, type Ctx, type Result } from "./errors.js";
import { envelopeFor, incompatible } from "./negotiate.js";

const CAPS = ["dev.ucp.shopping.catalog.search", "dev.ucp.shopping.catalog.lookup"];
const [SEARCH, LOOKUP] = CAPS;
const money = (amount: number) => ({ amount, currency: "USD" });

const searchBody = z.object({
  query: z.string().optional(),
  filters: z.object({
    categories: z.array(z.string()).optional(),
    price: z.object({ min: z.number().int().optional(), max: z.number().int().optional() }).optional(),
  }).optional(),
  pagination: z.object({ limit: z.number().int().min(1).max(50).default(20), cursor: z.string().optional() }).optional(),
});
const lookupBody = z.object({ ids: z.array(z.string()).min(1).max(50) });
const productBody = z.object({ id: z.string() });

// ponytail: loads the whole catalog per request and filters in JS; fine for a demo seed, push into SQL for real catalogs
const all = (db: Db) => {
  const variants = db.prepare("SELECT * FROM variants ORDER BY rowid").all() as any[];
  return (db.prepare("SELECT * FROM products ORDER BY position").all() as any[]).map((p) => {
    const vs = variants.filter((v) => v.product_id === p.id);
    const prices = vs.map((v) => v.price);
    return {
      id: p.id, handle: p.handle, title: p.title, description: { plain: p.description },
      categories: JSON.parse(p.categories) as string[],
      price_range: { min: money(Math.min(...prices)), max: money(Math.max(...prices)) },
      variants: vs.map((v) => ({
        id: v.id, sku: v.sku, title: v.title, description: { plain: v.description }, price: money(v.price),
        availability: { available: v.stock > 0 }, options: JSON.parse(v.options),
      })),
    };
  });
};

export function search(ctx: Ctx, input: unknown): Result {
  const bad = incompatible(ctx.negotiated, SEARCH);
  if (bad) return bad;
  const { query, filters, pagination } = searchBody.parse(input ?? {});
  const q = query?.toLowerCase();
  const hits = all(ctx.db).filter((p) =>
    (!q || `${p.title} ${p.description.plain}`.toLowerCase().includes(q)) &&
    (!filters?.categories?.length || p.categories.some((c) => filters.categories!.includes(c))) &&
    (filters?.price?.min === undefined || p.price_range.min.amount >= filters.price.min) &&
    (filters?.price?.max === undefined || p.price_range.min.amount <= filters.price.max));
  const limit = pagination?.limit ?? 20;
  const offset = Math.max(0, parseInt(Buffer.from(pagination?.cursor ?? "", "base64").toString(), 10) || 0);
  const next = offset + limit;
  const has_next_page = next < hits.length;
  return {
    status: 200,
    body: {
      ucp: envelopeFor(ctx.negotiated, CAPS),
      products: hits.slice(offset, next),
      pagination: { ...(has_next_page && { cursor: Buffer.from(String(next)).toString("base64") }), has_next_page, total_count: hits.length },
    },
  };
}

export function lookup(ctx: Ctx, input: unknown): Result {
  const bad = incompatible(ctx.negotiated, LOOKUP);
  if (bad) return bad;
  const { ids } = lookupBody.parse(input);
  const found = new Set<string>();
  const products = all(ctx.db).filter((p) => {
    const hit = ids.filter((id) => id === p.id || p.variants.some((v) => v.id === id));
    hit.forEach((id) => found.add(id));
    return hit.length > 0;
  });
  const missing = ids.filter((id) => !found.has(id));
  return {
    status: 200,
    body: {
      ucp: envelopeFor(ctx.negotiated, CAPS), products,
      ...(missing.length && { messages: [{ type: "info", code: "not_found", content: `Not found: ${missing.join(", ")}` }] }),
    },
  };
}

export function getProduct(ctx: Ctx, input: unknown): Result {
  const bad = incompatible(ctx.negotiated, LOOKUP);
  if (bad) return bad;
  const { id } = productBody.parse(input);
  const product = all(ctx.db).find((p) => p.id === id);
  if (!product) throw new ProtocolError(404, "not_found", `Product ${id} not found`);
  return { status: 200, body: { ucp: envelopeFor(ctx.negotiated, CAPS), product } };
}
