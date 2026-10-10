import { useCallback, useEffect, useRef, useState } from "react";
import { money, orderSummary, sameOrigin, type J, type Session } from "./api";

type Hook = { received_at: string; headers?: Record<string, string>; body: J };
const arr = (x: J): J[] => (Array.isArray(x) ? x : []);

export function OrderPanel({ session, orderId, merchantUrl, onResult }: { session: Session; orderId: string; merchantUrl: string; onResult: (b: J) => void }) {
  const [order, setOrder] = useState<J>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [hookErr, setHookErr] = useState("");

  const report = useRef(onResult);
  report.current = onResult; // latest callback without re-running load/effects on every parent render
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const b = await session.ucp("get_order", { id: orderId });
      setOrder(b);
      report.current(b);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [session, orderId]);
  // ponytail: a late get_order after unmount only sets state on an unmounted component (a no-op in React 18).
  useEffect(() => void load(), [load]);

  async function ship() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/merchant-admin/orders/${encodeURIComponent(orderId)}/ship`, { method: "POST" });
      if (!r.ok) {
        const b = await r.json().catch(() => null);
        throw new Error(b?.code ? `${b.code} ${b.content ?? ""}`.trim() : `Ship failed: HTTP ${r.status}`);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      return;
    }
    await load();
  }

  // Poll the studio receiver while mounted and visible; resume on visibilitychange.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      try {
        const r = await fetch("/api/webhooks/orders");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (live) {
          setHooks(arr(d?.events));
          setHookErr("");
        }
      } catch (e) {
        if (live) setHookErr(`Webhook polling failed: ${(e as Error).message}`);
      }
    };
    const sync = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === "visible") {
        void poll();
        timer = setInterval(poll, 2000);
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  async function clear() {
    try {
      const r = await fetch("/api/webhooks/orders", { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setHooks([]);
      setHookErr("");
    } catch (e) {
      setHookErr(`Clear failed: ${(e as Error).message}`);
    }
  }

  const lines = arr(order?.line_items);
  const events = arr(order?.fulfillment?.events);
  const totals = arr(order?.totals);
  const done = lines.length > 0 && lines.every((l) => l?.status === "fulfilled");
  const mine = hooks.filter((h) => h?.body?.id === orderId);

  return (
    <section className="step order-panel" aria-labelledby="order-h">
      <h2 id="order-h">Order <span className="mono">{orderId}</span></h2>
      {error && <div className="banner error" role="alert">{error}</div>}
      <div className="row">
        {order?.permalink_url && <a href={order.permalink_url} target="_blank" rel="noreferrer">Permalink</a>}
        <span className="grow" />
        <button onClick={() => void load()} disabled={busy}>Refresh</button>
        {sameOrigin(merchantUrl, window.location.origin) && <button className="primary" onClick={() => void ship()} disabled={busy || done}>Simulate shipment</button>}
      </div>

      {order && (
        <>
          <h3>Line items</h3>
          <table className="olines">
            <thead><tr><th>Item</th><th className="right">Fulfilled / total</th><th>Status</th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l?.id ?? i}>
                  <td>{l?.item?.title ?? l?.item?.id ?? l?.id ?? "(item)"}</td>
                  <td className="mono right">{l?.quantity?.fulfilled ?? 0} / {l?.quantity?.total ?? 0}</td>
                  <td><span className={`ostatus ${l?.status}`}>{l?.status ?? "unknown"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Fulfillment events</h3>
          {!events.length && <p className="muted small">No fulfillment events yet.</p>}
          <ul className="oevents">
            {events.map((e, i) => (
              <li key={e?.id ?? i}>
                <b>{e?.type ?? "event"}</b> <span className="muted small">{e?.occurred_at ? new Date(e.occurred_at).toLocaleString() : ""}</span>
                <div className="small">
                  {e?.tracking_number && (e?.tracking_url ? <a className="mono" href={e.tracking_url} target="_blank" rel="noreferrer">{e.tracking_number}</a> : <span className="mono">{e.tracking_number}</span>)}
                  {e?.carrier && <> · {e.carrier}</>}
                  {e?.description && <> · <span className="muted">{e.description}</span></>}
                </div>
              </li>
            ))}
          </ul>

          <h3>Totals</h3>
          <dl className="totals">
            {totals.map((t, i) => (
              <div key={t?.type ?? i} className={t?.type === "total" ? "grand" : ""}><dt>{t?.type}</dt><dd className="mono">{money(t?.amount ?? 0)}</dd></div>
            ))}
          </dl>
        </>
      )}

      <div className="row hooks-head">
        <h3 className="grow">Webhooks received</h3>
        <button onClick={() => void clear()}>Clear</button>
      </div>
      {hookErr && <p className="muted small" role="status">{hookErr}</p>}
      {!mine.length && <p className="muted small">No webhooks received yet.</p>}
      <ul className="hooks">
        {mine.map((h, i) => (
          <li key={h.headers?.["webhook-id"] ?? i}>
            <details>
              <summary>
                <span className="mono small">{new Date(h.received_at).toLocaleTimeString()}</span> <span className="mono small muted">{h.headers?.["webhook-id"]}</span> <span className="mono">{orderSummary(h.body)}</span>
              </summary>
              <pre>{JSON.stringify(h, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
