import { describe, expect, it } from "vitest";
import { checkoutBody, money, restEndpoint, stepOf } from "./api";

const addr = { street_address: "1 Main St", address_locality: "Austin", address_region: "TX", postal_code: "78701", address_country: "US" };
const buyer = { first_name: "", last_name: "", email: "", phone_number: "" };

describe("money", () => {
  it("formats integer minor units as USD", () => {
    expect(money(3306)).toBe("$33.06");
    expect(money(500)).toBe("$5.00");
  });
});

describe("restEndpoint", () => {
  it("finds the first rest endpoint across services", () => {
    const p = { ucp: { services: { a: [{ transport: "mcp", endpoint: "x" }], b: [{ transport: "rest", endpoint: "http://h/ucp" }] } } };
    expect(restEndpoint(p)).toBe("http://h/ucp");
    expect(restEndpoint({ ucp: {} })).toBeUndefined();
  });
});

describe("stepOf", () => {
  it("routes message paths to the step they concern", () => {
    expect(stepOf("$.line_items[0].quantity")).toBe("cart");
    expect(stepOf("$.buyer.email")).toBe("buyer");
    expect(stepOf("$.fulfillment.methods[0].destinations")).toBe("buyer");
    expect(stepOf("$.fulfillment.methods[0].groups[0].selected_option_id")).toBe("shipping");
    expect(stepOf(undefined)).toBe("pay");
  });
});

describe("checkoutBody", () => {
  const cart = [{ id: "v1", qty: 2 }];
  it("sends only line items until buyer or address are filled", () => {
    expect(checkoutBody(cart, buyer, addr, undefined, false)).toEqual({ line_items: [{ item: { id: "v1" }, quantity: 2 }] });
  });
  it("includes buyer, destination and selected option when present", () => {
    const b = checkoutBody(cart, { ...buyer, email: "a@b.co" }, addr, "express", true);
    expect(b.buyer).toEqual({ ...buyer, email: "a@b.co" });
    expect(b.fulfillment).toEqual({ methods: [{ type: "shipping", destinations: [addr], groups: [{ selected_option_id: "express" }] }] });
  });
  it("omits an incomplete destination", () => {
    expect(checkoutBody(cart, buyer, { ...addr, street_address: "" }, undefined, true).fulfillment).toBeUndefined();
  });
});
