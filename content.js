(function () {
  /************  STATE  ************/
  const IS_TOP = (window.top === window);
  let candidates = [];
  let overlayDescriptors = [];
  let scrollInterval = null;
  let typingTimeout = null;
  let digitBuffer = ""; // NEW: stores typed digits before pressing "y"
  const AGENT_PANEL_ID = "cora-agent-panel";
  const MIC_TOGGLE_ID = "cora-mic-toggle";
  const VOICE_STATUS_ID = "cora-voice-status";
  const VOICE_PREVIEW_ID = "cora-voice-preview";
  const IDLE_STOP_MS = 1300;
  let micToggleButton = null;
  let idleStopTimer = null;

  /************  UI BAR  ************/
  // Command bar removed – we now use global keyboard shortcuts (s / h / digits + y)

  /************  HELPERS  ************/
  function removeOverlayElements() {
    document
      .querySelectorAll(".button-outline-overlay,.button-index-label")
      .forEach((el) => el.remove());
  }

  function clearOverlays({ preserveCandidates = false } = {}) {
    removeOverlayElements();
    if (!preserveCandidates) {
      candidates = [];
      overlayDescriptors = [];
    }
  }

  function showOverlays() {
    clearOverlays();
    overlayDescriptors = [];

    const baseSelector = `
      button,
      [role='button'],
      [role='menuitem'],
      [role='tab'],
      [role='link'],
      [role='gridcell'],
      input[type='button'],
      input[type='submit'],
      input[type='image'],
      input[type='text'],
      textarea,
      [contenteditable="true"],
      a[href],
      [onclick],
      [tabindex]
    `;

    const docsExtra = location.host.includes("docs.google.com")
      ? `,
      canvas,
      [role="textbox"],
      [role="document"],
      iframe
    `
      : "";

    const elements = document.querySelectorAll(baseSelector + docsExtra);

    [...elements].forEach((el, idx) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);

      const visible =
        el.offsetParent !== null &&
        rect.width > 10 &&
        rect.height > 10 &&
        style.visibility !== "hidden" &&
        style.opacity !== "0";

      if (!visible) return;

      // 🔍 only keep elements that are actually on top
      let testX = rect.left + rect.width / 2;
      let testY = rect.top + rect.height / 2;

      if (rect.width > window.innerWidth * 0.7) {
        testX = rect.left + rect.width * 0.8;
      }

      const topEl = document.elementFromPoint(testX, testY);
      if (!topEl) return;

      const uiRoot = document.getElementById("voiceos-ui-root");
      const isCoveredByOurUI =
        uiRoot && (topEl === uiRoot || uiRoot.contains(topEl));

      // If it's covered by *other page elements*, skip it.
      // If it's only covered by our own UI bar, still allow it.
      if (!isCoveredByOurUI && !el.contains(topEl) && !topEl.contains(el)) {
        return;
      }

      // draw overlay
      const overlay = document.createElement("div");
      overlay.className = "button-outline-overlay";
      overlay.style.cssText = `
        position:fixed;
        left:${rect.left}px;
        top:${rect.top}px;
        width:${rect.width}px;
        height:${rect.height}px;
        border:2px solid #0f0;
        background:rgba(0,128,0,.01);
        z-index:9999;
        pointer-events:none;
        box-sizing:border-box;
      `;
      document.body.appendChild(overlay);

      const label = document.createElement("div");
      label.className = "button-index-label";
      label.textContent = idx + 1;
      label.style.cssText = `
        position:fixed;
        left:${rect.left + 4}px;
        top:${rect.top + 4}px;
        font:700 12px/1 sans-serif;
        color:#fff;
        background:rgba(0,128,0,.6);
        padding:2px 5px;
        border-radius:4px;
        z-index:10000;
        pointer-events:none;
      `;
      document.body.appendChild(label);

      candidates.push({ el, index: idx + 1 });
      overlayDescriptors.push(buildDescriptor(el, idx + 1, rect));
    });
  }

  function computePageContext() {
    try {
      const parts = [];

      // Selection text if any
      const sel = window.getSelection();
      if (sel && sel.toString()) {
        parts.push(`selection: ${sel.toString().trim()}`);
      }

      // Focused element hints
      const ae = document.activeElement;
      if (ae) {
        const tag = (ae.tagName || "").toLowerCase();
        const attrs = [
          ae.getAttribute("aria-label"),
          ae.getAttribute("placeholder"),
          ae.getAttribute("title"),
          ae.getAttribute("name"),
        ].filter(Boolean);
        const val = (ae.value || ae.innerText || "").toString().trim();
        const label = attrs.join(" ").trim();
        const focusHint = [`focus:${tag}`, label && `label:${label}`, val && `value:${val}`]
          .filter(Boolean)
          .join(" | ");
        if (focusHint) parts.push(focusHint);
      }

      // Nearby visible text (very small sample)
      const bodyText = (document.body && document.body.innerText) || "";
      if (bodyText) {
        parts.push(bodyText.slice(0, 300));
      }

      const context = parts.join(" || ").replace(/\s+/g, " ").trim();
      return context.slice(0, 500);
    } catch (_) {
      return "";
    }
  }

  function buildDescriptor(el, index, rect) {
    const role = computeRole(el);
    const accessibleName = getAccessibleName(el);
    const innerText = (el.innerText || "").trim().slice(0, 200);
    const placeholder = (el.getAttribute("placeholder") || "").trim();

    const viewportW = window.innerWidth || 1;
    const viewportH = window.innerHeight || 1;
    const xNorm = rect.left / viewportW;
    const yNorm = rect.top / viewportH;
    const horizontal = xNorm < 0.33 ? "left" : xNorm < 0.66 ? "center" : "right";
    const vertical = yNorm < 0.33 ? "top" : yNorm < 0.66 ? "middle" : "bottom";

    return {
      index,
      role,
      accessibleName,
      innerText,
      placeholder,
      bbox: {
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
      },
      region: {
        horizontal,
        vertical,
      },
    };
  }

  function computeRole(el) {
    const ariaRole = el.getAttribute("role");
    if (ariaRole) return ariaRole;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "textarea") return "textbox";
    if (el.isContentEditable) return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (["text", "search", "email", "password", "number", "url", "tel"].includes(type)) return "textbox";
      if (["submit", "button", "image", "reset"].includes(type)) return "button";
    }
    return tag || "element";
  }

  function getAccessibleName(el) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/).filter(Boolean);
      const parts = ids.map((id) => {
        const ref = document.getElementById(id);
        return ref ? (ref.innerText || ref.textContent || "").trim() : "";
      }).filter(Boolean);
      if (parts.length) return parts.join(" ").slice(0, 200);
    }

    const title = el.getAttribute("title");
    if (title) return title.trim();

    return "";
  }

  function smartClick(el) {
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus();
      ["mousedown", "mouseup", "click"].forEach((evt) =>
        el.dispatchEvent(new MouseEvent(evt, { bubbles: true }))
      );
    } catch (e) {
      console.warn("Smart-click failed:", e.message);
    }
  }

  function scrollPage(dir) {
    const px = 5;
    clearInterval(scrollInterval);
    scrollInterval = setInterval(
      () => window.scrollBy(0, dir === "up" ? -px : px),
      16
    );
  }

  function performClickIndex(n) {
    const idx = Number(n);
    if (!Number.isInteger(idx)) {
      return { success: false, error: "click_index requires an integer" };
    }

    const target = candidates.find((c) => c.index === idx);

    if (target) {
      clearOverlays();
      smartClick(target.el);
      return { success: true, info: `clicked ${idx}` };
    }

    return { success: false, error: `No candidate found for index ${idx}` };
  }

  function insertIntoContentEditable(el, text) {
    try {
      el.focus();
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.addRange(range);
      }

      const execOk = document.execCommand && document.execCommand("insertText", false, text);
      if (!execOk) {
        const selection = window.getSelection();
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        if (range) {
          range.deleteContents();
          range.insertNode(document.createTextNode(text));
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        } else {
          el.appendChild(document.createTextNode(text));
        }
      }

      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { success: true, info: "Typed into contentEditable" };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }

  function typeTextAction(text) {
    if (typeof text !== "string") {
      return { success: false, error: "type_text requires a string" };
    }

    let target = document.activeElement;
    if (!target) {
      return { success: false, error: "No active element to type into" };
    }

    // Heuristic: if typing an email into a subject-like field, redirect to a recipient field when available.
    if (isEmailLike(text) && looksLikeSubjectField(target) && !looksLikeRecipientField(target)) {
      const recipientField = findRecipientField();
      if (recipientField) {
        target = recipientField;
        try {
          target.focus();
        } catch (_) {}
      }
    }

    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      try {
        target.focus();
        target.value = text;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true, info: "Typed into input" };
      } catch (err) {
        return { success: false, error: err.message || String(err) };
      }
    }

    if (target.isContentEditable) {
      return insertIntoContentEditable(target, text);
    }

    return { success: false, error: "Active element is not typeable" };
  }

  function isEmailLike(text) {
    return typeof text === "string" && /.+@.+\..+/.test(text);
  }

  function getFieldHints(el) {
    if (!el) return "";
    const attrs = [
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("title"),
      el.getAttribute("name"),
    ].filter(Boolean);
    return attrs.join(" ").toLowerCase();
  }

  function looksLikeSubjectField(el) {
    return /subject/.test(getFieldHints(el));
  }

  function looksLikeRecipientField(el) {
    return /(to|recipient|recipients|cc|bcc)/.test(getFieldHints(el));
  }

  function findRecipientField() {
    const selectors = ["input", "textarea", "[contenteditable='true']"];
    const nodes = document.querySelectorAll(selectors.join(","));
    for (const el of nodes) {
      if (looksLikeRecipientField(el)) return el;
    }
    return null;
  }

  async function selectTypeAction(payload) {
    if (!payload || typeof payload !== "object") {
      return { success: false, error: "select_type requires { index, text }" };
    }

    const { index, text } = payload;
    if (!Number.isInteger(index)) {
      return { success: false, error: "select_type index must be an integer" };
    }
    if (typeof text !== "string") {
      return { success: false, error: "select_type text must be a string" };
    }

    const clickResult = performClickIndex(index);
    if (!clickResult.success) {
      return clickResult;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    return typeTextAction(text);
  }

  function performScrollAction(value) {
    clearInterval(scrollInterval);
    scrollInterval = null;

    const viewport = window.innerHeight || 800;
    const smallStep = Math.max(80, viewport * 0.25);
    const largeStep = Math.max(160, viewport * 0.8);

    switch (value) {
      case "down_small":
        window.scrollBy({ top: smallStep, behavior: "smooth" });
        return { success: true, info: "Scrolled down_small" };
      case "down":
        window.scrollBy({ top: largeStep, behavior: "smooth" });
        return { success: true, info: "Scrolled down" };
      case "up_small":
        window.scrollBy({ top: -smallStep, behavior: "smooth" });
        return { success: true, info: "Scrolled up_small" };
      case "up":
        window.scrollBy({ top: -largeStep, behavior: "smooth" });
        return { success: true, info: "Scrolled up" };
      case "top":
        window.scrollTo({ top: 0, behavior: "smooth" });
        return { success: true, info: "Scrolled to top" };
      case "bottom":
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        return { success: true, info: "Scrolled to bottom" };
      default:
        return { success: false, error: `Unsupported scroll value "${value}"` };
    }
  }

  /************  INLINE AGENT PANEL (top frame only) ************/
  function ensureAgentPanel() {
    let panel = document.getElementById(AGENT_PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = AGENT_PANEL_ID;
    panel.style.cssText = `
      position: fixed;
      bottom: 16px;
      right: 16px;
      width: 280px;
      padding: 12px;
      background: rgba(0,0,0,0.85);
      color: #fff;
      font: 13px/1.4 sans-serif;
      border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.35);
      z-index: 2147483647;
      display: none;
    `;

    const title = document.createElement("div");
    title.textContent = "Cora Agent Goal";
    title.style.cssText = "font-weight:700;margin-bottom:6px;";
    panel.appendChild(title);

    const questionRow = document.createElement("div");
    questionRow.dataset.role = "question";
    questionRow.style.cssText = "display:none;margin-bottom:6px;font-weight:600;";
    panel.appendChild(questionRow);

    const textarea = document.createElement("textarea");
    textarea.placeholder = 'e.g. "open gmail and click compose"';
    textarea.style.cssText = `
      width: 100%;
      box-sizing: border-box;
      height: 70px;
      margin-bottom: 8px;
      padding: 6px;
      border-radius: 4px;
      border: 1px solid #444;
      background: #111;
      color: #fff;
      resize: vertical;
    `;
    panel.appendChild(textarea);

    const buttonRow = document.createElement("div");
    buttonRow.style.cssText = "display:flex; gap:8px; justify-content:flex-end;";

    const micBtn = document.createElement("button");
    micBtn.id = MIC_TOGGLE_ID;
    micBtn.textContent = "Start Mic";
    micBtn.style.cssText = `
      padding: 6px 10px;
      border: none;
      border-radius: 4px;
      background: #ff8a3c;
      color: #fff;
      cursor: pointer;
      font-weight: 700;
    `;

    const startBtn = document.createElement("button");
    startBtn.textContent = "Submit";
    startBtn.style.cssText = `
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      background: #2e8bff;
      color: #fff;
      cursor: pointer;
      font-weight: 700;
    `;

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.style.cssText = `
      padding: 6px 10px;
      border: none;
      border-radius: 4px;
      background: #444;
      color: #fff;
      cursor: pointer;
    `;

    buttonRow.appendChild(closeBtn);
    buttonRow.appendChild(micBtn);
    buttonRow.appendChild(startBtn);
    panel.appendChild(buttonRow);

    const voiceStatus = document.createElement("div");
    voiceStatus.id = VOICE_STATUS_ID;
    voiceStatus.textContent = "Voice idle";
    voiceStatus.style.cssText = `
      margin-top: 6px;
      font-size: 12px;
      color: #ccc;
      min-height: 16px;
    `;
    panel.appendChild(voiceStatus);

    const voicePreview = document.createElement("div");
    voicePreview.id = VOICE_PREVIEW_ID;
    voicePreview.textContent = "Transcript: (none yet)";
    voicePreview.style.cssText = `
      margin-top: 6px;
      font-size: 12px;
      color: #fff;
      word-break: break-word;
      white-space: pre-wrap;
      max-height: 120px;
      overflow-y: auto;
      border: 1px solid #333;
      padding: 6px;
      border-radius: 4px;
      background: rgba(255,255,255,0.05);
    `;
    panel.appendChild(voicePreview);

    startBtn.addEventListener("click", () => {
      const mode = panel.dataset.mode || "start";
      const text = textarea.value.trim();
      if (!text) return;
      if (voiceActive) stopVoice();
      if (mode === "question") {
        chrome.runtime?.sendMessage?.({ type: "USER_REPLY", reply: text });
      } else if (mode === "summary") {
        hideAgentPanel();
      } else {
        chrome.runtime?.sendMessage?.({ type: "TEXT_COMMAND", text });
        hideAgentPanel();
      }
      textarea.value = "";
      if (mode === "question") {
        hideAgentPanel();
      }
    });

    closeBtn.addEventListener("click", () => {
      if (voiceActive) stopVoice();
      hideAgentPanel();
    });

    micBtn.addEventListener("click", async () => {
      micToggleButton = micBtn;
      if (voiceActive) {
        stopVoice();
      } else {
        await startVoice();
      }
    });

    micToggleButton = micBtn;
    voiceStatusEl = voiceStatus;

    document.body.appendChild(panel);
    return panel;
  }

  function showAgentPanel() {
    const panel = ensureAgentPanel();
    panel.dataset.mode = "start";
    const questionRow = panel.querySelector("[data-role='question']");
    if (questionRow) questionRow.style.display = "none";
    panel.style.display = "block";
    const textarea = panel.querySelector("textarea");
    if (textarea) {
      textarea.placeholder = 'e.g. "open gmail and click compose"';
      textarea.readOnly = false;
      textarea.focus();
    }
  }

  function showQuestionPanel(questionText) {
    const panel = ensureAgentPanel();
    panel.dataset.mode = "question";
    const questionRow = panel.querySelector("[data-role='question']");
    if (questionRow) {
      questionRow.textContent = questionText || "Please provide an answer:";
      questionRow.style.display = "block";
    }
    panel.style.display = "block";
    const textarea = panel.querySelector("textarea");
    if (textarea) {
      textarea.value = "";
      textarea.placeholder = "Type your answer...";
      textarea.readOnly = false;
      textarea.focus();
    }
    // Auto-start mic to capture the reply without manual start.
    startVoice().catch((err) => console.warn("[voice] auto start mic failed:", err?.message || err));
    setVoiceStatus("Listening for your answer...");
  }

  function showSummaryPanel(summaryText) {
    const panel = ensureAgentPanel();
    panel.dataset.mode = "summary";
    const questionRow = panel.querySelector("[data-role='question']");
    if (questionRow) {
      questionRow.textContent = "Summary";
      questionRow.style.display = "block";
    }
    panel.style.display = "block";
    const textarea = panel.querySelector("textarea");
    if (textarea) {
      textarea.value = summaryText || "";
      textarea.placeholder = "";
      textarea.readOnly = true;
      textarea.focus();
    }
  }

  function hideAgentPanel() {
    const panel = document.getElementById(AGENT_PANEL_ID);
    if (panel) panel.style.display = "none";
  }

  async function handleExecAction(action, value) {
    try {
      switch (action) {
        case "click_index":
          return performClickIndex(value);
        case "type_text":
          return typeTextAction(value);
        case "select_type":
          return selectTypeAction(value || {});
        case "scroll":
          return performScrollAction(value);
        default:
          return { success: false, error: `Unsupported action "${action}"` };
      }
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /************  GPT INTENT PARSER  ************/
  async function getIntent(text) {
    const url = "https://api.openai.com/v1/chat/completions";
    const body = {
      model: "gpt-4o",
      temperature: 0.15,
      messages: [
        {
          role: "system",
          content: `
You are a command interpreter for a Chrome extension.  
Only output a JSON object: { "action": string, "value"?: any }.  
No commentary, no code fences.


Allowed actions
  show_overlays | hide_overlays
  scroll_up | scroll_down | scroll_top | scroll_end | scroll_stop
  click_index           (value:number)
  switch_tab            (value:number)
  last_tab | next_tab | previous_tab | reopen_tab
  search                (value:string)
  close_tab


Interpret common synonyms:
• "scroll a little down / down a bit / go lower"   → scroll_down  
• "scroll a little up / go higher"                 → scroll_up  
• "go to very top / jump to top"                   → scroll_top  
• "bottom of the page / all the way down"          → scroll_end  
• "stop scrolling / hold it"                       → scroll_stop  
• "pick / choose / select / press / click 18"      → click_index, 18  
• "tab 4 / switch to 4th tab"                      → switch_tab, 4  
• "back one tab"                                   → previous_tab  
• "forward one tab"                                → next_tab  
• "reopen closed tab"                              → reopen_tab  
• "close this / shut tab"                          → close_tab  
• "search facebook / google cat videos"            → search, "facebook" / "cat videos"


EXAMPLES  
User: scroll a little down  
→ {"action":"scroll_down"}


User: choose 25  
→ {"action":"click_index","value":25}


User: search banana bread recipes  
→ {"action":"search","value":"banana bread recipes"}


User: google cnn.com  
→ {"action":"search","value":"cnn.com"}
          `.trim()
        },
        { role: "user", content: text }
      ]
    };

    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer YOUR_API_KEY_HERE"
    };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  }

  /************  ROUTER  ************/
  function route({ action, value }) {
    switch (action) {
      case "show_overlays":
        showOverlays();
        return;

      case "hide_overlays":
        clearOverlays();
        return;

      case "scroll_up":
        return scrollPage("up");
      case "scroll_down":
        return scrollPage("down");
      case "scroll_top":
        clearInterval(scrollInterval);
        return window.scrollTo({ top: 0, behavior: "smooth" });
      case "scroll_end":
        clearInterval(scrollInterval);
        return window.scrollTo({
          top: document.body.scrollHeight,
          behavior: "smooth"
        });
      case "scroll_stop":
        return clearInterval(scrollInterval);
      case "click_index":
        performClickIndex(value);
        return;
      case "switch_tab":
        return chrome.runtime.sendMessage({ type: "switch-tab", index: value });
      case "last_tab":
        return chrome.runtime.sendMessage({ type: "last-tab" });
      case "next_tab":
        return chrome.runtime.sendMessage({ type: "next-tab" });
      case "previous_tab":
        return chrome.runtime.sendMessage({ type: "previous-tab" });
      case "reopen_tab":
        return chrome.runtime.sendMessage({ type: "reopen-tab" });
      case "search":
        return chrome.runtime.sendMessage({ type: "search-query", query: value });
      case "close_tab":
        return chrome.runtime.sendMessage({ type: "close-tab" });
      default:
        throw new Error("Unknown action");
    }
  }

  /************  SIMPLE REGEX FAST-PATH (click N) ************/
  function numericClickFastPath(raw) {
    const m = raw.match(/^(?:choose|select|click|pick|press)\s+(\d+)$/i);
    if (m) {
      route({ action: "click_index", value: Number(m[1]) });
      return true;
    }
    return false;
  }

  /************  SEARCH FAST-PATH (search / open / go to …) ************/
  function searchFastPath(raw) {
    const m = raw.match(/^(?:search|google)\s+(.+)/i);
    if (!m) return false;

    const query = m[1].trim();
    route({ action: "search", value: query });
    return true;
  }

  /************  KEYWORD FALLBACK (runs only if fast-paths & GPT miss) ************/
  function keywordFallback(raw) {
    const v = raw.toLowerCase().trim();
    if (v === "show") return route({ action: "show_overlays" });
    if (v === "hide") return route({ action: "hide_overlays" });
    if (v === "up")   return route({ action: "scroll_up" });
    if (v === "down") return route({ action: "scroll_down" });
    if (v === "top")  return route({ action: "scroll_top" });
    if (v === "end")  return route({ action: "scroll_end" });
    if (v === "stop") return route({ action: "scroll_stop" });

    if (!isNaN(v)) return route({ action: "click_index", value: Number(v) });

    if (v.startsWith("tab ")) {
      const n = Number(v.split(" ")[1]);
      if (!isNaN(n)) return route({ action: "switch_tab", value: n });
    }
    if (v === "last tab")     return route({ action: "last_tab" });
    if (v === "next tab")     return route({ action: "next_tab" });
    if (v === "previous tab") return route({ action: "previous_tab" });
    if (v === "reopen")       return route({ action: "reopen_tab" });
    if (v === "close tab")    return route({ action: "close_tab" });
    if (v.startsWith("search ")) {
      return route({ action: "search", value: v.slice(7).trim() });
    }

    alert("Sorry, I didn't understand that command.");
  }

  /************  AGENT MESSAGE HANDLERS (top frame only) ************/
  chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (!IS_TOP) return;

    if (msg.type === "PING") {
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "OBSERVE_SHOW") {
      showOverlays();
      const pageContext = computePageContext();
      sendResponse({ success: true, info: "Overlays shown", count: candidates.length, elements: overlayDescriptors, pageContext });
      return;
    }

    if (msg.type === "OBSERVE_HIDE") {
      clearOverlays({ preserveCandidates: true });
      sendResponse({ success: true, info: "Overlays hidden" });
      return;
    }

    if (msg.type === "SHOW_QUESTION") {
      showQuestionPanel(msg.question || "");
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "SHOW_SUMMARY") {
      showSummaryPanel(msg.summary || "");
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "EXEC_ACTION") {
      (async () => {
        const result = await handleExecAction(msg.action, msg.value);
        sendResponse(result);
      })();
      return true;
    }
  });

  /************  NEW: GLOBAL KEY HANDLER (s / h / digits + y) ************/
  document.addEventListener("keydown", (e) => {
    // Only respond in the focused frame
    if (!document.hasFocus()) return;

    // Ignore when typing in inputs / textareas / contenteditable / selects
    const ae = document.activeElement;
    const tag = ae && ae.tagName;
    const isEditable =
      (ae && ae.isContentEditable) ||
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT";

    if (isEditable) return;

    const key = e.key.toLowerCase();

    // Ctrl/Cmd + Shift + P => toggle agent panel
    if (e.shiftKey && (e.metaKey || e.ctrlKey) && key === "l") {
      e.preventDefault();
      const panel = document.getElementById(AGENT_PANEL_ID);
      if (panel && panel.style.display === "block") {
        hideAgentPanel();
      } else {
        showAgentPanel();
      }
      return;
    }

    // s → show overlays
    if (key === "s") {
      e.preventDefault();
      digitBuffer = "";
      route({ action: "show_overlays" });
      return;
    }

    // h → hide overlays
    if (key === "h") {
      e.preventDefault();
      digitBuffer = "";
      route({ action: "hide_overlays" });
      return;
    }

    // Escape → clear digit buffer
    if (key === "escape") {
      digitBuffer = "";
      return;
    }

    // 0–9 → build up digit buffer
    if (key >= "0" && key <= "9") {
      e.preventDefault();
      digitBuffer += key;
      return;
    }

    // y → confirm selection and click that index
    if (key === "y") {
      e.preventDefault();
      if (!digitBuffer) return;

      const n = Number(digitBuffer);
      digitBuffer = "";
      if (!Number.isNaN(n)) {
        route({ action: "click_index", value: n });
      }
    }
  }, true);

  /************  MESSAGE LISTENER FOR MULTI-FRAME (legacy) ************/
  chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "overlay-command") return;
    if (!IS_TOP) return;

    if (msg.action === "show") {
      showOverlays();
    }
    else if (msg.action === "hide") {
      clearOverlays();
    }
    else if (msg.action === "click-index") {
      const n = Number(msg.index);
      const target = candidates.find((c) => c.index === n);
      if (target) {
        clearOverlays();
        smartClick(target.el);
      }
    }
  });

  /************  VOICE (REALTIME WS + TEXT_COMMAND) ************/
  const VOICE_WS_URL = "ws://localhost:8000/ws/realtime"; // adjust host/port for your backend
  let voiceWs = null;
  let audioCtx = null;
  let micStream = null;
  let processorNode = null;
  let voiceActive = false;
  let voiceStatusEl = null;
  let stopRequested = false;
  let stopForceCloseTimer = null;

  function getMicToggle() {
    if (micToggleButton && document.body.contains(micToggleButton)) return micToggleButton;
    const panel = ensureAgentPanel();
    micToggleButton = panel.querySelector(`#${MIC_TOGGLE_ID}`);
    return micToggleButton;
  }

  function setMicButtonState(active, label) {
    const btn = getMicToggle();
    if (!btn) return;
    btn.textContent = label || (active ? "Stop Mic" : "Start Mic");
    btn.style.background = active ? "#e34b3f" : "#ff8a3c";
  }

  function ensureVoiceStatus() {
    if (voiceStatusEl && document.body.contains(voiceStatusEl)) return voiceStatusEl;
    const panel = ensureAgentPanel();
    const found = panel.querySelector(`#${VOICE_STATUS_ID}`);
    if (found) {
      voiceStatusEl = found;
      return voiceStatusEl;
    }
    return null;
  }

  function setVoiceStatus(text) {
    const el = ensureVoiceStatus();
    if (!el) return;
    el.textContent = text || "";
  }

  function ensureVoicePreview() {
    const panel = ensureAgentPanel();
    const found = panel.querySelector(`#${VOICE_PREVIEW_ID}`);
    return found || null;
  }

  function setVoicePreview(text) {
    const el = ensureVoicePreview();
    if (!el) return;
    el.textContent = text ? `Transcript: ${text}` : "Transcript: (none yet)";
  }

  function clearIdleStopTimer() {
    if (idleStopTimer) {
      clearTimeout(idleStopTimer);
      idleStopTimer = null;
    }
  }

  function armIdleStopTimer() {
    clearIdleStopTimer();
    idleStopTimer = setTimeout(() => {
      if (!voiceActive || !voiceWs || voiceWs.readyState !== WebSocket.OPEN) return;
      setVoiceStatus("Sending...");
      stopVoice();
    }, IDLE_STOP_MS);
  }

  function autoSubmitTranscript(rawText) {
    const text = (rawText || "").trim();
    const panel = ensureAgentPanel();
    const mode = panel?.dataset?.mode || "start";
    const textarea = panel.querySelector("textarea");
    if (textarea && text) textarea.value = text;

    if (!text) {
      setVoiceStatus("No transcript captured");
      return;
    }

    // Text captured; status will be updated by the sender path.
    setVoiceStatus(mode === "question" ? "Transcript captured (replying...)" : "Transcript captured (sending...)");
  }

  async function startVoice() {
    console.log("[voice] startVoice clicked");
    if (voiceWs && (voiceWs.readyState === WebSocket.OPEN || voiceWs.readyState === WebSocket.CONNECTING)) {
      setVoiceStatus("Voice already active");
      return;
    }
    clearIdleStopTimer();
    stopRequested = false;
    voiceActive = true;
    setMicButtonState(true);
    setVoiceStatus("Connecting mic...");
    setVoicePreview("");
    try {
      voiceWs = new WebSocket(VOICE_WS_URL);
    } catch (err) {
      voiceActive = false;
      setMicButtonState(false);
      console.warn("[voice] WS open failed:", err?.message || err);
      setVoiceStatus("WS open failed");
      return;
    }

    voiceWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "partial") {
          console.log("[voice] partial:", msg.text);
          setVoiceStatus(`Listening: ${msg.text}`);
          setVoicePreview(msg.text);
          armIdleStopTimer();
        } 
        else if (msg.type === "final") {
          console.log("[voice] final:", msg.text);
          clearIdleStopTimer();
          setVoiceStatus(`Final: ${msg.text}`);
          setVoicePreview(msg.text);
          autoSubmitTranscript(msg.text);

          // Auto-send the final transcript to background without requiring Submit.
          const panel = ensureAgentPanel();
          const mode = panel?.dataset?.mode || "start";
          const finalText = (msg.text || "").trim();
          if (finalText) {
            if (mode === "question") {
              console.log("[voice] auto-send USER_REPLY:", finalText);
              chrome.runtime?.sendMessage?.({ type: "USER_REPLY", reply: finalText });
              setVoiceStatus("Reply sent automatically.");
            } else {
              console.log("[voice] auto-send TEXT_COMMAND:", finalText);
              chrome.runtime?.sendMessage?.({ type: "TEXT_COMMAND", text: finalText });
              setVoiceStatus("Command sent automatically.");
            }
            hideAgentPanel();
          }

          if (stopRequested) {
            stopRequested = false;
            if (stopForceCloseTimer) {
              clearTimeout(stopForceCloseTimer);
              stopForceCloseTimer = null;
            }
            try {
              voiceWs.close();
            } catch (_) {}
          }
        }
        else if (msg.type === "error") {
          console.warn("[voice] error:", msg.message);
          setVoiceStatus(`Error: ${msg.message}`);
        }
      } catch (_) {}
    };

    voiceWs.onopen = () => {
      console.log("[voice] ws open");
      try {
        voiceWs.send(JSON.stringify({ type: "start" }));
      } catch (_) {}
      startRecording();
      setVoiceStatus("Listening...");
    };

    voiceWs.onclose = (e) => {
      console.log("[voice] ws close", e?.code, e?.reason);
      clearIdleStopTimer();
      stopRecording();
      voiceWs = null;
      voiceActive = false;
      setMicButtonState(false);
      setVoiceStatus("Stopped");
    };

    voiceWs.onerror = (e) => {
      console.log("[voice] ws error", e);
      clearIdleStopTimer();
      voiceActive = false;
      setMicButtonState(false);
      setVoiceStatus("WS error");
      stopVoice();
    };
  }

  function stopVoice() {
    console.log("[voice] stopVoice clicked");
    clearIdleStopTimer();
    stopRequested = true;
    voiceActive = false;
    setMicButtonState(false);

    // Stop mic immediately (good UX)
    stopRecording();

    // Tell server to commit + generate transcript, but DON'T close yet
    if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
      try { voiceWs.send(JSON.stringify({ type: "stop" })); } catch (_) {}
      setVoiceStatus("Finishing transcription...");

      // Safety: if server never replies, force-close
      if (stopForceCloseTimer) clearTimeout(stopForceCloseTimer);
      stopForceCloseTimer = setTimeout(() => {
        try { voiceWs.close(); } catch (_) {}
      }, 4000);
    } else {
      setVoiceStatus("Stopped");
    }
  }

  function floatTo16BitPCM(float32Array) {
    const out = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      let s = float32Array[i];
      s = Math.max(-1, Math.min(1, s));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function resampleToMonoPCM16(inputBuffer, targetRate) {
    const sourceRate = inputBuffer.sampleRate || targetRate;
    const numChannels = inputBuffer.numberOfChannels || 1;
    const chanData = [];
    for (let c = 0; c < numChannels; c++) chanData.push(inputBuffer.getChannelData(c));

    const frameCount = inputBuffer.length;
    const mono = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let c = 0; c < numChannels; c++) sum += chanData[c][i] || 0;
      mono[i] = sum / numChannels;
    }

    if (sourceRate === targetRate) return floatTo16BitPCM(mono);

    const ratio = sourceRate / targetRate;
    const newLength = Math.round(frameCount / ratio);
    const resampled = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const idx = i * ratio;
      const idx0 = Math.floor(idx);
      const idx1 = Math.min(idx0 + 1, frameCount - 1);
      const weight = idx - idx0;
      resampled[i] = mono[idx0] * (1 - weight) + mono[idx1] * weight;
    }
    return floatTo16BitPCM(resampled);
  }

  async function startRecording() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("[voice] mic acquired");
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Resume explicitly; some browsers start suspended and otherwise no audio flows.
      await audioCtx.resume();
      console.log("[voice] audioCtx state:", audioCtx.state);
      const source = audioCtx.createMediaStreamSource(micStream);
      const sink = audioCtx.createGain();
      sink.gain.value = 0;
      sink.connect(audioCtx.destination);

      const bufferSize = 4096;
      processorNode = audioCtx.createScriptProcessor(bufferSize, source.channelCount, 1);
      processorNode.onaudioprocess = (e) => {
        if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN) return;
        try {
          const pcm16 = resampleToMonoPCM16(e.inputBuffer, 24000);

          // Safe base64 encoding (no spread operator)
          const bytes = new Uint8Array(pcm16.buffer);
          let binary = "";
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
          }
          const b64 = btoa(binary);

          console.log("[voice] send chunk bytes:", pcm16.byteLength, "ws state:", voiceWs.readyState);
          voiceWs.send(JSON.stringify({ type: "audio", data: b64 }));
        } catch (err) {
          console.warn("[voice] process send failed:", err?.message || err);
        }
      };

  
      source.connect(processorNode);
      processorNode.connect(sink);
    } catch (err) {
      console.warn("[voice] getUserMedia/AudioContext failed:", err?.message || err);
      setVoiceStatus("Mic permission failed");
      stopVoice();
    }
  }

  function stopRecording() {
    if (processorNode) {
      try { processorNode.disconnect(); } catch (_) {}
      processorNode.onaudioprocess = null;
      processorNode = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
    }
    if (micStream) {
      try { micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      micStream = null;
    }
  }

  // Expose helpers for manual testing (optional)
  window.startVoice = startVoice;
  window.stopVoice = stopVoice;
})();