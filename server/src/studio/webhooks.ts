import { Router } from "express";
import { protocolError } from "../ucp.js";

type Received = { received_at: string; headers: Record<string, string | undefined>; body: object };

// Receiver for the order webhooks the studio's agent profile advertises.
export const webhookRouter = () => {
  const events: Received[] = []; // ponytail: in-memory, newest first, capped at 200; lost on restart
  const r = Router();
  r.post("/webhooks/orders", (req, res) => {
    if (!req.is("application/json") || !req.body || typeof req.body !== "object" || Array.isArray(req.body)) return protocolError(res, 400, "invalid_request", "Body must be a JSON object");
    const h = (n: string) => req.header(n);
    events.unshift({ received_at: new Date().toISOString(), headers: { "webhook-id": h("webhook-id"), "webhook-timestamp": h("webhook-timestamp"), "ucp-agent": h("ucp-agent") }, body: req.body });
    events.length = Math.min(events.length, 200);
    res.status(204).end();
  });
  r.get("/webhooks/orders", (_req, res) => void res.json({ events }));
  r.delete("/webhooks/orders", (_req, res) => {
    events.length = 0;
    res.status(204).end();
  });
  return r;
};
