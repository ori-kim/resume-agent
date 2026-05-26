import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateObject,
  streamText,
  convertToModelMessages,
  tool,
  stepCountIs,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { resolveModel, type ProviderName } from "./providers/index.ts";
import { queryRag, indexRag } from "./qmd.ts";
import { join, basename } from "path";
import { readdir } from "fs/promises";
import { env } from "../config/env.js";
import type { SelectedField, SelectedScope } from "@resumagent/shared";

type RawPart = { type?: string; toolCallId?: string; [key: string]: unknown };

function isToolCallPart(p: unknown): p is RawPart & { type: "tool-call"; toolCallId: string } {
  const r = p as RawPart;
  return r?.type === "tool-call" && typeof r.toolCallId === "string";
}

function isToolResultPart(p: unknown): p is RawPart & { type: "tool-result"; toolCallId: string } {
  const r = p as RawPart;
  return r?.type === "tool-result" && typeof r.toolCallId === "string";
}

function isUIToolPart(p: unknown): p is RawPart & { type: `tool-${string}`; toolCallId: string } {
  const r = p as RawPart;
  return typeof r?.type === "string" && r.type.startsWith("tool-") && typeof r.toolCallId === "string";
}

function hasUIToolOutput(p: RawPart): boolean {
  return p.state === "output-available" || p.state === "output-error" || p.state === "output-denied";
}

// proposeFieldFill 등 execute 없는 tool call이 pending인 채로 새 메시지가 오면
// AI_MissingToolResultsError 발생 → result 없는 tool-call part를 제거해서 방지
function dropIncompleteToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages
    .map((m) => {
      if (m.role !== "assistant") return m;

      const parts = (m.parts ?? []) as unknown[];
      const resultIds = new Set(parts.filter(isToolResultPart).map((p) => p.toolCallId));
      const cleaned = parts.filter((p) => {
        if (isToolCallPart(p)) return resultIds.has(p.toolCallId);
        if (isUIToolPart(p)) return hasUIToolOutput(p);
        return true;
      });

      if (cleaned.length === parts.length) return m;

      const dropped = parts
        .filter(
          (p): p is RawPart & { toolCallId: string } =>
            (isToolCallPart(p) && !resultIds.has(p.toolCallId)) ||
            (isUIToolPart(p) && !hasUIToolOutput(p))
        )
        .map((p) => p.toolCallId);
      console.log("[agent] dropping incomplete tool calls:", dropped);

      return { ...m, parts: cleaned as UIMessage["parts"] };
    })
    .filter((m) => {
      // tool call 제거 후 텍스트/reasoning이 없는 assistant 메시지는 ModelMessage 스키마 위반 → 제거
      if (m.role !== "assistant") return true;
      const parts = (m.parts ?? []) as unknown[];
      return parts.some((p) => {
        const t = (p as RawPart).type;
        return t === "text" || t === "reasoning";
      });
    });
}

