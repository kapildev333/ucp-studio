import { useState } from "react";
import { checkoutBody, connect as connectMerchant, money, openSession, stepOf, type Address, type Buyer, type Connection, type J, type Op, type Session, type Step, type Trace as T, type Transport } from "./api";
import { Trace } from "./Trace";

type Line = { id: string; title: string; price: number; qty: number };
const STATES = ["incomplete", "ready_for_complete", "completed", "canceled"];
// Third-party merchants may omit fields; fill the ones the UI dereferences so a bad response never blanks the app.
const safeProduct = (p: J): J => ({
  ...p,
  title: p.title ?? p.id ?? "(untitled)",
  categories: Array.isArray(p.categories) ? p.categories : [],
  price_range: { min: { amount: p.price_range?.min?.amount ?? 0 } },
  variants: (Array.isArray(p.variants) ? p.variants : []).map((v: J) => ({ ...v, title: v.title ?? v.id, price: { amount: v.price?.amount ?? 0 }, availability: { available: !!v.availability?.available } })),
});
const EMPTY_BUYER: Buyer = { first_name: "", last_name: "", email: "", phone_number: "" };
const EMPTY_ADDR: Address = { street_address: "", address_locality: "", address_region: "", postal_code: "", address_country: "US" };

export function AgentConsole() {
  const [url, setUrl] = useState(window.location.origin);
  const [conn, setConn] = useState<Connection | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [caps, setCaps] = useState<{ name: string; version: string }[]>([]);
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<J[] | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [cart, setCart] = useState<Line[]>([]);
  const [checkout, setCheckout] = useState<J>(null);
  const [msgs, setMsgs] = useState<J[]>([]);
  const [buyer, setBuyer] = useState(EMPTY_BUYER);
  const [addr, setAddr] = useState(EMPTY_ADDR);
  const [token, setToken] = useState("tok_success");
  const [trace, setTrace] = useState<T[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const onTrace = (t: T) => setTrace((p) => [t, ...p]);
  const status: string | undefined = checkout?.status;
  const open = !!checkout && status !== "completed" && status !== "canceled";
  const group = checkout?.fulfillment?.methods?.[0]?.groups?.[0];

  // Runs one async step; any failure (UcpError, JSON-RPC error, proxy failure) lands in the banner, never a blank screen.
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const seen = (b: J) => b?.ucp && setCaps(Array.isArray(b.ucp.capabilities) ? b.ucp.capabilities : []);
  const found = (b: J) => setProducts((Array.isArray(b.products) ? b.products : []).filter((p: J) => p && typeof p === "object").map(safeProduct));
  // One UCP operation on the active session; transport details live in api.ts.
  const ucp = (op: Op, args: J, onOk: (b: J) => void) =>
    run(async () => {
      const b = await session!.ucp(op, args);
      seen(b);
      onOk(b);
    });
  const search = (q: string) => ucp("search_catalog", { query: q || undefined, pagination: { limit: 20 } }, found);

  // Opens a session on transport t and loads the empty catalog.
  async function begin(c: Connection, t: Transport) {
    const s = await openSession(onTrace, c, t);
    setSession(s);
    const b = await s.ucp("search_catalog", { pagination: { limit: 20 } });
    seen(b);
    found(b);
  }
  const offered = (c: Connection | null) => (["rest", "mcp"] as Transport[]).filter((t) => c?.endpoints[t]);

  const connect = () => {
    reset();
    setConn(null);
    setSession(null);
    setProducts(null);
    run(async () => {
      const c = await connectMerchant(onTrace, url);
      const first = offered(c)[0];
      if (!first) throw new Error("This profile offers no REST or MCP endpoint.");
      setConn(c);
      await begin(c, first);
    });
  };
  const switchTransport = (t: Transport) => {
    reset();
    setProducts(null);
    run(() => begin(conn!, t));
  };

  const applyCheckout = (b: J) => {
    setMsgs(b.messages ?? []);
    if (b.id) setCheckout({ ...b, totals: Array.isArray(b.totals) ? b.totals : [] });
  };
  const body = (opt?: string, withAddress = true) => checkoutBody(cart, buyer, addr, opt, withAddress);
  const start = () => ucp("create_checkout", { checkout: body(undefined, false) }, applyCheckout);
  const update = (opt = group?.selected_option_id) => ucp("update_checkout", { id: checkout.id, checkout: body(opt) }, applyCheckout);
  const pay = () =>
    ucp("complete_checkout", { id: checkout.id, checkout: { payment: { instruments: [{ id: "instr_1", handler_id: "mock_pay", type: "token", credential: { token } }] } } }, applyCheckout);
  const cancel = () => ucp("cancel_checkout", { id: checkout.id }, applyCheckout);
  const reset = () => {
    setCheckout(null);
    setMsgs([]);
    setCart([]);
    setBuyer(EMPTY_BUYER);
    setAddr(EMPTY_ADDR);
    setError("");
    setCaps([]);
  };

  function add(p: J) {
    const v = p.variants.find((x: J) => x.id === (picks[p.id] ?? p.variants.find((y: J) => y.availability.available)?.id));
    if (!v) return;
    setCart((c) => (c.some((l) => l.id === v.id) ? c.map((l) => (l.id === v.id ? { ...l, qty: l.qty + 1 } : l)) : [...c, { id: v.id, title: `${p.title} · ${v.title}`, price: v.price.amount, qty: 1 }]));
  }
  const setQty = (id: string, qty: number) => setCart((c) => (qty < 1 ? c.filter((l) => l.id !== id) : c.map((l) => (l.id === id ? { ...l, qty } : l))));

  const Msgs = ({ step }: { step: Step }) => (
    <>
      {msgs.filter((m) => stepOf(m.path) === step).map((m, i) => (
        <div key={i} className={`banner ${m.type === "error" ? "error" : m.type === "warning" ? "warn" : "info"}`}>
          <b className="mono">{m.code}</b> {m.content}
        </div>
      ))}
    </>
  );
  const field = (label: string, value: string, set: (v: string) => void, extra = "") => (
    <label className={extra}>
      <span>{label}</span>
      <input value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );
  const sum = (kind: string) => checkout.totals.find((t: J) => t.type === kind)?.amount;

  return (
    <div className="console">
      <section className="wizard">
        <div className="strip" aria-label="Checkout status">
          {STATES.map((s, i) => (
            <span key={s} aria-current={s === status ? "step" : undefined} className={`state ${s === status ? "current" : ""} ${s}`}>
              {i === 3 && <i className="sep" />}{s}{i < 2 && <i className="arrow">→</i>}
            </span>
          ))}
          {!status && <span className="muted small">no session</span>}
        </div>
        {error && <div className="banner error" role="alert">{error}</div>}

        <fieldset className="step" disabled={busy}>
          <legend><i>1</i> Connect</legend>
          <form className="row" onSubmit={(e) => { e.preventDefault(); connect(); }}>
            <label className="grow"><span className="sr">Merchant URL</span><input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} /></label>
            <button className="primary" disabled={!url.trim()}>Connect</button>
          </form>
          {conn && session && (
            <fieldset className="transport">
              <legend>Transport</legend>
              {offered(conn).map((t) => (
                <label key={t} className="opt">
                  <input type="radio" name="transport" checked={session.transport === t} onChange={() => switchTransport(t)} />
                  <span>{t.toUpperCase()}</span>
                </label>
              ))}
            </fieldset>
          )}
          <p className="muted small mono">{session && conn ? `${session.transport.toUpperCase()} endpoint ${conn.endpoints[session.transport]}` : "Reads /.well-known/ucp through the proxy to find the REST or MCP endpoint."}</p>
          {session && (
            <div className="chips">
              <span className="small muted">Negotiated capabilities</span>
              {caps.length ? caps.map((c) => <span key={c.name} className="chip mono">{c.name} <span className="muted">{c.version}</span></span>) : <span className="small muted">none</span>}
            </div>
          )}
        </fieldset>

        <fieldset className="step" disabled={busy || !session}>
          <legend><i>2</i> Catalog</legend>
          <form className="row" onSubmit={(e) => { e.preventDefault(); search(query); }}>
            <label className="grow"><span className="sr">Search products</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products…" /></label>
            <button>Search</button>
          </form>
          {products && !products.length && <div className="empty">No products matched.</div>}
          <div className="cards">
            {products?.map((p) => (
              <div className="card" key={p.id}>
                <div className="card-top"><b>{p.title}</b><span className="mono">{money(p.price_range.min.amount)}</span></div>
                <div className="muted small">{p.categories.join(", ")}</div>
                <div className="row">
                  <label className="grow">
                    <span className="sr">Variant of {p.title}</span>
                    <select value={picks[p.id] ?? p.variants.find((v: J) => v.availability.available)?.id ?? p.variants[0]?.id} onChange={(e) => setPicks({ ...picks, [p.id]: e.target.value })}>
                      {p.variants.map((v: J) => (
                        <option key={v.id} value={v.id} disabled={!v.availability.available}>
                          {v.title} · {money(v.price.amount)}{v.availability.available ? "" : " · out of stock"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button onClick={() => add(p)} disabled={open || !p.variants.some((v: J) => v.availability.available)}>Add</button>
                </div>
              </div>
            ))}
          </div>
        </fieldset>

        <fieldset className="step" disabled={busy || !session}>
          <legend><i>3</i> Cart</legend>
          {!cart.length && <div className="empty">Add a product to start.</div>}
          {cart.map((l) => (
            <div className="line" key={l.id}>
              <span className="grow">{l.title}</span>
              <input type="number" min={1} aria-label={`Quantity of ${l.title}`} value={l.qty} disabled={!!checkout && !open} onChange={(e) => setQty(l.id, Math.max(1, Math.floor(Number(e.target.value)) || 1))} />
              <span className="mono amt">{money(l.price * l.qty)}</span>
              <button aria-label={`Remove ${l.title}`} disabled={open} onClick={() => setQty(l.id, 0)}>×</button>
            </div>
          ))}
          <Msgs step="cart" />
          {open && <button onClick={() => update()}>Update cart</button>}
          {!checkout && <button className="primary" disabled={!cart.length} onClick={start}>Start checkout</button>}
        </fieldset>

        {checkout && (
          <>
            <fieldset className="step" disabled={busy || !open}>
              <legend><i>4</i> Buyer and address</legend>
              <div className="grid">
                {field("First name", buyer.first_name, (v) => setBuyer({ ...buyer, first_name: v }))}
                {field("Last name", buyer.last_name, (v) => setBuyer({ ...buyer, last_name: v }))}
                {field("Email", buyer.email, (v) => setBuyer({ ...buyer, email: v }), "wide")}
                {field("Street address", addr.street_address, (v) => setAddr({ ...addr, street_address: v }), "wide")}
                {field("City", addr.address_locality, (v) => setAddr({ ...addr, address_locality: v }))}
                {field("State", addr.address_region, (v) => setAddr({ ...addr, address_region: v }))}
                {field("Postal code", addr.postal_code, (v) => setAddr({ ...addr, postal_code: v }))}
                {field("Country", addr.address_country, (v) => setAddr({ ...addr, address_country: v }))}
              </div>
              <Msgs step="buyer" />
              <button onClick={() => update()}>Update</button>
            </fieldset>

            <fieldset className="step" disabled={busy || !open || !group}>
              <legend><i>5</i> Shipping</legend>
              {!group && <div className="empty">Add an address to see shipping options.</div>}
              {group?.options?.map((o: J) => (
                <label className="radio" key={o.id}>
                  <input type="radio" name="ship" checked={group.selected_option_id === o.id} onChange={() => update(o.id)} />
                  <span className="grow">{o.title}</span>
                  <span className="mono">{money(o.totals?.find((t: J) => t.type === "total")?.amount ?? 0)}</span>
                </label>
              ))}
              <Msgs step="shipping" />
            </fieldset>

            <fieldset className="step" disabled={busy || !open}>
              <legend><i>6</i> Pay</legend>
              <dl className="totals">
                {checkout.totals.map((t: J) => (
                  <div key={t.type} className={t.type === "total" ? "grand" : ""}><dt>{t.type}</dt><dd className="mono">{money(t.amount)}</dd></div>
                ))}
              </dl>
              <div className="row">
                <label className="grow"><span className="sr">Payment token</span>
                  <select value={token} onChange={(e) => setToken(e.target.value)}>
                    <option value="tok_success">tok_success</option>
                    <option value="tok_decline">tok_decline</option>
                  </select>
                </label>
                <button className="primary" disabled={status !== "ready_for_complete"} onClick={pay}>Pay {sum("total") !== undefined && money(sum("total"))}</button>
              </div>
              <Msgs step="pay" />
              <button className="danger" onClick={cancel}>Cancel checkout</button>
            </fieldset>

            {status === "completed" && checkout.order && (
              <div className="banner ok confirm">
                <b>Order placed</b>
                <span className="mono">{checkout.order.id}</span>
                <a href={checkout.order.permalink_url} target="_blank" rel="noreferrer">{checkout.order.permalink_url}</a>
              </div>
            )}
            {status === "canceled" && <div className="banner warn">Checkout canceled.</div>}
            {!open && <button onClick={reset}>New session</button>}
          </>
        )}
      </section>
      <Trace items={trace} onClear={() => setTrace([])} />
    </div>
  );
}
