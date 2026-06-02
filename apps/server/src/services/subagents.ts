import { streamText } from "ai";
import { resolveModel, type ProviderName } from "./providers/index.ts";
import { searchProfileContent } from "./profile.ts";

export const SUBAGENT_IDS = ["jobAnalyzer", "profileMatcher", "answerStrategist"] as const;

export type SubagentId = (typeof SUBAGENT_IDS)[number];

export type SubagentRequest = {
  id: SubagentId;
  task: string;
};

export type RawSubagentRequest = {
  id: string;
  task: string;
};

export type SubagentRunInput = {
  userText: string;
  conversationSummary: string;
  provider?: ProviderName;
  modelId?: string;
};

export type SubagentDefinition = {
  id: SubagentId;
  description: string;
  system: string;
  buildPrompt: (input: SubagentRunInput & { task: string }) => string | Promise<string>;
  run: (input: SubagentRunInput & { task: string }) => Promise<string>;
};

export type SubagentResult =
  | { id: SubagentId; status: "ok"; summary: string }
  | { id: SubagentId; status: "timeout" | "error"; error: string };

export type RunSubagentsInput = {
  agents: RawSubagentRequest[];
};

export type RunSubagentsOutput = {
  results: SubagentResult[];
};

type RunSubagentsOptions = {
  timeoutMs?: number;
  definitions?: SubagentDefinition[];
};

const DEFAULT_TIMEOUT_MS = 20_000;
const SUBAGENT_ID_SET = new Set<string>(SUBAGENT_IDS);

function isSubagentId(id: string): id is SubagentId {
  return SUBAGENT_ID_SET.has(id);
}

export function normalizeSubagentRequests(requests: RawSubagentRequest[]): SubagentRequest[] {
  if (requests.length > 3) {
    throw new Error("runSubagents accepts at most 3 agents");
  }

  const seen = new Set<SubagentId>();
  return requests.map((request) => {
    if (!isSubagentId(request.id)) {
      throw new Error(`Unknown subagent id: ${request.id}`);
    }
    if (seen.has(request.id)) {
      throw new Error(`Duplicate subagent id: ${request.id}`);
    }
    seen.add(request.id);

    const task = request.task.trim();
    if (!task) {
      throw new Error(`Subagent task is empty: ${request.id}`);
    }

    return { id: request.id, task };
  });
}

async function runWithTimeout<T>(id: SubagentId, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${id} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runTextSubagent(
  system: string,
  prompt: string,
  options: { provider?: ProviderName; modelId?: string }
): Promise<string> {
  const model = await resolveModel(options);
  const result = streamText({
    model,
    system,
    prompt,
    maxRetries: 0,
  });

  let text = "";
  for await (const delta of result.textStream) text += delta;
  return text.trim();
}

function buildBasePrompt(title: string, input: SubagentRunInput & { task: string }, extra: string): string {
  return [
    title,
    "",
    `Subagent task: ${input.task}`,
    "",
    "User request:",
    input.userText || "(empty)",
    "",
    "Conversation summary:",
    input.conversationSummary || "(empty)",
    "",
    extra,
    "",
    "Return a concise Korean Markdown summary. Do not call tools. Do not write the final answer for the user unless explicitly asked by the task.",
  ].join("\n");
}

function createTextSubagent(config: Omit<SubagentDefinition, "run">): SubagentDefinition {
  return {
    ...config,
    run: async (input) => runTextSubagent(config.system, await config.buildPrompt(input), input),
  };
}

export const defaultSubagentDefinitions: SubagentDefinition[] = [
  createTextSubagent({
    id: "jobAnalyzer",
    description: "Analyze job postings, form questions, and user tasks for requirements and evaluation signals.",
    system:
      "You are a resume job-analysis subagent. Extract requirements, seniority signals, keywords, and evaluation criteria. Stay concise and evidence-focused.",
    buildPrompt: (input) =>
      buildBasePrompt(
        "Analyze the user's resume/application task for job or form requirements.",
        input,
        "Focus on role signals, required skills, evaluation criteria, and missing context."
      ),
  }),
  createTextSubagent({
    id: "profileMatcher",
    description: "Find profile evidence that matches the requested resume or application task.",
    system:
      "You are a resume profile-matching subagent. Use provided profile context to identify relevant evidence and weak claims to avoid.",
    buildPrompt: async (input) => {
      const profileText = await searchProfileContent([input.task, input.userText].filter(Boolean).join(" "));
      return buildBasePrompt(
        "Match the user's stored profile information to the requested resume/application task.",
        input,
        [
          "Profile context:",
          profileText,
          "",
          "Focus on relevant experience, matching skills, projects or achievements to cite, and evidence gaps.",
        ].join("\n")
      );
    },
  }),
  createTextSubagent({
    id: "answerStrategist",
    description: "Plan answer structure, tone, emphasis, and claims to avoid for resume/application writing.",
    system:
      "You are a resume answer-strategy subagent. Plan structure, tone, emphasis, and risk controls for the final answer.",
    buildPrompt: (input) =>
      buildBasePrompt(
        "Plan how the main agent should answer the user's resume/application request.",
        input,
        "Focus on answer structure, tone and length, strongest claims to emphasize, and claims to avoid."
      ),
  }),
];

export async function runSubagents(
  input: RunSubagentsInput,
  runInput: SubagentRunInput,
  options: RunSubagentsOptions = {}
): Promise<RunSubagentsOutput> {
  const requests = normalizeSubagentRequests(input.agents);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const definitions = new Map((options.definitions ?? defaultSubagentDefinitions).map((definition) => [definition.id, definition]));

  const settled = await Promise.allSettled(
    requests.map(async (request): Promise<SubagentResult> => {
      const definition = definitions.get(request.id);
      if (!definition) return { id: request.id, status: "error", error: `Subagent is not configured: ${request.id}` };

      try {
        const summary = await runWithTimeout(request.id, timeoutMs, () =>
          definition.run({ ...runInput, task: request.task })
        );
        return { id: request.id, status: "ok", summary };
      } catch (error) {
        const message = getErrorMessage(error);
        const status = message.includes("timed out after") ? "timeout" : "error";
        return { id: request.id, status, error: message };
      }
    })
  );

  return {
    results: settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      return {
        id: requests[index]?.id ?? "jobAnalyzer",
        status: "error",
        error: getErrorMessage(result.reason),
      };
    }),
  };
}
