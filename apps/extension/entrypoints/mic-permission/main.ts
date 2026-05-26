interface MicrophonePermissionResult {
  ok: boolean;
  error?: string;
  timestamp: number;
}

const params = new URLSearchParams(window.location.search);
const requestId = params.get("requestId");
const storageKey = requestId ? `ra_mic_permission_${requestId}` : null;
const button = document.getElementById("request-button") as HTMLButtonElement | null;
const statusEl = document.getElementById("status");

function setStatus(message: string, tone: "neutral" | "ok" | "error" = "neutral") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = `status${tone === "neutral" ? "" : ` ${tone}`}`;
}

function permissionErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      return "Chrome 마이크 권한이 차단되었습니다. 권한을 허용한 뒤 다시 시도해주세요.";
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "마이크를 찾을 수 없습니다.";
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "마이크를 사용할 수 없습니다.";
    }
  }

  return error instanceof Error ? error.message : "마이크 권한 요청에 실패했습니다.";
}

async function publishResult(result: Omit<MicrophonePermissionResult, "timestamp">) {
  if (!storageKey) return;
  await chrome.storage.local.set({
    [storageKey]: {
      ...result,
      timestamp: Date.now(),
    },
  });
}

async function requestMicrophone(publishError: boolean) {
  if (!navigator.mediaDevices?.getUserMedia) {
    const error = "이 브라우저는 마이크 권한 요청을 지원하지 않습니다.";
    setStatus(error, "error");
    await publishResult({ ok: false, error });
    return;
  }

  if (button) button.disabled = true;
  setStatus("Chrome 권한 요청 창을 확인해주세요.");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    setStatus("마이크 권한이 허용되었습니다.", "ok");
    await publishResult({ ok: true });
    window.setTimeout(() => window.close(), 350);
  } catch (error) {
    const message = permissionErrorMessage(error);
    setStatus(message, "error");
    if (button) button.disabled = false;
    if (publishError) await publishResult({ ok: false, error: message });
  }
}

button?.addEventListener("click", () => {
  void requestMicrophone(true);
});

void requestMicrophone(false);
