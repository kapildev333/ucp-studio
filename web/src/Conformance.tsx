import { useState } from "react";
import { runConformance, type J, type Trace as T } from "./api";
import { download, conformanceToMarkdown } from "./export";
import { TraceEntry } from "./Trace";

const KINDS = ["pass", "fail", "warn", "skip"] as const;
const ICON = { pass: "✓", fail: "✕", warn: "!", skip: "–" } as const;

// A status-0 exchange got no response: show it as ERR with the error text, not a fake "0".
const toTrace = (e: J, i: number): T => {
  const none = e.response.status === 0;
  return {
    id: i, method: e.request.method, url: e.request.url, status: none ? null : e.response.status, duration_ms: e.duration_ms,
    request: e.request, response: none ? null : e.response,
    ...(none && { error: typeof e.response.body === "string" ? e.response.body : JSON.stringify(e.response.body) }),
  };
};

export function Conformance() {
  const [url, setUrl] = useState(window.location.origin);
  const [transport, setTransport] = useState<"rest" | "mcp">("rest");
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<J>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await runConformance({ url, transport, allow_complete: complete }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page narrow">
      <h1>Conformance</h1>
      <p className="muted">Runs a scripted checkout against a merchant and asserts each step against the UCP spec.</p>
      <form onSubmit={run}>
        <div className="row">
          <label className="grow">
            <span className="sr">Merchant URL</span>
            <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://merchant.example" spellCheck={false} />
          </label>
          <label>
            <span className="sr">Transport</span>
            <select value={transport} onChange={(e) => setTransport(e.target.value as "rest" | "mcp")}>
              <option value="rest">REST</option>
              <option value="mcp">MCP</option>
            </select>
          </label>
          <button className="primary" disabled={busy || !url.trim()}>{busy ? "Running…" : "Run"}</button>
        </div>
        <label className="notice">
          <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} /> Also complete a test purchase (mock payment only)
        </label>
        <p className="muted small notice">{complete ? "A run creates one checkout session on the target merchant and completes it with the mock payment handler." : "A run creates and then cancels one checkout session on the target merchant."}</p>
      </form>
      {error && <div className="banner error" role="alert">{error}</div>}
      {!result && !error && !busy && <div className="empty">Enter a merchant URL and press Run to start the conformance suite.</div>}
      <span className="sr" role="status">{result ? `Run finished: ${KINDS.map((k) => `${result.summary[k]} ${k}`).join(", ")}` : ""}</span>
      <div>
        {result && (
          <>
            <div className="summary wrap" aria-label="Summary">
              {KINDS.map((s) => (
                <div key={s} className={`stat ${s}`}><b>{result.summary[s]}</b><span>{s.toUpperCase()}</span></div>
              ))}
              <span className="muted mono small grow right">{result.origin} · {result.transport} · {result.duration_ms} ms</span>
              <button onClick={() => download("ucp-conformance.md", conformanceToMarkdown(result), "text/markdown")}>Download report (.md)</button>
            </div>
            <table className="steps">
              <caption>Conformance steps</caption>
              <thead>
                <tr><th scope="col">Status</th><th scope="col">Step</th><th scope="col">Detail</th></tr>
              </thead>
              <tbody>
                {result.steps.map((s: J) => (
                  <tr key={s.id}>
                    <td><span className={`badge ${s.status}`}><span aria-hidden="true">{ICON[s.status as keyof typeof ICON]}</span> {String(s.status).toUpperCase()}</span></td>
                    <td>
                      <span className="ctitle">{s.title}</span> <span className="muted mono small">{s.id}</span>
                      {s.exchanges?.length > 0 && (
                        <details>
                          <summary>{s.exchanges.length} exchange{s.exchanges.length === 1 ? "" : "s"}</summary>
                          <div className="trace"><ol>{s.exchanges.map((e: J, i: number) => <TraceEntry key={i} t={toTrace(e, i)} />)}</ol></div>
                        </details>
                      )}
                    </td>
                    <td className="detail mono">{s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  );
}
