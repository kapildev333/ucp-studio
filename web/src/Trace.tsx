import type { J, Trace as T } from "./api";

const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};
const cls = (s: number | null) => (s === null ? "err" : s < 300 ? "ok" : s < 400 ? "warn" : "err");
const json = (v: J) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

export function Trace({ items, onClear }: { items: T[]; onClear: () => void }) {
  return (
    <aside className="trace" aria-label="Wire trace">
      <div className="trace-head">
        <h2>Wire trace <span className="muted">{items.length}</span></h2>
        <button onClick={onClear} disabled={!items.length}>Clear</button>
      </div>
      {!items.length && <div className="empty">Every call to the merchant shows up here, newest first.</div>}
      <ol>
        {items.map((t) => (
          <li key={t.id}>
            <details>
              <summary>
                <span className={`method ${t.method}`}>{t.method}</span>
                <span className="path mono" title={t.url}>{pathOf(t.url)}</span>
                <span className={`status ${cls(t.status)}`}>{t.status ?? "ERR"}</span>
                <span className="muted mono small">{t.status === null ? "" : `${t.duration_ms}ms`}</span>
              </summary>
              {t.error && <div className="banner error">{t.error}</div>}
              <h3>Request <span className="mono muted small">{t.url}</span></h3>
              <pre>{json(t.request.headers ?? {})}</pre>
              {t.request.body !== undefined && <pre>{json(t.request.body)}</pre>}
              {t.response && (
                <>
                  <h3>Response</h3>
                  <pre>{json(t.response.headers)}</pre>
                  <pre>{json(t.response.body)}</pre>
                </>
              )}
            </details>
          </li>
        ))}
      </ol>
    </aside>
  );
}
