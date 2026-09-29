/**
 * Toolbar popup: type a task or a question, watch the steps or read the answer. The work runs in
 * the background worker, so closing the popup does not stop it; re-opening shows its progress.
 *
 * Run task   works on the page, but question-like text ("analyze this page") is answered in
 *            ask mode instead, which never clicks or types. Risky clicks wait for Allow here.
 * Ask        always ask mode.
 */
import { HEALTH_ENDPOINT, type HealthResponse } from "@odpa/shared";

import { CONFIG } from "../shared/config";
import { looksLikeQuestion, type BackgroundBroadcast, type PopupRequest, type TaskState } from "../shared/messages";

const DEMO_TASK =
  "Fill in the contact form with name John Doe, email john@example.com and message Hello from the agent, then submit it.";
const DEMO_QUESTION = "What personal information is shown on this page, and what can I do here?";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const taskEl = $<HTMLTextAreaElement>("task");
const runEl = $<HTMLButtonElement>("run");
const askEl = $<HTMLButtonElement>("ask");
const stopEl = $<HTMLButtonElement>("stop");

let tab: chrome.tabs.Tab | undefined;

async function serverUrl(): Promise<string> {
  const stored = await chrome.storage.local.get("serverUrl");
  const url = typeof stored.serverUrl === "string" && stored.serverUrl ? stored.serverUrl : CONFIG.serverUrl;
  return url.replace(/\/+$/, "");
}

function send<T = unknown>(msg: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

async function checkServer(): Promise<void> {
  const dot = $("dot");
  const label = $("server");
  try {
    const res = await fetch(`${await serverUrl()}${HEALTH_ENDPOINT}`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as HealthResponse;
    dot.className = "dot ok";
    label.textContent = body.reasoner === "gemma" ? "Gemma ready" : `server: ${body.reasoner}`;
  } catch {
    dot.className = "dot bad";
    label.textContent = "server offline";
  }
}

const TITLES: Record<TaskState["status"], string> = {
  running: "Working…",
  confirm: "Allow this action?",
  done: "Task complete",
  answered: "Answer",
  needs_user: "The agent needs your input",
  stopped: "Stopped",
  failed: "Something went wrong",
  max_steps: "Step limit reached",
};

function hiddenSummary(r: { faces: number; fields: number; text: number } | undefined): string {
  if (!r) return "";
  const hidden = r.faces + r.fields + r.text;
  return hidden
    ? `hidden before sending: ${r.faces} face(s), ${r.fields} field(s), ${r.text} personal text item(s)`
    : "nothing sensitive found";
}

function updateHint(): void {
  const text = taskEl.value.trim();
  $("hint").textContent =
    text && looksLikeQuestion(text) ? "This looks like a question: Run task will answer it without touching the page." : "";
}

function render(state: TaskState | null): void {
  const busy = state?.status === "running" || state?.status === "confirm";
  runEl.disabled = busy || !isWebPage();
  askEl.disabled = busy || !isWebPage();
  stopEl.disabled = !busy;
  taskEl.disabled = busy;

  const status = $("status");
  const steps = $("steps");
  steps.replaceChildren();
  $("confirm").classList.toggle("show", state?.status === "confirm");
  if (!state) {
    status.className = "";
    return;
  }

  status.className = `show ${state.status}`;
  if (state.status === "running") {
    $("status-title").textContent =
      state.mode === "ask" ? "Reading the page… (ask mode: nothing will be clicked or typed)" : `${TITLES.running} step ${state.steps.length + 1} of up to ${state.maxSteps}`;
  } else {
    $("status-title").textContent = TITLES[state.status];
  }
  $("status-msg").textContent = state.status === "confirm" ? `The agent wants to: ${state.pending ?? "do something"}` : state.message ?? "";
  $("status-meta").textContent =
    state.mode === "ask" && state.hidden ? `Ask mode, nothing was clicked or typed · ${hiddenSummary(state.hidden)}` : "";

  for (const step of state.steps) {
    const li = document.createElement("li");
    if (!step.ok) li.className = "fail";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = `${step.index + 1}.`;
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = step.summary + (step.confirmed === "user" ? " (allowed by you)" : "");
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent =
      `${(step.ms / 1000).toFixed(1)} s · ${hiddenSummary(step.redactions)}` +
      (step.vision
        ? ` · vision model found ${step.vision.found}/${step.vision.domCount} buttons, inputs and links ` +
          `(${Math.round(step.vision.precision * 100)}% of its boxes correct, ${step.vision.ms} ms)`
        : "") +
      (step.ok ? "" : ` · ${step.message ?? "failed"}`);
    li.append(n, what, meta);
    steps.append(li);
  }
  steps.scrollTop = steps.scrollHeight;
}

function isWebPage(): boolean {
  return !!tab?.url && /^https?:/i.test(tab.url);
}

async function init(): Promise<void> {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("page").textContent = tab?.url ?? "(no tab)";
  if (!isWebPage()) $("warn").classList.add("show");

  const stored = await chrome.storage.local.get("task");
  if (typeof stored.task === "string") taskEl.value = stored.task;
  updateHint();

  void checkServer();

  if (tab?.id !== undefined) {
    const res = await send<{ ok: boolean; state: TaskState | null }>({ type: "GET_TASK_STATE", tabId: tab.id });
    render(res?.state ?? null);
  } else {
    render(null);
  }

  chrome.runtime.onMessage.addListener((msg: BackgroundBroadcast) => {
    if (msg?.type === "TASK_UPDATE" && msg.state.tabId === tab?.id) render(msg.state);
  });

  const start = async (kind: "task" | "ask") => {
    const text = taskEl.value.trim();
    if (!text || tab?.id === undefined) {
      taskEl.focus();
      return;
    }
    runEl.disabled = askEl.disabled = true;
    await send(
      kind === "ask"
        ? { type: "ASK", tabId: tab.id, windowId: tab.windowId, question: text }
        : { type: "RUN_TASK", tabId: tab.id, windowId: tab.windowId, task: text }
    );
  };
  runEl.addEventListener("click", () => void start("task"));
  askEl.addEventListener("click", () => void start("ask"));

  stopEl.addEventListener("click", async () => {
    if (tab?.id !== undefined) await send({ type: "STOP_TASK", tabId: tab.id });
  });
  $("allow").addEventListener("click", async () => {
    if (tab?.id !== undefined) await send({ type: "CONFIRM", tabId: tab.id, allow: true });
  });
  $("deny").addEventListener("click", async () => {
    if (tab?.id !== undefined) await send({ type: "CONFIRM", tabId: tab.id, allow: false });
  });

  $("demo").addEventListener("click", () => {
    taskEl.value = DEMO_TASK;
    updateHint();
    taskEl.focus();
  });
  $("demo-q").addEventListener("click", () => {
    taskEl.value = DEMO_QUESTION;
    updateHint();
    taskEl.focus();
  });

  $("seen").addEventListener("click", async () => {
    await chrome.tabs.create({ url: `${await serverUrl()}${CONFIG.debugViewPath}` });
  });

  taskEl.addEventListener("input", updateHint);
  taskEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runEl.click();
  });
}

void init();