const BASE_SYSTEM_PROMPT = [
  "You are a personal profile assistant that helps search and manage resume/profile info.",
  "Use the searchProfile tool whenever the user asks about their profile, portfolio, projects, skills, or career.",
  "Use the agentBrowser tool whenever the user asks you to operate a website/browser/page: navigate/open pages, click, type/fill fields, scroll, inspect page state, take screenshots, or get page text/URL/title.",
  "For Korean requests such as '웹을 조작해줘', '브라우저 조작해줘', '클릭해줘', '스크롤해줘', '페이지 열어줘', use agentBrowser.",
  "When using agentBrowser on an existing page, first check page state with tab list/get url/snapshot if you are not certain which tab is active.",
  "Do not invent CSS selectors for agentBrowser. Prefer @refs from snapshot output (e.g. @e15). Use a CSS selector only when it was observed in the snapshot/page.",
  "If an agentBrowser selector action fails, inspect the returned diagnostics and retry with a visible @ref from snapshot instead of guessing another class name.",
  "Use the writeProfile tool ONLY when the user explicitly wants to save/remember information to their profile database (RAG files on disk). This is NOT for filling web page elements.",
  "",
  "CRITICAL — when a FILL TASK section appears in this prompt:",
  "  1. DO NOT ask clarifying questions. Infer content from field labels/placeholders/headings.",
  "  2. Call searchProfile with a query that captures what the fields are about.",
  "  3. For EACH field call proposeFieldFill(elementId, proposedValue, currentValue?, reason?).",
  "     — elementId MUST be the exact 'selector=' value from the FILL TASK (e.g. '#portfolio-text'). Do NOT invent IDs.",
  "     — NEVER call fillSelectedElement directly when a FILL TASK is present.",
  "     — NEVER call writeProfile when a FILL TASK is present. '작성/채워줘' here means filling the DOM element, not saving to a file.",
  "     — The client will show the user an accept/reject UI and execute fill on accept.",
  "  4. WITHOUT a FILL TASK, NEVER call proposeFieldFill or fillSelectedElement. Answer normally or ask the user to select a field.",
  "  Examples:",
  "    selector='#comments', label='Comments' → searchProfile → proposeFieldFill('#comments', value)",
  "    selector='form>textarea', label='직군' → proposeFieldFill('form>textarea', '백엔드 엔지니어')",
  "",
  "If the user previously rejected a proposal and asks to fill it again:",
  "  - Find the rejected proposal in message history (output contains 'rejected: elementId=...')",
  "  - Call fillSelectedElement(elementId, value) directly — do NOT propose again.",
  "If a previous fill output starts with 'failed:', the DOM element was not filled. Do not invent a replacement selector; ask the user to reselect the field if there is no current FILL TASK.",
  "",
  "Never prefix your response with tags like [RAG 검색 결과] — just answer naturally.",
  "For greetings and clearly off-topic questions WITHOUT a FILL TASK, do not call any tool.",
  "Respond in Korean.",
].join("\n");

function buildScopeContext(scopes: SelectedScope[]): string {
  if (scopes.length === 0) return "";
  const totalFields = scopes.reduce((n, s) => n + s.fields.length, 0);
  const lines: string[] = [
    "",
    "",
    `=== FILL TASK: ${totalFields}개 필드를 지금 바로 채우세요 ===`,
    "아래 각 필드에 대해 searchProfile로 내용을 검색한 뒤 proposeFieldFill로 제안하세요.",
  ];
  scopes.forEach((scope, i) => {
    const tag = scope.containerTag ?? scope.fields[0]?.tagName ?? "element";
    const label = scope.label ?? "";
    const scopePath = scope.cssPath ? ` [${scope.cssPath}]` : "";
    lines.push(`\nScope ${i + 1}: ${scope.kind} <${tag}> "${label}"${scopePath}`);
    for (const f of scope.fields) {
      const hints: string[] = [`  필드 selector="${f.id}"`, `tag=${f.tagName}`];
      if (f.cssPath) hints.push(`path="${f.cssPath}"`);
      if (f.label) hints.push(`label="${f.label}"`);
      if (f.placeholder) hints.push(`placeholder="${f.placeholder}"`);
      if (f.heading) hints.push(`heading="${f.heading}"`);
      if (f.name) hints.push(`name="${f.name}"`);
      if (f.currentValue) hints.push(`currentValue="${f.currentValue.slice(0, 40)}"`);
      if (f.draftValue) hints.push(`draftValue="${f.draftValue.slice(0, 80)}"`);
      lines.push(hints.join(" "));
    }
  });
  lines.push("\n위 모든 필드에 대해 proposeFieldFill을 반복 호출하세요 (fillSelectedElement·writeProfile 호출 금지).");
  lines.push("=== END FILL TASK ===");
  return lines.join("\n");
}

async function searchProfileContent(query: string): Promise<string> {
  const result = await queryRag(query);
  if (result) return result;

  try {
    const files = await readdir(env.RAG_DIR);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    if (mdFiles.length === 0) return "저장된 프로필 정보가 없습니다.";

    const contents = await Promise.all(
      mdFiles.map(async (f) => {
        const text = await Bun.file(join(env.RAG_DIR, f))
          .text()
          .catch(() => "");
        return text ? `## ${f}\n${text}` : null;
      })
    );
    return contents.filter(Boolean).join("\n\n---\n\n") || "저장된 프로필 정보가 없습니다.";
  } catch {
    return "RAG 폴더를 읽을 수 없습니다.";
  }
}

