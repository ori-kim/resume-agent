import type { ReactNode } from "react";

type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language?: string; code: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "rule" };

function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isBlockStart(line: string, nextLine?: string) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("```") ||
    /^#{1,6}\s+/.test(trimmed) ||
    /^([-*•])\s+/.test(trimmed) ||
    /^\d+[.)]\s+/.test(trimmed) ||
    /^-{3,}$/.test(trimmed) ||
    (line.includes("|") && Boolean(nextLine && isTableSeparator(nextLine)))
  );
}

function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", language, code: codeLines.join("\n") });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (/^-{3,}$/.test(trimmed)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    if (/^([-*•])\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      const ordered = /^\d+[.)]\s+/.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const current = (lines[i] ?? "").trim();
        const match = ordered ? current.match(/^\d+[.)]\s+(.+)$/) : current.match(/^[-*•]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraphLines: string[] = [trimmed];
    i += 1;
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (!current.trim() || isBlockStart(current, lines[i + 1])) break;
      paragraphLines.push(current.trim());
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${match.index}-${token}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-zinc-100 px-1 py-0.5 text-[0.92em] font-medium text-zinc-800">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold text-zinc-950">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("*")) {
      nodes.push(
        <em key={key} className="text-zinc-700">
          {token.slice(1, -1)}
        </em>
      );
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        nodes.push(
          <a
            key={key}
            href={link[2]}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-blue-600 underline decoration-blue-200 underline-offset-2 hover:text-blue-700"
          >
            {link[1]}
          </a>
        );
      }
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

export function MarkdownMessage({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return null;

  return (
    <div className="text-sm leading-relaxed text-zinc-900">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading":
            return (
              <div
                key={index}
                className="mb-1.5 mt-3 first:mt-0 text-[13px] font-semibold leading-snug text-zinc-950"
              >
                {renderInline(block.text)}
              </div>
            );
          case "paragraph":
            return (
              <p key={index} className="mb-2 last:mb-0">
                {renderInline(block.text)}
              </p>
            );
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag
                key={index}
                className={`mb-2 mt-1 space-y-1 pl-4 ${block.ordered ? "list-decimal" : "list-disc"}`}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="pl-1">
                    {renderInline(item)}
                  </li>
                ))}
              </ListTag>
            );
          }
          case "code":
            return (
              <div key={index} className="my-2 overflow-hidden rounded-md border border-zinc-200 bg-zinc-950">
                {block.language && (
                  <div className="border-b border-zinc-800 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                    {block.language}
                  </div>
                )}
                <pre className="overflow-x-auto px-3 py-2 text-xs leading-relaxed text-zinc-50">
                  <code>{block.code}</code>
                </pre>
              </div>
            );
          case "table":
            return (
              <div key={index} className="my-2 overflow-x-auto rounded-md border border-zinc-200">
                <table className="min-w-full border-collapse text-left text-xs">
                  <thead className="bg-zinc-100 text-zinc-700">
                    <tr>
                      {block.headers.map((header, headerIndex) => (
                        <th key={headerIndex} className="border-b border-zinc-200 px-2 py-1.5 font-semibold">
                          {renderInline(header)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="odd:bg-white even:bg-zinc-50">
                        {block.headers.map((_, cellIndex) => (
                          <td key={cellIndex} className="border-t border-zinc-100 px-2 py-1.5 align-top">
                            {renderInline(row[cellIndex] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "rule":
            return <div key={index} className="my-3 h-px bg-zinc-200" />;
        }
      })}
    </div>
  );
}
