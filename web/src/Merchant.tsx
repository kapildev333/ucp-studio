import { useEffect, useState } from "react";
import { fulfillmentStatus, getCatalog, getOrders, importCatalog, money, resetCatalog, shipOrder, type J } from "./api";
import { download, parseCatalogImport } from "./export";

const counts = (r: J) => `${r.imported.products} products, ${r.imported.variants} variants`;

const totalOf = (o: J) => (Array.isArray(o.totals) ? o.totals : []).find((t: J) => t?.type === "total")?.amount;

export function OrdersTable({ orders, busyId, onShip }: { orders: J[]; busyId?: string; onShip: (id: string) => void }) {
  return (
    <table className="steps">
      <caption className="sr">Orders</caption>
      <thead>
        <tr><th scope="col">Order</th><th scope="col">Created</th><th scope="col" className="num">Total</th><th scope="col">Fulfillment</th><th scope="col"><span className="sr">Actions</span></th></tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const st = fulfillmentStatus(o);
          return (
            <tr key={o.id}>
              <td className="mono">{o.id}</td>
              <td className="mono small">{o.created_at}</td>
              <td className="num">{totalOf(o) === undefined ? "" : money(totalOf(o))}</td>
              <td>{st}</td>
              <td>{st !== "fulfilled" && <button disabled={busyId === o.id} aria-label={`Ship ${o.id}`} onClick={() => onShip(o.id)}>Ship</button>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Merchant() {
  const [products, setProducts] = useState<J[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetError, setResetError] = useState("");
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [orders, setOrders] = useState<J[] | null>(null);
  const [orderError, setOrderError] = useState("");
  const [shipping, setShipping] = useState("");

  async function loadOrders() {
    try {
      setOrders((await getOrders()).orders);
      setOrderError("");
    } catch (e) {
      setOrderError((e as Error).message);
    }
  }
  async function ship(id: string) {
    setShipping(id);
    try {
      await shipOrder(id);
      await loadOrders();
    } catch (e) {
      setOrderError(`Ship ${id}: ${(e as Error).message}`); // 409 invalid_state, 403 forbidden
      await loadOrders();
    } finally {
      setShipping("");
    }
  }

  async function load() {
    setLoadError("");
    try {
      setProducts((await getCatalog()).products);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    void loadOrders();
    // Panes mount at page load; refresh on arriving so stock/orders changed in the Agent Console are not stale.
    const on = () => { if (location.hash === "#merchant") { void load(); void loadOrders(); } };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  async function reset() {
    setBusy(true);
    setResetError("");
    setStatus("");
    try {
      setStatus(`Catalog reset: ${counts(await resetCatalog())}`);
      setConfirming(false);
      await load();
    } catch (e) {
      setResetError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doImport(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setImportErrors([]);
    setStatus("");
    try {
      const r = await importCatalog({ replace, products: parseCatalogImport(text) });
      setStatus(`Imported ${counts(r)}`);
      await load();
    } catch (err) {
      // Server 400 content is "path: message; path: message"; ponytail: a message containing "; " itself splits too.
      setImportErrors((err as Error).message.split("; "));
    } finally {
      setBusy(false);
    }
  }

  const variants = products?.reduce((n, p) => n + p.variants.length, 0) ?? 0;
  return (
    <section className="page">
      <h1>Merchant</h1>
      <p className="muted">Back-office for the built-in merchant only, not the URL typed in other tabs.</p>
      <div className="row">
        <h2 className="grow">Catalog</h2>
        <button onClick={load}>Refresh</button>
        <button disabled={!products} onClick={() => download("ucp-catalog.json", JSON.stringify({ products }, null, 2), "application/json")}>Download current catalog (.json)</button>
        {!confirming && <button className="danger" onClick={() => { setConfirming(true); setResetError(""); }}>Reset to sample catalog</button>}
      </div>
      {confirming && (
        <div className="banner warn" role="group" aria-label="Confirm reset">
          <span>Reset the catalog to the sample products? Orders and checkouts are kept.</span>
          <button className="danger" disabled={busy} onClick={reset}>Confirm reset</button>
          <button autoFocus disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
      {resetError && <div className="banner error" role="alert">{resetError}</div>}
      <div role="status" aria-live="polite">{status && <div className="banner ok">{status}</div>}</div>
      {loadError && <div className="banner error" role="alert">{loadError}</div>}
      {products && products.length === 0 && <div className="empty">The catalog is empty. Import products or reset to the sample catalog.</div>}
      {products && products.length > 0 && (
        <>
          <p className="muted small">{products.length} products, {variants} variants</p>
          <table className="steps">
            <caption className="sr">Catalog variants</caption>
            <thead>
              <tr><th scope="col">Product</th><th scope="col">Variant</th><th scope="col">SKU</th><th scope="col" className="num">Price</th><th scope="col" className="num">Stock</th></tr>
            </thead>
            <tbody>
              {products.flatMap((p) => p.variants.map((v: J) => (
                <tr key={v.id}>
                  <td>{p.title}</td>
                  <td>{v.title}</td>
                  <td className="mono">{v.sku}</td>
                  <td className="num">{money(v.price)}</td>
                  <td className="num">{v.stock === 0 && <span className="badge fail">OUT OF STOCK</span>} {v.stock}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </>
      )}

      <div className="merchant-sec">
        <div className="row">
          <h2 className="grow">Orders</h2>
          <button onClick={loadOrders}>Refresh</button>
        </div>
        {orderError && <div className="banner error" role="alert">{orderError}</div>}
        {orders && orders.length === 0 && <div className="empty">No orders yet. Complete a checkout in the Agent Console.</div>}
        {orders && orders.length > 0 && <OrdersTable orders={orders} busyId={shipping} onShip={ship} />}
      </div>

      <div className="merchant-sec">
        <h2>Import</h2>
        <form onSubmit={doImport}>
          <label>
            <span className="muted small">Catalog JSON file</span>
            <input type="file" accept=".json,application/json" onChange={async (e) => {
              const input = e.target, f = input.files?.[0];
              if (!f) return;
              try { setText(await f.text()); setImportErrors([]); } catch (err) { setImportErrors([(err as Error).message]); }
              input.value = ""; // so re-picking the same (edited) file fires change again
            }} />
          </label>
          <label>
            <span className="muted small">Catalog JSON</span>
            <textarea className="mono" rows={10} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "products": [ ... ] }' />
          </label>
          <label className="notice">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace existing catalog
          </label>
          <button className="primary" disabled={busy || !text.trim()}>{busy ? "Working…" : "Import"}</button>
        </form>
        {importErrors.length > 0 && (
          <div className="banner error" role="alert">
            {importErrors.length === 1 ? <span className="mono">{importErrors[0]}</span> : <ul>{importErrors.map((m, i) => <li key={i} className="mono">{m}</li>)}</ul>}
          </div>
        )}
      </div>
    </section>
  );
}
