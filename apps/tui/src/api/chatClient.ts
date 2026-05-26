import type { ChatMessage, ProviderName } from '@resumagent/shared';
import { createClient } from '@resumagent/api-client';

export interface StreamEvent {
  type: 'token' | 'end' | 'error';
  token?: string;
  error?: string;
}

interface UIMessagePart {
  type: 'text';
  text: string;
}

interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: UIMessagePart[];
}

interface StreamChatParams {
  serverUrl: string;
  provider: ProviderName;
  model: string;
  messages: ChatMessage[];
  onEvent: (event: StreamEvent) => void;
}

function chatMessagesToUIMessages(messages: ChatMessage[]): UIMessage[] {
  return messages.map((m, i) => ({
    id: String(i),
    role: m.role as UIMessage['role'],
    parts: [{ type: 'text' as const, text: m.content }],
  }));
}

interface UIMessageStreamChunk {
  type: string;
  delta?: string;
  errorText?: string;
}

function parseAIStreamChunk(payload: string): string | null {
  if (payload === '[DONE]') return null;
  try {
    const chunk = JSON.parse(payload) as UIMessageStreamChunk;
    if (chunk.type === 'text-delta' && chunk.delta) {
      return chunk.delta;
    }
    return null;
  } catch {
    return null;
  }
}

export async function streamChat({
  serverUrl,
  provider,
  model,
  messages,
  onEvent,
}: StreamChatParams) {
  const client = createClient(serverUrl);
  const chatUrl = client.chat.$url();

  const uiMessages = chatMessagesToUIMessages(messages);

  const response = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ provider, model, messages: uiMessages }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`채팅 요청 실패 (${response.status}): ${errorText}`);
  }

  if (!response.body) {
    throw new Error('스트리밍 응답 바디가 없습니다.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;

      // SSE data line
      if (trimmed.startsWith('data: ')) {
        const payload = trimmed.slice(6);
        const token = parseAIStreamChunk(payload);
        if (token !== null) {
          onEvent({ type: 'token', token });
        }
      }
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data: ')) {
      const token = parseAIStreamChunk(trimmed.slice(6));
      if (token !== null) onEvent({ type: 'token', token });
    }
  }

  onEvent({ type: 'end' });
}
