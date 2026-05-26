import { useEffect, useRef, useState } from "react";

interface ReasoningPart {
  type: "reasoning";
  text: string;
}

interface Props {
  parts: ReasoningPart[];
  streaming: boolean;
}

export function ReasoningAccordion({ parts, streaming }: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [elapsedSec, setElapsedSec] = useState<number | null>(null);

  useEffect(() => {
    if (streaming && detailsRef.current && !detailsRef.current.open) {
      detailsRef.current.open = true;
    }
  }, [streaming]);

  useEffect(() => {
    if (!streaming) return;
    setElapsedSec(0);
    const id = setInterval(() => setElapsedSec((s) => (s ?? 0) + 1), 1000);
    return () => clearInterval(id);
  }, [streaming]);

  const text = parts.map((p) => p.text).join("");
  if (!text && !streaming) return null;

  return (
    <details ref={detailsRef} className="mb-2 rounded-lg border border-zinc-200 bg-zinc-50 text-sm">
      <summary className="cursor-pointer select-none list-none px-3 py-1.5 text-zinc-600 marker:hidden">
        <span className="inline-flex items-center gap-2">
          <span className="text-xs font-medium">{streaming ? "Thinking…" : "Thoughts"}</span>
          {elapsedSec != null && (
            <span className="text-xs text-zinc-400">{elapsedSec}s</span>
          )}
        </span>
      </summary>
      <div className="border-t border-zinc-200 px-3 py-2 text-xs text-zinc-500 whitespace-pre-wrap leading-relaxed">
        {text}
      </div>
    </details>
  );
}
