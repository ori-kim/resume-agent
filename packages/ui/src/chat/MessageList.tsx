import { useEffect, useRef } from "react";
import type { UIMessage } from "ai";
import { Sparkles } from "lucide-react";
import type { SelectedScope } from "@resumagent/shared";
import { ReasoningAccordion } from "./ReasoningAccordion";
import { ToolCallBlock, type ProposeInput } from "./ToolCallBlock";
import { MarkdownMessage } from "./MarkdownMessage";

type Status = "submitted" | "streaming" | "ready" | "error";

interface Props {
  messages: UIMessage[];
  status: Status;
  scopesMap?: Record<number, SelectedScope[]>;
  onAcceptProposal?: (toolCallId: string, elementId: string, value: string) => void;
  onRejectProposal?: (toolCallId: string, elementId: string, value: string) => void;
  onEditProposal?: (toolCallId: string, input: ProposeInput) => void;
}

export interface ToolUIPart {
  type: string;
  toolCallId?: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input: unknown;
  output?: unknown;
  errorText?: string;
}

function isToolPart(p: unknown): p is ToolUIPart {
  if (typeof p !== "object" || p === null) return false;
  const type = (p as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("tool-");
}

function scopeChipLabel(scope: SelectedScope): string {
  const base = scope.label || scope.containerTag || (scope.fields[0]?.tagName ?? "element");
  if (scope.kind === "container") return `@${scope.containerTag ?? "div"}·${base} (${scope.fields.length})`;
  return `@${scope.fields[0]?.tagName ?? "input"}·${base}`;
}

function AgentIcon({ active = false, size = "sm" }: { active?: boolean; size?: "sm" | "md" }) {
  const boxSize = size === "md" ? "h-8 w-8" : "h-6 w-6";
  const iconSize = size === "md" ? "h-4 w-4" : "h-3.5 w-3.5";

  return (
    <div className={`relative inline-flex ${boxSize} items-center justify-center rounded-full bg-zinc-100`}>
      {active && (
        <>
          <span className="absolute inset-0 rounded-full bg-blue-400/25 animate-ping" />
          <span className="absolute inset-1 rounded-full bg-blue-300/20 animate-pulse" />
        </>
      )}
      <Sparkles
        className={`${iconSize} relative z-10 ${
          active ? "text-blue-500 animate-pulse drop-shadow-sm" : "text-zinc-400"
        }`}
      />
    </div>
  );
}

function MessageRow({
  m,
  streaming,
  scopes,
  onAcceptProposal,
  onRejectProposal,
  onEditProposal,
}: {
  m: UIMessage;
  streaming: boolean;
  scopes?: SelectedScope[];
  onAcceptProposal?: (toolCallId: string, elementId: string, value: string) => void;
  onRejectProposal?: (toolCallId: string, elementId: string, value: string) => void;
  onEditProposal?: (toolCallId: string, input: ProposeInput) => void;
}) {
  const isUser = m.role === "user";

  if (isUser) {
    const text = (m.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    return (
      <div className="flex flex-col items-end mb-4">
        {scopes && scopes.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1 max-w-[75%] justify-end">
            {scopes.map((scope) => (
              <span
                key={scope.scopeId}
                className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700"
              >
                {scopeChipLabel(scope)}
              </span>
            ))}
          </div>
        )}
        <div className="bg-zinc-100 text-zinc-900 rounded-2xl px-4 py-2 max-w-[75%] text-sm leading-relaxed whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }

  const parts = (m.parts ?? []) as unknown[];
  const reasoningParts = parts.filter(
    (p): p is { type: "reasoning"; text: string } =>
      typeof p === "object" && p !== null && (p as { type?: unknown }).type === "reasoning"
  );
  const toolParts = parts.filter(isToolPart);
  const textParts = parts.filter(
    (p): p is { type: "text"; text: string } =>
      typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text"
  );
  const text = textParts.map((p) => p.text).join("");

  return (
    <div className="flex gap-2 mb-4">
      <div className="mt-1 flex-shrink-0">
        <AgentIcon active={streaming} />
      </div>
      <div className="flex-1 min-w-0">
        {reasoningParts.length > 0 && (
          <ReasoningAccordion parts={reasoningParts} streaming={streaming} />
        )}
        {toolParts.map((p, i) => (
          <ToolCallBlock
            key={p.toolCallId ?? i}
            part={p}
            onAcceptProposal={onAcceptProposal}
            onRejectProposal={onRejectProposal}
            onEditProposal={onEditProposal}
          />
        ))}
        {text && (
          <div className="max-w-[92%] rounded-xl bg-white px-3 py-2 shadow-sm ring-1 ring-zinc-100">
            <MarkdownMessage text={text} />
          </div>
        )}
        {streaming && !text && toolParts.length === 0 && (
          <span className="inline-block h-4 w-2 bg-zinc-400 animate-pulse rounded-sm ml-0.5" />
        )}
      </div>
    </div>
  );
}

export function MessageList({ messages, status, scopesMap = {}, onAcceptProposal, onRejectProposal, onEditProposal }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const isStreaming = status === "streaming";
  const lastAssistantId = [...messages].reverse().find((m: UIMessage) => m.role === "assistant")?.id;

  const showLoader =
    status === "submitted" &&
    (messages.length === 0 || messages.at(-1)?.role === "user");

  if (messages.length === 0 && status !== "submitted") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-zinc-500">
        <Sparkles className="h-6 w-6 text-zinc-400" />
        <p className="text-sm">무엇이든 물어보세요</p>
      </div>
    );
  }

  return (
    <div className="px-6 py-6">
      {messages.map((m, i) => (
        <MessageRow
          key={m.id}
          m={m}
          streaming={isStreaming && m.id === lastAssistantId}
          scopes={scopesMap[i]}
          onAcceptProposal={onAcceptProposal}
          onRejectProposal={onRejectProposal}
          onEditProposal={onEditProposal}
        />
      ))}
      {showLoader && (
        <div className="flex gap-2 mb-4">
          <div className="mt-1 flex-shrink-0">
            <AgentIcon active />
          </div>
          <div className="text-sm text-zinc-500">생각 중...</div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
