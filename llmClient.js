// llmClient.js (classic script loaded via importScripts)
const API_BASE = "http://localhost:8000";
const AGENT_STEP_ENDPOINT = `${API_BASE}/agent-step`;
const PLAN_ENDPOINT = `${API_BASE}/plan`;
const EXECUTE_STEP_ENDPOINT = `${API_BASE}/execute-step`;
const STATUS_ENDPOINT = `${API_BASE}/status`;
const ALLOWED_ACTIONS = new Set([
  "click_index",
  "type_text",
  "select_type",
  "scroll",
  "switch_tab",
  "open_url",
  "search",
  "done",
  "report_error",
  "ask_user"
]);
const ALLOWED_SCROLL_VALUES = new Set([
  "down_small",
  "down",
  "up_small",
  "up",
  "top",
  "bottom"
]);

function isInteger(value) {
  return Number.isInteger(value);
}

function validateActionPayload(action, value) {
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`Invalid action "${action}" from LLM`);
  }

  switch (action) {
    case "click_index":
      if (!isInteger(value)) {
        throw new Error("click_index value must be an integer");
      }
      break;
    case "type_text":
      if (typeof value !== "string") {
        throw new Error("type_text value must be a string");
      }
      break;
    case "select_type":
      if (
        !value ||
        typeof value !== "object" ||
        !isInteger(value.index) ||
        typeof value.text !== "string"
      ) {
        throw new Error("select_type value must be { index: integer, text: string }");
      }
      break;
    case "scroll":
      if (!ALLOWED_SCROLL_VALUES.has(value)) {
        throw new Error("scroll value must be one of the allowed enums");
      }
      break;
    case "switch_tab":
      if (value !== "next" && value !== "prev") {
        throw new Error('switch_tab value must be "next" or "prev"');
      }
      break;
    case "open_url":
      if (typeof value !== "string") {
        throw new Error("open_url value must be a string URL");
      }
      break;
    case "search":
      if (typeof value !== "string") {
        throw new Error("search value must be a string query");
      }
      break;
    case "done":
      if (value !== null) {
        throw new Error("done value must be null");
      }
      break;
    case "report_error":
      if (typeof value !== "string") {
        throw new Error("report_error value must be a string");
      }
      break;
    case "ask_user":
      if (typeof value !== "string") {
        throw new Error("ask_user value must be a string question");
      }
      break;
    default:
      throw new Error(`Unhandled action "${action}"`);
  }
}

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new Error(`LLM request failed: ${err && err.message ? err.message : err}`);
  }

  if (!response.ok) {
    throw new Error(`LLM HTTP error: ${response.status}`);
  }

  try {
    return await response.json();
  } catch (err) {
    throw new Error("Failed to parse LLM JSON response");
  }
}

self.requestAgentStep = async function requestAgentStep({
  goalText,
  screenshotDataUrl,
  url,
  title,
  actionHistory,
  elements,
  userReply,
  lastAction,
  lastExpectation,
  userProfile
}) {
  const payload = {
    controllerPrompt: self.CONTROLLER_PROMPT,
    goalText: goalText || "",
    screenshotDataUrl: screenshotDataUrl || "",
    meta: {
      url: url || "",
      title: title || "",
      actionHistory: Array.isArray(actionHistory) ? actionHistory : [],
      elements: Array.isArray(elements) ? elements : [],
      userReply: userReply || "",
      lastAction: lastAction || null,
      lastExpectation: lastExpectation || null,
      userProfile: userProfile || null
    }
  };

  const data = await postJson(AGENT_STEP_ENDPOINT, payload);
  if (!data || typeof data.action !== "string") {
    throw new Error("LLM response missing required action");
  }
  validateActionPayload(data.action, data.value);
  return {
    action: data.action,
    value: data.value,
    why: typeof data.why === "string" ? data.why : "",
    expect_next: typeof data.expect_next === "string" ? data.expect_next : ""
  };
};

self.requestPlan = async function requestPlan(payload) {
  const data = await postJson(PLAN_ENDPOINT, payload);
  if (!data || !Array.isArray(data.plan)) {
    throw new Error("Planner response missing plan array");
  }
  return data;
};

self.requestExecuteStep = async function requestExecuteStep(payload) {
  const data = await postJson(EXECUTE_STEP_ENDPOINT, payload);
  if (!data || typeof data.action !== "string") {
    throw new Error("Executor response missing required action");
  }
  if (typeof data.confidence !== "number" || Number.isNaN(data.confidence)) {
    throw new Error("Executor response missing numeric confidence");
  }
  validateActionPayload(data.action, data.value);
  return {
    action: data.action,
    value: data.value,
    confidence: data.confidence,
    rationale: data.rationale
  };
};

self.requestStatus = async function requestStatus(payload) {
  const data = await postJson(STATUS_ENDPOINT, payload);
  if (!data || typeof data.status !== "string") {
    throw new Error("Status response missing status");
  }
  const status = data.status;
  if (status !== "done" && status !== "not_done") {
    throw new Error("Status response has invalid status");
  }
  return {
    status,
    missing: typeof data.missing === "string" ? data.missing : ""
  };
};

// Legacy export name preserved for existing callers.
self.getNextAction = self.requestAgentStep;
