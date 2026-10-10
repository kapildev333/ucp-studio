import { useEffect, useState } from "react";
import { AgentConsole } from "./AgentConsole";
import { Conformance } from "./Conformance";
import { Inspector } from "./Inspector";
import { ErrorBoundary } from "./ErrorBoundary";
import { Merchant } from "./Merchant";

const TABS = [
  ["inspector", "Inspector"],
  ["console", "Agent Console"],
  ["conformance", "Conformance"],
  ["merchant", "Merchant"],
] as const;
const fromHash = () => TABS.find(([id]) => `#${id}` === location.hash)?.[0] ?? "inspector";

export function App() {
  const [tab, setTab] = useState<string>(fromHash());
  useEffect(() => {
    const on = () => setTab(fromHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  // All panes stay mounted (hidden) so switching tabs keeps their state.
  return (
    <>
      <header className="topbar">
        <span className="brand"><span className="logo">U</span>UCP Studio</span>
        <nav aria-label="Sections">
          {TABS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className={tab === id ? "tab active" : "tab"} aria-current={tab === id ? "page" : undefined}>{label}</a>
          ))}
        </nav>
        <span className="muted mono small">localhost only</span>
      </header>
      <main>
        <div hidden={tab !== "inspector"}><ErrorBoundary label="Inspector"><Inspector /></ErrorBoundary></div>
        <div hidden={tab !== "console"}><ErrorBoundary label="AgentConsole"><AgentConsole /></ErrorBoundary></div>
        <div hidden={tab !== "conformance"}><ErrorBoundary label="Conformance"><Conformance /></ErrorBoundary></div>
        <div hidden={tab !== "merchant"}><ErrorBoundary label="Merchant"><Merchant /></ErrorBoundary></div>
      </main>
    </>
  );
}
