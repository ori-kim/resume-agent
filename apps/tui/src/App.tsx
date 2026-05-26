import { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';

import { resolvedServerUrl } from './env.js';
import type {
  ChatMessage,
  HealthResponse,
  ProviderCatalogResponse,
  ProviderName,
} from '@resumagent/shared';
import { streamChat, type StreamEvent } from './api/chatClient.js';
import { fetchHealth } from './api/healthClient.js';
import { fetchProviderCatalog } from './api/providerClient.js';

const STREAM_FLUSH_INTERVAL_MS = 80;
const MAX_HISTORY_LENGTH = 80;
const MAX_MODEL_LINES = 10;

type UiMessage = ChatMessage & { id: number; at: string };

interface AsyncState<T> {
  loading: boolean;
  data: T | null;
  error: string | null;
}

function normalizeModelId(modelId: string) {
  return modelId.replace(/^models\//, '');
}

function shorten(text: string, max = 120) {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max)}...`;
}

function nowTime() {
  return new Date().toTimeString().slice(0, 8);
}

function ChatInput({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (disabled) {
      setValue('');
    }
  }, [disabled]);

  if (disabled) {
    return <Text color="gray">generating...</Text>;
  }

  return (
    <TextInput
      value={value}
      onChange={setValue}
      onSubmit={async (next) => {
        await onSubmit(next);
        setValue('');
      }}
      placeholder="메시지를 입력하세요"
    />
  );
}

export function App() {
  const { exit } = useApp();

  const [history, setHistory] = useState<UiMessage[]>([]);
  const [assistantDraft, setAssistantDraft] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('initializing...');

  const [selectedProvider, setSelectedProvider] =
    useState<ProviderName | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [showModelList, setShowModelList] = useState(false);

  const [health, setHealth] = useState<AsyncState<Pick<HealthResponse, 'status'>>>({
    loading: true,
    data: null,
    error: null,
  });

  const [catalog, setCatalog] = useState<AsyncState<ProviderCatalogResponse>>({
    loading: true,
    data: null,
    error: null,
  });

  const [tokenBuffer, setTokenBuffer] = useState('');

  const [nextId, setNextId] = useState(1);

  const assistantDraftRef = useRef('');
  const tokenBufferRef = useRef('');

  const pushMessage = (role: ChatMessage['role'], content: string) => {
    const id = nextId;
    setNextId((prev) => prev + 1);

    setHistory((prev) => {
      const next = [
        ...prev,
        {
          id,
          role,
          content,
          at: nowTime(),
        },
      ];

      if (next.length <= MAX_HISTORY_LENGTH) {
        return next;
      }

      return next.slice(next.length - MAX_HISTORY_LENGTH);
    });
  };

  const toChatMessages = (messages: UiMessage[]): ChatMessage[] =>
    messages.map(({ role, content }) => ({ role, content }));

  useEffect(() => {
    if (!tokenBuffer) {
      return;
    }

    const timer = setTimeout(() => {
      setAssistantDraft((prev) => {
        const next = prev + tokenBuffer;
        assistantDraftRef.current = next;
        return next;
      });

      setTokenBuffer('');
      tokenBufferRef.current = '';
    }, STREAM_FLUSH_INTERVAL_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [tokenBuffer]);

  const refreshHealth = async () => {
    setHealth((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const info = await fetchHealth(resolvedServerUrl);
      setHealth({ loading: false, data: info, error: null });
      return info;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      setHealth({ loading: false, data: null, error: message });
      return null;
    }
  };

  const refreshCatalog = async (options: {
    provider: ProviderName;
    model?: string;
  }) => {
    setCatalog((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const info = await fetchProviderCatalog(resolvedServerUrl, options);
      setCatalog({ loading: false, data: info, error: null });
      return info;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      setCatalog({ loading: false, data: null, error: message });
      return null;
    }
  };

  const resolveProviderFromArg = (arg: string): ProviderName | null => {
    const value = arg.trim().toLowerCase();
    if (value === 'codex' || value === 'ollama') {
      return value;
    }
    return null;
  };

  const resolveModelFromArg = (arg: string) => {
    const data = catalog.data;
    if (!data) {
      return null;
    }

    const trimmed = arg.trim();
    if (!trimmed) {
      return null;
    }

    const byIndex = Number(trimmed);
    if (Number.isInteger(byIndex)) {
      const index = byIndex - 1;
      if (index >= 0 && index < data.models.length) {
        return data.models[index].id;
      }
    }

    const normalized = normalizeModelId(trimmed);
    const byId = data.models.find((model) => model.id === normalized);
    return byId?.id ?? null;
  };

  useEffect(() => {
    const bootstrap = async () => {
      const healthInfo = await refreshHealth();

      if (!healthInfo) {
        setStatus('health 조회 실패: 서버/API 상태를 확인하세요.');
        return;
      }

      // health 성공 후 기본 provider(ollama)로 catalog 조회
      const defaultProvider: ProviderName = 'ollama';
      setSelectedProvider(defaultProvider);

      const catalogInfo = await refreshCatalog({
        provider: defaultProvider,
      });

      if (!catalogInfo) {
        setStatus('provider 정보 조회 실패. /models 로 재시도하세요.');
        setShowModelList(true);
        return;
      }

      const initialModel =
        catalogInfo.activeModel ?? catalogInfo.models[0]?.id ?? null;
      setSelectedModel(initialModel);
      setShowModelList(false);
      setStatus(
        initialModel
          ? `ready · provider=${catalogInfo.provider} model=${initialModel}`
          : 'ready · 모델을 /use 로 선택하세요.',
      );
    };

    void bootstrap();
  }, []);

  const handleSubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) {
      return;
    }

    if (trimmed === '/exit') {
      exit();
      return;
    }

    if (trimmed === '/clear') {
      setHistory([]);
      setAssistantDraft('');
      setTokenBuffer('');
      assistantDraftRef.current = '';
      tokenBufferRef.current = '';
      setStatus('history cleared');
      return;
    }

    if (trimmed === '/providers') {
      setStatus('providers: codex, ollama');
      return;
    }

    if (trimmed.startsWith('/provider')) {
      const arg = trimmed.replace('/provider', '').trim();
      const nextProvider = resolveProviderFromArg(arg);

      if (!nextProvider) {
        setStatus('usage: /provider codex | ollama');
        return;
      }

      setSelectedProvider(nextProvider);
      setSelectedModel(null);
      setShowModelList(true);

      const info = await refreshCatalog({ provider: nextProvider });
      if (!info) {
        setStatus(`provider 전환 실패: ${nextProvider}`);
        return;
      }

      const nextModel = info.activeModel ?? info.models[0]?.id ?? null;
      setSelectedModel(nextModel);
      setShowModelList(false);
      setStatus(
        nextModel
          ? `provider switched: ${nextProvider} / ${nextModel}`
          : `provider switched: ${nextProvider} (모델 선택 필요)`,
      );
      return;
    }

    if (trimmed === '/models') {
      if (!selectedProvider) {
        setStatus('먼저 /provider <name> 으로 provider를 선택하세요.');
        return;
      }

      const info = await refreshCatalog({
        provider: selectedProvider,
        model: selectedModel ?? undefined,
      });

      if (info) {
        setShowModelList((prev) => !prev);
        setStatus(`models refreshed (count=${info.models.length})`);
      } else {
        setStatus('models refresh failed');
      }
      return;
    }

    if (trimmed === '/health') {
      const healthInfo = await refreshHealth();
      if (healthInfo) {
        setStatus(`health ok (status=${healthInfo.status})`);
      } else {
        setStatus('health failed');
      }
      return;
    }

    if (trimmed.startsWith('/use')) {
      const arg = trimmed.replace('/use', '').trim();
      const nextModel = resolveModelFromArg(arg);

      if (!nextModel) {
        setStatus('usage: /use <번호|model-id>');
        return;
      }

      setSelectedModel(nextModel);
      setShowModelList(false);

      if (selectedProvider) {
        await refreshCatalog({ provider: selectedProvider, model: nextModel });
      }

      setStatus(`model selected: ${nextModel}`);
      return;
    }

    if (!selectedProvider || !selectedModel) {
      setStatus('provider/model이 선택되지 않았습니다. /provider, /use를 먼저 실행하세요.');
      return;
    }

    const userMessage: ChatMessage = {
      role: 'user',
      content: trimmed,
    };

    const requestMessages = [...toChatMessages(history), userMessage];

    pushMessage('user', trimmed);
    setAssistantDraft('');
    setTokenBuffer('');
    assistantDraftRef.current = '';
    tokenBufferRef.current = '';
    setIsLoading(true);
    setStatus(`thinking... ${selectedProvider}/${selectedModel}`);

    let streamErrorMessage: string | null = null;

    try {
      await streamChat({
        serverUrl: resolvedServerUrl,
        provider: selectedProvider,
        model: selectedModel,
        messages: requestMessages,
        onEvent: (event: StreamEvent) => {
          if (event.type === 'token' && event.token) {
            setTokenBuffer((prev) => {
              const next = prev + event.token;
              tokenBufferRef.current = next;
              return next;
            });
            return;
          }

          if (event.type === 'end') {
            setStatus('done');
            return;
          }

          if (event.type === 'error' && event.error) {
            streamErrorMessage = event.error;
            setStatus(`error: ${shorten(event.error, 110)}`);
          }
        },
      });
    } catch (error) {
      streamErrorMessage =
        error instanceof Error ? error.message : '알 수 없는 오류';
      setStatus(`error: ${shorten(streamErrorMessage, 110)}`);
    } finally {
      setIsLoading(false);

      const finalDraft = `${assistantDraftRef.current}${tokenBufferRef.current}`.trim();

      if (streamErrorMessage) {
        pushMessage('assistant', `[error] ${streamErrorMessage}`);
      } else if (finalDraft.length > 0) {
        pushMessage('assistant', finalDraft);
      } else {
        setStatus('empty response');
      }

      setAssistantDraft('');
      setTokenBuffer('');
      assistantDraftRef.current = '';
      tokenBufferRef.current = '';
    }
  };

  const healthText = health.loading
    ? 'health:...'
    : health.error
      ? `health:err`
      : `health:ok`;

  const quotaText = catalog.loading
    ? 'quota:...'
    : catalog.error
      ? 'quota:err'
      : `quota:${catalog.data?.quota.status ?? 'unknown'}`;

  const quotaMessage = catalog.data?.quota.message ?? catalog.error ?? '-';

  const modelItems = catalog.data?.models ?? [];
  const visibleModels = modelItems.slice(0, MAX_MODEL_LINES);

  const terminalRows = process.stdout.rows ?? 30;
  const reservedRows = showModelList ? 18 + visibleModels.length : 14;
  const maxVisibleHistory = Math.max(4, terminalRows - reservedRows);
  const visibleHistory = history.slice(-maxVisibleHistory);

  const providerSummary = selectedProvider ?? '-';
  const modelSummary = selectedModel ?? '-';

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>
        resume-agent ▸ {providerSummary} / {modelSummary}
      </Text>
      <Text dimColor>
        {healthText} · {quotaText} · {shorten(quotaMessage, 80)}
      </Text>
      <Text dimColor>
        cmds: /providers /provider /models /use /health /clear /exit
      </Text>

      {showModelList ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">models</Text>
          {visibleModels.map((model, index) => (
            <Text key={model.id}>
              {String(index + 1).padStart(2, ' ')}. {model.id}
              {selectedModel === model.id ? '  ←' : ''}
            </Text>
          ))}
          {modelItems.length > MAX_MODEL_LINES ? (
            <Text dimColor>... +{modelItems.length - MAX_MODEL_LINES} more</Text>
          ) : null}
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        {visibleHistory.length === 0 && !assistantDraft && !tokenBuffer ? (
          <Text color="gray">대화를 시작하세요.</Text>
        ) : null}

        <Static items={visibleHistory}>
          {(message) => (
            <Text key={message.id}>
              <Text dimColor>[{message.at}]</Text>{' '}
              <Text color={message.role === 'user' ? 'cyan' : 'white'}>
                {message.role === 'user' ? 'You >' : 'Agent >'}
              </Text>{' '}
              {message.content}
            </Text>
          )}
        </Static>

        {assistantDraft || tokenBuffer ? (
          <Text>
            <Text dimColor>[{nowTime()}]</Text>{' '}
            <Text color="white">Agent &gt;</Text> {assistantDraft}
            {tokenBuffer}
          </Text>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text color="cyan">status</Text>
        <Text>: {shorten(isLoading ? 'streaming...' : status, 140)}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color="cyan">› </Text>
        <ChatInput disabled={isLoading} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}
