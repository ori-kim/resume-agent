import { createOpenAI } from "@ai-sdk/openai";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";
import { env } from "../../config/env.js";
import type { ProviderCatalogResponse, ProviderModelInfo, ProviderQuotaInfo } from "@resumagent/shared";

const ollamaClient = createOpenAI({
  apiKey: env.OLLAMA_API_KEY,
  baseURL: env.OLLAMA_BASE_URL,
});

export function getOllamaModel(modelId: string = env.OLLAMA_MODEL) {
  return wrapLanguageModel({
    model: ollamaClient.chat(modelId || env.OLLAMA_MODEL),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

export async function listOllamaModels(): Promise<ProviderModelInfo[]> {
  const base = env.OLLAMA_BASE_URL.replace(/\/v1\/?$/, "");

  let response: Response;
  try {
    response = await fetch(`${base}/api/tags`);
  } catch {
    throw new Error(
      "Ollama 서버 연결 실패: `ollama serve` 또는 Ollama 앱 실행 상태를 확인하세요."
    );
  }

  if (!response.ok) {
    throw new Error(`Ollama 모델 목록 조회 실패 (${response.status})`);
  }

  const payload = (await response.json()) as {
    models?: Array<{ name?: string; model?: string }>;
  };

  const uniqueById = new Map<string, ProviderModelInfo>();
  for (const model of payload.models ?? []) {
    const id = (model.name ?? model.model ?? "").trim();
    if (!id || uniqueById.has(id)) continue;
    uniqueById.set(id, { id, displayName: id });
  }

  const models = [...uniqueById.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (models.length === 0) {
    throw new Error("Ollama 모델이 없습니다. `ollama pull <model>`을 먼저 실행하세요.");
  }
  return models;
}

export async function probeOllamaQuota(modelId: string): Promise<ProviderQuotaInfo> {
  const base = env.OLLAMA_BASE_URL.replace(/\/v1\/?$/, "");
  try {
    const response = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        prompt: "ping",
        options: { num_predict: 1 },
        stream: false,
      }),
    });

    if (response.ok) return { status: "ok", message: "로컬 Ollama 요청 가능" };
    if (response.status === 404) {
      return { status: "blocked", message: "해당 Ollama 모델이 없습니다. `ollama pull`로 다운로드하세요." };
    }
    return { status: "unknown", message: `Ollama 응답 코드: ${response.status}` };
  } catch {
    return { status: "blocked", message: "Ollama 서버 연결 실패 (http://localhost:11434 실행 여부 확인)" };
  }
}

export async function getOllamaCatalog(activeModel = env.OLLAMA_MODEL): Promise<ProviderCatalogResponse> {
  const models = await listOllamaModels();
  const selectedModel = models.find((m) => m.id === activeModel)?.id ?? models[0].id;
  const quota = await probeOllamaQuota(selectedModel);
  return { provider: "ollama", activeModel: selectedModel, models, quota };
}
