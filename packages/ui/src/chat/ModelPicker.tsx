import { useState, useEffect, useRef } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../primitives/dropdown-menu";
import type { ProviderCatalogResponse, ProviderName } from "@resumagent/shared";

interface Props {
  provider: string;
  model: string;
  onProviderChange: (p: string) => void;
  onModelChange: (m: string) => void;
  fetchCatalog: (p: ProviderName) => Promise<ProviderCatalogResponse>;
}

type Catalogs = Partial<Record<ProviderName, ProviderCatalogResponse>>;

const PROVIDERS: ProviderName[] = ["ollama", "codex"];

function getProviderLabel(provider: ProviderName) {
  switch (provider) {
    case "codex":
      return "Codex";
    case "ollama":
      return "Ollama";
  }
}

export function ModelPicker({ provider, model, onProviderChange, onModelChange, fetchCatalog }: Props) {
  const [catalogs, setCatalogs] = useState<Catalogs>({});
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  async function loadCatalogs(isInitial = false) {
    if (isInitial) setLoading(true);
    const results = await Promise.allSettled(PROVIDERS.map(fetchCatalog));
    const next: Catalogs = {};
    results.forEach((r, i) => {
      if (r.status === "fulfilled") next[PROVIDERS[i]] = r.value;
    });
    setCatalogs(next);
    if (isInitial) {
      setLoading(false);
      loadedRef.current = true;
    }

    const current = next[provider as ProviderName];
    if (current && !model) {
      const first = current.models[0];
      if (first) onModelChange(first.id);
    }
  }

  useEffect(() => {
    void loadCatalogs(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = catalogs[provider as ProviderName];
    if (current && current.models.length > 0) {
      onModelChange(current.models[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const currentCatalog = catalogs[provider as ProviderName];
  const currentModel = currentCatalog?.models.find((m) => m.id === model);
  const displayLabel = currentModel
    ? `${provider} · ${currentModel.displayName || currentModel.id}`
    : provider;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(v: boolean) => {
        setOpen(v);
        if (v) void loadCatalogs();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-200 transition-colors"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <>
              {displayLabel}
              <ChevronDown className="h-3 w-3" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {PROVIDERS.map((p, idx) => {
          const cat = catalogs[p];
          const blocked = cat?.quota.status === "blocked";
          return (
            <DropdownMenuGroup key={p}>
              {idx > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{getProviderLabel(p)}</DropdownMenuLabel>
              {cat ? (
                cat.models.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    disabled={blocked}
                    onSelect={() => {
                      onProviderChange(p);
                      onModelChange(m.id);
                    }}
                  >
                    <span>{m.displayName || m.id}</span>
                    {blocked && (
                      <span className="ml-auto text-xs text-zinc-400">unavailable</span>
                    )}
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem disabled>
                  <span className="text-zinc-400">로딩 중...</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
