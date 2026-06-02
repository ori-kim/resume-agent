import { useEffect, useRef, useState } from "react";
import { ArrowUp, ImagePlus, Mic, RefreshCw, X, Square } from "lucide-react";
import { Button } from "../primitives/button";
import { cn } from "../lib/utils";
import { ModelPicker } from "./ModelPicker";
import type { ProviderCatalogResponse, ProviderName, SelectedScope } from "@resumagent/shared";
import {
  getAcceptedImageFiles,
  imageAttachmentId,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS,
} from "./imageAttachments";

interface Props {
  onSend: (text: string, scopes: SelectedScope[], files: File[]) => void;
  onStop?: () => void;
  disabled: boolean;
  provider: string;
  model: string;
  onProviderChange: (p: string) => void;
  onModelChange: (m: string) => void;
  fetchCatalog: (p: ProviderName) => Promise<ProviderCatalogResponse>;
  onReindex?: () => Promise<void>;
  scopes?: SelectedScope[];
  onRemoveScope?: (scopeId: string) => void;
  onRequestMicrophonePermission?: () => Promise<void>;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike | undefined;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike | undefined;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message?: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  abort: () => void;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as SpeechRecognitionWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function appendVoiceText(baseText: string, transcript: string): string {
  const trimmedTranscript = transcript.trimStart();
  if (!trimmedTranscript) return baseText;
  const separator = baseText.trim().length > 0 && !/\s$/.test(baseText) ? " " : "";
  return `${baseText}${separator}${trimmedTranscript}`;
}

function voiceErrorMessage(error: string, message?: string): string {
  if (error === "not-allowed" || error === "service-not-allowed") return "마이크 권한이 필요합니다";
  if (error === "audio-capture") return "마이크를 찾을 수 없습니다";
  if (error === "no-speech") return "음성이 감지되지 않았습니다";
  return message || "음성 입력을 시작할 수 없습니다";
}

function microphonePermissionErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      return "Chrome 마이크 권한을 허용한 뒤 다시 눌러주세요";
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "마이크를 찾을 수 없습니다";
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "마이크를 사용할 수 없습니다";
    }
  }

  return error instanceof Error ? error.message : "마이크 권한을 요청할 수 없습니다";
}

function ImageAttachmentPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  return (
    <div
      className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-zinc-200 bg-white"
      title={file.name}
    >
      {url && (
        <img
          src={url}
          alt={file.name}
          className="h-full w-full object-cover"
        />
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-90 transition-opacity hover:bg-black"
        aria-label="이미지 첨부 제거"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

async function requestBrowserMicrophonePermission(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("이 브라우저는 마이크 권한 요청을 지원하지 않습니다");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}

export function Composer({
  onSend,
  onStop,
  disabled,
  provider,
  model,
  onProviderChange,
  onModelChange,
  fetchCatalog,
  onReindex,
  scopes = [],
  onRemoveScope,
  onRequestMicrophonePermission,
}: Props) {
  const [text, setText] = useState("");
  const [reindexing, setReindexing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [requestingMicPermission, setRequestingMicPermission] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceBaseTextRef = useRef("");
  const requestingMicPermissionRef = useRef(false);

  function autoGrow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  function autoGrowSoon() {
    window.requestAnimationFrame(autoGrow);
  }

  function detachRecognitionHandlers(recognition: SpeechRecognitionLike) {
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
  }

  function abortListening(updateState = true) {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    detachRecognitionHandlers(recognition);
    recognition.abort();
    recognitionRef.current = null;
    if (updateState) setIsListening(false);
  }

  function submit() {
    const trimmed = text.trim();
    if ((!trimmed && imageFiles.length === 0) || disabled || !model) return;
    abortListening();
    onSend(trimmed, scopes, imageFiles);
    setText("");
    setImageFiles([]);
    setAttachmentError(null);
    setVoiceError(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  async function handleReindex() {
    if (reindexing || !onReindex) return;
    setReindexing(true);
    try {
      await onReindex();
    } finally {
      setReindexing(false);
    }
  }

  function addImageFiles(files: Iterable<File>) {
    const incoming = Array.from(files);
    const accepted = getAcceptedImageFiles(incoming, { existingCount: imageFiles.length });
    if (accepted.length > 0) {
      setImageFiles((prev) => [...prev, ...accepted]);
    }

    const rejectedCount = incoming.length - accepted.length;
    if (rejectedCount > 0) {
      setAttachmentError(
        `이미지는 최대 ${MAX_IMAGE_ATTACHMENTS}개, 파일당 ${Math.floor(MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024)}MB까지 첨부할 수 있습니다`
      );
    } else {
      setAttachmentError(null);
    }
  }

  function removeImageFile(id: string) {
    setImageFiles((prev) => prev.filter((file) => imageAttachmentId(file) !== id));
    setAttachmentError(null);
  }

  function scopeLabel(scope: SelectedScope): string {
    const base = scope.label || scope.containerTag || (scope.fields[0]?.tagName ?? "element");
    if (scope.kind === "container") {
      return `@${scope.containerTag ?? "div"}·${base} (${scope.fields.length})`;
    }
    const field = scope.fields[0];
    const tag = field?.tagName ?? "input";
    return `@${tag}·${base}`;
  }

  function scopeTitle(scope: SelectedScope): string {
    return scope.fields
      .map((f) => `${f.tagName}${f.label ? `·${f.label}` : ""}${f.placeholder ? ` (${f.placeholder})` : ""}`)
      .join(", ");
  }

  function stopListening() {
    recognitionRef.current?.stop();
  }

  function startVoiceRecognition(): boolean {
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      setVoiceError("이 브라우저는 음성 입력을 지원하지 않습니다");
      return false;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "ko-KR";
    voiceBaseTextRef.current = text;
    setVoiceError(null);

    recognition.onresult = (event) => {
      let finalTranscript = "";
      let interimTranscript = "";

      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript ?? "";
        if (result?.isFinal) finalTranscript += transcript;
        else interimTranscript += transcript;
      }

      setText(appendVoiceText(voiceBaseTextRef.current, `${finalTranscript}${interimTranscript}`));
      autoGrowSoon();
    };

    recognition.onerror = (event) => {
      setVoiceError(voiceErrorMessage(event.error, event.message));
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
    } catch (error) {
      recognitionRef.current = null;
      setIsListening(false);
      setVoiceError(error instanceof Error ? error.message : "음성 입력을 시작할 수 없습니다");
      return false;
    }

    return true;
  }

  async function requestMicrophonePermission(): Promise<boolean> {
    requestingMicPermissionRef.current = true;
    setRequestingMicPermission(true);
    setVoiceError(null);

    try {
      await (onRequestMicrophonePermission ?? requestBrowserMicrophonePermission)();
      return true;
    } catch (error) {
      setVoiceError(microphonePermissionErrorMessage(error));
      return false;
    } finally {
      requestingMicPermissionRef.current = false;
      setRequestingMicPermission(false);
    }
  }

  async function toggleVoiceInput() {
    if (isListening) {
      stopListening();
      return;
    }

    if (requestingMicPermissionRef.current) return;

    const hasMicPermission = await requestMicrophonePermission();
    if (!hasMicPermission) return;
    startVoiceRecognition();
  }

  useEffect(() => {
    return () => {
      abortListening(false);
    };
  }, []);

  return (
    <div className="shrink-0 px-4 pb-6 pt-2">
      <div
        className="rounded-2xl border border-zinc-200 bg-zinc-100 p-2 shadow-sm"
        onDrop={(event) => {
          event.preventDefault();
          addImageFiles(event.dataTransfer.files);
        }}
        onDragOver={(event) => {
          event.preventDefault();
        }}
      >
        {scopes.length > 0 && (
          <div className="flex flex-wrap gap-1 px-2 pb-1 pt-1">
            {scopes.map((scope) => (
              <span
                key={scope.scopeId}
                title={scopeTitle(scope)}
                className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700"
              >
                {scopeLabel(scope)}
                {onRemoveScope && (
                  <button
                    type="button"
                    onClick={() => onRemoveScope(scope.scopeId)}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-blue-200"
                    aria-label="참조 제거"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder="무엇이든 물어보세요"
          className="w-full resize-none bg-transparent px-2 py-2 text-sm text-zinc-900 placeholder:text-zinc-500 focus:outline-none"
          onChange={(e) => {
            setText(e.target.value);
            autoGrow();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(event) => {
            const files = event.clipboardData.files;
            if (files.length > 0) addImageFiles(files);
          }}
        />
        {imageFiles.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-2 pb-2">
            {imageFiles.map((file) => {
              const id = imageAttachmentId(file);
              return (
                <ImageAttachmentPreview
                  key={id}
                  file={file}
                  onRemove={() => removeImageFile(id)}
                />
              );
            })}
          </div>
        )}
        {voiceError && (
          <div className="px-2 pb-1 text-xs text-red-600">
            {voiceError}
          </div>
        )}
        {attachmentError && (
          <div className="px-2 pb-1 text-xs text-amber-600">
            {attachmentError}
          </div>
        )}
        <div className="flex items-center gap-1 px-1">
          {onReindex && (
            <button
              type="button"
              onClick={() => void handleReindex()}
              title="RAG 재인덱스"
              className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 transition-colors"
            >
              <RefreshCw className={cn("h-4 w-4", reindexing && "animate-spin")} />
            </button>
          )}
          <ModelPicker
            provider={provider}
            model={model}
            onProviderChange={onProviderChange}
            onModelChange={onModelChange}
            fetchCatalog={fetchCatalog}
          />
          <span className="flex-1" />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.currentTarget.files) addImageFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || imageFiles.length >= MAX_IMAGE_ATTACHMENTS}
            aria-label="이미지 첨부"
            title="이미지 첨부"
            className="rounded-full p-2 text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={toggleVoiceInput}
            disabled={requestingMicPermission}
            aria-label={isListening ? "음성 입력 중지" : requestingMicPermission ? "마이크 권한 요청 중" : "음성 입력"}
            aria-pressed={isListening}
            title={isListening ? "음성 입력 중지" : requestingMicPermission ? "마이크 권한 요청 중" : "음성 입력"}
            className={cn(
              "rounded-full p-2 transition-colors disabled:cursor-wait",
              isListening
                ? "bg-red-100 text-red-600 shadow-[0_0_0_3px_rgba(220,38,38,0.12)]"
                : requestingMicPermission
                  ? "bg-amber-100 text-amber-700"
                : "text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800"
            )}
          >
            <Mic className={cn("h-4 w-4", (isListening || requestingMicPermission) && "animate-pulse")} />
          </button>
          {disabled && onStop ? (
            <Button
              type="button"
              size="icon"
              onClick={onStop}
              className="h-8 w-8 rounded-full bg-zinc-900 text-white hover:bg-red-600 transition-colors"
              title="생성 중단"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              onClick={submit}
              disabled={(!text.trim() && imageFiles.length === 0) || disabled || !model}
              className="h-8 w-8 rounded-full bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
