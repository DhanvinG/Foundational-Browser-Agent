console.log("[background] service worker loaded");

importScripts("prompts.js", "llmClient.js");

const MSG_TYPES = {
  START_AGENT: "START_AGENT",
  OBSERVE_SHOW: "OBSERVE_SHOW",
  OBSERVE_HIDE: "OBSERVE_HIDE",
  EXEC_ACTION: "EXEC_ACTION",
};

const MAX_STEPS = 30;
const MAX_CONSECUTIVE_SCROLLS = 6;
let isAgentRunning = false;
let pendingUserReplyResolver = null;
const sessionState = new Map(); // per-tab state

const SUMMARIZE_ENDPOINT = "http://localhost:8000/summarize"; // placeholder; adjust as needed
const INTENT_ENDPOINT = "http://localhost:8000/intent"; // simple command intent classifier

// TODO: Stage 2 - wire wake-word/ASR via offscreen page when ready.

// Simple personalization profile used to auto-fill forms/emails.
const USER_PROFILE = {
  name: "Alex Chen",
  email: "alex.chen.dev@gmail.com",
  phone: "+1-415-867-3921",
  role: "Software Engineer",
  company: "Stripe",
  school: "University of California, Berkeley",
  skills: [
    "JavaScript",
    "TypeScript",
    "React",
    "Node.js",
    "Python",
    "AI Agents",
    "Distributed Systems"
  ],
  bio: "Software engineer at Stripe focused on building scalable, user-centered products at the intersection of AI and web platforms. Passionate about clean system design, low-latency experiences, and turning complex workflows into intuitive tools. Always experimenting, shipping, and iterating."
};

const SMALL_LLM_API_KEY = null; // set to your OpenAI API key if desired
const SMALL_LLM_MODEL = "gpt-4o-mini";
const PROFILE_ANSWER_ENDPOINT = "http://localhost:8000/profile-answer";
const TTS_ENDPOINT = "http://localhost:8000/tts";
const TTS_VOICE = "marin";

function answerFromProfile(question = "") {
  const q = (question || "").toLowerCase();
  const fields = [
    { key: "name", aliases: ["name"] },
    { key: "email", aliases: ["email", "e-mail"] },
    { key: "phone", aliases: ["phone", "phone number", "mobile"] },
    { key: "role", aliases: ["role", "title", "job title", "position"] },
    { key: "company", aliases: ["company", "employer", "organization"] },
    { key: "school", aliases: ["school", "university", "college"] },
    { key: "bio", aliases: ["bio", "background"] },
    { key: "skills", aliases: ["skills", "skillset"] },
  ];

  for (const f of fields) {
    const val = USER_PROFILE[f.key];
    if (!val || (Array.isArray(val) && val.length === 0)) continue;
    for (const alias of f.aliases) {
      if (q.includes(alias)) {
        if (Array.isArray(val)) {
          return val.join(", ");
        }
        return String(val);
      }
    }
  }
  return null;
}

// Non-streaming TTS: fetch a data URL and return it.
async function speakText(text = "") {
  if (!text) return null;
  try {
    const res = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: TTS_VOICE }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const audioUrl = data && data.audio;
    return typeof audioUrl === "string" ? audioUrl : null;
  } catch (err) {
    console.warn("[tts] failed:", err?.message || err);
    return null;
  }
}

function normalizeQuestionKey(q = "") {
  return q.toLowerCase().trim();
}

async function askSmallProfileLLM(question = "") {
  try {
    const res = await fetch(PROFILE_ANSWER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question || "", user_profile: USER_PROFILE }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ans = data && data.answer;
    if (typeof ans !== "string") return null;
    return ans.trim();
  } catch (err) {
    console.warn("[profile-llm] failed:", err?.message || err);
    return null;
  }
}

async function autoAnswerAskUser(question = "", askCache = null) {
  const key = normalizeQuestionKey(question);
  if (askCache && askCache[key]) return askCache[key];

  const auto = await askSmallProfileLLM(question || "");
  if (auto) {
    const upper = auto.toUpperCase().trim();
    if (upper !== "UNKNOWN") {
      if (askCache) askCache[key] = auto;
      return auto;
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function triggerShowShortcut(tabId) {
  try {
    let targetTabId = null;
    const tabs = await chrome.tabs.query({});
    let highestId = null;
    for (const t of tabs) {
      if (t && typeof t.id === "number") {
        if (highestId === null || t.id > highestId) {
          highestId = t.id;
        }
      }
    }
    // Always target the highest tab id, regardless of the provided tabId.
    targetTabId = highestId;
    console.log("[agent] triggerShowShortcut: highest tab id:", highestId, "targeting tab id:", targetTabId);
    if (targetTabId === null) {
      console.warn("[agent] triggerShowShortcut: no tabs found");
      return null;
    }

    console.log("[agent] triggerShowShortcut: targeting tab id:", targetTabId);

    await chrome.tabs.update(targetTabId, { active: true });
    const frameId = await getBestFrameId(targetTabId);
    console.log("[agent] triggerShowShortcut: targeting frame", frameId);
    console.log("[agent] triggerShowShortcut chose frame id:", frameId);
    const showResult = await sendMessageToTab(targetTabId, { type: MSG_TYPES.OBSERVE_SHOW }, frameId);
    await sleep(50);
    const hideResult = await sendMessageToTab(targetTabId, { type: MSG_TYPES.OBSERVE_HIDE }, frameId);
    const screenshotDataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
        const err = chrome.runtime.lastError;
        if (err || !dataUrl) {
          reject(err || new Error("captureVisibleTab failed"));
          return;
        }
        resolve(dataUrl);
      });
    });
    console.log("[agent] triggerShowShortcut: tab", targetTabId, "frame", frameId, "captured screenshot length", screenshotDataUrl?.length || 0);
    return {
      frameId,
      screenshotDataUrl,
      showResult,
      hideResult,
    };
  } catch (err) {
    console.warn("[agent] triggerShowShortcut failed:", err?.message || err);
    return null;
  }
}

async function handleTextCommand(rawText) {
  const text = (rawText || "").trim();
  if (!text) return;

  const lowered = text.toLowerCase();
  const hotwords = ["hey cora", "hey quora", "hey clara"];
  const matchedHotword = hotwords.find((hw) => lowered.startsWith(hw));
  const stripped = matchedHotword ? text.slice(matchedHotword.length).trim() : text;

  if (matchedHotword) {
    // tell UI to go orange and animate
    const tab = await getActiveTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: "UI_HOTWORD_START" }, { frameId: 0 }, () => {});
    }
    const summarizeReason = summarizeTriggerMatch(stripped);
    if (summarizeReason) {
      console.log("[summarize] trigger matched:", summarizeReason, "text:", stripped);
      await summarizeScreenshot(stripped);
      return;
    }
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: "UI_LISTENING_STOP" }, { frameId: 0 }, () => {});
    }
    startAgent(stripped).catch((e) => console.error("[agent] crashed:", e));
    return;
  }

  // First try LLM intent classifier for flexible phrasing
  const llmSimple = await classifyIntent(stripped);
  if (llmSimple) {
    await runSimpleCommand(llmSimple);
    return;
  }

  // Fallback to local keyword detection
  const simple = detectSimpleCommand(stripped);
  if (simple) {
    await runSimpleCommand(simple);
  } else {
    console.log("[router] Ignored non-hey-cora non-simple text");
  }
}

