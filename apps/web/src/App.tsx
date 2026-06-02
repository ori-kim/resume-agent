import { useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Button, MessageList, Composer } from "@resumagent/ui";
import type { ProviderName, ProviderCatalogResponse } from "@resumagent/shared";

const BACKEND_URL = "http://127.0.0.1:8080";

async function fetchCatalog(p: ProviderName): Promise<ProviderCatalogResponse> {
  const url = new URL(`${BACKEND_URL}/provider/catalog`);
  url.searchParams.set("provider", p);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
  return res.json() as Promise<ProviderCatalogResponse>;
}

async function reindex(): Promise<void> {
  await fetch(`${BACKEND_URL}/rag/reindex`, { method: "POST" });
}

function filesToFileList(files: File[]): FileList | undefined {
  if (files.length === 0) return undefined;
  const dataTransfer = new DataTransfer();
  files.forEach((file) => dataTransfer.items.add(file));
  return dataTransfer.files;
}

export default function App() {
  const [provider, setProvider] = useState("ollama");
  const [model, setModel] = useState("");

  const stateRef = useRef({ provider, model });
  stateRef.current = { provider, model };

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${BACKEND_URL}/chat`,
        body: () => ({ provider: stateRef.current.provider, model: stateRef.current.model }),
      }),
    []
  );

  const { messages, sendMessage, status, error, setMessages } = useChat({ transport });

  function onSend(text: string, _scopes: unknown[], files: File[]) {
    sendMessage({ text, files: filesToFileList(files) });
  }

  const isLoading = status === "submitted" || status === "streaming";

  return (
    <main className="flex h-dvh flex-col bg-white text-zinc-900">
      <header className="shrink-0 border-b border-zinc-200">
        <div className="flex h-12 items-center w-full max-w-3xl mx-auto px-6">
          <span className="text-sm font-semibold text-zinc-900">resume-agent</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-zinc-500"
            onClick={() => setMessages([])}
          >
            Clear
          </Button>
        </div>
      </header>
      {error && (
        <div className="shrink-0 w-full max-w-3xl mx-auto px-6 pt-2">
          <div className="rounded-full bg-red-50 border border-red-200 px-4 py-1.5 text-xs text-red-600">
            {error.message}
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col min-h-full w-full max-w-3xl mx-auto">
          <MessageList messages={messages} status={status} />
        </div>
      </div>
      <div className="shrink-0 border-t border-zinc-100">
        <div className="w-full max-w-3xl mx-auto">
          <Composer
            onSend={onSend}
            disabled={isLoading}
            provider={provider}
            model={model}
            onProviderChange={setProvider}
            onModelChange={setModel}
            fetchCatalog={fetchCatalog}
            onReindex={reindex}
          />
        </div>
      </div>
    </main>
  );
}
