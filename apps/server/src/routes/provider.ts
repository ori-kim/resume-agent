import { Hono } from "hono";
import { getProviderCatalog, type ProviderName } from "../services/providers/index.ts";

const provider = new Hono();

provider.get("/catalog", async (c) => {
  const query = c.req.query();
  const rawProvider = query.provider;
  const resolvedProvider: ProviderName | undefined =
    rawProvider === "codex" || rawProvider === "ollama" ? rawProvider : undefined;
  const activeModel = query.model;

  try {
    const catalog = await getProviderCatalog({ provider: resolvedProvider, activeModel });
    return c.json(catalog);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return c.json({ error: message }, 500);
  }
});

export { provider };