function getMessageText(message: UIMessage): string {
  return (message.parts ?? [])
    .map((part) => {
      const p = part as { type?: string; text?: unknown };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

function getLastUserText(messages: UIMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  return lastUserMessage ? getMessageText(lastUserMessage) : "";
}

function flattenSelectedFields(scopes: SelectedScope[]): SelectedField[] {
  return scopes.flatMap((scope) => scope.fields);
}

function buildFieldLabel(field: SelectedField): string {
  return [
    field.label,
    field.ariaLabel,
    field.placeholder,
    field.heading,
    field.legend,
    field.name,
    field.elementType,
  ]
    .filter(Boolean)
    .join(" ");
}

function extractProfileName(profileText: string): string | undefined {
  const firstProfileLine = profileText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("-"));
  return firstProfileLine?.split("|")[0]?.trim() || undefined;
}

function slugFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  return slug || undefined;
}

function fallbackProposal(field: SelectedField, profileText: string): string {
  const label = buildFieldLabel(field).toLowerCase();
  const name = extractProfileName(profileText);
  const slug = slugFromName(name);
  const email = profileText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const github = profileText.match(/(?:https?:\/\/)?github\.com\/[A-Za-z0-9_-]+/i)?.[0];
  const linkedIn = profileText.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i)?.[0];

  if (/이름|name/.test(label)) return name ?? field.currentValue ?? "Example User";
  if (/이메일|email|메일/.test(label)) return email ?? "user@example.com";
  if (/github|깃허브/.test(label)) return github?.replace(/^http:\/\//, "https://") ?? (slug ? `https://github.com/${slug}` : "");
  if (/linkedin|링크드인/.test(label)) return linkedIn?.replace(/^http:\/\//, "https://") ?? (slug ? `https://www.linkedin.com/in/${slug}` : "");
  if (/직책|headline|포지션|역할/.test(label)) return "소프트웨어 엔지니어 @ Example Company · 백엔드";
  if (/도시|국가|location|근무지|주소/.test(label)) return "서울, 대한민국";
  if (/소개|자기소개|about/.test(label)) {
    return "TypeScript/Node.js 기반 백엔드 개발과 LLM 기반 서비스 프로토타이핑 경험을 갖춘 소프트웨어 엔지니어입니다. RAG 챗봇, 크롬 익스텐션 자동 입력, CLI/TUI 개발 도구 제작을 통해 자동화와 개발 생산성 개선에 집중해 왔습니다.";
  }
  if (/주요 업무|성과|description|desc|활동/.test(label)) {
    return [
      "• Example Company 서비스 전체 개발",
      "• TypeScript/Node.js 기반 백엔드 개발",
      "• LLM 기반 서비스 프로토타이핑",
      "• 문서 기반 검색(RAG) 챗봇 및 크롬 익스텐션 자동 입력 실험",
    ].join("\n");
  }
  if (/기술|skill|스킬|태그/.test(label)) return "TypeScript, Node.js, RAG, LLM, Chrome Extension, CLI/TUI";

  return field.currentValue || "소프트웨어 엔지니어";
}

function buildFillPlanPrompt(fields: SelectedField[], profileText: string, userText: string): string {
  const fieldList = fields.map((field, index) => ({
    index: index + 1,
    elementId: field.id,
    tagName: field.tagName,
    label: field.label,
    placeholder: field.placeholder,
    heading: field.heading,
    name: field.name,
    currentValue: field.currentValue,
    draftValue: field.draftValue,
  }));

  return [
    "사용자의 프로필 정보를 기반으로 웹 이력서 폼의 각 필드에 채울 값을 만드세요.",
    "반드시 fields 배열의 모든 elementId에 대해 정확히 한 개씩 proposal을 생성하세요.",
    "elementId는 입력받은 값을 글자 하나도 바꾸지 말고 그대로 사용하세요.",
    "프로필에 없는 회사명, 연결 수, URL, 날짜, 학위 같은 구체 정보는 지어내지 말고 생략하세요.",
    "값을 모르는 필드는 필드 의미와 프로필에서 안전하게 추론 가능한 짧은 값만 작성하세요.",
    "draftValue가 있는 필드는 이전 AI 제안입니다. 사용자 요청에 맞게 그 제안을 보완하거나 수정하세요.",
    "응답은 스키마에 맞는 JSON 객체만 생성하세요.",
    "",
    `사용자 요청: ${userText || "선택한 필드를 내 정보로 채워줘"}`,
    "",
    "프로필 정보:",
    profileText,
    "",
    "fields:",
    JSON.stringify(fieldList, null, 2),
  ].join("\n");
}

const FillPlanSchema = z.object({
  proposals: z.array(
    z.object({
      elementId: z.string(),
      proposedValue: z.string(),
      reason: z.string().optional(),
    })
  ),
});

function extractJsonObject(text: string): string {
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return withoutFence;
  return withoutFence.slice(start, end + 1);
}

async function generateFieldFillProposals(
  messages: UIMessage[],
  options: { provider?: ProviderName; modelId?: string; selectedScopes?: SelectedScope[] },
  fields: SelectedField[],
  profileText: string
) {
  const model = await resolveModel(options);
  const userText = getLastUserText(messages);

  try {
    let object: z.infer<typeof FillPlanSchema>;
    const prompt = buildFillPlanPrompt(fields, profileText, userText);

    if (options.provider === "codex") {
      const stream = streamText({
        model,
        prompt: `${prompt}\n\nReturn ONLY valid JSON matching this TypeScript shape: { "proposals": [{ "elementId": string, "proposedValue": string, "reason"?: string }] }`,
        maxRetries: 0,
      });
      let raw = "";
      for await (const delta of stream.textStream) raw += delta;
      object = FillPlanSchema.parse(JSON.parse(extractJsonObject(raw)));
    } else {
      const result = await generateObject({
        model,
        schema: FillPlanSchema,
        schemaName: "FieldFillPlan",
        schemaDescription: "Form fill proposals keyed by exact elementId",
        prompt,
        maxRetries: 0,
      });
      object = result.object;
    }

    const byId = new Map(
      object.proposals
        .filter((p) => p.elementId && p.proposedValue.trim())
        .map((p) => [p.elementId, p])
    );

    return fields.map((field) => {
      const generated = byId.get(field.id);
      return {
        elementId: field.id,
        proposedValue: generated?.proposedValue.trim() || fallbackProposal(field, profileText),
        currentValue: field.currentValue,
        reason: generated?.reason || "선택한 필드와 저장된 프로필 정보를 기반으로 제안했습니다.",
      };
    });
  } catch (error) {
    console.warn("[agent] generate field fill proposals failed, using fallback:", error);
    return fields.map((field) => ({
      elementId: field.id,
      proposedValue: fallbackProposal(field, profileText),
      currentValue: field.currentValue,
      reason: "구조화 생성에 실패해 저장된 프로필 정보 기반 기본값으로 제안했습니다.",
    }));
  }
}

function makeToolCallId(prefix: string, index: number): string {
  return `${prefix}_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildEditScope(field: SelectedField, proposedValue: string): SelectedScope {
  return {
    scopeId: makeToolCallId("editScope", 0),
    kind: "field",
    label: field.label || field.placeholder || field.heading || field.name || field.id,
    cssPath: field.cssPath,
    fields: [{ ...field, draftValue: proposedValue }],
  };
}

type AgentBrowserInput = z.infer<typeof AgentBrowserInputSchema>;

const AgentBrowserInputSchema = z.object({
  action: z
    .enum([
      "open",
      "snapshot",
      "click",
      "dblclick",
      "fill",
      "type",
      "press",
      "hover",
      "focus",
      "check",
      "uncheck",
      "select",
      "scroll",
      "scrollintoview",
      "wait",
      "get",
      "back",
      "forward",
      "reload",
      "screenshot",
      "tab",
      "close",
    ])
    .describe("Browser action to execute."),
  url: z.string().optional().describe("URL for action=open."),
  selector: z.string().optional().describe("agent-browser @ref from snapshot, e.g. @e1, or a CSS selector confirmed from the page. Prefer @refs."),
  text: z.string().optional().describe("Text for fill/type/select, or tab subcommand such as list or a tab index."),
  key: z.string().optional().describe("Keyboard key for press, e.g. Enter, Tab, Control+a."),
  direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction."),
  pixels: z.number().int().positive().max(10000).optional().describe("Scroll distance in pixels."),
  waitFor: z.string().optional().describe("Selector, @ref, or milliseconds string/number for wait."),
  what: z.enum(["text", "html", "value", "attr", "title", "url", "count", "box", "styles"]).optional().describe("Information to read for action=get."),
  attrName: z.string().optional().describe("Attribute name when using get attr."),
  path: z.string().optional().describe("Output path for screenshot."),
  interactive: z.boolean().optional().describe("For snapshot: only show interactive elements."),
  compact: z.boolean().optional().describe("For snapshot: compact output."),
  full: z.boolean().optional().describe("For screenshot: full page."),
  annotate: z.boolean().optional().describe("For screenshot: annotate elements."),
});

function getAgentBrowserCdpPort(): number {
  return Number.isInteger(env.AGENT_BROWSER_CDP_PORT) && env.AGENT_BROWSER_CDP_PORT > 0
    ? env.AGENT_BROWSER_CDP_PORT
    : 9222;
}

function getAgentBrowserBaseArgs(): string[] {
  return ["--cdp", String(getAgentBrowserCdpPort())];
}

function pushIfValue(args: string[], ...values: Array<string | number | undefined>) {
  for (const value of values) {
    if (value !== undefined && value !== "") args.push(String(value));
  }
}

function buildAgentBrowserArgs(input: AgentBrowserInput): string[] {
  const args = getAgentBrowserBaseArgs();

  switch (input.action) {
    case "open":
      if (!input.url) throw new Error("agentBrowser.open requires url");
      args.push("open", input.url);
      break;
    case "snapshot":
      args.push("snapshot");
      if (input.interactive ?? true) args.push("-i");
      if (input.compact) args.push("-c");
      if (input.selector) args.push("-s", input.selector);
      break;
    case "click":
    case "dblclick":
    case "hover":
    case "focus":
    case "check":
    case "uncheck":
    case "scrollintoview":
      if (!input.selector) throw new Error(`agentBrowser.${input.action} requires selector`);
      args.push(input.action, input.selector);
      break;
    case "fill":
    case "type":
      if (!input.selector || input.text == null) throw new Error(`agentBrowser.${input.action} requires selector and text`);
      args.push(input.action, input.selector, input.text);
      break;
    case "select":
      if (!input.selector || input.text == null) throw new Error("agentBrowser.select requires selector and text");
      args.push("select", input.selector, input.text);
      break;
    case "press":
      if (!input.key) throw new Error("agentBrowser.press requires key");
      args.push("press", input.key);
      break;
    case "scroll":
      if (!input.direction) throw new Error("agentBrowser.scroll requires direction");
      args.push("scroll", input.direction);
      if (input.pixels) args.push(String(input.pixels));
      break;
    case "wait":
      args.push("wait", input.waitFor ?? "1000");
      break;
    case "get":
      if (!input.what) throw new Error("agentBrowser.get requires what");
      args.push("get", input.what);
      if (input.what === "attr") {
        if (!input.attrName) throw new Error("agentBrowser.get attr requires attrName");
        args.push(input.attrName);
      }
      if (input.selector) args.push(input.selector);
      break;
    case "screenshot":
      args.push("screenshot");
      if (input.path) args.push(input.path);
      if (input.full) args.push("--full");
      if (input.annotate) args.push("--annotate");
      break;
    case "tab":
      args.push("tab");
      pushIfValue(args, input.text);
      break;
    case "back":
    case "forward":
    case "reload":
    case "close":
      args.push(input.action);
      break;
  }

  return args;
}

type AgentBrowserRunResult = {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
};

type AgentBrowserTab = {
  index: number;
  title: string;
  url: string;
  current: boolean;
};

const ACTIONS_THAT_OPERATE_ON_PAGE = new Set<AgentBrowserInput["action"]>([
  "snapshot",
  "click",
  "dblclick",
  "fill",
  "type",
  "press",
  "hover",
  "focus",
  "check",
  "uncheck",
  "select",
  "scroll",
  "scrollintoview",
  "wait",
  "get",
  "back",
  "forward",
  "reload",
  "screenshot",
]);

function isContentPageUrl(url: string): boolean {
  const trimmed = url.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== "about:blank" &&
    !trimmed.startsWith("chrome://") &&
    !trimmed.startsWith("chrome-extension://") &&
    !trimmed.startsWith("devtools://")
  );
}

function parseAgentBrowserTabs(output: string): AgentBrowserTab[] {
  return output
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(→\s*)?\[(\d+)]\s*(.*?)\s+-\s+(.+?)\s*$/);
      if (!match) return undefined;
      return {
        current: Boolean(match[1]),
        index: Number(match[2]),
        title: match[3].trim(),
        url: match[4].trim(),
      };
    })
    .filter((tab): tab is AgentBrowserTab => Boolean(tab));
}

function truncateForToolOutput(text: string, maxLength = 6000): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n... (${text.length - maxLength} chars truncated)`;
}

async function runAgentBrowserCommand(args: string[], timeoutMs = env.AGENT_BROWSER_TIMEOUT_MS): Promise<AgentBrowserRunResult> {
  const proc = Bun.spawn([env.AGENT_BROWSER_BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error(`agent-browser timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  return {
    args,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

async function maybeFocusContentTab(input: AgentBrowserInput): Promise<string | undefined> {
  if (!ACTIONS_THAT_OPERATE_ON_PAGE.has(input.action)) return undefined;

  const currentUrlResult = await runAgentBrowserCommand([...getAgentBrowserBaseArgs(), "get", "url"], 5_000);
  const currentUrl = currentUrlResult.stdout.trim();
  if (currentUrlResult.exitCode !== 0 || isContentPageUrl(currentUrl)) return undefined;

  const tabsResult = await runAgentBrowserCommand([...getAgentBrowserBaseArgs(), "tab", "list"], 5_000);
  if (tabsResult.exitCode !== 0) return undefined;

  const target = parseAgentBrowserTabs(tabsResult.stdout).find((tab) => isContentPageUrl(tab.url));
  if (!target) return undefined;

  const switchResult = await runAgentBrowserCommand([...getAgentBrowserBaseArgs(), "tab", String(target.index)], 5_000);
  if (switchResult.exitCode !== 0) return undefined;

  return `ⓘ active tab was ${currentUrl || "unknown"}; switched to tab ${target.index}: ${target.title || target.url}`;
}

async function buildAgentBrowserFailureDiagnostics(): Promise<string> {
  const [urlResult, tabsResult, snapshotResult] = await Promise.all([
    runAgentBrowserCommand([...getAgentBrowserBaseArgs(), "get", "url"], 5_000),
    runAgentBrowserCommand([...getAgentBrowserBaseArgs(), "tab", "list"], 5_000),
    runAgentBrowserCommand([...getAgentBrowserBaseArgs(), "snapshot", "-i", "-C"], 8_000),
  ]);

  const lines = [
    "",
    "진단:",
    `currentUrl: ${urlResult.stdout || urlResult.stderr || "(unknown)"}`,
    "tabs:",
    tabsResult.stdout || tabsResult.stderr || "(unavailable)",
    "interactive snapshot:",
    truncateForToolOutput(snapshotResult.stdout || snapshotResult.stderr || "(unavailable)"),
    "",
    "다음 호출에서는 snapshot에 나온 @ref를 우선 사용하세요. 위 snapshot에 없는 CSS class/id는 추측하지 마세요.",
  ];

  return lines.join("\n");
}

async function runAgentBrowser(input: AgentBrowserInput): Promise<string> {
  const focusNote = await maybeFocusContentTab(input);
  const args = buildAgentBrowserArgs(input);
  const result = await runAgentBrowserCommand(args);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

  if (result.exitCode !== 0) {
    const diagnostics = await buildAgentBrowserFailureDiagnostics();
    return [
      `✗ agent-browser failed (exit ${result.exitCode})`,
      `command: agent-browser ${result.args.join(" ")}`,
      output,
      diagnostics,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [focusNote, output || `✓ agent-browser ${input.action} 완료`].filter(Boolean).join("\n");
}

export async function createFieldFillResponse(
  messages: UIMessage[],
  options: { provider?: ProviderName; modelId?: string; selectedScopes?: SelectedScope[] } = {}
): Promise<Response> {
  const fields = flattenSelectedFields(options.selectedScopes ?? []);
  const userText = getLastUserText(messages);
  const query =
    userText ||
    fields
      .map(buildFieldLabel)
      .filter(Boolean)
      .join(" ") ||
    "프로필 이력서 포트폴리오";

  const stream = createUIMessageStream<UIMessage>({
    execute: async ({ writer }) => {
      const searchToolCallId = makeToolCallId("searchProfile", 0);
      writer.write({
        type: "tool-input-available",
        toolCallId: searchToolCallId,
        toolName: "searchProfile",
        input: { query },
      });

      const profileText = await searchProfileContent(query);
      writer.write({
        type: "tool-output-available",
        toolCallId: searchToolCallId,
        output: profileText,
      });

      const proposals = await generateFieldFillProposals(messages, options, fields, profileText);
      proposals.forEach((proposal, index) => {
        const sourceField = fields[index];
        writer.write({
          type: "tool-input-available",
          toolCallId: makeToolCallId("proposeFieldFill", index + 1),
          toolName: "proposeFieldFill",
          input: {
            ...proposal,
            editScope: sourceField ? buildEditScope(sourceField, proposal.proposedValue) : undefined,
          },
        });
      });

      writer.write({ type: "finish", finishReason: "tool-calls" });
    },
    onError: (error) => (error instanceof Error ? error.message : "알 수 없는 오류"),
  });

  return createUIMessageStreamResponse({ stream });
}

const tools = {
  searchProfile: tool({
    description:
      "사용자의 프로필/포트폴리오/경력/스킬 정보를 rag 폴더에서 검색합니다. 시맨틱 검색 후 결과가 없으면 전체 파일을 반환합니다.",
    inputSchema: z.object({
      query: z.string().describe("검색할 키워드 또는 문장"),
    }),
    execute: async ({ query }) => {
      console.log("[agent] searchProfile:", query);
      return searchProfileContent(query);
    },
  }),

  writeProfile: tool({
    description:
      "사용자 프로필/이력 정보를 rag 폴더의 특정 마크다운 파일에 저장하거나 추가합니다. 파일명을 지정해 내용을 overwrite 또는 append 할 수 있습니다.",
    inputSchema: z.object({
      filename: z
        .string()
        .regex(/^[a-zA-Z0-9가-힣._-]+\.md$/, "반드시 .md 확장자 포함 (예: github.md)")
        .describe("파일명 — 반드시 .md 확장자 포함. 예: profile.md, experience.md, skills.md"),
      content: z
        .string()
        .min(1, "내용이 비어있으면 안 됩니다")
        .describe("저장할 마크다운 내용"),
      mode: z
        .enum(["overwrite", "append"])
        .describe("overwrite: 파일 전체 교체(새 파일 생성 포함), append: 기존 파일 끝에 추가"),
    }),
    execute: async ({ filename, content, mode }) => {
      const safe = basename(filename).replace(/[^a-zA-Z0-9가-힣._-]/g, "_");
      if (!safe.endsWith(".md")) return "오류: .md 파일만 허용됩니다.";

      const filePath = join(env.RAG_DIR, safe);
      console.log("[agent] writeProfile:", mode, filePath);

      if (mode === "append") {
        const existing = await Bun.file(filePath).text().catch(() => "");
        const separator = existing && !existing.endsWith("\n") ? "\n" : "";
        await Bun.write(filePath, existing + separator + content);
      } else {
        await Bun.write(filePath, content);
      }

      try {
        await indexRag();
      } catch (e) {
        console.warn("[agent] reindex after write failed:", e);
      }

      return `✓ ${safe} ${mode === "append" ? "에 내용을 추가" : "를 저장"}했습니다.`;
    },
  }),

  agentBrowser: tool({
    description:
      "웹/브라우저를 실제로 조작하는 로컬 agent-browser CLI 도구입니다. 페이지 열기, 스냅샷 확인, 클릭, 입력, 스크롤, URL/텍스트 조회, 스크린샷 등에 사용합니다. WXT dev Chrome의 CDP 포트에 연결합니다. 브라우저 조작 관련 요청이면 이 도구를 사용하세요.",
    inputSchema: AgentBrowserInputSchema,
    execute: async (input) => {
      console.log("[agent] agentBrowser:", input.action);
      return runAgentBrowser(input);
    },
  }),

  // execute 없음 — 클라이언트가 수락/거절 UI를 표시하고 처리
  proposeFieldFill: tool({
    description:
      "필드에 채울 내용을 사용자에게 먼저 제안합니다. 사이드패널에 수락/거절 버튼이 표시되며, 수락 시 클라이언트가 직접 DOM에 채웁니다. FILL TASK가 있을 때 fillSelectedElement 대신 반드시 이 tool을 사용하세요.",
    inputSchema: z.object({
      elementId: z.string().describe("채울 DOM 요소의 CSS 셀렉터 — FILL TASK의 '필드 id=' 값을 그대로 사용 (예: #portfolio-text 또는 cssPath)"),
      proposedValue: z.string().describe("제안할 텍스트 내용"),
      currentValue: z.string().optional().describe("현재 필드의 기존 값 (있으면 diff 표시에 사용)"),
      reason: z.string().optional().describe("이 내용을 제안한 이유"),
    }),
  }),

  // execute 없음 — 클라이언트(sidepanel)가 처리 (거절 후 재요청 시 사용)
  fillSelectedElement: tool({
    description:
      "사용자가 사이드패널에 첨부한 selected scope의 특정 field에 텍스트를 채워 넣습니다. elementId는 첨부된 scope의 fields[].id (CSS 셀렉터) 값이어야 합니다.",
    inputSchema: z.object({
      elementId: z.string().describe("첨부된 SelectedScope의 fields 중 하나의 CSS 셀렉터 (예: #portfolio-text). FILL TASK의 '필드 id=' 값을 그대로 사용."),
      value: z
        .string()
        .describe("해당 DOM 요소에 입력할 최종 텍스트. 라벨/placeholder에 맞는 내용으로 작성."),
      reason: z.string().optional().describe("이 값을 선택한 이유 (선택적)"),
    }),
  }),
};

export async function streamAgentResponse(
  messages: UIMessage[],
  options: { provider?: ProviderName; modelId?: string; selectedScopes?: SelectedScope[] } = {}
) {
  const model = await resolveModel(options);
  const modelMessages = await convertToModelMessages(dropIncompleteToolCalls(messages));

  const scopeContext = buildScopeContext(options.selectedScopes ?? []);
  const system = BASE_SYSTEM_PROMPT + scopeContext;

  const totalFields = (options.selectedScopes ?? []).reduce((sum, s) => sum + s.fields.length, 0);
  // proposeFieldFill(1) + 사용자 응답(1) + fillSelectedElement(재요청 1) — 필드당 최대 2 step
  const stopWhenCount = Math.max(8, 3 + totalFields * 2);

  return streamText({
    model,
    system,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(stopWhenCount),
    maxRetries: 0,
    onError: (event) => {
      console.error("[agent] streamText error:", event.error);
    },
  });
}