function summarizeTriggerMatch(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("summarize")) return "summarize";
  if (t.includes("explain")) return "explain";
  if (t.includes("what is")) return "what is";
  if (t.includes("what does")) return "what does";
  if (t.startsWith("describe ")) return "describe";
  const whatAboutPattern = /\bwhat(?:'s| is)\s+.*about\b/;
  if (whatAboutPattern.test(t)) return "what's about";
  if (t.includes("how")) return "how";
  return null;
}

function isSummarizeRequest(text) {
  return summarizeTriggerMatch(text) !== null;
}

function detectSimpleCommand(text) {
  const t = (text || "").toLowerCase().trim();
  if (!t) return null;

  if (t === "show overlays" || t === "show overlay") return { kind: "show_overlays" };
  if (t === "hide overlays" || t === "hide overlay") return { kind: "hide_overlays" };

  if (t.includes("scroll")) {
    if (t.includes("top")) return { kind: "scroll", value: "top" };
    if (t.includes("bottom") || t.includes("end")) return { kind: "scroll", value: "bottom" };
    if (t.includes("up")) return { kind: "scroll", value: "up" };
    if (t.includes("down")) return { kind: "scroll", value: "down" };
  }

  if (t === "next tab") return { kind: "tab", value: "next" };
  if (t === "previous tab" || t === "prev tab") return { kind: "tab", value: "prev" };

  const clickNum = t.match(/^(?:click|choose|select|press)\s+(\d+)$/);
  if (clickNum) return { kind: "click_index", value: Number(clickNum[1]) };

  const tabNum = t.match(/^tab\s+(\d+)$/);
  if (tabNum) return { kind: "switch_tab", value: Number(tabNum[1]) };

  const searchMatch = t.match(/^(?:search|google)\s+(.+)/);
  if (searchMatch) return { kind: "search", value: searchMatch[1].trim() };

  const openMatch = t.match(/^(?:open)\s+(.+)/);
  if (openMatch) return { kind: "open_url", value: openMatch[1].trim() };

  return null;
}

async function runSimpleCommand(cmd) {
  if (!cmd) return;
  const tab = await getActiveTab();
  if (!tab) {
    console.warn("[router] No active tab for simple command");
    return;
  }

  switch (cmd.kind) {
    case "show_overlays":
      chrome.tabs.sendMessage(tab.id, { type: "OBSERVE_SHOW" }, { frameId: 0 }, () => {});
      return;
    case "hide_overlays":
      chrome.tabs.sendMessage(tab.id, { type: "OBSERVE_HIDE" }, { frameId: 0 }, () => {});
      return;
    case "scroll":
      chrome.tabs.sendMessage(
        tab.id,
        { type: "EXEC_ACTION", action: "scroll", value: cmd.value },
        { frameId: 0 },
        () => {}
      );
      return;
    case "click_index":
      chrome.tabs.sendMessage(
        tab.id,
        { type: "EXEC_ACTION", action: "click_index", value: cmd.value },
        { frameId: 0 },
        () => {}
      );
      return;
    case "tab":
      chrome.tabs.query({ active: true }, (tabs) => {
        const active = tabs[0];
        if (!active) return;
        chrome.tabs.query({}, (all) => {
          const idx = all.findIndex((t) => t.id === active.id);
          if (idx === -1) return;
          const nextIdx = cmd.value === "next" ? (idx + 1) % all.length : (idx - 1 + all.length) % all.length;
          const target = all[nextIdx];
          if (target) chrome.tabs.update(target.id, { active: true });
        });
      });
      return;
    case "switch_tab":
      chrome.tabs.query({}, (tabs) => {
        const target = tabs[cmd.value - 1];
        if (target) chrome.tabs.update(target.id, { active: true });
      });
      return;
    case "search": {
      const q = cmd.value;
      const url = q.includes(".") ? (q.startsWith("http") ? q : `https://${q}`) : `https://www.google.com/search?q=${encodeURIComponent(q)}`;
      chrome.tabs.create({ url });
      return;
    }
    case "open_url": {
      const url = cmd.value.startsWith("http") ? cmd.value : `https://${cmd.value}`;
      chrome.tabs.create({ url });
      return;
    }
    default:
      return;
  }
}

async function classifyIntent(text) {
  if (!text) return null;
  try {
    const res = await fetch(INTENT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const action = data && data.action;
    const value = data ? data.value : null;
    if (!action) return null;

    // Map intent action/value to runSimpleCommand payload
    switch (action) {
      case "show_overlays":
        return { kind: "show_overlays" };
      case "hide_overlays":
        return { kind: "hide_overlays" };
      case "scroll":
        if (typeof value === "string") return { kind: "scroll", value };
        return null;
      case "click_index":
        if (Number.isInteger(value)) return { kind: "click_index", value };
        return null;
      case "switch_tab":
        if (value === "next" || value === "prev") return { kind: "tab", value };
        if (Number.isInteger(value)) return { kind: "switch_tab", value };
        return null;
      case "search":
        if (typeof value === "string") return { kind: "search", value };
        return null;
      case "open_url":
        if (typeof value === "string") return { kind: "open_url", value };
        return null;
      default:
        return null;
    }
  } catch (err) {
    console.warn("[intent] classify failed:", err);
    return null;
  }
}

async function summarizeScreenshot(questionText) {
  const tab = await getActiveTab();
  if (!tab) {
    console.warn("[summarize] No active tab to capture");
    return;
  }
  if (isDisallowedUrl(tab.url)) {
    console.warn("[summarize] Cannot capture chrome:// or extension pages");
    return;
  }

  let screenshotDataUrl = "";
  try {
    screenshotDataUrl = await captureVisibleTab(tab.windowId);
  } catch (err) {
    console.error("[summarize] Failed to capture screenshot:", err);
    return;
  }

  try {
    const answer = await callSummarizeLLM({
      question: questionText || "Summarize the visible page.",
      screenshotDataUrl,
    });
    console.log("[summarize] Answer:", answer);
    // store last summary for this tab
    const state = sessionState.get(tab.id) || {
      lastSummary: "",
      lastPageContext: "",
      lastUserReply: "",
      recentActions: [],
    };
    state.lastSummary = (answer || "").slice(0, 500);
    sessionState.set(tab.id, state);

    chrome.tabs.sendMessage(tab.id, { type: "UI_RESPONSE_SHOW", text: answer || "" }, { frameId: 0 }, () => {});
    chrome.tabs.sendMessage(tab.id, { type: "SHOW_SUMMARY", summary: answer }, { frameId: 0 }, () => {});
    // Speak the summary (fire and forget) in background; pill collapses when PLAY_TTS ends (handled in content).
    speakText(answer || "").then((audioUrl) => {
      if (audioUrl) {
        chrome.tabs.sendMessage(tab.id, { type: "PLAY_TTS", audioUrl }, { frameId: 0 }, () => {});
      }
    }).catch(() => {});
  } catch (err) {
    console.error("[summarize] Summarization failed:", err);
  }
}

function captureVisibleTab(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      const err = chrome.runtime.lastError;
      if (err || !dataUrl) {
        reject(err || new Error("captureVisibleTab failed"));
        return;
      }
      resolve(dataUrl);
    });
  });
}

