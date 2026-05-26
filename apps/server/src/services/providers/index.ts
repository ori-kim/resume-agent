import { env } from "../../config/env.ts";
import type { ProviderCatalogResponse } from "@resumagent/shared";
import { getCodexCatalog, getCodexModel } from "./codex.ts";
import { getOllamaCatalog, getOllamaModel } from "./ollama.ts";

export type ProviderName = "ollama" | "codex";

function resolveProvider(provider?: ProviderName): ProviderName {
  return provider ?? env.PROVIDER;
}

export async function resolveModel(options: { provider?: ProviderName; modelId?: string } = {}) {
  const provider = resolveProvider(options.provider);
  switch (provider) {
    case "codex":
      return getCodexModel(options.modelId);
    case "ollama":
      return getOllamaModel(options.modelId);
    default:
      throw new Error(`지원하지 않는 provider: ${String(provider)}`);
  }
}

export async function getProviderCatalog(
  options: { provider?: ProviderName; activeModel?: string } = {}
): Promise<ProviderCatalogResponse> {
  const provider = resolveProvider(options.provider);
  switch (provider) {
    case "codex":
      return getCodexCatalog(options.activeModel);
    case "ollama":
      return getOllamaCatalog(options.activeModel);
    default:
      throw new Error(`지원하지 않는 provider: ${String(provider)}`);
  }
}
