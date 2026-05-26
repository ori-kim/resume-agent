import { resolve } from "path";

const ROOT_DIR = resolve(import.meta.dir, "../../../..");

export const env = {
  PORT: Number(process.env.PORT ?? 8080),
  HOST: process.env.HOST ?? "127.0.0.1",
  RAG_DIR: resolve(ROOT_DIR, process.env.RAG_DIR ?? "rag"),

  // provider
  PROVIDER: (process.env.PROVIDER ?? "ollama") as "ollama" | "codex",

  // ollama
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY ?? "ollama",
  OLLAMA_MODEL: process.env.OLLAMA_MODEL ?? "qwen2.5:3b",

  // codex / ChatGPT OAuth compatible Responses API
  CODEX_MODEL: process.env.CODEX_MODEL ?? "gpt-5.4",
  OPENAI_CODEX_AUTH_PATH: process.env.OPENAI_CODEX_AUTH_PATH,
  OPENAI_CODEX_BASE_URL:
    process.env.OPENAI_CODEX_BASE_URL ??
    "https://chatgpt.com/backend-api/codex",
  OPENAI_CODEX_ORIGINATOR: process.env.OPENAI_CODEX_ORIGINATOR ?? "resume-agent",

  // browser automation
  AGENT_BROWSER_BIN: process.env.AGENT_BROWSER_BIN ?? "agent-browser",
  AGENT_BROWSER_CDP_PORT: Number(process.env.AGENT_BROWSER_CDP_PORT ?? process.env.WXT_CHROMIUM_PORT ?? 9222),
  AGENT_BROWSER_TIMEOUT_MS: Number(process.env.AGENT_BROWSER_TIMEOUT_MS ?? 30_000),
} as const;
