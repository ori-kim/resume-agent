const BACKEND_URL = "http://127.0.0.1:8080";

export default defineBackground(() => {
  function openSidePanel(tabId: number) {
    chrome.sidePanel.open({ tabId }).catch((err) => {
      console.warn("[background] sidePanel.open failed", err);
    });
  }

  function togglePicker(tabId: number) {
    chrome.tabs.sendMessage(tabId, { type: "picker:toggle" }, () => {
      // content script가 없는 탭에서는 lastError만 소비하고 조용히 무시한다.
      void chrome.runtime.lastError;
    });
  }

  chrome.action.onClicked.addListener((tab) => {
    if (tab.id == null) return;
    openSidePanel(tab.id);
  });

  chrome.sidePanel.setOptions({ enabled: true });

  // 글로벌 단축키(Cmd/Ctrl+Shift+E) → 사이드패널 열기 + 활성 탭 picker 토글
  chrome.commands.onCommand.addListener((command) => {
    if (command !== "toggle-picker") return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId == null) return;
      openSidePanel(tabId);
      togglePicker(tabId);
    });
  });

  // content script → background → storage.local → sidepanel onChanged
  // chrome.runtime.sendMessage는 service worker sleep 시 sidepanel 미도달.
  // background에서 storage.local.set하면 sidepanel의 storage.onChanged가 항상 수신.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!sender.tab) return;
    if (message?.type !== "picker:event") return;
    const payload = message.payload as Record<string, unknown>;
    console.log("[background] picker:event", payload.type, "from tab", sender.tab.id);
    chrome.storage.local
      .set({ ra_picker_event: payload })
      .catch((err) => console.error("[background] storage.local.set failed", err));
  });

  // content script는 공개 https:// 오리진에서 실행되어 localhost fetch가
  // Chrome의 Private Network Access 정책으로 차단됨.
  // background service worker는 특권 컨텍스트라 localhost에 자유롭게 접근 가능.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "form:suggest") return;
    fetch(`${BACKEND_URL}/form/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldContext: message.fieldContext }),
    })
      .then(async (res) => {
        if (!res.ok) { sendResponse({ ok: false }); return; }
        const data = await res.json() as unknown;
        sendResponse({ ok: true, data });
      })
      .catch(() => sendResponse({ ok: false }));
    return true; // async sendResponse
  });

  console.log("[background] resume-agent extension started");
});
