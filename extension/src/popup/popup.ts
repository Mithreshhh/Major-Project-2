/**
 * Toolbar popup: type a task, press Run, watch the steps. The task itself runs in the
 * background worker, so closing the popup does not stop it; re-opening shows its progress.
 */
import { HEALTH_ENDPOINT, type HealthResponse } from "@odpa/shared";

import { CONFIG } from "../shared/config";
import type { BackgroundBroadcast, PopupRequest, TaskState } from "../shared/messages";

const DEMO_TASK =
  "Fill in the contact form with name John Doe, email john@example.com and message Hello from the agent, then submit it.";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const taskEl = $<HTMLTextAreaElement>("task");
const runEl = $<HTMLButtonElement>("run");
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
  done: "Task complete",
  needs_user: "The agent needs your input",
  stopped: "Stopped",
  failed: "Something went wrong",
  max_steps: "Step limit reached",
};

function render(state: TaskState | null): void {
  const running = state?.status === "running";
  runEl.disabled = running || !isWebPage();
  stopEl.disabled = !running;
  taskEl.disabled = running;

  const status = $("status");
  const steps = $("steps");
  steps.replaceChildren();
  if (!state) {
    status.className = "";
    return;
  }

  status.className = `show ${state.status}`;
  $("status-title").textContent = running ? `${TITLES.running} step ${state.steps.length + 1} of up to ${state.maxSteps}` : TITLES[state.status];
  $("status-msg").textContent = state.message ?? "";

  for (const step of state.steps) {
    const li = document.createElement("li");
    if (!step.ok) li.className = "fail";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = `${step.index + 1}.`;
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = step.summary;
    const meta = document.createElement("span");
    meta.className = "meta";
    const r = step.redactions;
    const hidden = r.faces + r.fields + r.text;
    meta.textContent =
      `${(step.ms / 1000).toFixed(1)} s · hidden before sending: ` +
      (hidden ? `${r.faces} face(s), ${r.fields} field(s), ${r.text} text item(s)` : "nothing sensitive found") +
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

  runEl.addEventListener("click", async () => {
    const task = taskEl.value.trim();
    if (!task || tab?.id === undefined) {
      taskEl.focus();
      return;
    }
    runEl.disabled = true;
    await send({ type: "RUN_TASK", tabId: tab.id, windowId: tab.windowId, task });
  });

  stopEl.addEventListener("click", async () => {
    if (tab?.id !== undefined) await send({ type: "STOP_TASK", tabId: tab.id });
  });

  $("demo").addEventListener("click", () => {
    taskEl.value = DEMO_TASK;
    taskEl.focus();
  });

  $("seen").addEventListener("click", async () => {
    await chrome.tabs.create({ url: `${await serverUrl()}${CONFIG.debugViewPath}` });
  });

  taskEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runEl.click();
  });
}

void init();
