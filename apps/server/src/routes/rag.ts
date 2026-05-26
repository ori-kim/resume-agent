import { Hono } from "hono";
import { env } from "../config/env.ts";
import { indexRag, queryRag, statusRag } from "../services/qmd.ts";

const rag = new Hono();

rag.get("/status", async (c) => {
  try {
    const status = await statusRag();
    return c.json({ status, ragDir: env.RAG_DIR });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return c.json({ error: message }, 500);
  }
});

rag.post("/reindex", async (c) => {
  try {
    await indexRag({ embed: true });
    return c.json({
      ok: true,
      ragDir: env.RAG_DIR,
      indexedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return c.json({ error: message }, 500);
  }
});

rag.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q) {
    return c.json({ error: "q 쿼리 파라미터가 필요합니다." }, 400);
  }
  try {
    const result = await queryRag(q);
    return c.json({ query: q, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return c.json({ error: message }, 500);
  }
});

export { rag };
