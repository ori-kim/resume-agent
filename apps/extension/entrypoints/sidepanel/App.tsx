import "./style.css";
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Button, MessageList, Composer } from "@resumagent/ui";
import type { ProviderName, ProviderCatalogResponse, SelectedField, SelectedScope } from "@resumagent/shared";

const BACKEND_URL = "http://127.0.0.1:8080";
const AGENT_BROWSER_TOOL_NAME = "agentBrowser";
const AGENT_BROWSER_ACTIVITY_PULSE_MS = 300;

async function fetchCatalog(p: ProviderName): Promise<ProviderCatalogResponse> {
  const url = new URL(`${BACKEND_URL}/provider/catalog`);
  url.searchParams.set("provider", p);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
  return res.json() as Promise<ProviderCatalogResponse>;
}

async function reindex(): Promise<void> {
  await fetch(`${BACKEND_URL}/rag/reindex`, { method: "POST" });
}

interface MicrophonePermissionResult {
  ok: boolean;
  error?: string;
}

interface FillResponse {
  ok: boolean;
  applied: boolean;
  reason?: string;
}

interface ProposeFieldFillInput {
  elementId: string;
  proposedValue: string;
  currentValue?: string;
  reason?: string;
  editScope?: SelectedScope;
}

function normalizeFillResponse(response: unknown): FillResponse {
  if (typeof response !== "object" || response === null) {
    return { ok: false, applied: false, reason: "no_response_from_content_script" };
  }

  const raw = response as Partial<FillResponse>;
  return {
    ok: raw.ok === true,
    applied: raw.applied === true,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
  };
}

function formatFillOutput(elementId: string, response: FillResponse): string {
  if (response.applied) return "accepted: ✓ 입력 완료";
  if (response.reason === "user_rejected") return "rejected: 사용자가 취소했습니다";
  return `failed: reason=${response.reason ?? "unknown"} elementId=${elementId}`;
}

function makeScopeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function requestMicrophoneInCurrentContext(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("이 브라우저는 마이크 권한 요청을 지원하지 않습니다");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}

function shouldOpenMicrophonePermissionPage(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "NotAllowedError" || error.name === "PermissionDeniedError";
  }

  if (error instanceof Error) {
    return /permission|dismissed|denied|notallowed/i.test(`${error.name} ${error.message}`);
  }

  return false;
}

