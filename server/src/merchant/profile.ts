import { Router } from "express";
import { UCP_VERSION } from "../ucp.js";
import { BUSINESS_CAPS } from "./negotiate.js";

export const profileRouter = (baseUrl: string) => {
  const r = Router();
  r.get("/.well-known/ucp", (_req, res) => {
    res.json({
      ucp: {
        version: UCP_VERSION,
        services: { "dev.ucp.shopping": [{ version: UCP_VERSION, transport: "rest", endpoint: `${baseUrl}/ucp` }] },
        capabilities: BUSINESS_CAPS,
        payment_handlers: { "dev.ucpstudio.mock_pay": [{ id: "mock_pay", version: UCP_VERSION }] },
      },
      keys: [],
    });
  });
  return r;
};
