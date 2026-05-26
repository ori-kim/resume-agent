import { Hono } from "hono";
import { createFieldFillResponse, streamAgentResponse } from "../services/agent.ts";
import { ChatRequestSchema, SelectedScopeSchema } from "@resumagent/shared";
import type { UIMessage } from "ai";
import type { ProviderName, SelectedScope } from "@resumagent/shared";

const chat = new Hono();

function getMessageText(message: UIMessage): string {
  return (message.parts ?? [])
    .map((part) => {
      const p = part as { type?: string; text?: unknown };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

function isBrowserAutomationRequest(messages: UIMessage[]): boolean {
  const lastUserText = getMessageText([...messages].reverse().find((m) => m.role === "user") ?? messages.at(-1)!).toLowerCase();
  return /agent-browser|브라우저|웹\s*조작|웹페이지|웹사이트|페이지.*(열|이동|클릭|스크롤)|클릭|스크롤|스크린샷|캡처|url|주소.*열|open .*page|click|scroll|screenshot/.test(lastUserText);
}

function formatStreamError(error: unknown, provider?: ProviderName): string {
  const raw = error instanceof Error ? error.message : "알 수 없는 오류";
  const lowered = raw.toLowerCase();

  if (
    lowered.includes("too many requests") ||
    lowered.includes("resource_exhausted") ||
    lowered.includes("quota") ||
    lowered.includes("429")
  ) {
    return "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.";
  }

  if (
    provider === "ollama" &&
    (lowered.includes("fetch failed") ||
      lowered.includes("econnrefused") ||
      lowered.includes("cannot connect to api"))
  ) {
    return "Ollama 서버 연결 실패: `ollama serve` 또는 Ollama 앱 실행 상태를 확인하세요.";
  }

  if (raw.length > 500) return `${raw.slice(0, 500)}...`;
  return raw;
}

chat.post("/", async (c) => {
  const bodyRaw = await c.req.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(bodyRaw);

  if (!parsed.success) {
    return c.json(
      { error: "요청 형식 오류: " + parsed.error.issues.map((i) => i.message).join(", ") },
      400
    );
  }

  const { messages, provider, model, selectedScopes: rawScopes } = parsed.data;

  const selectedScopes: SelectedScope[] = (rawScopes ?? []).flatMap((s) => {
    const r = SelectedScopeSchema.safeParse(s);
    return r.success ? [r.data] : [];
  });

  const wantsBrowserAutomation = isBrowserAutomationRequest(messages as UIMessage[]);
  const totalFields = selectedScopes.reduce((sum, scope) => sum + scope.fields.length, 0);
  if (totalFields > 0 && !wantsBrowserAutomation) {
    try {
      const response = await createFieldFillResponse(messages as UIMessage[], {
        provider,
        modelId: model,
        selectedScopes,
      });
      response.headers.set("X-Accel-Buffering", "no");
      return response;
    } catch (err) {
      return c.text(formatStreamError(err, provider), 503);
    }
  }

  let result;
  try {
    result = await streamAgentResponse(messages as UIMessage[], {
      provider,
      modelId: model,
      selectedScopes: wantsBrowserAutomation ? [] : selectedScopes,
    });
  } catch (err) {
    return c.text(formatStreamError(err, provider), 503);
  }

  const response = result.toUIMessageStreamResponse({
    sendReasoning: true,
    sendSources: false,
    onError: (error) => formatStreamError(error, provider),
  });

  response.headers.set("X-Accel-Buffering", "no");
  return response;
});

export { chat };
