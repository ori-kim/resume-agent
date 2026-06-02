import { SUBAGENT_IDS, type RawSubagentRequest, type RunSubagentsOutput, type SubagentId } from "./subagents.ts";

export type ParsedSubagentCommand = {
  task: string;
  agents: RawSubagentRequest[];
};

const ALIASES: Record<string, SubagentId | "all"> = {
  all: "all",
  answer: "answerStrategist",
  answers: "answerStrategist",
  draft: "answerStrategist",
  drafts: "answerStrategist",
  job: "jobAnalyzer",
  jobs: "jobAnalyzer",
  jd: "jobAnalyzer",
  match: "profileMatcher",
  matcher: "profileMatcher",
  posting: "jobAnalyzer",
  profile: "profileMatcher",
  profiles: "profileMatcher",
  strategy: "answerStrategist",
  strategist: "answerStrategist",
};

function splitFirstToken(input: string): { first: string; rest: string } {
  const match = input.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return {
    first: match?.[1] ?? "",
    rest: match?.[2]?.trim() ?? "",
  };
}

function parseSelectorToken(token: string): SubagentId[] | undefined {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return undefined;

  const selectorParts = normalized.split(/[,+]/).filter(Boolean);
  const isExplicitSelector = normalized === "all" || selectorParts.length > 1 || ALIASES[normalized] !== undefined;
  if (!isExplicitSelector) return undefined;

  const selected: SubagentId[] = [];
  for (const part of selectorParts) {
    const alias = ALIASES[part];
    if (!alias) throw new Error(`Unknown subagent selector: ${part}`);
    if (alias === "all") return [...SUBAGENT_IDS];
    if (selected.includes(alias)) throw new Error(`Duplicate subagent selector: ${alias}`);
    selected.push(alias);
  }

  return selected;
}

export function parseSubagentCommand(text: string): ParsedSubagentCommand | null {
  const trimmed = text.trim();
  if (!/^\/sub(?:\s|$)/i.test(trimmed)) return null;

  const body = trimmed.replace(/^\/sub(?:\s+)?/i, "").trim();
  if (!body) throw new Error("/sub requires a task");

  const { first, rest } = splitFirstToken(body);
  const selectedAgents = parseSelectorToken(first);
  const task = selectedAgents ? rest : body;
  if (!task) throw new Error("/sub requires a task");

  const ids = selectedAgents ?? [...SUBAGENT_IDS];
  return {
    task,
    agents: ids.map((id) => ({ id, task })),
  };
}

export function buildSubagentSynthesisPrompt(
  command: ParsedSubagentCommand,
  output: RunSubagentsOutput
): string {
  const resultLines = output.results.map((result) => {
    if (result.status === "ok") {
      return [`## ${result.id} [ok]`, result.summary || "(empty summary)"].join("\n");
    }
    return [`## ${result.id} [${result.status}]`, result.error].join("\n");
  });

  return [
    "The user explicitly invoked /sub, so specialized subagents have already run.",
    "Use the subagent results below to synthesize the final answer in Korean.",
    "If one subagent failed or timed out, proceed with the successful results and mention uncertainty only when it affects the answer.",
    "Do not ask the user to run /sub again.",
    "",
    "Original /sub task:",
    command.task,
    "",
    "Subagent results:",
    resultLines.join("\n\n"),
  ].join("\n");
}
