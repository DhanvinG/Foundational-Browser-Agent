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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function triggerShowShortcut(tabId) {
  try {
    const tabs = await chrome.tabs.query({});
    let maxId = null;
    for (const t of tabs) {
      if (t && typeof t.id === "number") {
        if (maxId === null || t.id > maxId) {
          maxId = t.id;
        }
      }
    }
    if (maxId === null) {
      console.warn("[agent] triggerShowShortcut: no tabs found");
      return;
    }

    console.log("[agent] triggerShowShortcut: highest tab id selected:", maxId);

    await chrome.tabs.update(maxId, { active: true });
    await sendMessageToTab(maxId, { type: MSG_TYPES.OBSERVE_SHOW });
    await sleep(50);
    await sendMessageToTab(maxId, { type: MSG_TYPES.OBSERVE_HIDE });
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
    console.log("[agent] triggerShowShortcut: activated tab", maxId, "captured screenshot length", screenshotDataUrl?.length || 0);
  } catch (err) {
    console.warn("[agent] triggerShowShortcut failed:", err?.message || err);
  }
}

async function handleTextCommand(rawText) {
  const text = (rawText || "").trim();
  if (!text) return;

  const lowered = text.toLowerCase();
  const heyCoraPrefix = "hey cora";
  const hasHeyCora = lowered.startsWith(heyCoraPrefix);
  const stripped = hasHeyCora ? text.slice(heyCoraPrefix.length).trim() : text;

  if (hasHeyCora) {
    if (isSummarizeRequest(stripped)) {
      await summarizeScreenshot(stripped);
      return;
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

function isSummarizeRequest(text) {
  const t = (text || "").toLowerCase();
  const whatAboutPattern = /\bwhat(?:'s| is)\s+.*about\b/;
  return (
    t.includes("how") ||
    t.includes("summarize") ||
    t.includes("explain") ||
    t.includes("what is") ||
    t.includes("what does") ||
    t.startsWith("describe ") ||
    whatAboutPattern.test(t)
  );
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

    chrome.tabs.sendMessage(
      tab.id,
      { type: "SHOW_SUMMARY", summary: answer },
      { frameId: 0 },
      () => {}
    );
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

    const observation = await observeTab({
      tabId: agentTabId,
      windowId: agentWindowId,
      url: currentTab.url,
      title: currentTab.title,
    });
    if (!observation) {
      console.warn("[agent] Observation failed; stopping");
      break;
    }
    if (!observation.elements || observation.elements.length <= 3) {
      console.warn("[agent] Low candidate count (<=3); re-observing once");
      await triggerShowShortcut(agentTabId);
      const retryObs = await observeTab({
        tabId: agentTabId,
        windowId: agentWindowId,
        url: currentTab.url,
        title: currentTab.title,
        waitMs: 6000,
      });
      if (!retryObs || !retryObs.elements || retryObs.elements.length <= 3) {
        console.warn("[agent] No sufficient overlays after re-observe; stopping");
        break;
      }
      observation.screenshotDataUrl = retryObs.screenshotDataUrl;
      observation.elements = retryObs.elements;
      observation.pageContext = retryObs.pageContext;
      observation.url = retryObs.url;
      observation.title = retryObs.title;
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
      state
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

async function runBaselineRecovery({ goalText, agentTabId, agentWindowId, actionHistory, pendingUserReply, state, lastError }) {
  try {
    const tab = await getTabById(agentTabId);
    if (!tab) return false;
    const observation = await observeTab({
      tabId: agentTabId,
      windowId: agentWindowId,
      url: tab.url,
      title: tab.title,
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
      state
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
        state
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

async function observeTab({ tabId, windowId, url, title, waitMs = 10 }) {
  let attempts = 0;
  while (attempts < 2) {
    try {
      const showResult = await sendMessageToTab(tabId, { type: MSG_TYPES.OBSERVE_SHOW });
      if (!showResult || showResult.success === false) {
        console.warn("[agent] OBSERVE_SHOW failed:", showResult && showResult.error);
        attempts++;
        if (attempts >= 2) return null;
        await tryInjectContentScript(tabId);
        continue;
      }

      await sleep(waitMs);
      const screenshotDataUrl = await captureVisibleTab(windowId);

      const hideResult = await sendMessageToTab(tabId, { type: MSG_TYPES.OBSERVE_HIDE });
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

async function executeAction(tabId, action, value, actionHistory, elements, currentUrl, state) {
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
          result = await sendMessageToTab(tabId, { type: MSG_TYPES.EXEC_ACTION, action, value });
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

function sendMessageToTab(tabId, payload) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, payload, { frameId: 0 }, (response) => {
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