function openMicrophonePermissionPage(): Promise<void> {
  const requestId = makeScopeId("mic_permission");
  const storageKey = `ra_mic_permission_${requestId}`;
  const url = chrome.runtime.getURL(`mic-permission.html?requestId=${encodeURIComponent(requestId)}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: number | undefined;

    const cleanup = () => {
      if (timeoutId != null) window.clearTimeout(timeoutId);
      chrome.storage.onChanged.removeListener(onStorageChange);
      chrome.storage.local.remove(storageKey).catch(() => {
        // best effort cleanup
      });
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    function onStorageChange(changes: Record<string, chrome.storage.StorageChange>, area: string) {
      if (area !== "local") return;
      const result = changes[storageKey]?.newValue as MicrophonePermissionResult | undefined;
      if (!result) return;

      if (result.ok) {
        settle(resolve);
        return;
      }

      settle(() => reject(new Error(result.error ?? "Chrome 마이크 권한을 허용한 뒤 다시 눌러주세요")));
    }

    chrome.storage.onChanged.addListener(onStorageChange);
    chrome.storage.local.remove(storageKey).catch(() => {
      // stale values are ignored because requestId is unique
    });

    timeoutId = window.setTimeout(() => {
      settle(() => reject(new Error("마이크 권한 요청 창이 응답하지 않았습니다")));
    }, 90_000);

    chrome.windows.create(
      { url, type: "popup", width: 420, height: 420, focused: true },
      () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          settle(() => reject(new Error(lastError.message)));
        }
      }
    );
  });
}

async function requestChromeMicrophonePermission(): Promise<void> {
  try {
    await requestMicrophoneInCurrentContext();
  } catch (error) {
    if (!shouldOpenMicrophonePermissionPage(error)) throw error;
    await openMicrophonePermissionPage();
  }
}

function inferTagNameFromSelector(selector: string): SelectedField["tagName"] {
  const lower = selector.toLowerCase();
  if (lower.includes("textarea")) return "textarea";
  if (lower.includes("select")) return "select";
  if (lower.includes("contenteditable")) return "contenteditable";
  return "input";
}

function withDraftValue(scope: SelectedScope, draftValue: string): SelectedScope {
  return {
    ...scope,
    scopeId: makeScopeId("edit_scope"),
    kind: "field",
    fields: scope.fields.map((field) => ({ ...field, draftValue })),
  };
}

function makeFallbackEditScope(input: ProposeFieldFillInput): SelectedScope {
  const field: SelectedField = {
    id: input.elementId,
    tagName: inferTagNameFromSelector(input.elementId),
    currentValue: input.currentValue,
    draftValue: input.proposedValue,
    cssPath: input.elementId,
  };

  return {
    scopeId: makeScopeId("edit_scope"),
    kind: "field",
    label: input.elementId,
    cssPath: input.elementId,
    fields: [field],
  };
}

function getToolNameFromPartType(type: string): string {
  return type.startsWith("tool-") ? type.slice(5) : type;
}

function getAgentBrowserToolActivity(messages: readonly unknown[]): { running: boolean; toolKeys: string[] } {
  let running = false;
  const toolKeys: string[] = [];

  messages.forEach((message, messageIndex) => {
    if (typeof message !== "object" || message === null) return;

    const { id, parts } = message as { id?: unknown; parts?: unknown };
    if (!Array.isArray(parts)) return;

    parts.forEach((part, partIndex) => {
      if (typeof part !== "object" || part === null) return;

      const { toolCallId, type, state } = part as { toolCallId?: unknown; type?: unknown; state?: unknown };
      if (typeof type !== "string") return;
      if (getToolNameFromPartType(type) !== AGENT_BROWSER_TOOL_NAME) return;

      const key =
        typeof toolCallId === "string"
          ? toolCallId
          : `${typeof id === "string" ? id : messageIndex}:${partIndex}:${type}`;

      toolKeys.push(key);
      if (state === "input-streaming" || state === "input-available") {
        running = true;
      }
    });
  });

  return { running, toolKeys };
}

function App() {
  const [provider, setProvider] = useState("ollama");
  const [model, setModel] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<SelectedScope[]>([]);
  const [pickerActive, setPickerActive] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [messageScopesMap, setMessageScopesMap] = useState<Record<number, SelectedScope[]>>({});

  const stateRef = useRef({ provider, model });
  stateRef.current = { provider, model };
  const agentBrowserActivityRef = useRef(false);
  const seenAgentBrowserToolKeysRef = useRef(new Set<string>());

  // sendMessage 직전에 명시적으로 set — re-render로 자동 갱신되지 않아야 body()가 올바른 값을 읽음
  const pendingScopesRef = useRef<SelectedScope[]>([]);

  // picker:selected / picker:cancelled — content script에서 storage.session.set으로 발신
  // chrome.runtime.sendMessage는 service worker sleep 시 sidepanel에 미도달 → storage 방식으로 교체
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function onStorageChange(changes: Record<string, chrome.storage.StorageChange>, area: string) {
      if (area !== "local") return;
      if (!changes.ra_picker_event) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const event = changes.ra_picker_event.newValue as any;
      console.log("[sidepanel] storage event", event?.type, event?.scope?.scopeId ?? "");
      if (event?.type === "selected" && event.scope) {
        const scope = event.scope as SelectedScope;
        addSelectedScope(scope);
        setPickerActive(false);
      } else if (event?.type === "cancelled") {
        setPickerActive(false);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome as any).storage.onChanged.addListener(onStorageChange);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chrome as any).storage.onChanged.removeListener(onStorageChange);
    };
  }, []);

  // 사이드패널 내부 키보드 단축키 (Cmd+Shift+E) — fallback
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyE") {
        e.preventDefault();
        togglePicker();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
    return new Promise((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chrome as any).tabs.query({ active: true, currentWindow: true }, (tabs: chrome.tabs.Tab[]) => {
        resolve(tabs[0] ?? null);
      });
    });
  }

  async function getActiveTabId(): Promise<number | null> {
    const tab = await getActiveTab();
    return tab?.id ?? null;
  }

  function isRestrictedUrl(url: string | undefined): boolean {
    if (!url) return true;
    return (
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("about:") ||
      url.startsWith("edge://") ||
      url.startsWith("devtools://")
    );
  }

  async function sendToContentScript(tabId: number, message: object): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chrome as any).tabs.sendMessage(tabId, message, () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const err = (chrome as any).runtime?.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  async function signalAgentBrowserActivity(active: boolean): Promise<void> {
    const tab = await getActiveTab();
    if (tab?.id == null || isRestrictedUrl(tab.url)) return;

    try {
      await sendToContentScript(tab.id, {
        type: "agent-browser:activity",
        payload: { active, pulseMs: AGENT_BROWSER_ACTIVITY_PULSE_MS },
      });
    } catch {
      try {
        // extension reload 후 content script 연결이 끊긴 탭에서도 activity 표시를 복구한다.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (chrome as any).scripting.executeScript({
          target: { tabId: tab.id },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          func: () => { const w = window as any; try { w.__raCleanup?.(); } catch { /**/ } delete w.__raLoaded; },
        }).catch(() => { /* 무시 */ });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (chrome as any).scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content-scripts/content.js"],
        });
        await new Promise((r) => setTimeout(r, 80));
        await sendToContentScript(tab.id, {
          type: "agent-browser:activity",
          payload: { active, pulseMs: AGENT_BROWSER_ACTIVITY_PULSE_MS },
        });
      } catch {
        // content script가 없는 탭이면 조용히 무시한다. tool 실행 자체는 서버에서 계속 진행된다.
      }
    }
  }

  function addSelectedScope(scope: SelectedScope) {
    const nextFieldIds = new Set(scope.fields.map((field) => field.id));
    setSelectedScopes((prev) => {
      const withoutSameFields = prev.filter(
        (existing) => !existing.fields.some((field) => nextFieldIds.has(field.id))
      );
      return [...withoutSameFields, scope];
    });
  }

  async function resolveEditScope(input: ProposeFieldFillInput): Promise<SelectedScope> {
    const tabId = await getActiveTabId();
    if (tabId != null) {
      try {
        const response = await new Promise<{ ok: boolean; scope?: SelectedScope }>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("timeout")), 8_000);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (chrome as any).tabs.sendMessage(
            tabId,
            { type: "field:resolve", payload: { elementId: input.elementId, draftValue: input.proposedValue } },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (res: any) => {
              clearTimeout(timeout);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const lastError = (chrome as any).runtime?.lastError;
              if (lastError) reject(new Error(lastError.message));
              else resolve(res);
            }
          );
        });
        if (response.ok && response.scope) return response.scope;
      } catch {
        // fall back to tool input metadata below
      }
    }

    return input.editScope ? withDraftValue(input.editScope, input.proposedValue) : makeFallbackEditScope(input);
  }

  async function togglePicker() {
    setPickerError(null);
    const tab = await getActiveTab();
    if (tab?.id == null) return;

    if (isRestrictedUrl(tab.url)) {
      setPickerError("chrome:// 또는 새 탭 페이지에서는 DOM picker를 사용할 수 없습니다.\n일반 웹 페이지(https://)로 이동 후 다시 시도해주세요.");
      return;
    }

    const nextActive = !pickerActive;
    const msgType = nextActive ? "picker:enable" : "picker:disable";
    try {
      await sendToContentScript(tab.id, { type: msgType });
      setPickerActive(nextActive);
    } catch {
      // content script 미주입 또는 extension reload 후 끊긴 컨텍스트 — 재주입
      try {
        // __raLoaded 플래그 및 이전 리스너 정리 (extension reload 시 window에 남는 플래그 제거)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (chrome as any).scripting.executeScript({
          target: { tabId: tab.id },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          func: () => { const w = window as any; try { w.__raCleanup?.(); } catch { /**/ } delete w.__raLoaded; },
        }).catch(() => { /* 무시 */ });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (chrome as any).scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content-scripts/content.js"],
        });
        await new Promise((r) => setTimeout(r, 80));
        await sendToContentScript(tab.id, { type: msgType });
        setPickerActive(nextActive);
      } catch {
        setPickerActive(false);
        setPickerError("이 페이지에서 content script를 찾을 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.");
      }
    }
  }

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${BACKEND_URL}/chat`,
        body: () => ({
          provider: stateRef.current.provider,
          model: stateRef.current.model,
          selectedScopes: pendingScopesRef.current,
        }),
      }),
    []
  );

  const { messages, sendMessage, status, error, setMessages, addToolResult, stop, regenerate, clearError } = useChat({
    transport,
    onToolCall: async ({ toolCall }) => {
      // proposeFieldFill은 UI에서 사용자 결정 대기 — 즉시 처리하지 않음
      if (toolCall.toolName === "proposeFieldFill") return;
      if (toolCall.toolName !== "fillSelectedElement") return;

      const { elementId, value } = toolCall.input as { elementId: string; value: string };
      const tool = toolCall.toolName;
      const tabId = await getActiveTabId();
      if (tabId == null) {
        addToolResult({ tool, toolCallId: toolCall.toolCallId, output: "✗ 활성 탭을 찾을 수 없습니다" });
        return;
      }

      try {
        const response = await new Promise<FillResponse>(
          (resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("timeout")), 35_000);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (chrome as any).tabs.sendMessage(
              tabId,
              { type: "fill", payload: { elementId, value } },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (res: any) => {
                clearTimeout(timeout);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const lastError = (chrome as any).runtime?.lastError;
                if (lastError) reject(new Error(lastError.message));
                else resolve(normalizeFillResponse(res));
              }
            );
          }
        );
        addToolResult({ tool, toolCallId: toolCall.toolCallId, output: formatFillOutput(elementId, response) });
      } catch (err) {
        addToolResult({
          tool,
          toolCallId: toolCall.toolCallId,
          output: `failed: reason=${err instanceof Error ? err.message : "오류"} elementId=${elementId}`,
        });
      }
    },
  });

  useEffect(() => {
    const activity = getAgentBrowserToolActivity(messages);
    const seenToolKeys = seenAgentBrowserToolKeysRef.current;
    const hasNewTool = activity.toolKeys.some((key) => !seenToolKeys.has(key));

    activity.toolKeys.forEach((key) => seenToolKeys.add(key));

    if (agentBrowserActivityRef.current !== activity.running) {
      agentBrowserActivityRef.current = activity.running;
      void signalAgentBrowserActivity(activity.running);
      return;
    }

    if (hasNewTool && !activity.running) {
      void signalAgentBrowserActivity(false);
    }
  }, [messages]);

  async function fillViaContentScript(
    tabId: number,
    elementId: string,
    value: string,
    force = false
  ): Promise<string> {
    const response = await new Promise<FillResponse>(
      (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), 35_000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (chrome as any).tabs.sendMessage(
          tabId,
          { type: "fill", payload: { elementId, value, force } },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (res: any) => {
            clearTimeout(timeout);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lastError = (chrome as any).runtime?.lastError;
            if (lastError) reject(new Error(lastError.message));
            else resolve(normalizeFillResponse(res));
          }
        );
      }
    );
    return formatFillOutput(elementId, response);
  }

  async function handleAcceptProposal(toolCallId: string, elementId: string, proposedValue: string) {
    const tabId = await getActiveTabId();
    if (tabId == null) {
      addToolResult({ tool: "proposeFieldFill", toolCallId, output: "✗ 활성 탭을 찾을 수 없습니다" });
      return;
    }
    try {
      // 사이드패널에서 이미 수락 → force=true로 인라인 diff popover 생략
      const output = await fillViaContentScript(tabId, elementId, proposedValue, true);
      addToolResult({ tool: "proposeFieldFill", toolCallId, output });
    } catch (err) {
      addToolResult({
        tool: "proposeFieldFill",
        toolCallId,
        output: `failed: reason=${err instanceof Error ? err.message : "오류"} elementId=${elementId}`,
      });
    }
  }

  function handleRejectProposal(toolCallId: string, elementId: string, proposedValue: string) {
    addToolResult({
      tool: "proposeFieldFill",
      toolCallId,
      output: `rejected: elementId=${elementId} proposedValue="${proposedValue.slice(0, 80)}"`,
    });
  }

  async function handleEditProposal(toolCallId: string, input: ProposeFieldFillInput) {
    const scope = await resolveEditScope(input);
    addSelectedScope(scope);
    addToolResult({
      tool: "proposeFieldFill",
      toolCallId,
      output: `editing: 필터에 추가됨 elementId=${input.elementId} proposedValue="${input.proposedValue.slice(0, 80)}"`,
    });
  }

  function onSend(text: string, scopes: SelectedScope[]) {
    if (scopes.length > 0) {
      setMessageScopesMap((prev) => ({ ...prev, [messages.length]: scopes }));
    }
    pendingScopesRef.current = scopes;  // body()가 호출될 때까지 보존
    sendMessage({ text });
    setSelectedScopes([]);
  }

  const isLoading = status === "submitted" || status === "streaming";

  return (
    <main className="flex h-screen flex-col bg-white text-zinc-900">
      <header className="shrink-0 border-b border-zinc-200">
        <div className="flex h-10 items-center px-3">
          <span className="text-xs font-semibold text-zinc-900">resume-agent</span>
          <button
            type="button"
            onClick={() => void togglePicker()}
            title="DOM 요소 선택 (Cmd+Shift+E)"
            className={`ml-2 rounded-md p-1.5 transition-colors ${
              pickerActive
                ? "bg-blue-100 text-blue-600"
                : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/>
              <line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/>
              <line x1="12" y1="22" x2="12" y2="18"/>
            </svg>
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-xs text-zinc-500"
            onClick={() => {
              setMessages([]);
              setMessageScopesMap({});
              seenAgentBrowserToolKeysRef.current.clear();
              agentBrowserActivityRef.current = false;
              void signalAgentBrowserActivity(false);
            }}
          >
            Clear
          </Button>
        </div>
      </header>
      {pickerError && (
        <div className="shrink-0 px-3 pt-2">
          <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
            <span className="shrink-0 mt-0.5">⚠</span>
            <span className="whitespace-pre-line">{pickerError}</span>
            <button
              type="button"
              onClick={() => setPickerError(null)}
              className="ml-auto shrink-0 text-amber-400 hover:text-amber-600"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="shrink-0 px-3 pt-2">
          <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-1.5 text-xs text-red-600">
            <span className="flex-1 truncate">{error.message}</span>
            <button
              type="button"
              onClick={() => void regenerate()}
              className="shrink-0 font-medium underline hover:text-red-800"
            >
              다시 시도
            </button>
            <button
              type="button"
              onClick={clearError}
              className="shrink-0 text-red-400 hover:text-red-600"
              aria-label="에러 닫기"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col min-h-full">
          <MessageList
          messages={messages}
          status={status}
          scopesMap={messageScopesMap}
          onAcceptProposal={handleAcceptProposal}
          onRejectProposal={handleRejectProposal}
          onEditProposal={(toolCallId, input) => void handleEditProposal(toolCallId, input)}
        />
        </div>
      </div>
      <div className="shrink-0 border-t border-zinc-100">
        <Composer
          onSend={onSend}
          onStop={stop}
          disabled={isLoading}
          provider={provider}
          model={model}
          onProviderChange={setProvider}
          onModelChange={setModel}
          fetchCatalog={fetchCatalog}
          onReindex={reindex}
          scopes={selectedScopes}
          onRemoveScope={(id) => setSelectedScopes((prev) => prev.filter((s) => s.scopeId !== id))}
          onRequestMicrophonePermission={requestChromeMicrophonePermission}
        />
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
