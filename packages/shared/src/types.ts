import type { z } from "zod";
import type {
  ChatRequestSchema,
  ChatMessageSchema,
  ChatRoleSchema,
  ProviderInfoSchema,
  ProviderNameSchema,
  ProviderModelInfoSchema,
  ProviderQuotaInfoSchema,
  ProviderCatalogResponseSchema,
  RagStatusResponseSchema,
  RagReindexResponseSchema,
  RagSearchResponseSchema,
  FormFieldContextSchema,
  FormSuggestRequestSchema,
  FormSuggestResponseSchema,
  SelectedFieldSchema,
  SelectedScopeSchema,
  FillSelectedElementInputSchema,
  FillCommandMessageSchema,
  FillCommandResponseSchema,
} from "./schema.ts";

export type ProviderName = z.infer<typeof ProviderNameSchema>;
export type ChatRole = z.infer<typeof ChatRoleSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;
export type ProviderModelInfo = z.infer<typeof ProviderModelInfoSchema>;
export type ProviderQuotaInfo = z.infer<typeof ProviderQuotaInfoSchema>;
export type ProviderCatalogResponse = z.infer<typeof ProviderCatalogResponseSchema>;
export type RagStatusResponse = z.infer<typeof RagStatusResponseSchema>;
export type RagReindexResponse = z.infer<typeof RagReindexResponseSchema>;
export type RagSearchResponse = z.infer<typeof RagSearchResponseSchema>;

export type FormFieldContext = z.infer<typeof FormFieldContextSchema>;
export type FormSuggestRequest = z.infer<typeof FormSuggestRequestSchema>;
export type FormSuggestResponse = z.infer<typeof FormSuggestResponseSchema>;

export type SelectedField = z.infer<typeof SelectedFieldSchema>;
export type SelectedScope = z.infer<typeof SelectedScopeSchema>;
export type FillSelectedElementInput = z.infer<typeof FillSelectedElementInputSchema>;
export type FillCommandMessage = z.infer<typeof FillCommandMessageSchema>;
export type FillCommandResponse = z.infer<typeof FillCommandResponseSchema>;

export interface HealthResponse {
  status: string;
  ts: string;
}
