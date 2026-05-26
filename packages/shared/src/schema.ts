import { z } from "zod";

// ── Provider ──────────────────────────────────────────────────────────────────

export const ProviderNameSchema = z.enum(["ollama", "codex"]);

export const ProviderModelInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
});

export const ProviderQuotaInfoSchema = z.object({
  status: z.enum(["ok", "limited", "blocked", "unknown"]),
  message: z.string(),
  retryAfterSec: z.number().optional(),
});

export const ProviderCatalogResponseSchema = z.object({
  provider: ProviderNameSchema,
  activeModel: z.string(),
  models: z.array(ProviderModelInfoSchema),
  quota: ProviderQuotaInfoSchema,
});

// ── Chat ──────────────────────────────────────────────────────────────────────

export const ChatRoleSchema = z.enum(["system", "user", "assistant"]);

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
});

export const ChatRequestSchema = z.object({
  messages: z.array(z.unknown()).min(1),
  provider: ProviderNameSchema.optional(),
  model: z.string().optional(),
  id: z.string().optional(),
  selectedScopes: z.array(z.unknown()).optional(),
});

// ── RAG ───────────────────────────────────────────────────────────────────────

export const RagStatusResponseSchema = z.object({
  status: z.string(),
  ragDir: z.string(),
});

export const RagReindexResponseSchema = z.object({
  ok: z.boolean(),
  ragDir: z.string(),
  indexedAt: z.string(),
});

export const RagSearchResponseSchema = z.object({
  query: z.string(),
  result: z.string(),
});

// ── Form Fill ─────────────────────────────────────────────────────────────────

export const FormFieldContextSchema = z.object({
  label: z.string().optional(),
  ariaLabel: z.string().optional(),
  placeholder: z.string().optional(),
  heading: z.string().optional(),
  legend: z.string().optional(),
  fieldType: z.string().optional(),
});

export const FormSuggestRequestSchema = z.object({
  fieldContext: FormFieldContextSchema,
  provider: ProviderNameSchema.optional(),
  model: z.string().optional(),
});

export const FormSuggestResponseSchema = z.object({
  value: z.string(),
  source: z.string().optional(),
});

// ── ProviderInfo (legacy compat) ──────────────────────────────────────────────

export const ProviderInfoSchema = z.object({
  id: z.enum(["ollama", "codex"]),
  available: z.boolean(),
  models: z.array(z.string()),
});

// ── DOM Picker ────────────────────────────────────────────────────────────────

export const SelectedFieldSchema = z.object({
  id: z.string(),
  tagName: z.enum(["input", "textarea", "select", "contenteditable"]),
  elementType: z.string().optional(),
  label: z.string().optional(),
  ariaLabel: z.string().optional(),
  placeholder: z.string().optional(),
  heading: z.string().optional(),
  legend: z.string().optional(),
  name: z.string().optional(),
  currentValue: z.string().optional(),
  draftValue: z.string().optional(),
  cssPath: z.string().optional(),
});

export const SelectedScopeSchema = z.object({
  scopeId: z.string(),
  kind: z.enum(["field", "container"]),
  containerTag: z.string().optional(),
  label: z.string().optional(),
  heading: z.string().optional(),
  legend: z.string().optional(),
  cssPath: z.string().optional(),
  fields: z.array(SelectedFieldSchema).min(1),
});

export const FillSelectedElementInputSchema = z.object({
  elementId: z.string(),
  value: z.string(),
  reason: z.string().optional(),
  force: z.boolean().optional(),
});

export const FillCommandMessageSchema = z.object({
  type: z.literal("fill"),
  payload: FillSelectedElementInputSchema,
});

export const FillCommandResponseSchema = z.object({
  ok: z.boolean(),
  applied: z.boolean(),
  reason: z.string().optional(),
});
