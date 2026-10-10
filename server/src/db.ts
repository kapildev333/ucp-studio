import Database from "better-sqlite3";

export type Db = Database.Database;

// orders.snapshot is the order object as JSON (immutable except fulfillment); webhook_url is captured from the platform profile at Complete.
// Checkout request state is stored as JSON; totals and messages are derived on read. `status` is the snapshot taken at the last write (Complete gates on it).
// checkouts.snapshot is the response body (minus `ucp`) frozen at Complete/Cancel; once set, reads never touch the catalog again.
// ponytail: no migrations; bumping SCHEMA_VERSION drops and recreates the transactional tables (orders, checkouts, idempotency), so that data is discarded. Real migrations if it must survive.
const SCHEMA_VERSION = 3;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, handle TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  categories TEXT NOT NULL, position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), sku TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL, price INTEGER NOT NULL, options TEXT NOT NULL, stock INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS checkouts (
  id TEXT PRIMARY KEY, request TEXT NOT NULL, status TEXT NOT NULL, canceled INTEGER NOT NULL DEFAULT 0,
  order_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, snapshot TEXT);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, checkout_id TEXT NOT NULL, snapshot TEXT NOT NULL, webhook_url TEXT, created_at TEXT NOT NULL);
`;

// [handle, title, description, category, [variant title, price cents, [option name, label], stock][]]
type Seed = [string, string, string, string, [string, number, [string, string], number][]];
const SEED: Seed[] = [
  ["trail-sneaker", "Trail Sneaker", "Grippy everyday sneaker for rough ground.", "Footwear",
    [["Size 9", 8900, ["Size", "9"], 12], ["Size 10", 8900, ["Size", "10"], 0], ["Size 11", 9400, ["Size", "11"], 5]]],
  ["court-sneaker", "Court Sneaker", "Clean leather sneaker with a low profile.", "Footwear",
    [["White", 7500, ["Color", "White"], 20], ["Black", 7500, ["Color", "Black"], 8]]],
  ["rain-boot", "Rain Boot", "Waterproof boot with a rubber sole.", "Footwear", [["Size 9", 6500, ["Size", "9"], 6]]],
  ["classic-tee", "Classic Tee", "Soft cotton t-shirt in a relaxed fit.", "Apparel",
    [["Small", 1999, ["Size", "S"], 40], ["Medium", 1999, ["Size", "M"], 35], ["Large", 1999, ["Size", "L"], 25]]],
  ["fleece-hoodie", "Fleece Hoodie", "Warm brushed fleece hoodie.", "Apparel",
    [["Grey", 4900, ["Color", "Grey"], 10], ["Navy", 4900, ["Color", "Navy"], 7]]],
  ["canvas-cap", "Canvas Cap", "Adjustable six-panel cap.", "Accessories", [["One size", 1800, ["Size", "One size"], 30]]],
  ["leather-belt", "Leather Belt", "Full-grain leather belt with a brass buckle.", "Accessories",
    [["Brown", 3500, ["Color", "Brown"], 15], ["Black", 3500, ["Color", "Black"], 15]]],
  ["wool-socks", "Wool Socks", "Pair of merino wool socks.", "Accessories", [["Medium", 1200, ["Size", "M"], 60]]],
];

export function seedCatalog(db: Db) {
  const addP = db.prepare("INSERT INTO products VALUES (?,?,?,?,?,?)");
  const addV = db.prepare("INSERT INTO variants VALUES (?,?,?,?,?,?,?,?)");
  db.transaction(() => {
    SEED.forEach(([handle, title, desc, cat, variants], i) => {
      const pid = `prod_${i + 1}`;
      addP.run(pid, handle, title, desc, JSON.stringify([cat]), i);
      variants.forEach(([vt, price, [name, label], stock], j) =>
        addV.run(`var_${i + 1}_${j + 1}`, pid, `${handle}-${j + 1}`.toUpperCase(), `${title} - ${vt}`, desc, price, JSON.stringify([{ name, label }]), stock));
    });
  })();
}

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  if ((db.pragma("user_version", { simple: true }) as number) < SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS checkouts; DROP TABLE IF EXISTS idempotency");
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  db.exec(SCHEMA);
  if (!db.prepare("SELECT 1 FROM products LIMIT 1").get()) seedCatalog(db);
  return db;
}