async function callSummarizeLLM(payload) {
  const body = {
    question: payload.question,
    screenshotDataUrl: payload.screenshotDataUrl,
  };

  const res = await fetch(SUMMARIZE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Summarize HTTP error: ${res.status}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }

  if (data && typeof data.answer === "string") return data.answer;
  const text = data && typeof data === "string" ? data : "";
  return text || "No summary available.";
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === MSG_TYPES.START_AGENT) {
    startAgent(msg.goalText || "", undefined, msg.mode).catch((e) => console.error("[agent] crashed:", e));
    return;
  }

  if (msg.type === "TEXT_COMMAND") {
    handleTextCommand(msg.text || "").catch((e) => console.error("[router] crashed:", e));
    return;
  }

  if (msg.type === "START_AGENT_AT_URL") {
    startAgentAtUrl(msg.url, msg.goalText || "", msg.mode);
    return;
  }

  if (msg.type === "USER_REPLY" && pendingUserReplyResolver) {
    pendingUserReplyResolver(msg.reply || "");
    pendingUserReplyResolver = null;
    sendResponse?.({ success: true });
    return;
  }

  if (msg.type === "broadcast-overlay-command") {
    broadcastOverlayCommand(msg);
    return;
  }

  handleLegacyMessage(msg);
});

async function broadcastOverlayCommand(msg) {
  const tab = await getActiveTab();
  if (!tab) return;

  chrome.tabs.sendMessage(
    tab.id,
    { type: "overlay-command", action: msg.action, index: msg.index },
    { frameId: 0 }
  );
}


function handleLegacyMessage(msg) {
  chrome.tabs.query({ currentWindow: true }, (tabs) => {
    if (msg.type === "switch-tab") {
      const targetTab = tabs[msg.index - 1];
      if (targetTab) chrome.tabs.update(targetTab.id, { active: true });
      return;
    }

    if (msg.type === "last-tab") {
      const lastTab = tabs[tabs.length - 1];
      if (lastTab) chrome.tabs.update(lastTab.id, { active: true });
      return;
    }

    if (msg.type === "next-tab" || msg.type === "previous-tab") {
      chrome.tabs.query({ currentWindow: true, active: true }, (activeTabs) => {
        const activeTab = activeTabs[0];
        const currentIndex = tabs.findIndex((tab) => tab.id === activeTab.id);

        if (msg.type === "next-tab") {
          const next = tabs[(currentIndex + 1) % tabs.length];
          chrome.tabs.update(next.id, { active: true });
        } else {
          const prev = tabs[(currentIndex - 1 + tabs.length) % tabs.length];
          chrome.tabs.update(prev.id, { active: true });
        }
      });
      return;
    }

    if (msg.type === "reopen-tab") {
      chrome.sessions.restore();
      return;
    }

    if (msg.type === "search-query") {
      const query = msg.query.toLowerCase();
      let url;

      if (query.includes(".")) {
        url = query.startsWith("http") ? query : `https://${query}`;
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      }

      chrome.tabs.create({ url });
      return;
    }

    if (msg.type === "close-tab") {
      chrome.tabs.query({ currentWindow: true, active: true }, (activeTabs) => {
        const currentTab = activeTabs[0];
        if (currentTab) chrome.tabs.remove(currentTab.id);
      });
    }
  });
}

async function startAgent(goalText, lockedTarget, mode) {
  if (isAgentRunning) {
    console.warn("[agent] Already running; ignoring START_AGENT");
    return;
  }

  let initialTab;
  if (lockedTarget && lockedTarget.tabId && lockedTarget.windowId !== undefined) {
    initialTab = await getTabById(lockedTarget.tabId);
    if (!initialTab) {
      console.warn("[agent] Locked tab not found; cannot start");
      return;
    }
  } else {
    initialTab = await getActiveTab();
  }

  if (!initialTab || !initialTab.id || initialTab.windowId === undefined) {
    console.warn("[agent] No active tab found; cannot start");
    return;
  }

  if (isDisallowedUrl(initialTab.url)) {
    console.error("[agent] Cannot run agent on chrome:// pages; switch to a normal website tab and restart");
    return;
  }

  const agentTabId = lockedTarget?.tabId ?? initialTab.id;
  const agentWindowId = lockedTarget?.windowId ?? initialTab.windowId;
  const agentMode = mode === "planner_executor" ? "planner_executor" : "baseline";

  isAgentRunning = true;
  console.log(
    "[agent] Starting agent with goal:",
    goalText,
    "tab:",
    agentTabId,
    "window:",
    agentWindowId,
    "mode:",
    agentMode
  );

  const state = sessionState.get(agentTabId) || {
    lastSummary: "",
    lastPageContext: "",
    lastUserReply: "",
    recentActions: [],
  };
  sessionState.set(agentTabId, state);

  try {
    if (agentMode === "planner_executor") {
      await runAgentPlannerExecutor({
        goalText,
        agentTabId,
        agentWindowId,
        state,
      });
    } else {
      await runAgentBaseline({
        goalText,
        agentTabId,
        agentWindowId,
        state,
      });
    }
  } finally {
    isAgentRunning = false;
    console.log("[agent] Stopped");
    try {
      const tab = await getTabById(agentTabId);
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: "UI_HOTWORD_STOP" }, { frameId: 0 }, () => {});
      }
    } catch (_) {}
  }
}

async function runAgentBaseline({ goalText, agentTabId, agentWindowId, state }) {
  const actionHistory = [];
  let consecutiveScrolls = 0;
  let pendingUserReply = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    const currentTab = await getTabById(agentTabId);
    if (!currentTab) {
      console.warn("[agent] Agent tab no longer exists; stopping");
      break;
    }

    if (isDisallowedUrl(currentTab.url)) {
      console.error("[agent] Cannot run agent on chrome:// pages; switch to a normal website tab and restart");
      break;
    }

    let observation = await observeTab({
      tabId: agentTabId,
      windowId: agentWindowId,
      url: currentTab.url,
      title: currentTab.title,
    });
    if (!observation) {
      console.warn("[agent] Observation failed; stopping");
      break;
    }
    if (!observation.elements || observation.elements.length <= 1) {
      console.warn("[agent] Low candidate count (<=1); re-observing once");
      const fallbackInfo = await triggerShowShortcut(agentTabId);
      const targetFrameId = fallbackInfo?.frameId ?? 0;
      const retryObs = await observeTab({
        tabId: agentTabId,
        windowId: agentWindowId,
        url: currentTab.url,
        title: currentTab.title,
        waitMs: 6000,
        frameId: targetFrameId,
      });
      if (!retryObs || !retryObs.elements || retryObs.elements.length <= 3) {
        console.warn("[agent] No sufficient overlays after re-observe; stopping");
        break;
      }
      const shot = fallbackInfo?.screenshotDataUrl || retryObs.screenshotDataUrl;
      observation = {
        ...retryObs,
        screenshotDataUrl: shot,
        frameId: targetFrameId,
      };
      console.log(
        "[agent] Fallback observation succeeded; frame:",
        targetFrameId,
        "candidates:",
        retryObs.elements.length,
        "screenshot len:",
        shot ? shot.length : 0
      );
    }

    let decision;
    try {
      decision = await getNextAction({
        goalText,
        screenshotDataUrl: observation.screenshotDataUrl,
        url: currentTab.url || "",
        title: currentTab.title || "",
        actionHistory,
        elements: observation.elements || [],
        userReply: pendingUserReply,
        pageContext: observation.pageContext || state.lastPageContext || "",
        lastSummary: state.lastSummary || "",
        userProfile: USER_PROFILE,
      });
      pendingUserReply = "";
    } catch (err) {
      console.error("[agent] Decision error:", err);
      break;
    }

    if (!decision || typeof decision.action !== "string") {
      console.warn("[agent] Invalid decision payload; stopping");
      break;
    }

    let { action, value } = decision;
    console.log("[agent] Step", step + 1, "- decided:", decision);

    if (action === "done") {
      console.log("[agent] Goal complete; stopping");
      break;
    }
    if (action === "report_error") {
      console.warn("[agent] report_error from LLM:", value);
      break;
    }

    if (action === "ask_user") {
      const auto = await autoAnswerAskUser(value || "");
      if (auto) {
        actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${auto.slice(0, 80)}`, true));
        pendingUserReply = auto;
        continue;
      }
      const reply = await promptUser(value, agentTabId);
      if (!reply) {
        console.warn("[agent] No user reply; stopping");
        break;
      }
      actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${reply.slice(0, 80)}`, true));
      pendingUserReply = reply;
      continue;
    }

    const executed = await executeAction(
      agentTabId,
      action,
      value,
      actionHistory,
      observation.elements || [],
      currentTab.url || "",
      state,
      observation.frameId || 0
    );
    if (!executed || executed.ok !== true) {
      const errMsg = (executed && executed.error) || "action_failed";
      if (errMsg.toLowerCase().includes("no candidate found")) {
        const recovered = await runBaselineRecovery({
          goalText,
          agentTabId,
          agentWindowId,
          actionHistory,
          pendingUserReply,
          state,
          lastError: errMsg,
          frameId: observation.frameId || 0,
        });
        if (recovered) {
          continue;
        }
      }
      console.warn("[agent] Action failed; stopping");
      break;
    }

    consecutiveScrolls = action === "scroll" ? consecutiveScrolls + 1 : 0;

    if (consecutiveScrolls > MAX_CONSECUTIVE_SCROLLS) {
      console.warn("[agent] Too many consecutive scroll actions; stopping");
      break;
    }
  }
}

