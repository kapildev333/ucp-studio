import { useState } from "react";
import type { J, Trace as T } from "./api";
import { download, toCurl, traceToMarkdown } from "./export";

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

export function TraceEntry({ t }: { t: T }) {
  const [copied, setCopied] = useState("Copy as curl");
  const copy = () => {
    const flash = (m: string) => {
      setCopied(m);
      setTimeout(() => setCopied("Copy as curl"), 1500);
    };
    navigator.clipboard.writeText(toCurl(t)).then(() => flash("Copied"), () => flash("Copy failed"));
  };
  return (
    <li>
      <details>
        <summary>
          <span className={`method ${t.method}`}>{t.method}</span>
          <span className="path mono" title={t.url}>{pathOf(t.url)}</span>
          <span className={`status ${cls(t.status)}`}>{t.status ?? "ERR"}</span>
          <span className="muted mono small">{t.status === null ? "" : `${t.duration_ms}ms`}</span>
        </summary>
        {t.error && <div className="banner error">{t.error}</div>}
        <button className="trace-copy" onClick={copy}>{copied}</button>
        <span className="sr" role="status">{copied === "Copy as curl" ? "" : copied}</span>
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
  );
}

export function Trace({ items, onClear }: { items: T[]; onClear: () => void }) {
  const chrono = () => [...items].sort((a, b) => a.id - b.id); // items arrive newest first
  return (
    <aside className="trace" aria-label="Wire trace">
      <div className="trace-head">
        <h2>Wire trace <span className="muted">{items.length}</span></h2>
        <div className="actions">
          <button onClick={() => download("ucp-trace.json", JSON.stringify(chrono(), null, 2), "application/json")} disabled={!items.length}>Download JSON</button>
          <button onClick={() => download("ucp-trace.md", traceToMarkdown(chrono()), "text/markdown")} disabled={!items.length}>Download report (.md)</button>
          <button onClick={onClear} disabled={!items.length}>Clear</button>
        </div>
      </div>
      {!items.length && <div className="empty">Every call to the merchant shows up here, newest first.</div>}
      <ol>
        {items.map((t) => (
          <TraceEntry key={t.id} t={t} />
        ))}
      </ol>
    </aside>
  );
}
