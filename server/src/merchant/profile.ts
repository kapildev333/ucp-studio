import { Router } from "express";
import { UCP_VERSION } from "../ucp.js";

export const profileRouter = (baseUrl: string) => {
  const v = { version: UCP_VERSION };
  const r = Router();
  r.get("/.well-known/ucp", (_req, res) => {
    res.json({
      ucp: {
        version: UCP_VERSION,
        services: { "dev.ucp.shopping": [{ ...v, transport: "rest", endpoint: `${baseUrl}/ucp` }] },
        capabilities: {
          "dev.ucp.shopping.checkout": [v],
          "dev.ucp.shopping.catalog.search": [v],
          "dev.ucp.shopping.catalog.lookup": [v],
          "dev.ucp.shopping.fulfillment": [{ ...v, extends: "dev.ucp.shopping.checkout" }],
        },
        payment_handlers: { "dev.ucpstudio.mock_pay": [{ id: "mock_pay", ...v }] },
      },
      keys: [],
    });
  });
  return r;
};
