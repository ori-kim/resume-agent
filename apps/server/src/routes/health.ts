import { Hono } from "hono";
import type { ChatRequest } from "@resumagent/shared";

const health = new Hono();

health.get("/", (c) => {
  return c.json({ status: "ok", ts: new Date().toISOString() });
});

export { health };
