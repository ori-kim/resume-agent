import { useEffect, useRef, useState } from "react";
import { Wrench } from "lucide-react";
import type { SelectedScope } from "@resumagent/shared";

interface ToolUIPart {
  type: string;
  toolCallId?: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input: unknown;
  output?: unknown;
  errorText?: string;
}

export interface ProposeInput {
  elementId: string;
  proposedValue: string;
  currentValue?: string;
  reason?: string;
  editScope?: SelectedScope;
}

export interface Props {
  part: ToolUIPart;
  onAcceptProposal?: (toolCallId: string, elementId: string, value: string) => void;
  onRejectProposal?: (toolCallId: string, elementId: string, value: string) => void;
  onEditProposal?: (toolCallId: string, input: ProposeInput) => void;
}

function getToolName(type: string): string {
  return type.startsWith("tool-") ? type.slice(5) : type;
}

function getInputPreview(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return "";
    const [key, val] = entries[0];
    return `${key}: "${String(val).slice(0, 40)}"`;
  }
  return String(input).slice(0, 40);
}

function ProposeFieldFillBlock({ part, onAcceptProposal, onRejectProposal, onEditProposal }: Props) {
  const input = (part.input ?? {}) as ProposeInput;
  const toolCallId = part.toolCallId ?? "";
  const streaming = part.state === "input-streaming";
  const waiting = part.state === "input-available";
  const [editedValue, setEditedValue] = useState(input.proposedValue ?? "");

  useEffect(() => {
    setEditedValue(input.proposedValue ?? "");
  }, [input.proposedValue, toolCallId]);

  if (part.state === "output-available") {
    const output = typeof part.output === "string" ? part.output : "";
    const accepted = output.startsWith("accepted");
    const rejected = output.startsWith("rejected");
    const editing = output.startsWith("editing");
    const label = accepted ? "✓ 입력 완료" : rejected ? "✗ 거절됨" : editing ? "수정 대기" : "⚠ 실패";
    const detail = output.replace(/^(accepted|rejected|editing|failed):\s*/, "");
    return (
      <div
        className={`mb-2 rounded-lg border text-sm px-3 py-2 flex items-center gap-2 ${
          accepted
            ? "border-green-200 bg-green-50"
            : editing
              ? "border-blue-200 bg-blue-50"
              : rejected
                ? "border-zinc-200 bg-zinc-50"
                : "border-amber-200 bg-amber-50"
        }`}
      >
        <Wrench className="h-3 w-3 text-zinc-400 shrink-0" />
        <span
          className={`text-xs font-medium ${
            accepted ? "text-green-700" : editing ? "text-blue-700" : rejected ? "text-zinc-400" : "text-amber-700"
          }`}
        >
          {label}
        </span>
        {!accepted && detail && (
          <span className="min-w-0 truncate text-[10px] text-zinc-400">{detail}</span>
        )}
        {input.elementId && (
          <span className="text-[10px] text-zinc-400 ml-auto">id={input.elementId}</span>
        )}
      </div>
    );
  }

  return (
    <div className="mb-2 rounded-lg border border-blue-200 bg-blue-50 text-sm p-3">
      <div className="flex items-center gap-2 mb-2">
        <Wrench className={`h-3 w-3 ${streaming ? "text-blue-300 animate-pulse" : "text-blue-400"}`} />
        <span className="text-xs font-semibold text-blue-700">필드 채우기 제안</span>
        {streaming && (
          <span className="rounded px-1 py-0.5 text-[10px] bg-blue-100 text-blue-500">준비 중...</span>
        )}
      </div>

      {input.currentValue ? (
        <div className="mb-2 grid grid-cols-2 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <div className="min-w-0 border-r border-zinc-200 bg-red-50/70">
            <div className="border-b border-red-100 px-2 py-1 font-mono text-[10px] font-semibold text-red-600">
              - 현재 값
            </div>
            <pre className="min-h-20 whitespace-pre-wrap break-words px-2 py-2 font-mono text-[11px] leading-relaxed text-red-700">
              {input.currentValue || " "}
            </pre>
          </div>
          <div className="min-w-0 bg-emerald-50/70">
            <div className="border-b border-emerald-100 px-2 py-1 font-mono text-[10px] font-semibold text-emerald-700">
              + 새 값
            </div>
            <textarea
              value={editedValue}
              onChange={(e) => setEditedValue(e.target.value)}
              disabled={!waiting}
              className="min-h-20 w-full resize-y border-0 bg-transparent px-2 py-2 font-mono text-[11px] leading-relaxed text-emerald-900 outline-none placeholder:text-emerald-300 disabled:cursor-default"
              placeholder="채울 내용을 입력하세요"
            />
          </div>
        </div>
      ) : (
        <div className="mb-2">
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">채울 내용</p>
          <textarea
            value={editedValue}
            onChange={(e) => setEditedValue(e.target.value)}
            disabled={!waiting}
            className="min-h-20 w-full resize-y rounded-md border border-blue-100 bg-white px-2 py-1.5 text-xs leading-relaxed text-zinc-800 outline-none transition-colors focus:border-blue-300 focus:ring-2 focus:ring-blue-100 disabled:cursor-default"
            placeholder="채울 내용을 입력하세요"
          />
        </div>
      )}

      {input.reason && (
        <p className="text-[10px] text-zinc-400 mb-2 italic">{input.reason}</p>
      )}

      {waiting && (
        <div className="flex gap-2 mt-2">
          <button
            type="button"
            onClick={() => onAcceptProposal?.(toolCallId, input.elementId, editedValue)}
            disabled={!editedValue.trim()}
            className="flex-1 rounded-md bg-blue-600 text-white text-xs py-1.5 font-medium transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
          >
            수락
          </button>
          <button
            type="button"
            onClick={() => onEditProposal?.(toolCallId, { ...input, proposedValue: editedValue })}
            className="flex-1 rounded-md border border-blue-200 bg-white text-blue-700 text-xs py-1.5 font-medium hover:bg-blue-50 transition-colors"
          >
            다시 AI 수정
          </button>
          <button
            type="button"
            onClick={() => onRejectProposal?.(toolCallId, input.elementId, editedValue)}
            className="flex-1 rounded-md border border-zinc-300 bg-white text-zinc-600 text-xs py-1.5 font-medium hover:bg-zinc-50 transition-colors"
          >
            거절
          </button>
        </div>
      )}
    </div>
  );
}

