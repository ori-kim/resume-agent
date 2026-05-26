import { Hono } from "hono";
import { FormSuggestRequestSchema } from "@resumagent/shared";
import type { FormFieldContext } from "@resumagent/shared";
import { queryRag } from "../services/qmd.ts";
import { resolveModel } from "../services/providers/index.ts";
import { generateText, streamText } from "ai";

const form = new Hono();

/**
 * 필드 컨텍스트로부터 qmd 쿼리 문자열을 생성한다.
 * 페이지 본문은 포함하지 않는다 (Q12 가드).
 */
function buildQuery(ctx: FormFieldContext): string {
  const parts: string[] = [];
  if (ctx.heading) parts.push(ctx.heading);
  if (ctx.legend) parts.push(ctx.legend);
  if (ctx.label) parts.push(ctx.label);
  if (ctx.ariaLabel) parts.push(ctx.ariaLabel);
  if (ctx.placeholder) parts.push(ctx.placeholder);
  return parts.filter(Boolean).join(" — ");
}

/**
 * POST /form/suggest
 *
 * 필드 컨텍스트(label/heading/placeholder 등) → qmd query → LLM 단답 생성.
 * 페이지 본문 수집은 하지 않는다 (Q12).
 */
form.post("/suggest", async (c) => {
  const bodyRaw = await c.req.json().catch(() => null);
  const parsed = FormSuggestRequestSchema.safeParse(bodyRaw);

  if (!parsed.success) {
    return c.json(
      {
        error: "요청 형식 오류: " + parsed.error.issues.map((i) => i.message).join(", "),
      },
      400,
    );
  }

  const { fieldContext, provider, model } = parsed.data;
  const query = buildQuery(fieldContext);

  if (!query.trim()) {
    return c.json({ error: "필드 컨텍스트가 비어있습니다." }, 400);
  }

  // qmd query — 실패 시 빈 컨텍스트로 진행
  let ragContext = "";
  try {
    ragContext = await queryRag(query);
  } catch (err) {
    console.warn("[form/suggest] qmd query failed, proceeding without RAG context:", err);
  }

  const llmModel = await resolveModel({ provider, modelId: model });

  const labelDesc =
    fieldContext.label ||
    fieldContext.ariaLabel ||
    fieldContext.placeholder ||
    fieldContext.heading ||
    fieldContext.legend ||
    "this field";

  const systemPrompt = ragContext
    ? [
        "You are a resume assistant. Answer with a single concise value (no sentence, no explanation) that fits the form field.",
        "Use the CONTEXT below as primary reference.",
        "",
        "[CONTEXT START]",
        ragContext,
        "[CONTEXT END]",
      ].join("\n")
    : "You are a resume assistant. Answer with a single concise value (no sentence, no explanation) that fits the form field.";

  const userPrompt = `Fill in the form field: "${labelDesc}". Return only the value, nothing else.`;

  let value = "";
  let source: string | undefined;

  try {
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];

    if (provider === "codex") {
      const result = streamText({
        model: llmModel,
        messages,
        maxRetries: 0,
      });
      for await (const delta of result.textStream) value += delta;
      value = value.trim();
    } else {
      const result = await generateText({
        model: llmModel,
        messages,
        maxRetries: 0,
      });
      value = result.text.trim();
    }

    if (ragContext) source = "rag";
  } catch (err) {
    const msg = err instanceof Error ? err.message : "알 수 없는 오류";
    console.error("[form/suggest] LLM error:", msg);
    return c.json({ error: `LLM 호출 실패: ${msg}` }, 500);
  }

  return c.json({ value, source });
});

export { form };
