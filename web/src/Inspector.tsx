import { useState } from "react";
import { inspect, type J } from "./api";

const LABEL = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;
const ICON = { pass: "✓", warn: "!", fail: "✕" } as const;

export function Inspector() {
  const [url, setUrl] = useState(window.location.origin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<J>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResult(await inspect(url));
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page narrow">
      <h1>Profile inspector</h1>
      <p className="muted">Fetches <code>/.well-known/ucp</code> from a merchant origin and validates it.</p>
      <form className="row" onSubmit={run}>
        <label className="grow">
          <span className="sr">Merchant URL</span>
          <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://merchant.example" spellCheck={false} />
        </label>
        <button className="primary" disabled={busy || !url.trim()}>{busy ? "Inspecting…" : "Inspect"}</button>
      </form>
      {error && <div className="banner error" role="alert">{error}</div>}
      {!result && !error && !busy && <div className="empty">Enter a merchant URL and press Inspect to run the checks.</div>}
      {result && (
        <>
          <div className="summary" aria-label="Summary">
            {(["pass", "warn", "fail"] as const).map((s) => (
              <div key={s} className={`stat ${s}`}><b>{result.summary[s]}</b><span>{LABEL[s]}</span></div>
            ))}
            <span className="muted mono small grow right">{result.origin}</span>
          </div>
          <ul className="checks">
            {result.checks.map((c: J) => (
              <li key={c.id} className={c.status}>
                <span className={`badge ${c.status}`}><span aria-hidden="true">{ICON[c.status as keyof typeof ICON]}</span> {LABEL[c.status as keyof typeof LABEL]}</span>
                <span className="ctitle">{c.title}</span>
                <span className="detail mono">{c.detail}</span>
              </li>
            ))}
          </ul>
          {result.profile && (
            <details className="raw">
              <summary>Raw profile JSON</summary>
              <pre>{JSON.stringify(result.profile, null, 2)}</pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}