async function runBaselineRecovery({ goalText, agentTabId, agentWindowId, actionHistory, pendingUserReply, state, lastError, frameId = 0 }) {
  try {
    const tab = await getTabById(agentTabId);
    if (!tab) return false;
    const observation = await observeTab({
      tabId: agentTabId,
      windowId: agentWindowId,
      url: tab.url,
      title: tab.title,
      frameId,
    });
    if (!observation) return false;

    let statusResp;
    try {
      statusResp = await self.requestStatus({
        statusPrompt: self.STATUS_PROMPT || "",
        goalText: goalText || "",
        screenshotDataUrl: observation.screenshotDataUrl || "",
        meta: {
          url: observation.url || tab.url || "",
          title: observation.title || tab.title || "",
          pageContext: observation.pageContext || "",
          elements: observation.elements || [],
          actionHistory: actionHistory.slice(-5),
          userReply: pendingUserReply || "",
          lastSummary: state.lastSummary || "",
          recentActions: state.recentActions || [],
          userProfile: USER_PROFILE,
        },
      });
    } catch (err) {
      console.warn("[agent][status] Status check failed:", err);
      statusResp = null;
    }

    if (statusResp && statusResp.status === "done") {
      console.log("[agent][status] Goal already satisfied per status check; stopping");
      return true;
    }

    const missingNote = (statusResp && typeof statusResp.missing === "string" && statusResp.missing) || lastError || "";
    console.warn("[agent][status] Retry after status check; missing:", missingNote);

    let retryDecision;
    try {
      retryDecision = await self.requestAgentStep({
        goalText,
        screenshotDataUrl: observation.screenshotDataUrl || "",
        url: observation.url || tab.url || "",
        title: observation.title || tab.title || "",
        actionHistory,
        elements: observation.elements || [],
        userReply: pendingUserReply,
        pageContext: observation.pageContext || state.lastPageContext || "",
        lastSummary: state.lastSummary || "",
        lastError: missingNote,
        userProfile: USER_PROFILE,
      });
    } catch (err) {
      console.error("[agent][status] Retry decision failed:", err);
      return false;
    }

    if (!retryDecision || typeof retryDecision.action !== "string") {
      console.warn("[agent][status] Invalid retry decision");
      return false;
    }

    const executed = await executeAction(
      agentTabId,
      retryDecision.action,
      retryDecision.value,
      actionHistory,
      observation.elements || [],
      observation.url || tab.url || "",
      state,
      observation.frameId || frameId || 0
    );
    if (!executed || executed.ok !== true) {
      console.warn("[agent][status] Retry execute failed");
      return false;
    }

    console.log("[agent][status] Retry succeeded");
    return true;
  } catch (err) {
    console.warn("[agent][status] Recovery error:", err);
    return false;
  }
}

