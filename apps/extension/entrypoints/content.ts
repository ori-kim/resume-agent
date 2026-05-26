import type { FormFieldContext, FormSuggestResponse, SelectedField, SelectedScope } from "@resumagent/shared";

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    const w = window as Window & { __raLoaded?: boolean; __raCleanup?: () => void };
    // extension reload 후 재주입 시 이전 인스턴스 정리
    w.__raCleanup?.();
    if (w.__raLoaded) return;
    w.__raLoaded = true;

    const DEBOUNCE_MS = 300;
    const AGENT_BROWSER_ACTIVITY_PULSE_MS = 300;
    const IGNORE_TYPES = new Set(["submit", "button", "reset", "hidden", "file", "checkbox", "radio"]);
    const MIN_QUERY_LENGTH = 2;

    let lastFocusedEl: HTMLElement | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let agentBrowserActivityOverlay: HTMLDivElement | null = null;
    let agentBrowserActivityStyle: HTMLStyleElement | null = null;
    let agentBrowserActivityTimer: ReturnType<typeof setTimeout> | null = null;

    // ── Context extraction ──────────────────────────────────────────────────

    function getSelectorSegment(el: HTMLElement): string {
      const tag = el.tagName.toLowerCase();
      if (el.id) return `${tag}#${CSS.escape(el.id)}`;

      let seg = tag;
      const classes = Array.from(el.classList)
        .filter(Boolean)
        .slice(0, 3)
        .map((c) => `.${CSS.escape(c)}`)
        .join("");
      seg += classes;

      const parent = el.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(
          (child) => child.tagName === el.tagName,
        );
        if (sameTagSiblings.length > 1) {
          seg += `:nth-of-type(${sameTagSiblings.indexOf(el) + 1})`;
        }
      }

      return seg;
    }

    function isUniqueSelector(selector: string, el: HTMLElement): boolean {
      try {
        const matches = Array.from(document.querySelectorAll<HTMLElement>(selector));
        return matches.length === 1 && matches[0] === el;
      } catch {
        return false;
      }
    }

    function getCssPath(el: HTMLElement): string {
      if (el.id) return `#${CSS.escape(el.id)}`;

      const parts: string[] = [];
      let cur: HTMLElement | null = el;
      while (cur && cur !== document.documentElement) {
        parts.unshift(getSelectorSegment(cur));
        const candidate = parts.join(" > ");
        if (isUniqueSelector(candidate, el)) return candidate;
        cur = cur.parentElement;
      }

      return parts.join(" > ");
    }

    function resolveFillTarget(elementId: string): HTMLElement | null {
      const selectors = [
        elementId,
        elementId.replace(/^…\s*>\s*/, ""),
      ].filter((selector, index, all) => selector && all.indexOf(selector) === index);

      for (const selector of selectors) {
        try {
          const el = document.querySelector<HTMLElement>(selector);
          if (el) return el;
        } catch {
          // ignore invalid selectors and try fallbacks
        }
      }

      if (!elementId.startsWith("#")) {
        try {
          return document.querySelector<HTMLElement>(`#${CSS.escape(elementId)}`);
        } catch {
          return null;
        }
      }

      return null;
    }

    function getLabel(el: HTMLElement): string {
      if (el.id) {
        const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
        if (label?.textContent) return label.textContent.trim();
      }
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return ariaLabel.trim();
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl?.textContent) return labelEl.textContent.trim();
      }
      const parentLabel = el.closest("label");
      if (parentLabel?.textContent) return parentLabel.textContent.trim();
      return "";
    }

    function getPrecedingHeading(el: HTMLElement): string {
      const container = el.closest("form, section, [role='group'], body") ?? document.body;
      const headings = Array.from(container.querySelectorAll("h1,h2,h3,h4,legend"));
      let best = "";
      for (const h of headings) {
        if (el.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING) {
          best = (h.textContent ?? "").trim();
        }
      }
      return best;
    }

    function getFieldsetLegend(el: HTMLElement): string {
      const fieldset = el.closest("fieldset");
      if (!fieldset) return "";
      const legend = fieldset.querySelector("legend");
      return (legend?.textContent ?? "").trim();
    }

    function extractContext(el: HTMLElement): FormFieldContext {
      const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      return {
        label: getLabel(el) || undefined,
        ariaLabel: el.getAttribute("aria-label") ?? undefined,
        placeholder: (input as HTMLInputElement).placeholder ?? undefined,
        heading: getPrecedingHeading(el) || undefined,
        legend: getFieldsetLegend(el) || undefined,
        fieldType: (input as HTMLInputElement).type ?? undefined,
      };
    }

    function hasEnoughContext(ctx: FormFieldContext): boolean {
      const combined = [ctx.label, ctx.ariaLabel, ctx.placeholder, ctx.heading, ctx.legend]
        .filter(Boolean)
        .join(" ");
      return combined.trim().length >= MIN_QUERY_LENGTH;
    }

    // ── Controlled input fill ───────────────────────────────────────────────

    function fillField(el: HTMLElement, value: string): void {
      const tag = el.tagName.toLowerCase();

      if (tag === "input" || tag === "textarea") {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
          "value",
        )?.set;

        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, value);
        } else {
          (el as HTMLInputElement).value = value;
        }

        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (tag === "select") {
        const select = el as HTMLSelectElement;
        const matchingOption = Array.from(select.options).find(
          (o) => o.value === value || o.text.toLowerCase().includes(value.toLowerCase()),
        );
        if (matchingOption) {
          select.value = matchingOption.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (el.isContentEditable) {
        el.textContent = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    function flashFilledField(el: HTMLElement): void {
      const previous = {
        borderColor: el.style.borderColor,
        outline: el.style.outline,
        outlineOffset: el.style.outlineOffset,
        boxShadow: el.style.boxShadow,
        transition: el.style.transition,
      };

      el.style.transition = `${previous.transition ? `${previous.transition}, ` : ""}border-color 120ms ease, outline-color 120ms ease, box-shadow 120ms ease`;
      el.style.borderColor = "#3b82f6";
      el.style.outline = "2px solid #3b82f6";
      el.style.outlineOffset = "1px";
      el.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.18)";

      window.setTimeout(() => {
        el.style.borderColor = previous.borderColor;
        el.style.outline = previous.outline;
        el.style.outlineOffset = previous.outlineOffset;
        el.style.boxShadow = previous.boxShadow;
        el.style.transition = previous.transition;
      }, 300);
    }

    function ensureAgentBrowserActivityStyle(): void {
      if (agentBrowserActivityStyle?.isConnected) return;

      const style = document.createElement("style");
      style.setAttribute("data-resumagent-agent-browser-activity-style", "true");
      style.textContent = `
        @keyframes ra-agent-browser-border-pulse {
          0%, 100% {
            border-color: rgba(59, 130, 246, 0.72);
            box-shadow:
              inset 0 0 0 1px rgba(147, 197, 253, 0.48),
              0 0 0 1px rgba(59, 130, 246, 0.20),
              0 0 18px rgba(59, 130, 246, 0.28);
          }
          50% {
            border-color: rgba(96, 165, 250, 1);
            box-shadow:
              inset 0 0 0 1px rgba(191, 219, 254, 0.88),
              0 0 0 2px rgba(59, 130, 246, 0.30),
              0 0 34px rgba(59, 130, 246, 0.48);
          }
        }

        @keyframes ra-agent-browser-dot {
          0%, 100% { transform: scale(0.68); opacity: 0.45; }
          50% { transform: scale(1); opacity: 1; }
        }

        [data-resumagent-agent-browser-activity="true"] {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 2147483647;
          box-sizing: border-box;
          opacity: 0;
          transition: opacity 120ms ease;
        }

        [data-resumagent-agent-browser-activity="true"] .ra-agent-browser-ring {
          position: absolute;
          inset: 2px;
          overflow: hidden;
          border: 3px solid rgba(59, 130, 246, 0.72);
          border-radius: 10px;
          box-sizing: border-box;
          animation: ra-agent-browser-border-pulse 900ms ease-in-out infinite;
        }

        [data-resumagent-agent-browser-activity="true"] .ra-agent-browser-badge {
          position: absolute;
          top: 12px;
          right: 12px;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 28px;
          padding: 0 10px;
          border: 1px solid rgba(147, 197, 253, 0.75);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.82);
          box-shadow: 0 8px 24px rgba(59, 130, 246, 0.18);
          color: #1d4ed8;
          font: 700 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: 0.02em;
          backdrop-filter: blur(8px);
        }

        [data-resumagent-agent-browser-activity="true"] .ra-agent-browser-dot {
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: #3b82f6;
          box-shadow: 0 0 12px rgba(59, 130, 246, 0.85);
          animation: ra-agent-browser-dot 760ms ease-in-out infinite;
        }
      `;
      document.documentElement.appendChild(style);
      agentBrowserActivityStyle = style;
    }

    function ensureAgentBrowserActivityOverlay(): HTMLDivElement {
      if (agentBrowserActivityOverlay?.isConnected) return agentBrowserActivityOverlay;

      ensureAgentBrowserActivityStyle();
      const overlay = document.createElement("div");
      overlay.setAttribute("data-resumagent-agent-browser-activity", "true");
      overlay.innerHTML = `
        <div class="ra-agent-browser-ring"></div>
        <div class="ra-agent-browser-badge">
          <span class="ra-agent-browser-dot"></span>
          <span>AGENT</span>
        </div>
      `;
      document.documentElement.appendChild(overlay);
      agentBrowserActivityOverlay = overlay;
      return overlay;
    }

    function setAgentBrowserActivity(active: boolean, pulseMs = AGENT_BROWSER_ACTIVITY_PULSE_MS): void {
      const overlay = ensureAgentBrowserActivityOverlay();
      if (agentBrowserActivityTimer) {
        clearTimeout(agentBrowserActivityTimer);
        agentBrowserActivityTimer = null;
      }

      overlay.style.opacity = "1";
      overlay.setAttribute("data-active", "true");
      if (active) return;

      agentBrowserActivityTimer = setTimeout(() => {
        overlay.style.opacity = "0";
        overlay.removeAttribute("data-active");
        agentBrowserActivityTimer = null;
      }, Math.max(0, pulseMs));
    }

    function cleanupAgentBrowserActivity(): void {
      if (agentBrowserActivityTimer) {
        clearTimeout(agentBrowserActivityTimer);
        agentBrowserActivityTimer = null;
      }
      agentBrowserActivityOverlay?.remove();
      agentBrowserActivityOverlay = null;
      agentBrowserActivityStyle?.remove();
      agentBrowserActivityStyle = null;
    }

    // ── Backend call (focusin 자동 채움용) ─────────────────────────────────

    async function fetchSuggestion(ctx: FormFieldContext): Promise<FormSuggestResponse | null> {
      // content script는 공개 https:// 오리진 컨텍스트에서 실행되므로
      // localhost fetch가 Chrome PNA 정책으로 차단됨.
      // background service worker를 통해 프록시한다.
      try {
        const response = await chrome.runtime.sendMessage({
          type: "form:suggest",
          fieldContext: ctx,
        }) as { ok: boolean; data?: FormSuggestResponse } | null;
        if (!response?.ok) return null;
        return response.data ?? null;
      } catch {
        return null;
      }
    }

    async function handleFocus(el: HTMLElement): Promise<void> {
      // picker 모드 중엔 자동 채움 건너뜀
      if (pickerActive) return;

      const tag = el.tagName.toLowerCase();
      if (tag === "input") {
        const inputType = (el as HTMLInputElement).type?.toLowerCase() ?? "text";
        if (IGNORE_TYPES.has(inputType)) return;
      } else if (tag !== "textarea" && tag !== "select" && !el.isContentEditable) {
        return;
      }

      const ctx = extractContext(el);
      if (!hasEnoughContext(ctx)) return;

      const suggestion = await fetchSuggestion(ctx);
      if (!suggestion || !suggestion.value) return;

      if (document.activeElement !== el) return;
      const currentVal =
        tag === "input" || tag === "textarea"
          ? (el as HTMLInputElement).value
          : el.textContent ?? "";
      if (currentVal.trim() !== "") return;

      fillField(el, suggestion.value);
    }

    function onFocusIn(e: FocusEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target === lastFocusedEl) return;
      lastFocusedEl = target;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void handleFocus(target);
      }, DEBOUNCE_MS);
    }

    // ── Picker mode ─────────────────────────────────────────────────────────

    let pickerActive = false;

    // 오버레이 DOM (한 번만 생성)
    const overlay = document.createElement("div");
    overlay.setAttribute("data-resumagent-overlay", "true");
    overlay.style.cssText =
      "display:none;position:fixed;pointer-events:none;z-index:2147483647;" +
      "outline:2px solid #3b82f6;background:rgba(59,130,246,0.15);" +
      "border-radius:2px;box-sizing:border-box;" +
      "transition:left 60ms ease-out,top 60ms ease-out,width 60ms ease-out,height 60ms ease-out;";
    const overlayLabel = document.createElement("div");
    overlayLabel.setAttribute("data-resumagent-overlay", "true");
    overlayLabel.style.cssText =
      "position:absolute;top:-22px;left:0;background:#3b82f6;color:#fff;" +
      "font-size:11px;font-family:system-ui,sans-serif;padding:2px 6px;" +
      "border-radius:3px;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;";
    overlay.appendChild(overlayLabel);
    document.documentElement.appendChild(overlay);

    function isOverlayElement(el: Element | null): boolean {
      return !!el && !!el.closest?.("[data-resumagent-overlay]");
    }

    function isFillable(el: HTMLElement): boolean {
      const tag = el.tagName.toLowerCase();
      if (tag === "input") {
        const t = (el as HTMLInputElement).type?.toLowerCase() ?? "text";
        return !IGNORE_TYPES.has(t);
      }
      return tag === "textarea" || tag === "select" || el.isContentEditable;
    }

    function resolveScope(
      el: HTMLElement,
    ): { kind: "field" | "container"; root: HTMLElement; fillables: HTMLElement[] } | null {
      if (isFillable(el)) return { kind: "field", root: el, fillables: [el] };
      if (el === document.body || el === document.documentElement) return null;

      const fillables = Array.from(
        el.querySelectorAll<HTMLElement>(
          "input,textarea,select,[contenteditable='true'],[contenteditable='']",
        ),
      ).filter(isFillable);

      if (fillables.length === 0 || fillables.length > 30) return null;
      return { kind: "container", root: el, fillables };
    }

    function getScopeLabel(rootEl: HTMLElement, kind: "field" | "container"): string {
      if (kind === "field") {
        return (
          getLabel(rootEl) ||
          (rootEl as HTMLInputElement).placeholder ||
          rootEl.tagName.toLowerCase()
        );
      }
      const legend = rootEl.querySelector(":scope legend");
      if (legend?.textContent) return legend.textContent.trim();
      const formName = (rootEl as HTMLFormElement).name || rootEl.getAttribute("name");
      if (formName) return formName;
      const heading = rootEl.querySelector("h1,h2,h3,h4");
      if (heading?.textContent) return heading.textContent.trim();
      return rootEl.tagName.toLowerCase();
    }

    function buildSelectedField(el: HTMLElement): SelectedField {
      const ctx = extractContext(el);
      const tag = el.tagName.toLowerCase();
      // Use real DOM id as CSS selector when available; otherwise fall back to cssPath
      const cssPath = getCssPath(el);
      const id = el.id ? `#${CSS.escape(el.id)}` : cssPath;
      const currentValue =
        tag === "input" || tag === "textarea"
          ? (el as HTMLInputElement).value
          : el.isContentEditable
            ? (el.textContent ?? "")
            : "";
      return {
        id,
        tagName: el.isContentEditable ? "contenteditable" : (tag as SelectedField["tagName"]),
        elementType: (el as HTMLInputElement).type || undefined,
        label: ctx.label,
        ariaLabel: ctx.ariaLabel,
        placeholder: ctx.placeholder,
        heading: ctx.heading,
        legend: ctx.legend,
        name: (el as HTMLInputElement).name || undefined,
        currentValue: currentValue || undefined,
        cssPath,
      };
    }

    function buildScope(
      kind: "field" | "container",
      rootEl: HTMLElement,
      fillables: HTMLElement[],
    ): SelectedScope {
      const scopeId = `scope_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const label = getScopeLabel(rootEl, kind);
      const fields = fillables.map(buildSelectedField);
      return {
        scopeId,
        kind,
        containerTag: kind === "container" ? rootEl.tagName.toLowerCase() : undefined,
        label,
        heading: kind === "container" ? (getPrecedingHeading(rootEl) || undefined) : undefined,
        legend: kind === "container" ? (getFieldsetLegend(rootEl) || undefined) : undefined,
        cssPath: getCssPath(rootEl),
        fields,
      };
    }

    function updateOverlay(
      target: HTMLElement | null,
      scope: ReturnType<typeof resolveScope>,
    ) {
      if (!target || !scope) {
        overlay.style.display = "none";
        return;
      }
      const rect = scope.root.getBoundingClientRect();
      overlay.style.display = "block";
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      const label = getScopeLabel(scope.root, scope.kind);
      const suffix = scope.kind === "container" ? ` (${scope.fillables.length}개 필드)` : "";
      overlayLabel.textContent = `${scope.root.tagName.toLowerCase()}·${label}${suffix}`;

      // 뷰포트 경계 보정: 위쪽 공간 부족하면 box 아래로, 우측 overflow면 왼쪽 정렬
      if (rect.top < 26) {
        overlayLabel.style.top = `${rect.height}px`;
        overlayLabel.style.bottom = "auto";
      } else {
        overlayLabel.style.top = "-22px";
        overlayLabel.style.bottom = "auto";
      }
      const labelRight = rect.left + overlayLabel.offsetWidth;
      if (labelRight > window.innerWidth - 4) {
        overlayLabel.style.left = "auto";
        overlayLabel.style.right = "0";
      } else {
        overlayLabel.style.left = "0";
        overlayLabel.style.right = "auto";
      }
    }

    function onPickerMove(e: MouseEvent) {
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!target || isOverlayElement(target)) return;
      updateOverlay(target, resolveScope(target));
    }

    function emitPickerEvent(type: "selected" | "cancelled", scope?: SelectedScope) {
      // storage.session은 content script 접근 불가. storage.local은 가능.
      // background relay(service worker sleep 시 소실) 없이 직접 set → sidepanel onChanged 수신.
      const payload: Record<string, unknown> = { type, ts: Date.now() };
      if (scope) payload.scope = scope;
      chrome.storage.local
        .set({ ra_picker_event: payload })
        .then(() => console.log("[picker] storage.local.set ok", type, scope?.scopeId ?? ""))
        .catch((err) => console.error("[picker] storage.local.set failed", err));
    }

    function pickScope(target: HTMLElement | null): boolean {
      let el: HTMLElement | null = target;
      while (el && el !== document.documentElement) {
        const scope = resolveScope(el);
        if (scope) {
          const selectedScope = buildScope(scope.kind, scope.root, scope.fillables);
          disablePicker();
          emitPickerEvent("selected", selectedScope);
          return true;
        }
        el = el.parentElement;
      }
      return false;
    }

    function onPickerClick(e: MouseEvent) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // mousedown에서 이미 처리됐으면 click은 건너뜀
      if (!pickerActive) return;

      const fromPoint = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const el = fromPoint ?? (e.target as HTMLElement | null);
      if (!el || isOverlayElement(el)) return;

      if (!pickScope(el)) {
        console.warn("[picker] no fillable scope under click target", fromPoint);
      }
    }

    function onPickerKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        disablePicker();
        emitPickerEvent("cancelled");
      }
    }

    function onPickerMouseDown(e: MouseEvent) {
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (target && isOverlayElement(target)) return;
      // mousedown에서 직접 처리 — 페이지 rerender 전, click 이벤트 기다리지 않음
      // e.preventDefault() 사용 안 함: mousedown 취소 시 후속 click이 발생 안 됨
      if (pickScope(target)) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      } else {
        console.warn("[picker] mousedown: no fillable scope under", target);
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }

    function onPickerPointerDown(e: PointerEvent) {
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (target && isOverlayElement(target)) return;
      if (pickScope(target)) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      } else {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }

    function onPickerFocusIn(e: FocusEvent) {
      const target = e.target as HTMLElement | null;
      if (target && isOverlayElement(target)) return;
      // focus는 cancelable=false → preventDefault 무의미. stop만.
      e.stopPropagation();
      e.stopImmediatePropagation();
    }

    function enablePicker() {
      if (pickerActive) return;
      pickerActive = true;
      document.documentElement.style.cursor = "crosshair";
      document.addEventListener("mousemove", onPickerMove, { capture: true, passive: true });
      document.addEventListener("mousedown", onPickerMouseDown, true);
      document.addEventListener("pointerdown", onPickerPointerDown, true);
      document.addEventListener("click", onPickerClick, true);
      document.addEventListener("keydown", onPickerKeyDown, true);
      document.addEventListener("focusin", onPickerFocusIn, true);
      console.log("[picker] enabled");
    }

    function disablePicker() {
      if (!pickerActive) return;
      pickerActive = false;
      document.documentElement.style.cursor = "";
      overlay.style.display = "none";
      document.removeEventListener("mousemove", onPickerMove, { capture: true } as EventListenerOptions);
      document.removeEventListener("mousedown", onPickerMouseDown, true);
      document.removeEventListener("pointerdown", onPickerPointerDown, true);
      document.removeEventListener("click", onPickerClick, true);
      document.removeEventListener("keydown", onPickerKeyDown, true);
      document.removeEventListener("focusin", onPickerFocusIn, true);
      console.log("[picker] disabled");
    }

    // ── Diff popover ─────────────────────────────────────────────────────────

    let activePopover: HTMLElement | null = null;

    function escHtml(s: string): string {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function truncate(s: string, n: number): string {
      return s.length > n ? s.slice(0, n) + "…" : s;
    }

    function getCurrentValue(el: HTMLElement): string {
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea") return (el as HTMLInputElement).value;
      if (el.isContentEditable) return el.textContent ?? "";
      return "";
    }

    function showDiffPopover(el: HTMLElement, oldValue: string, newValue: string): Promise<boolean> {
      activePopover?.remove();
      activePopover = null;

      return new Promise<boolean>((resolve) => {
        const rect = el.getBoundingClientRect();
        const pop = document.createElement("div");
        pop.style.cssText =
          "position:fixed;z-index:2147483647;background:#fff;border:1px solid #e4e4e7;" +
          "border-radius:10px;padding:12px;box-shadow:0 8px 24px rgba(0,0,0,0.12);" +
          "min-width:220px;max-width:360px;font-family:system-ui,sans-serif;font-size:12px;";
        const top = Math.max(rect.bottom + 8, 8);
        const left = Math.min(Math.max(rect.left, 8), window.innerWidth - 380);
        pop.style.top = `${top}px`;
        pop.style.left = `${left}px`;
        pop.innerHTML = `
          <div style="color:#71717a;font-size:11px;font-weight:500;margin-bottom:6px;">AI 제안 미리보기</div>
          <div style="background:#fef2f2;color:#dc2626;padding:6px 8px;border-radius:6px;margin-bottom:4px;max-height:56px;overflow:auto;text-decoration:line-through;opacity:0.7;">${escHtml(truncate(oldValue, 120))}</div>
          <div style="background:#f0fdf4;color:#16a34a;padding:6px 8px;border-radius:6px;max-height:72px;overflow:auto;">${escHtml(truncate(newValue, 240))}</div>
          <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px;">
            <button id="ra-reject" style="padding:4px 12px;border-radius:6px;border:1px solid #e4e4e7;background:#fff;cursor:pointer;color:#71717a;">✕ 취소</button>
            <button id="ra-accept" style="padding:4px 12px;border-radius:6px;border:none;background:#18181b;color:#fff;cursor:pointer;">✓ 적용</button>
          </div>`;
        document.documentElement.appendChild(pop);
        activePopover = pop;

        let resolved = false;
        function done(result: boolean) {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          document.removeEventListener("keydown", onKey, true);
          pop.remove();
          if (activePopover === pop) activePopover = null;
          resolve(result);
        }

        pop.querySelector<HTMLButtonElement>("#ra-accept")!.addEventListener("click", () => done(true));
        pop.querySelector<HTMLButtonElement>("#ra-reject")!.addEventListener("click", () => done(false));

        function onKey(e: KeyboardEvent) {
          if (e.key === "Escape") { e.preventDefault(); done(false); }
        }
        document.addEventListener("keydown", onKey, true);
        const timer = setTimeout(() => done(false), 30_000);
      });
    }

    // ── Message listener ────────────────────────────────────────────────────

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function onMessage(message: any, _sender: unknown, sendResponse: (r: unknown) => void): boolean | undefined {
      const type = message?.type as string | undefined;

      if (type === "agent-browser:activity") {
        const payload = message.payload as { active?: boolean; pulseMs?: number } | undefined;
        setAgentBrowserActivity(payload?.active === true, payload?.pulseMs);
        sendResponse({ ok: true });
        return;
      }

      if (type === "picker:enable") { enablePicker(); sendResponse({ ok: true }); return; }
      if (type === "picker:disable") { disablePicker(); sendResponse({ ok: true }); return; }
      if (type === "picker:toggle") {
        if (pickerActive) {
          disablePicker();
          emitPickerEvent("cancelled");
        } else {
          enablePicker();
        }
        sendResponse({ ok: true });
        return;
      }

      if (type === "fill") {
        const { elementId, value, force } = message.payload as { elementId: string; value: string; force?: boolean };
        // elementId is a CSS selector (#real-id or generated cssPath) — query live DOM each time
        const el = resolveFillTarget(elementId);
        if (!el || !document.contains(el)) {
          sendResponse({ ok: false, applied: false, reason: "element_not_found" });
          return;
        }
        if (!isFillable(el)) {
          sendResponse({ ok: false, applied: false, reason: "element_not_fillable" });
          return;
        }
        const old = getCurrentValue(el);
        if (!old.trim() || force) {
          // force=true: 사이드패널에서 이미 수락 — 인라인 diff popover 없이 바로 채움
          fillField(el, value);
          flashFilledField(el);
          sendResponse({ ok: true, applied: true });
        } else {
          showDiffPopover(el, old, value).then((accepted) => {
            if (accepted) {
              fillField(el, value);
              flashFilledField(el);
            }
            sendResponse({ ok: true, applied: accepted, reason: accepted ? undefined : "user_rejected" });
          });
          return true; // async sendResponse
        }
      }

      if (type === "field:resolve") {
        const { elementId, draftValue } = message.payload as { elementId: string; draftValue?: string };
        const el = resolveFillTarget(elementId);
        if (!el || !document.contains(el)) {
          sendResponse({ ok: false, reason: "element_not_found" });
          return;
        }
        if (!isFillable(el)) {
          sendResponse({ ok: false, reason: "element_not_fillable" });
          return;
        }

        const scope = buildScope("field", el, [el]);
        if (draftValue) scope.fields[0].draftValue = draftValue;
        sendResponse({ ok: true, scope });
      }
    }

    chrome.runtime.onMessage.addListener(onMessage);
    document.addEventListener("focusin", onFocusIn, true);

    // extension reload 후 재주입 시 이전 인스턴스(리스너·오버레이) 정리용
    w.__raCleanup = () => {
      // 플래그 먼저 초기화 — Chrome API throw 전에 반드시 실행돼야 함
      w.__raLoaded = false;
      w.__raCleanup = undefined;
      try { disablePicker(); } catch { /* picker 미활성 시 무시 */ }
      cleanupAgentBrowserActivity();
      overlay.remove();
      document.removeEventListener("focusin", onFocusIn, true);
      try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* context 무효화 시 무시 */ }
    };

    console.log("[content] resume-agent content script loaded");
  },
});
