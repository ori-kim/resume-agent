import { describe, expect, test } from "bun:test";
import { buildSubagentSynthesisPrompt, parseSubagentCommand } from "./subagentCommand.ts";

describe("parseSubagentCommand", () => {
  test("ignores normal chat messages", () => {
    expect(parseSubagentCommand("지원서 답변을 만들어줘")).toBeNull();
  });

  test("uses all subagents when no selector is provided", () => {
    expect(parseSubagentCommand("/sub 이 채용공고를 분석해줘")).toEqual({
      task: "이 채용공고를 분석해줘",
      agents: [
        { id: "jobAnalyzer", task: "이 채용공고를 분석해줘" },
        { id: "profileMatcher", task: "이 채용공고를 분석해줘" },
        { id: "answerStrategist", task: "이 채용공고를 분석해줘" },
      ],
    });
  });

  test("supports comma-separated subagent aliases", () => {
    expect(parseSubagentCommand("/sub job,profile 백엔드 포지션 매칭해줘")).toEqual({
      task: "백엔드 포지션 매칭해줘",
      agents: [
        { id: "jobAnalyzer", task: "백엔드 포지션 매칭해줘" },
        { id: "profileMatcher", task: "백엔드 포지션 매칭해줘" },
      ],
    });
  });

  test("supports a single subagent alias", () => {
    expect(parseSubagentCommand("/sub strategy 자기소개서 구조만 잡아줘")).toEqual({
      task: "자기소개서 구조만 잡아줘",
      agents: [{ id: "answerStrategist", task: "자기소개서 구조만 잡아줘" }],
    });
  });

  test("supports all as an explicit selector", () => {
    expect(parseSubagentCommand("/sub all 지원동기 초안 작성")).toEqual({
      task: "지원동기 초안 작성",
      agents: [
        { id: "jobAnalyzer", task: "지원동기 초안 작성" },
        { id: "profileMatcher", task: "지원동기 초안 작성" },
        { id: "answerStrategist", task: "지원동기 초안 작성" },
      ],
    });
  });

  test("rejects duplicate aliases in a selector", () => {
    expect(() => parseSubagentCommand("/sub job,jd 요구사항 분석")).toThrow(
      "Duplicate subagent selector: jobAnalyzer"
    );
  });

  test("rejects unknown aliases in an explicit selector", () => {
    expect(() => parseSubagentCommand("/sub job,unknown 요구사항 분석")).toThrow(
      "Unknown subagent selector: unknown"
    );
  });

  test("requires a task after the command", () => {
    expect(() => parseSubagentCommand("/sub")).toThrow("/sub requires a task");
  });
});

describe("buildSubagentSynthesisPrompt", () => {
  test("formats subagent results for final synthesis", () => {
    const prompt = buildSubagentSynthesisPrompt(
      { task: "지원동기 초안 작성", agents: [{ id: "jobAnalyzer", task: "지원동기 초안 작성" }] },
      {
        results: [
          { id: "jobAnalyzer", status: "ok", summary: "요구사항: TypeScript, 백엔드" },
          { id: "profileMatcher", status: "error", error: "RAG unavailable" },
        ],
      }
    );

    expect(prompt).toContain("Original /sub task:");
    expect(prompt).toContain("지원동기 초안 작성");
    expect(prompt).toContain("jobAnalyzer [ok]");
    expect(prompt).toContain("요구사항: TypeScript, 백엔드");
    expect(prompt).toContain("profileMatcher [error]");
    expect(prompt).toContain("RAG unavailable");
  });
});