async function runAgentPlannerExecutor({ goalText, agentTabId, agentWindowId, state }) {
  const actionHistory = [];
  let pendingUserReply = "";
  let lastError = "";
  let lastObservation = null;

  const metrics = {
    startTime: Date.now(),
    stepsExecuted: 0,
    observeCalls: 0,
    plannerCalls: 0,
    executorCalls: 0,
    fallbackCalls: 0,
    observeDurations: [],
    plannerDurations: [],
    executorDurations: [],
  };

  const recordObservation = async () => {
    const tab = await getTabById(agentTabId);
    if (!tab) return null;
    const t0 = Date.now();
    const observation = await observeTab({
      tabId: agentTabId,
      windowId: agentWindowId,
      url: tab.url,
      title: tab.title,
    });
    metrics.observeCalls += 1;
    metrics.observeDurations.push(Date.now() - t0);
    if (observation && observation.pageContext) {
      state.lastPageContext = observation.pageContext;
    }
    return observation;
  };

  const buildMeta = (observation, extraMeta = {}) => ({
    url: (observation && observation.url) || "",
    title: (observation && observation.title) || "",
    actionHistory,
    elements: (observation && observation.elements) || [],
    pageContext: (observation && observation.pageContext) || state.lastPageContext || "",
    lastSummary: state.lastSummary || "",
    userReply: pendingUserReply,
    recentActions: state.recentActions || [],
    ...extraMeta,
  });

  const callPlanner = async (observation, extraMeta = {}) => {
    const t0 = Date.now();
    const resp = await self.requestPlan({
      controllerPrompt: self.PLANNER_PROMPT || "",
      goalText: goalText || "",
      screenshotDataUrl: observation?.screenshotDataUrl || "",
      meta: buildMeta(observation, extraMeta),
    });
    metrics.plannerCalls += 1;
    metrics.plannerDurations.push(Date.now() - t0);
    try {
      const planArr = Array.isArray(resp?.plan) ? resp.plan : [];
      const stepIds = planArr.map((s) => s?.id || "?").join(", ");
      console.log("[agent][planner] plan received:", planArr.length, "steps ids:", stepIds);
    } catch (e) {
      console.warn("[agent][planner] plan logging failed:", e);
    }
    return resp;
  };

  const callExecutor = async (observation, step, extraMeta = {}) => {
    const t0 = Date.now();
    const decision = await self.requestExecuteStep({
      executorPrompt: self.EXECUTOR_PROMPT || "",
      goalText: goalText || "",
      step,
      meta: buildMeta(observation, extraMeta),
    });
    metrics.executorCalls += 1;
    metrics.executorDurations.push(Date.now() - t0);
    try {
      console.log(
        "[agent][planner] executor decision for",
        step?.id || "no-id",
        "action:",
        decision?.action,
        "conf:",
        decision?.confidence,
        "allowed:",
        Array.isArray(step?.allowed_actions) ? step.allowed_actions.join(",") : ""
      );
    } catch (e) {
      console.warn("[agent][planner] executor logging failed:", e);
    }
    return decision;
  };

  const verifyStep = async (step, observation) => {
    const verify = step && typeof step === "object" ? step.verify : null;
    if (!verify || typeof verify !== "object") {
      return { passed: true, observation, reason: "" };
    }

    let latestObservation = observation;
    if (verify.url_includes) {
      try {
        await waitForTabComplete(agentTabId).catch(() => {});
      } catch (_) {}
      const tab = await getTabById(agentTabId);
      const currentUrl = (tab && tab.url) || (latestObservation && latestObservation.url) || "";
      if (!currentUrl.includes(verify.url_includes)) {
        return { passed: false, observation: latestObservation, reason: `url missing "${verify.url_includes}"` };
      }
    }

    const includesAny = Array.isArray(verify.page_includes_any) ? verify.page_includes_any : [];
    const excludesAny = Array.isArray(verify.page_excludes_any) ? verify.page_excludes_any : [];
    const needsPageCheck = includesAny.length || excludesAny.length;
    if (needsPageCheck) {
      const refreshed = await recordObservation();
      if (refreshed) {
        latestObservation = refreshed;
      }
      const pageText = ((latestObservation && latestObservation.pageContext) || "").toLowerCase();
      if (includesAny.length) {
        const hasInclude = includesAny.some((frag) => pageText.includes((frag || "").toLowerCase()));
        if (!hasInclude) {
          return { passed: false, observation: latestObservation, reason: "page_includes_any not found" };
        }
      }
      if (excludesAny.length) {
        const hasExclude = excludesAny.some((frag) => pageText.includes((frag || "").toLowerCase()));
        if (hasExclude) {
          return { passed: false, observation: latestObservation, reason: "page_excludes_any present" };
        }
      }
    }

    return { passed: true, observation: latestObservation, reason: "" };
  };

  try {
    lastObservation = await recordObservation();
    if (!lastObservation) {
      console.warn("[agent][planner] Initial observation failed; stopping");
      return;
    }

    let planResp;
    try {
      planResp = await callPlanner(lastObservation, { lastError });
    } catch (err) {
      console.error("[agent][planner] Planner call failed:", err);
      return;
    }

    let plan = Array.isArray(planResp?.plan) ? planResp.plan : [];
    if (!plan.length) {
      console.warn("[agent][planner] Planner returned empty plan; stopping");
      return;
    }

    let planIndex = 0;
    while (planIndex < plan.length && metrics.stepsExecuted < MAX_STEPS) {
      const currentTab = await getTabById(agentTabId);
      if (!currentTab) {
        console.warn("[agent][planner] Agent tab no longer exists; stopping");
        break;
      }

      if (isDisallowedUrl(currentTab.url)) {
        console.error("[agent][planner] Cannot run agent on chrome:// pages; stopping");
        break;
      }

      const step = plan[planIndex];
      planIndex += 1;

      lastObservation = await recordObservation();
      if (!lastObservation) {
        console.warn("[agent][planner] Observation failed; stopping");
        break;
      }

      let decision;
      try {
        decision = await callExecutor(lastObservation, step, { planStepId: step?.id || "" });
      } catch (err) {
        console.warn("[agent][planner] Executor call failed:", err);
        decision = null;
      }

      let action = decision?.action;
      let value = decision?.value;
      let confidence = typeof decision?.confidence === "number" ? decision.confidence : 0;

      if (!decision || confidence < 0.55 || (action === "report_error" && value === "NEED_FALLBACK")) {
        metrics.fallbackCalls += 1;
        console.warn(
          "[agent][planner] low confidence or NEED_FALLBACK; using baseline. step:",
          step?.id || "no-id",
          "conf:",
          confidence,
          "action:",
          action
        );
        try {
          const fallbackDecision = await self.requestAgentStep({
            goalText,
            screenshotDataUrl: lastObservation.screenshotDataUrl || "",
            url: lastObservation.url || currentTab.url || "",
            title: lastObservation.title || currentTab.title || "",
            actionHistory,
            elements: lastObservation.elements || [],
            userReply: pendingUserReply,
          });
          action = fallbackDecision.action;
          value = fallbackDecision.value;
          confidence = 1;
        } catch (err) {
          console.error("[agent][planner] Fallback agent-step failed:", err);
          break;
        }
      }

      pendingUserReply = "";
      if (!action) {
        console.warn("[agent][planner] Missing action after executor/fallback; stopping");
        break;
      }

      console.log("[agent][planner] Step", metrics.stepsExecuted + 1, "-", step?.id || "no-id", "action:", action, "conf:", confidence);

      if (action === "done") {
        metrics.stepsExecuted += 1;
        break;
      }
      if (action === "report_error") {
        metrics.stepsExecuted += 1;
        console.warn("[agent][planner] report_error:", value);
        break;
      }

      if (action === "ask_user") {
        const auto = await autoAnswerAskUser(value || "");
        if (auto) {
          actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${auto.slice(0, 80)}`, true));
          pendingUserReply = auto;
          metrics.stepsExecuted += 1;
          continue;
        }
        const reply = await promptUser(value, agentTabId);
        if (!reply) {
          console.warn("[agent][planner] No user reply; stopping");
          break;
        }
        actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${reply.slice(0, 80)}`, true));
        pendingUserReply = reply;
        metrics.stepsExecuted += 1;
        continue;
      }

      const executed = await executeAction(
        agentTabId,
        action,
        value,
        actionHistory,
        lastObservation.elements || [],
        currentTab.url || "",
        state,
        lastObservation.frameId || 0
      );
      if (!executed || executed.ok !== true) {
        console.warn("[agent][planner] Action failed; stopping");
        break;
      }

      metrics.stepsExecuted += 1;
      lastError = "";

      const verifyResult = await verifyStep(step, lastObservation);
      if (!verifyResult.passed) {
        lastError = verifyResult.reason;
        lastObservation = verifyResult.observation || lastObservation;
        console.warn("[agent][planner] Verification failed:", lastError);
        try {
          const replanResp = await callPlanner(lastObservation, {
            lastError: `${step?.id || "step"}: ${lastError}`,
            failedStep: step?.id || "",
          });
          plan = Array.isArray(replanResp?.plan) ? replanResp.plan : [];
          planIndex = 0;
          if (!plan.length) {
            console.warn("[agent][planner] Replan returned empty plan; stopping");
            break;
          }
          console.log("[agent][planner] Replan triggered; new plan length:", plan.length);
          continue;
        } catch (err) {
          console.error("[agent][planner] Replan failed:", err);
          break;
        }
      }
    }
  } finally {
    await sendPlannerSummary(agentTabId, metrics);
  }
}

