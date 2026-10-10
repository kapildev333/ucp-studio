import { describe, it, expect } from "vitest";
import { derive, unknownItems, type CheckoutRequest, type Variant } from "../src/merchant/checkout-logic.js";

const V: Record<string, Variant> = {
  a: { id: "a", title: "A", price: 1299, stock: 5 },
  b: { id: "b", title: "B", price: 1999, stock: 1 },
};
const lookup = (id: string) => V[id];
const addr = { street_address: "1 Main", address_locality: "X", address_region: "CA", postal_code: "94000", address_country: "US" };
const full = (opt?: string): CheckoutRequest => ({
  line_items: [{ item: { id: "a" }, quantity: 2 }],
  buyer: { email: "a@b.co" },
  fulfillment: { methods: [{ type: "shipping", destinations: [addr], groups: [{ selected_option_id: opt }] }] },
});

describe("derive", () => {
  it("computes totals with fulfillment and tax", () => {
    const d = derive(full("standard"), lookup);
    expect(d.totals).toEqual([
      { type: "subtotal", amount: 2598 }, { type: "fulfillment", amount: 500 }, { type: "tax", amount: 208 }, { type: "total", amount: 3306 },
    ]);
    expect(d.line_items[0]).toMatchObject({ id: "li_1", item: { id: "a", title: "A", price: 1299 }, quantity: 2 });
    expect(d.line_items[0].totals).toEqual([{ type: "subtotal", amount: 2598 }, { type: "total", amount: 2598 }]);
    expect(d.messages).toEqual([]);
    expect(d.status).toBe("ready_for_complete");
  });
  it("uses express and omits fulfillment total when no option selected", () => {
    expect(derive(full("express"), lookup).totals.find((t) => t.type === "fulfillment")?.amount).toBe(1500);
    const d = derive(full("bogus"), lookup);
    expect(d.totals.map((t) => t.type)).toEqual(["subtotal", "tax", "total"]);
    expect(d.fulfillment!.methods[0]).not.toHaveProperty("groups.0.selected_option_id");
  });
  it("rounds tax half up", () => {
    // 1999 * .08 = 159.92 -> 160 ; 1299 * .08 = 103.92 -> 104 ; 6 * .08 = .48 -> 0 ; 7 * .08 = .56 -> 1
    expect(derive({ line_items: [{ item: { id: "b" }, quantity: 1 }] }, lookup).totals[1]).toEqual({ type: "tax", amount: 160 });
    expect(derive({ line_items: [{ item: { id: "a" }, quantity: 1 }] }, lookup).totals[1]).toEqual({ type: "tax", amount: 104 });
    V.c = { id: "c", title: "C", price: 1, stock: 9 }; // 0.08 -> 0
    expect(derive({ line_items: [{ item: { id: "c" }, quantity: 6 }] }, lookup).totals[1].amount).toBe(0); // .48
    expect(derive({ line_items: [{ item: { id: "c" }, quantity: 7 }] }, lookup).totals[1].amount).toBe(1); // .56
  });
  it("emits messages in order with paths", () => {
    const d = derive({ line_items: [{ item: { id: "b" }, quantity: 3 }, { item: { id: "a" }, quantity: 9 }] }, lookup);
    expect(d.messages.map((m) => [m.code, m.path])).toEqual([
      ["out_of_stock", "$.line_items[0].quantity"], ["out_of_stock", "$.line_items[1].quantity"],
      ["field_required", "$.buyer.email"], ["field_required", "$.fulfillment.methods[0].destinations"],
    ]);
    expect(d.messages.every((m) => m.type === "error" && m.severity === "recoverable")).toBe(true);
    expect(d.status).toBe("incomplete");
    expect(d.fulfillment).toBeUndefined();
  });
  it("asks for an option when a destination exists but none is selected", () => {
    const d = derive({ ...full(), buyer: { email: "x@y.z" } }, lookup);
    expect(d.messages.map((m) => m.path)).toEqual(["$.fulfillment.methods[0].groups[0].selected_option_id"]);
    expect(d.status).toBe("incomplete");
    expect(d.fulfillment!.methods[0]).toMatchObject({ selected_destination_id: "dest_1", groups: [{ id: "grp_1", line_item_ids: ["li_1"] }] });
  });
  it("empty destinations means no destination and no groups", () => {
    const d = derive({ line_items: full().line_items, buyer: { email: "e" }, fulfillment: { methods: [{ type: "shipping", destinations: [] }] } }, lookup);
    expect(d.messages.map((m) => m.path)).toEqual(["$.fulfillment.methods[0].destinations"]);
    expect(d.fulfillment!.methods[0]).not.toHaveProperty("groups");
  });
});

describe("unknownItems", () => {
  it("reports each unknown id with its path", () => {
    const m = unknownItems({ line_items: [{ item: { id: "a" }, quantity: 1 }, { item: { id: "zz" }, quantity: 1 }] }, (id) => id in V);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ type: "error", code: "item_not_found", path: "$.line_items[1].item.id", severity: "unrecoverable" });
  });
});
