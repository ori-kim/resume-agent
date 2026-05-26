import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform, release, arch } from "node:os";
import { dirname, join } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "../../config/env.js";
import type { ProviderCatalogResponse, ProviderModelInfo, ProviderQuotaInfo } from "@resumagent/shared";

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_MASTRA_AUTH_PATH = join(homedir(), ".mastra", "codex-oauth.json");
const DEFAULT_CODEX_CLI_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

const SUPPORTED_CODEX_MODELS = ["gpt-5.4", "gpt-5.5", "gpt-5.3-codex"] as const;

type CodexAuthFile = {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token?: string | null;
    refresh_token?: string | null;
    account_id?: string | null;
  };
  account_id?: string | null;
  last_refresh?: string | null;
};

type ActiveOAuthSession = {
  accessToken: string;
  refreshToken: string;
  accountId: string;
};

type ResponsesInputItem = {
  role?: string;
  type?: string;
  content?: unknown;
};

type ResponsesFunctionCallItem = {
  id: string;
  type: "function_call";
  status?: string;
  arguments: string;
  call_id: string;
  name: string;
};

const functionCallItems = new Map<string, ResponsesFunctionCallItem>();

function getPreferredAuthPath() {
  return env.OPENAI_CODEX_AUTH_PATH || DEFAULT_MASTRA_AUTH_PATH;
}

function resolveAuthPath() {
  const preferredPath = getPreferredAuthPath();
  if (existsSync(preferredPath)) return preferredPath;
  if (existsSync(DEFAULT_CODEX_CLI_AUTH_PATH)) return DEFAULT_CODEX_CLI_AUTH_PATH;
  return preferredPath;
}

function readAuthFile(authPath = resolveAuthPath()): CodexAuthFile {
  if (!existsSync(authPath)) {
    throw new Error(
      `OpenAI Codex OAuth 파일을 찾지 못했습니다: ${authPath}. \`codex login\`을 실행하거나 OPENAI_CODEX_AUTH_PATH를 설정하세요.`
    );
  }

  return JSON.parse(readFileSync(authPath, "utf8")) as CodexAuthFile;
}

function writeAuthFile(authPath: string, auth: CodexAuthFile) {
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("OpenAI Codex OAuth 토큰 형식이 올바르지 않습니다.");
  }

  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
    exp?: number;
    [JWT_AUTH_CLAIM]?: {
      chatgpt_account_id?: string;
    };
  };
}

function getAccountIdFromAccessToken(accessToken: string) {
  const payload = decodeJwtPayload(accessToken);
  const accountId = payload[JWT_AUTH_CLAIM]?.chatgpt_account_id;
  if (!accountId) {
    throw new Error("OpenAI Codex OAuth 토큰에서 chatgpt_account_id를 찾지 못했습니다.");
  }
  return accountId;
}

function getAccessTokenExpiry(accessToken: string) {
  const payload = decodeJwtPayload(accessToken);
  return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
}

function shouldRefreshAccessToken(accessToken: string) {
  return getAccessTokenExpiry(accessToken) <= Date.now() + TOKEN_REFRESH_SKEW_MS;
}

async function refreshAccessToken(refreshToken: string): Promise<ActiveOAuthSession> {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI Codex OAuth 토큰 갱신 실패 (${response.status}). ${body}`.trim());
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
  };

  if (!json.access_token || !json.refresh_token) {
    throw new Error("OpenAI Codex OAuth 갱신 응답에 access_token 또는 refresh_token이 없습니다.");
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    accountId: getAccountIdFromAccessToken(json.access_token),
  };
}

async function getActiveOAuthSession(): Promise<ActiveOAuthSession> {
  const authPath = resolveAuthPath();
  const auth = readAuthFile(authPath);
  const accessToken = auth.tokens?.access_token;
  const refreshToken = auth.tokens?.refresh_token;

  if (!accessToken || !refreshToken) {
    throw new Error(`OpenAI Codex OAuth 인증 정보가 불완전합니다: ${authPath}. \`codex login\`을 다시 실행하세요.`);
  }

  if (!shouldRefreshAccessToken(accessToken)) {
    return {
      accessToken,
      refreshToken,
      accountId: auth.tokens?.account_id || auth.account_id || getAccountIdFromAccessToken(accessToken),
    };
  }

  const refreshed = await refreshAccessToken(refreshToken);
  writeAuthFile(authPath, {
    ...auth,
    auth_mode: auth.auth_mode || "chatgpt",
    OPENAI_API_KEY: null,
    account_id: refreshed.accountId,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...auth.tokens,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      account_id: refreshed.accountId,
    },
  });

  return refreshed;
}