async function sendPlannerSummary(tabId, metrics) {
  if (!tabId || !metrics) return;
  const totalMs = Math.max(0, Date.now() - (metrics.startTime || Date.now()));
  const avg = (list) => {
    if (!Array.isArray(list) || !list.length) return 0;
    const sum = list.reduce((acc, cur) => acc + cur, 0);
    return Math.round(sum / list.length);
  };

  const summaryLines = [
    "mode: planner_executor",
    `total_ms: ${totalMs}`,
    `steps_executed: ${metrics.stepsExecuted || 0}`,
    `observe_calls: ${metrics.observeCalls || 0}`,
    `planner_calls: ${metrics.plannerCalls || 0}`,
    `executor_calls: ${metrics.executorCalls || 0}`,
    `fallback_calls: ${metrics.fallbackCalls || 0}`,
    `avg_planner_ms: ${avg(metrics.plannerDurations)}`,
    `avg_executor_ms: ${avg(metrics.executorDurations)}`,
  ];

  try {
    await sendMessageToTab(tabId, { type: "SHOW_SUMMARY", summary: summaryLines.join("\n") });
  } catch (err) {
    console.warn("[agent][planner] Failed to send summary:", err);
  }
}

async function observeTab({ tabId, windowId, url, title, waitMs = 10, frameId = 0 }) {
  let attempts = 0;
  while (attempts < 2) {
    try {
      const showResult = await sendMessageToTab(tabId, { type: MSG_TYPES.OBSERVE_SHOW }, frameId);
      if (!showResult || showResult.success === false) {
        console.warn("[agent] OBSERVE_SHOW failed:", showResult && showResult.error);
        attempts++;
        if (attempts >= 2) return null;
        await tryInjectContentScript(tabId);
        continue;
      }

      await sleep(waitMs);
      const screenshotDataUrl = await captureVisibleTab(windowId);

      const hideResult = await sendMessageToTab(tabId, { type: MSG_TYPES.OBSERVE_HIDE }, frameId);
      if (!hideResult || hideResult.success === false) {
        console.warn("[agent] OBSERVE_HIDE failed:", hideResult && hideResult.error);
        attempts++;
        if (attempts >= 2) return null;
        await tryInjectContentScript(tabId);
        continue;
      }

      console.log(
        "[agent] Observed tab with overlays; candidates:",
        showResult.count !== undefined ? showResult.count : "unknown"
      );

      return {
        screenshotDataUrl,
        url: url || "",
        title: title || "",
        elements: showResult.elements || [],
        pageContext: showResult.pageContext || "",
        frameId,
      };
    } catch (err) {
      attempts++;
      if (attempts >= 2) {
        console.error("[agent] Observation error:", err);
        return null;
      }
      await tryInjectContentScript(tabId);
    }
  }
  return null;
}

async function executeAction(tabId, action, value, actionHistory, elements, currentUrl, state, frameId = 0) {
  try {
    if (action === "switch_tab") {
      await switchTabDirection(value);
      await waitForTabComplete(tabId).catch(() => {});
      actionHistory?.push(formatActionHistoryEntry(action, value, "switched tab", true));
      console.log("[agent] Switched tab:", value);
      updateRecentState(tabId, action, value);
      return { ok: true, info: "switched tab" };
    }

    if (action === "open_url") {
      await openUrlInTab(tabId, value);
      await waitForTabComplete(tabId);
      actionHistory?.push(formatActionHistoryEntry(action, value, "navigated", true));
      console.log("[agent] Navigated to URL:", value);
      updateRecentState(tabId, action, value);
      return { ok: true, info: "navigated" };
    }

    if (action === "search") {
      const query = typeof value === "string" ? value : "";
      const searchUrl = query.includes(".")
        ? (query.startsWith("http") ? query : `https://${query}`)
        : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      await openUrlInTab(tabId, searchUrl);
      await waitForTabComplete(tabId);
      actionHistory?.push(formatActionHistoryEntry(action, value, "searched", true));
      console.log("[agent] Searched:", query);
      updateRecentState(tabId, action, value);
      return { ok: true, info: "searched" };
    }

    if (["click_index", "type_text", "select_type", "scroll"].includes(action)) {
      let result;
      let attemptedRetry = false;
      while (true) {
        try {
          result = await sendMessageToTab(tabId, { type: MSG_TYPES.EXEC_ACTION, action, value }, frameId);
        } catch (err) {
          const msg = err && err.message ? err.message.toLowerCase() : "";
          const needRetry =
            !attemptedRetry &&
            (msg.includes("receiving end does not exist") || msg.includes("could not establish connection"));
          if (needRetry) {
            attemptedRetry = true;
            console.warn("[agent] Content script missing; reinjecting and retrying action");
            await ensureContentScriptInjected(tabId).catch(() => {});
            continue;
          }
          console.warn("[agent] Content action failed:", err);
          return { ok: false, error: err && err.message ? err.message : "content_action_failed" };
        }

        if (!result || result.success === false) {
          const errStr = (result && result.error) || "";
          const lowerErr = errStr.toLowerCase();
          const needRetry =
            !attemptedRetry &&
            (lowerErr.includes("receiving end does not exist") || lowerErr.includes("could not establish connection"));
          if (needRetry) {
            attemptedRetry = true;
            console.warn("[agent] Content script missing (result); reinjecting and retrying action");
            await ensureContentScriptInjected(tabId).catch(() => {});
            continue;
          }
          console.warn("[agent] Content action failed:", result && result.error);
          return { ok: false, error: errStr || "content_action_failed" };
        }
        break;
      }
      actionHistory?.push(formatActionHistoryEntry(action, value, result.info, true));
      console.log("[agent] Content action success:", result.info || action);

      if (action === "click_index") {
        const desc = findElementDescriptor(elements, value);
        const needsPause = isDriveUrl(currentUrl) ? isMenuLikeDescriptor(desc) : isLikelyModalTrigger(desc);
        if (needsPause) await sleep(50);
      }
      updateRecentState(tabId, action, value);
      return { ok: true };
    }

    if (action === "ask_user") {
      const auto = await autoAnswerAskUser(value || "");
      if (auto) {
        actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${auto.slice(0, 80)}`, true));
        state.lastUserReply = auto;
        updateRecentState(tabId, action, value);
        return { ok: true, info: "user_reply_captured" };
      }
      const reply = await promptUser(value, tabId);
      if (!reply) {
        console.warn("[agent] ask_user had no reply; stopping");
        return { ok: false, error: "user_no_reply" };
      }
      actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${reply.slice(0, 80)}`, true));
      state.lastUserReply = reply;
      updateRecentState(tabId, action, value);
      return { ok: true, info: "user_reply_captured" };
    }

    console.warn("[agent] Unsupported action:", action);
    return { ok: false, error: "unsupported_action" };
  } catch (err) {
    console.error("[agent] executeAction error:", err);
    return { ok: false, error: err && err.message ? err.message : "executeAction_error" };
  }
}

function formatActionHistoryEntry(action, value, info, success) {
  const status = success ? "success" : "fail";
  let valStr = "";
  if (action === "click_index") {
    valStr = `(${value})`;
  } else if (action === "select_type" && value && typeof value === "object") {
    const preview = typeof value.text === "string" ? value.text.slice(0, 40) : "";
    valStr = `(${value.index}, "${preview}")`;
  } else if (action === "type_text") {
    const preview = typeof value === "string" ? value.slice(0, 40) : "";
    valStr = `("${preview}")`;
  } else if (value !== undefined && value !== null) {
    valStr = `(${JSON.stringify(value)})`;
  }
  const infoPart = info ? `: ${info}` : "";
  return `${action}${valStr} -> ${status}${infoPart}`;
}


function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
        return;
      }
      const filtered = (tabs || []).filter(
        (t) => t && t.id && !isDisallowedUrl(t.url)
      );
      if (!filtered.length) {
        resolve(null);
        return;
      }
      filtered.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      resolve(filtered[0]);
    });
  });
}


