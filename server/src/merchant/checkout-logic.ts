// Pure checkout derivation: stored request + variant lookup in, line items / fulfillment / totals / messages / status out.
export type Variant = { id: string; title: string; price: number; stock: number };
export type Address = { street_address: string; address_locality: string; address_region: string; postal_code: string; address_country: string };
export type CheckoutRequest = {
  line_items: { item: { id: string }; quantity: number }[];
  buyer?: { first_name?: string; last_name?: string; email?: string; phone_number?: string };
  fulfillment?: { methods: { type: "shipping"; destinations: Address[]; groups?: { selected_option_id?: string }[] }[] };
};
export type Message = { type: "error" | "warning" | "info"; code: string; content: string; path?: string; severity?: string };

export const OPTIONS = [
  { id: "standard", title: "Standard (5-7 days)", amount: 500 },
  { id: "express", title: "Express (2 days)", amount: 1500 },
];
// ponytail: flat demo tax rate; replace with a tax lookup for real use
const TAX_RATE = 0.08;

const required = (path: string, content: string): Message => ({ type: "error", code: "field_required", content, path, severity: "recoverable" });

export function unknownItems(req: CheckoutRequest, exists: (id: string) => boolean): Message[] {
  return req.line_items.flatMap((l, i) => exists(l.item.id) ? [] : [{
    type: "error" as const, code: "item_not_found", path: `$.line_items[${i}].item.id`, severity: "unrecoverable", content: `Unknown item ${l.item.id}`,
  }]);
}

// `fulfillmentOn` false = the fulfillment extension wasn't negotiated: no fulfillment, total or messages for it.
export function derive(req: CheckoutRequest, lookup: (id: string) => Variant, fulfillmentOn = true) {
  const variants = req.line_items.map((l) => lookup(l.item.id));
  const line_items = req.line_items.map((l, i) => {
    const amount = variants[i].price * l.quantity;
    return {
      id: `li_${i + 1}`, item: { id: variants[i].id, title: variants[i].title, price: variants[i].price }, quantity: l.quantity,
      totals: [{ type: "subtotal", amount }, { type: "total", amount }],
    };
  });

  const method = fulfillmentOn ? req.fulfillment?.methods[0] : undefined;
  const dests = method?.destinations ?? [];
  const selected = dests.length ? OPTIONS.find((o) => o.id === method?.groups?.[0]?.selected_option_id) : undefined;
  const fulfillment = method && {
    methods: [{
      id: "shipping", type: "shipping",
      destinations: dests.map((d, i) => ({ id: `dest_${i + 1}`, ...d })),
      ...(dests.length && {
        selected_destination_id: "dest_1",
        groups: [{
          id: "grp_1", line_item_ids: line_items.map((l) => l.id),
          options: OPTIONS.map((o) => ({ id: o.id, title: o.title, totals: [{ type: "total", amount: o.amount }] })),
          ...(selected && { selected_option_id: selected.id }),
        }],
      }),
    }],
  };

  const subtotal = line_items.reduce((s, l) => s + l.totals[0].amount, 0);
  const tax = Math.round(subtotal * TAX_RATE);
  const shipping = selected?.amount ?? 0;
  const totals = [
    { type: "subtotal", amount: subtotal },
    ...(selected ? [{ type: "fulfillment", amount: shipping }] : []),
    { type: "tax", amount: tax },
    { type: "total", amount: subtotal + shipping + tax },
  ];

  const wanted = new Map<string, number>(); // lines may repeat a variant: check stock against the sum
  for (const l of req.line_items) wanted.set(l.item.id, (wanted.get(l.item.id) ?? 0) + l.quantity);
  const messages: Message[] = [
    ...req.line_items.flatMap((l, i): Message[] => wanted.get(l.item.id)! > variants[i].stock ? [{
      type: "error", code: "out_of_stock", path: `$.line_items[${i}].quantity`, severity: "recoverable",
      content: `Only ${variants[i].stock} of ${variants[i].title} in stock`,
    }] : []),
    ...(req.buyer?.email ? [] : [required("$.buyer.email", "Buyer email is required")]),
    ...(dests.length || !fulfillmentOn ? [] : [required("$.fulfillment.methods[0].destinations", "A shipping destination is required")]),
    ...(dests.length && !selected ? [required("$.fulfillment.methods[0].groups[0].selected_option_id", "Select a shipping option")] : []),
  ];
  const status = messages.some((m) => m.type === "error") ? "incomplete" : "ready_for_complete";
  return { line_items, fulfillment, totals, messages, status };
}