function buildUserAgent() {
  return `resume-agent-codex (${platform()} ${release()}; ${arch()})`;
}

function extractInstructionText(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .flatMap((item) => {
        if (typeof item === "string") return [item];
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          (item as { type?: unknown }).type === "input_text" &&
          "text" in item &&
          typeof (item as { text?: unknown }).text === "string"
        ) {
          return [(item as { text: string }).text];
        }
        return [];
      })
      .join("\n\n")
      .trim();
  }

  return "";
}

function normalizeCodexResponsesRequest(body: unknown) {
  if (!body || typeof body !== "object") return body;

  const payload = { ...(body as Record<string, unknown>) };
  const input = Array.isArray(payload.input) ? (payload.input as ResponsesInputItem[]) : [];
  const instructionParts: string[] = [];

  const normalizedInput = input.flatMap((item) => {
    if (item?.type === "item_reference") {
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string") return [];
      const cached = functionCallItems.get(id);
      return cached ? [cached] : [];
    }
    if (item?.role === "developer" || item?.role === "system") {
      const text = extractInstructionText(item.content);
      if (text) instructionParts.push(text);
      return [];
    }
    return [item];
  });

  if (instructionParts.length > 0) {
    const existingInstructions =
      typeof payload.instructions === "string" ? payload.instructions.trim() : "";
    payload.instructions = [existingInstructions, ...instructionParts].filter(Boolean).join("\n\n");
  }

  if (typeof payload.instructions !== "string" || !payload.instructions.trim()) {
    payload.instructions = "You are a helpful assistant.";
  }

  payload.input = normalizedInput;
  payload.store = false;
  return payload;
}

function cacheFunctionCallItemsFromSse(text: string) {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;

    try {
      const payload = JSON.parse(line.slice(6)) as {
        type?: string;
        item?: ResponsesFunctionCallItem;
      };
      const item = payload.item;
      if (
        payload.type === "response.output_item.done" &&
        item?.type === "function_call" &&
        item.id &&
        item.call_id &&
        item.name
      ) {
        functionCallItems.set(item.id, item);
      }
    } catch {
      // Ignore non-JSON stream lines.
    }
  }
}

function cacheFunctionCallItems(response: Response) {
  if (!response.ok || !response.body) return;
  void response
    .clone()
    .text()
    .then(cacheFunctionCallItemsFromSse)
    .catch(() => {});
}

async function readBodyAsText(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (!body) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return body.text();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  }
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return undefined;
}

async function codexCompatibleFetch(input: RequestInfo | URL, init?: RequestInit) {
  const bodyText = await readBodyAsText(init?.body);
  if (!bodyText) return fetch(input, init);

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return fetch(input, init);
  }

  const response = await fetch(input, {
    ...init,
    body: JSON.stringify(normalizeCodexResponsesRequest(parsedBody)),
  });
  cacheFunctionCallItems(response);
  return response;
}

const codexFetch = Object.assign(codexCompatibleFetch, {
  preconnect: fetch.preconnect?.bind(fetch),
}) as typeof fetch;

async function createCodexProvider() {
  const session = await getActiveOAuthSession();
  return createOpenAI({
    name: "codex",
    apiKey: session.accessToken,
    baseURL: env.OPENAI_CODEX_BASE_URL,
    fetch: codexFetch,
    headers: {
      "chatgpt-account-id": session.accountId,
      originator: env.OPENAI_CODEX_ORIGINATOR,
      "OpenAI-Beta": "responses=experimental",
      "User-Agent": buildUserAgent(),
    },
  });
}

export async function getCodexModel(modelId: string = env.CODEX_MODEL) {
  const provider = await createCodexProvider();
  return provider.responses(modelId || env.CODEX_MODEL);
}

export function listCodexModels(): ProviderModelInfo[] {
  return SUPPORTED_CODEX_MODELS.map((id) => ({ id, displayName: id }));
}

export async function probeCodexQuota(): Promise<ProviderQuotaInfo> {
  try {
    await getActiveOAuthSession();
    return { status: "ok", message: `ChatGPT Codex OAuth 사용 가능 (${resolveAuthPath()})` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex OAuth 상태 확인 실패";
    return { status: "blocked", message };
  }
}

export async function getCodexCatalog(activeModel = env.CODEX_MODEL): Promise<ProviderCatalogResponse> {
  const models = listCodexModels();
  const selectedModel = models.find((m) => m.id === activeModel)?.id ?? env.CODEX_MODEL;
  const quota = await probeCodexQuota();
  return { provider: "codex", activeModel: selectedModel, models, quota };
}