function isInjectableUrl(url = "") {
  return url.startsWith("http://") || url.startsWith("https://");
}

function getTabById(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        const err = chrome.runtime.lastError;
        if (err || !tab) {
          resolve(null);
        } else {
          resolve(tab);
        }
      });
    } catch (err) {
      resolve(null);
    }
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.query(queryInfo, (tabs) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve(tabs || []);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function sendMessageToTab(tabId, payload, frameId = 0) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, payload, { frameId }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function getBestFrameId(tabId) {
  const fallback = 0;

  // Small delay to let the tab paint/focus settle, mirroring the reference flow.
  await sleep(150);

  const frames = await new Promise((resolve) => {
    try {
      chrome.webNavigation.getAllFrames({ tabId }, (fs) => {
        const err = chrome.runtime.lastError;
        if (err || !fs?.length) {
          resolve([{ frameId: 0, parentFrameId: -1, url: "" }]);
          return;
        }
        resolve(fs);
      });
    } catch (_) {
      resolve([{ frameId: 0, parentFrameId: -1, url: "" }]);
    }
  });

  const settled = await Promise.allSettled(
    frames.map((f) =>
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        args: [f.frameId],
        func: (frameId) => {
          const vw = Math.max(1, window.innerWidth || 0);
          const vh = Math.max(1, window.innerHeight || 0);

          const safeNum = (x, d = 0) => {
            const n = Number(x);
            return Number.isFinite(n) ? n : d;
          };
          const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
          const isVisible = (el) => {
            if (!el) return false;
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden" || safeNum(cs.opacity, 1) === 0) return false;
            const r = el.getBoundingClientRect();
            if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return false;
            if (r.width < 3 || r.height < 3) return false;
            if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) return false;
            return true;
          };

          const modalSelectors =
            '[role="dialog"],[aria-modal="true"],dialog[open],.goog-modalpopup,.docs-dialog-container,.docs-material-dialog,.jfk-dialog,.jfk-modal-dialog,.docs-overlay-container,.docs-dialog,.modal-dialog';
          const modals = Array.from(document.querySelectorAll(modalSelectors)).filter(isVisible);

          const modalInfos = modals.map((el) => {
            const r = el.getBoundingClientRect();
            const areaRatio = (() => {
              const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
              const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
              return (w * h) / (vw * vh);
            })();
            const z = (() => {
              const zi = getComputedStyle(el).zIndex;
              const n = Number(zi);
              return Number.isFinite(n) ? n : 0;
            })();
            const pts = [
              { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 },
              { x: r.left + r.width * 0.25, y: r.top + r.height * 0.25 },
              { x: r.left + r.width * 0.75, y: r.top + r.height * 0.25 },
            ].map((p) => ({
              x: clamp(Math.floor(p.x), 0, vw - 1),
              y: clamp(Math.floor(p.y), 0, vh - 1),
            }));
            let hits = 0;
            for (const p of pts) {
              const topEl = document.elementFromPoint(p.x, p.y);
              if (topEl && (topEl === el || el.contains(topEl))) hits++;
            }
            const ae = document.activeElement || null;
            const aeInside = !!(ae && (ae === el || el.contains(ae)));
            return { areaRatio, z, hitCount: hits, strongTopmost: hits >= 2, aeInside };
          });

          modalInfos.sort(
            (a, b) =>
              (b.strongTopmost - a.strongTopmost) ||
              (b.hitCount - a.hitCount) ||
              (b.aeInside - a.aeInside) ||
              (b.z - a.z) ||
              (b.areaRatio - a.areaRatio)
          );
          const bestModal = modalInfos[0] || null;

          let parentFrameTopHits = 0;
          let parentProbeOk = false;
          try {
            if (window.top !== window && window.frameElement && window.parent?.document) {
              const fe = window.frameElement;
              const pr = fe.getBoundingClientRect();
              const pts = [
                { x: (pr.left + pr.right) / 2, y: (pr.top + pr.bottom) / 2 },
                { x: pr.left + pr.width * 0.25, y: pr.top + pr.height * 0.25 },
                { x: pr.left + pr.width * 0.75, y: pr.top + pr.height * 0.25 },
              ].map((p) => ({
                x: clamp(Math.floor(p.x), 0, Math.max(0, window.parent.innerWidth - 1)),
                y: clamp(Math.floor(p.y), 0, Math.max(0, window.parent.innerHeight - 1)),
              }));
              for (const p of pts) {
                const topElInParent = window.parent.document.elementFromPoint(p.x, p.y);
                if (topElInParent && (topElInParent === fe || fe.contains(topElInParent))) {
                  parentFrameTopHits++;
                }
              }
              parentProbeOk = true;
            }
          } catch (_) {
            parentProbeOk = false;
          }

          const hasFocus = document.hasFocus();

          let score = 0;
          if (hasFocus) score += 8000;
          score += parentFrameTopHits * 6000;
          if (bestModal) {
            score += 4000;
            score += (bestModal.hitCount || 0) * 2200;
            if (bestModal.strongTopmost) score += 1600;
            if (bestModal.aeInside) score += 2200;
            score += Math.round((bestModal.areaRatio || 0) * 1800);
            score += Math.min(1200, Math.max(0, bestModal.z || 0));
          }
          if (parentProbeOk && window.top !== window && parentFrameTopHits === 0) {
            score -= 9000;
          }
          if (frameId === 0) score += 50;

          return {
            frameId,
            score,
            hasFocus,
            modalCount: modals.length,
            hitCount: bestModal?.hitCount ?? 0,
            strongTopmost: !!bestModal?.strongTopmost,
            aeInside: !!bestModal?.aeInside,
            parentFrameTopHits,
            parentProbeOk,
          };
        },
      })
    )
  );

  const results = settled.map((s, idx) => {
    const f = frames[idx];
    if (s.status !== "fulfilled") {
      return { frameId: f?.frameId ?? fallback, score: -1, parentFrameId: f?.parentFrameId ?? -1, parentProbeOk: false, parentFrameTopHits: 0, modalCount: 0, hitCount: 0, strongTopmost: false, aeInside: false, hasFocus: false };
    }
    const r = s.value?.[0]?.result;
    if (!r) return { frameId: f?.frameId ?? fallback, score: -1, parentFrameId: f?.parentFrameId ?? -1, parentProbeOk: false, parentFrameTopHits: 0, modalCount: 0, hitCount: 0, strongTopmost: false, aeInside: false, hasFocus: false };
    return { ...r, parentFrameId: f?.parentFrameId ?? -1 };
  });

  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const strong = results.filter((r) => {
    if ((r.score ?? -1) < 0) return false;
    const frontmostIframe = r.parentProbeOk === true && (r.parentFrameTopHits ?? 0) >= 2;
    const strongModal = r.strongTopmost === true || (r.hitCount ?? 0) >= 2 || r.aeInside === true;
    if ((r.parentFrameId ?? -1) !== -1 && r.frameId !== 0) {
      return frontmostIframe || (strongModal && r.hasFocus);
    }
    return strongModal;
  });

  const weak = results.filter((r) => (r.score ?? -1) >= 0 && ((r.modalCount ?? 0) > 0 || (r.hitCount ?? 0) > 0));

  const bestCandidate =
    (strong.length ? strong[0] : null) ||
    (weak.length ? weak[0] : null) ||
    results.find((r) => (r.score ?? -1) >= 0);

  return bestCandidate?.frameId ?? fallback;
}

