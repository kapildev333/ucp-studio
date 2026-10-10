import { useState } from "react";
import { call, checkoutBody, money, restEndpoint, stepOf, type Address, type Buyer, type J, type Step, type Trace as T } from "./api";
import { Trace } from "./Trace";

type Line = { id: string; title: string; price: number; qty: number };
const STATES = ["incomplete", "ready_for_complete", "completed", "canceled"];
const EMPTY_BUYER: Buyer = { first_name: "", last_name: "", email: "", phone_number: "" };
const EMPTY_ADDR: Address = { street_address: "", address_locality: "", address_region: "", postal_code: "", address_country: "US" };

export function AgentConsole() {
  const [url, setUrl] = useState(window.location.origin);
  const [endpoint, setEndpoint] = useState("");
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

  // Runs one merchant call; HTTP errors and failures land in the banner, never a blank screen.
  async function run(method: "GET" | "POST" | "PUT", path: string, body?: unknown, onOk?: (b: J) => void) {
    setBusy(true);
    setError("");
    try {
      const r = await call(onTrace, method, path.startsWith("http") ? path : `${endpoint}${path}`, body);
      if (r.status >= 400) setError(`${r.status} ${r.body?.code ?? ""} ${r.body?.content ?? ""}`.trim());
      else onOk?.(r.body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const search = (q: string, ep = endpoint) =>
    run("POST", `${ep}/catalog/search`, { query: q || undefined, pagination: { limit: 20 } }, (b) => setProducts(b.products ?? []));

  const connect = () => {
    setEndpoint("");
    setProducts(null);
    run("GET", `${url.replace(/\/$/, "")}/.well-known/ucp`, undefined, (profile) => {
      const ep = restEndpoint(profile);
      if (!ep) return setError("This profile offers no REST endpoint.");
      setEndpoint(ep);
      search("", ep);
    });
  };

  const applyCheckout = (b: J) => {
    setMsgs(b.messages ?? []);
    if (b.id) setCheckout(b);
  };
  const body = (opt?: string, withAddress = true) => checkoutBody(cart, buyer, addr, opt, withAddress);
  const start = () => run("POST", "/checkout-sessions", body(undefined, false), applyCheckout);
  const update = (opt = group?.selected_option_id) => run("PUT", `/checkout-sessions/${checkout.id}`, body(opt), applyCheckout);
  const pay = () =>
    run("POST", `/checkout-sessions/${checkout.id}/complete`, { payment: { instruments: [{ id: "instr_1", handler_id: "mock_pay", type: "token", credential: { token } }] } }, applyCheckout);
  const cancel = () => run("POST", `/checkout-sessions/${checkout.id}/cancel`, {}, applyCheckout);
  const reset = () => {
    setCheckout(null);
    setMsgs([]);
    setCart([]);
    setBuyer(EMPTY_BUYER);
    setAddr(EMPTY_ADDR);
    setError("");
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
            <span key={s} className={`state ${s === status ? "current" : ""} ${s}`}>
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
          <p className="muted small mono">{endpoint ? `REST endpoint ${endpoint}` : "Reads /.well-known/ucp through the proxy to find the REST endpoint."}</p>
        </fieldset>

        <fieldset className="step" disabled={busy || !endpoint}>
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
                    <select value={picks[p.id] ?? p.variants.find((v: J) => v.availability.available)?.id ?? p.variants[0].id} onChange={(e) => setPicks({ ...picks, [p.id]: e.target.value })}>
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

        <fieldset className="step" disabled={busy || !endpoint}>
          <legend><i>3</i> Cart</legend>
          {!cart.length && <div className="empty">Add a product to start.</div>}
          {cart.map((l) => (
            <div className="line" key={l.id}>
              <span className="grow">{l.title}</span>
              <input type="number" min={1} aria-label={`Quantity of ${l.title}`} value={l.qty} disabled={open} onChange={(e) => setQty(l.id, Number(e.target.value))} />
              <span className="mono amt">{money(l.price * l.qty)}</span>
              <button aria-label={`Remove ${l.title}`} disabled={open} onClick={() => setQty(l.id, 0)}>×</button>
            </div>
          ))}
          <Msgs step="cart" />
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
              {group?.options.map((o: J) => (
                <label className="radio" key={o.id}>
                  <input type="radio" name="ship" checked={group.selected_option_id === o.id} onChange={() => update(o.id)} />
                  <span className="grow">{o.title}</span>
                  <span className="mono">{money(o.totals.find((t: J) => t.type === "total")?.amount ?? 0)}</span>
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
