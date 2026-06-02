import { describe, expect, test } from "bun:test";
import {
  normalizeSubagentRequests,
  runSubagents,
  type SubagentDefinition,
  type SubagentRunInput,
} from "./subagents.ts";

const input: SubagentRunInput = {
  userText: "백엔드 포지션 지원 답변을 만들어줘",
  conversationSummary: "사용자는 이력서 기반 지원서 작성을 요청했다.",
  provider: "ollama",
  modelId: "test-model",
};

function makeAgent(id: SubagentDefinition["id"], run: SubagentDefinition["run"]): SubagentDefinition {
  return {
    id,
    description: `${id} test agent`,
    system: `${id} system`,
    buildPrompt: ({ task }) => task,
    run,
  };
}

describe("normalizeSubagentRequests", () => {
  test("rejects unknown subagent IDs", () => {
    expect(() =>
      normalizeSubagentRequests([{ id: "unknown", task: "analyze this" }])
    ).toThrow("Unknown subagent id: unknown");
  });

  test("rejects duplicate subagent IDs", () => {
    expect(() =>
      normalizeSubagentRequests([
        { id: "jobAnalyzer", task: "first" },
        { id: "jobAnalyzer", task: "second" },
      ])
    ).toThrow("Duplicate subagent id: jobAnalyzer");
  });

  test("rejects more than three subagents", () => {
    expect(() =>
      normalizeSubagentRequests([
        { id: "jobAnalyzer", task: "a" },
        { id: "profileMatcher", task: "b" },
        { id: "answerStrategist", task: "c" },
        { id: "jobAnalyzer", task: "d" },
      ])
    ).toThrow("runSubagents accepts at most 3 agents");
  });
});

describe("runSubagents", () => {
  test("returns ok results from selected agents", async () => {
    const result = await runSubagents(
      {
        agents: [
          { id: "jobAnalyzer", task: "extract requirements" },
          { id: "profileMatcher", task: "find matching evidence" },
        ],
      },
      input,
      {
        timeoutMs: 100,
        definitions: [
          makeAgent("jobAnalyzer", async () => "requirements summary"),
          makeAgent("profileMatcher", async () => "profile evidence"),
        ],
      }
    );

    expect(result.results).toEqual([
      { id: "jobAnalyzer", status: "ok", summary: "requirements summary" },
      { id: "profileMatcher", status: "ok", summary: "profile evidence" },
    ]);
  });

  test("returns partial error results without failing the whole run", async () => {
    const result = await runSubagents(
      {
        agents: [
          { id: "jobAnalyzer", task: "extract requirements" },
          { id: "profileMatcher", task: "find matching evidence" },
        ],
      },
      input,
      {
        timeoutMs: 100,
        definitions: [
          makeAgent("jobAnalyzer", async () => "requirements summary"),
          makeAgent("profileMatcher", async () => {
            throw new Error("RAG unavailable");
          }),
        ],
      }
    );

    expect(result.results).toEqual([
      { id: "jobAnalyzer", status: "ok", summary: "requirements summary" },
      { id: "profileMatcher", status: "error", error: "RAG unavailable" },
    ]);
  });

  test("returns timeout results without failing the whole run", async () => {
    const result = await runSubagents(
      {
        agents: [{ id: "answerStrategist", task: "plan answer" }],
      },
      input,
      {
        timeoutMs: 5,
        definitions: [
          makeAgent(
            "answerStrategist",
            () => new Promise((resolve) => setTimeout(() => resolve("late summary"), 50))
          ),
        ],
      }
    );

    expect(result.results).toEqual([
      { id: "answerStrategist", status: "timeout", error: "answerStrategist timed out after 5ms" },
    ]);
  });
});