function captureVisibleTab(windowId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        if (!dataUrl) {
          reject(new Error("No screenshot data returned"));
          return;
        }
        resolve(dataUrl);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function switchTabDirection(direction) {
  if (direction !== "next" && direction !== "prev") {
    throw new Error(`Invalid switch_tab direction: ${direction}`);
  }

  const tabs = await queryTabs({ currentWindow: true });
  if (!tabs.length) {
    throw new Error("No tabs available to switch");
  }

  const activeIndex = tabs.findIndex((tab) => tab.active);
  const delta = direction === "prev" ? -1 : 1;
  const target = tabs[(activeIndex + delta + tabs.length) % tabs.length];

  return new Promise((resolve, reject) => {
    chrome.tabs.update(target.id, { active: true }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
      } else {
        resolve(true);
      }
    });
  });
}

function openUrlInTab(tabId, url) {
  if (!url) {
    return Promise.reject(new Error("open_url requires a URL"));
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
      } else {
        resolve(true);
      }
    });
  });
}

function waitForTabComplete(tabId, timeoutMs = 12000, pollIntervalMs = 250) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }

        if (tab && tab.status === "complete") {
          resolve(true);
          return;
        }

        if (Date.now() - start >= timeoutMs) {
          reject(new Error("Tab did not complete loading in time"));
          return;
        }

        setTimeout(check, pollIntervalMs);
      });
    };

    check();
  });
}

function isDisallowedUrl(url) {
  return typeof url === "string" && (url.startsWith("chrome://") || url.startsWith("chrome-extension://"));
}

function tryInjectContentScript(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript(
        { target: { tabId, allFrames: true }, files: ["content.js"] },
        () => resolve(true)
      );
    } catch (e) {
      resolve(false);
    }
  });
}

function findElementDescriptor(elements, idx) {
  if (!Array.isArray(elements)) return null;
  const n = Number(idx);
  return elements.find((el) => el && Number(el.index) === n) || null;
}

function isMenuLikeDescriptor(desc) {
  if (!desc) return false;
  const role = (desc.role || "").toLowerCase();
  const name = ((desc.accessibleName || "") + " " + (desc.innerText || "")).toLowerCase();
  if (role.includes("menu")) return true;
  if (name.includes("new")) return true;
  if (name.includes("more")) return true;
  if (name.includes("⋮") || name.includes("…") || name.includes("⋯")) return true;
  return false;
}

function isDriveUrl(url) {
  return typeof url === "string" && url.includes("://drive.google.com/");
}

function isLikelyModalTrigger(desc) {
  if (!desc) return false;
  const role = (desc.role || "").toLowerCase();
  const text = (
    (desc.accessibleName || "") +
    " " +
    (desc.innerText || "") +
    " " +
    (desc.placeholder || "")
  ).toLowerCase();

  const roleMatch = ["button", "menu", "menuitem", "tab", "dialog"].some((r) => role.includes(r));
  const keywords = [
    "create",
    "new",
    "add",
    "start",
    "compose",
    "event",
    "meeting",
    "calendar",
    "appointment",
    "schedule",
    "task",
    "reminder",
    "edit",
    "options",
    "settings",
    "more",
    "menu",
    "dropdown",
    "open",
    "view",
    "details",
    "attach",
    "upload",
    "insert",
    "picker",
    "select",
    "choose",
    "save",
    "buy",
    "next",
    "continue",
    "confirm",
    "done",
    "finish",
    "login",
    "log in",
    "sign in",
    "sign up",
    "signup",
    "register",
    "continue with",
    "submit",
  ];
  const textMatch = keywords.some((k) => text.includes(k));
  return roleMatch || textMatch;
}

function promptUser(question, tabId) {
  return new Promise((resolve) => {
    try {
      pendingUserReplyResolver = resolve;
      chrome.tabs.sendMessage(
        tabId,
        { type: "SHOW_QUESTION", question },
        { frameId: 0 },
        () => {}
      );
      // Speak the question (fire and forget).
      speakText(question || "").then((audioUrl) => {
        if (audioUrl) {
          chrome.tabs.sendMessage(tabId, { type: "PLAY_TTS", audioUrl }, { frameId: 0 }, () => {});
        }
      }).catch(() => {});
      setTimeout(() => {
      if (pendingUserReplyResolver) {
        pendingUserReplyResolver("");
        pendingUserReplyResolver = null;
      }
    }, 45000);
  } catch (err) {
    resolve("");
  }
});
}

function updateRecentState(tabId, action, value) {
  const state = sessionState.get(tabId) || {
    lastSummary: "",
    lastPageContext: "",
    lastUserReply: "",
    recentActions: [],
  };
  state.recentActions = updateRecentActions(state.recentActions, action, value);
  sessionState.set(tabId, state);
}

function updateRecentActions(recentActions = [], action, value) {
  const entry = `${action}:${JSON.stringify(value)}`.slice(0, 120);
  const next = [...recentActions, entry];
  return next.slice(-5);
}

async function startAgentAtUrl(url, goalText, mode) {
  if (!url || typeof url !== "string") {
    console.error("[agent] START_AGENT_AT_URL requires a url");
    return;
  }

  if (isDisallowedUrl(url)) {
    console.error("[agent] Cannot run agent on chrome:// pages; switch to a normal website tab and restart");
    return;
  }

  if (isAgentRunning) {
    console.warn("[agent] Already running; ignoring START_AGENT_AT_URL");
    return;
  }

  let tab;
  try {
    tab = await createTab(url);
  } catch (err) {
    console.error("[agent] Failed to create tab:", err);
    return;
  }

  const tabId = tab.id;
  const windowId = tab.windowId;

  try {
    await waitForTabCompleteEvent(tabId);
  } catch (err) {
    console.error("[agent] Tab did not finish loading:", err);
    return;
  }

  const ready = await ensureContentScriptInjected(tabId);
  if (!ready) {
    console.error("[agent] Could not reach content script on tab", tabId);
    return;
  }

  startAgent(goalText, { tabId, windowId }, mode);
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create({ url }, (tab) => {
        const err = chrome.runtime.lastError;
        if (err || !tab) {
          reject(err || new Error("Failed to create tab"));
          return;
        }
        resolve(tab);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function waitForTabCompleteEvent(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let timer;

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete" || tab?.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        if (timer) clearInterval(timer);
        resolve(true);
      }
    };

    chrome.tabs.get(tabId, (tab) => {
      const err = chrome.runtime.lastError;
      if (err || !tab) {
        reject(err || new Error("Tab not found"));
        return;
      }
      if (tab.status === "complete") {
        resolve(true);
        return;
      }
      chrome.tabs.onUpdated.addListener(listener);
      timer = setInterval(() => {
        if (Date.now() - start >= timeoutMs) {
          chrome.tabs.onUpdated.removeListener(listener);
          if (timer) clearInterval(timer);
          reject(new Error("Timed out waiting for tab load"));
        }
      }, 300);
    });
  });
}

async function ensureContentScriptInjected(tabId) {
  const pingOk = await pingContent(tabId);
  if (pingOk) return true;

  try {
    await injectContentScript(tabId);
  } catch (err) {
    console.error("[agent] Failed to inject content script:", err);
    return false;
  }

  return pingContent(tabId);
}

function pingContent(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "PING" }, { frameId: 0 }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve(false);
        return;
      }
      resolve(resp && resp.success === true);
    });
  });
}

function injectContentScript(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"],
  });
}