export function ToolCallBlock({ part, onAcceptProposal, onRejectProposal, onEditProposal }: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const running = part.state === "input-streaming" || part.state === "input-available";
  const hasOutput = part.state === "output-available" || part.state === "output-error";

  useEffect(() => {
    if (!detailsRef.current) return;
    if (running) {
      detailsRef.current.open = true;
    } else if (hasOutput) {
      detailsRef.current.open = false;
    }
  }, [running, hasOutput]);

  const toolName = getToolName(part.type);

  if (toolName === "proposeFieldFill") {
    return (
      <ProposeFieldFillBlock
        part={part}
        onAcceptProposal={onAcceptProposal}
        onRejectProposal={onRejectProposal}
        onEditProposal={onEditProposal}
      />
    );
  }

  const preview = getInputPreview(part.input);

  return (
    <details ref={detailsRef} className="mb-2 rounded-lg border border-zinc-200 bg-zinc-50 text-sm">
      <summary className="cursor-pointer select-none list-none px-3 py-1.5 marker:hidden">
        <span className="inline-flex items-center gap-2 text-zinc-600">
          {running ? (
            <Wrench className="h-3 w-3 animate-pulse text-zinc-400" />
          ) : (
            <Wrench className="h-3 w-3 text-zinc-400" />
          )}
          <span className="text-xs font-medium">{toolName}</span>
          {part.state === "output-error" ? (
            <span className="rounded px-1 py-0.5 text-[10px] bg-red-100 text-red-600">error</span>
          ) : running ? (
            <span className="rounded px-1 py-0.5 text-[10px] bg-zinc-200 text-zinc-500">running</span>
          ) : (
            <span className="rounded px-1 py-0.5 text-[10px] bg-green-100 text-green-700">done</span>
          )}
          {preview && (
            <span className="text-xs text-zinc-400 truncate max-w-[160px]">{preview}</span>
          )}
        </span>
      </summary>
      <div className="border-t border-zinc-200 px-3 py-2 space-y-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 mb-1">Input</p>
          <pre className="text-xs text-zinc-600 whitespace-pre-wrap break-all leading-relaxed">
            {JSON.stringify(part.input, null, 2)}
          </pre>
        </div>
        {hasOutput && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 mb-1">
              {part.state === "output-error" ? "Error" : "Output"}
            </p>
            {part.state === "output-error" ? (
              <p className="text-xs text-red-600 whitespace-pre-wrap">{part.errorText ?? "Unknown error"}</p>
            ) : (
              <p className="text-xs text-zinc-600 whitespace-pre-wrap leading-relaxed">
                {typeof part.output === "string" ? part.output : JSON.stringify(part.output, null, 2)}
              </p>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
