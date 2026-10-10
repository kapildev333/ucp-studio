import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { protocolError } from "../ucp.js";
import { seedCatalog, type Db } from "../db.js";

const variant = z.object({
  id: z.string().min(1).optional(), sku: z.string().min(1), title: z.string().min(1),
  price: z.number().int().min(0), stock: z.number().int().min(0),
  options: z.array(z.object({ name: z.string(), label: z.string() })).default([]),
});
const product = z.object({
  id: z.string().min(1).optional(), title: z.string().min(1).max(200), description: z.string().default(""),
  categories: z.array(z.string()).default([]), variants: z.array(variant).min(1).max(50),
});
const importBody = z.object({ replace: z.boolean().default(false), products: z.array(product).min(1).max(500) }).superRefine((b, ctx) => {
  const seen = new Set<string>(), pids = new Set<string>(), vids = new Set<string>();
  b.products.forEach((p, i) => {
    if (p.id && pids.has(p.id)) ctx.addIssue({ code: "custom", path: ["products", i, "id"], message: "duplicate id" });
    if (p.id) pids.add(p.id);
    p.variants.forEach((v, j) => {
    if (v.id && vids.has(v.id)) ctx.addIssue({ code: "custom", path: ["products", i, "variants", j, "id"], message: "duplicate id" });
    if (v.id) vids.add(v.id);
    if (seen.has(v.sku)) ctx.addIssue({ code: "custom", path: ["products", i, "variants", j, "sku"], message: "duplicate sku" });
    seen.add(v.sku);
    });
  });
});

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ponytail: header-based CSRF check only (browsers always send Sec-Fetch-Site); real auth is out of scope
export const crossSiteGuard: RequestHandler = (req, res, next) =>
  req.method !== "GET" && ["cross-site", "same-site"].includes(req.header("Sec-Fetch-Site") ?? "") ? protocolError(res, 403, "forbidden", "Cross-site requests are not allowed") : next();

// ponytail: no auth, localhost demo only; add real auth before exposing this beyond the developer's machine
export const merchantAdminRouter = (db: Db) => {
  const r = Router();

  r.get("/catalog", (_req, res) => {
    const variants = db.prepare("SELECT * FROM variants ORDER BY rowid").all() as any[];
    const products = (db.prepare("SELECT * FROM products ORDER BY position").all() as any[]).map((p) => ({
      id: p.id, title: p.title, description: p.description, categories: JSON.parse(p.categories),
      variants: variants.filter((v) => v.product_id === p.id).map((v) => ({
        id: v.id, sku: v.sku, title: v.title, price: v.price, stock: v.stock, options: JSON.parse(v.options),
      })),
    }));
    res.json({ products });
  });

  r.post("/catalog/import", (req, res) => {
    const body = importBody.parse(req.body ?? {});
    let variants = 0;
    db.transaction(() => {
      if (body.replace) db.exec("DELETE FROM variants; DELETE FROM products");
      let pos = (db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM products").get() as { m: number }).m;
      for (const p of body.products) {
        const pid = p.id ?? `prod_${randomUUID()}`;
        const cats = JSON.stringify(p.categories);
        const upd = db.prepare("UPDATE products SET handle=?, title=?, description=?, categories=? WHERE id=?")
          .run(slug(p.title), p.title, p.description, cats, pid);
        if (!upd.changes) db.prepare("INSERT INTO products VALUES (?,?,?,?,?,?)").run(pid, slug(p.title), p.title, p.description, cats, ++pos);
        for (const v of p.variants) {
          const row = [pid, v.sku, v.title, p.description, v.price, JSON.stringify(v.options), v.stock] as const;
          const vid = v.id ?? `var_${randomUUID()}`;
          const u = db.prepare("UPDATE variants SET product_id=?, sku=?, title=?, description=?, price=?, options=?, stock=? WHERE id=?").run(...row, vid);
          if (!u.changes) db.prepare("INSERT INTO variants VALUES (?,?,?,?,?,?,?,?)").run(vid, ...row);
          variants++;
        }
      }
    })();
    res.json({ imported: { products: body.products.length, variants } });
  });

  r.post("/catalog/reset", (_req, res) => {
    db.transaction(() => {
      db.exec("DELETE FROM variants; DELETE FROM products");
      seedCatalog(db);
    })();
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    res.json({ imported: { products: n("products"), variants: n("variants") } });
  });

  return r;
};
