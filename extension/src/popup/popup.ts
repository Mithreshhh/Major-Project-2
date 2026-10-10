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
import { looksLikeQuestion, type BackgroundBroadcast, type InputAnswer, type PopupRequest, type TaskState } from "../shared/messages";
import { loadPeople, profileFieldNames, setActivePerson } from "../shared/profile";

const DEMO_TASK =
  "Fill in the contact form with name John Doe, email john@example.com, subject Charged twice this month and message I was charged twice for my Pro plan this month, please refund one payment. Then submit it.";
const DEMO_INFO_TASK = "Fill this form with my saved details, then submit it.";
const DEMO_QUESTION = "What personal information is shown on this page, and what can I do here?";
/** Questions that show reasoning, offered on the test site's store and pricing pages. */
const PAGE_QUESTIONS: Array<[RegExp, string]> = [
  [/store\.html/, "How much do Clean Code and The Pragmatic Programmer cost together? Would I pay less if I add The Alchemist as a third book?"],
  [/pricing\.html/, "We are a team of 7 people and we need priority support. Which plan should we choose, and what will it cost per month?"],
  [/features\.html/, "Is Nimbus a good fit for a 20-person remote team that also needs payroll? Explain."],
  [/login\.html/, "Analyze this login page"],
  [/chat\.html/, "Summarize this conversation"],
];

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
  input: "The agent needs your input",
  done: "Task complete",
  answered: "Answer",
  needs_user: "The agent needs your input",
  stopped: "Stopped",
  failed: "Something went wrong",
  max_steps: "Step limit reached",
};

type Counts = { faces: number; photos?: number; fields: number; text: number };

function hiddenSummary(r: Counts | undefined): string {
  if (!r) return "";
  const parts = [
    [r.faces, "face"],
    [r.photos ?? 0, "photo"],
    [r.fields, "sensitive field"],
    [r.text, "personal text item"],
  ].filter(([n]) => (n as number) > 0).map(([n, what]) => `${n} ${what}${n === 1 ? "" : "s"}`);
  return parts.length ? `Hidden before sending: ${parts.join(", ")}` : "Nothing sensitive found";
}

function chip(kind: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = `chip ${kind}`;
  el.textContent = text;
  return el;
}

/** Coloured chips for what was hidden in one step (same colours as "What the AI sees"). */
function hiddenChips(r: Counts): HTMLSpanElement[] {
  const chips = [
    r.faces ? chip("face", `${r.faces} face${r.faces === 1 ? "" : "s"}`) : null,
    r.photos ? chip("photo", `${r.photos} photo${r.photos === 1 ? "" : "s"}`) : null,
    r.fields ? chip("field", `${r.fields} field${r.fields === 1 ? "" : "s"}`) : null,
    r.text ? chip("text", `${r.text} personal text`) : null,
  ].filter((c): c is HTMLSpanElement => c !== null);
  return chips.length ? chips : [chip("none", "nothing sensitive")];
}

function updateHint(): void {
  const text = taskEl.value.trim();
  $("hint").textContent =
    text && looksLikeQuestion(text) ? "This looks like a question: Run task will answer it without touching the page." : "";
}

/** Question currently shown in the answer box, so a progress update does not wipe what is typed. */
let shownQuestion = "";

function renderAnswer(state: TaskState | null): void {
  const input = state?.status === "input" ? state.input : undefined;
  $("answer").classList.toggle("show", !!input);
  if (!input) {
    shownQuestion = "";
    return;
  }
  const key = `${input.target ?? ""}|${input.question}`;
  if (key === shownQuestion) return;
  shownQuestion = key;
  const text = $<HTMLInputElement>("answer-text");
  const field = input.target !== undefined;
  text.hidden = !!input.file;
  text.value = input.suggestion ?? "";
  text.placeholder = input.label ? `Type the ${input.label.replace(/\((optional|required)\)|\*/gi, "").trim()} here` : "Type your answer here";
  $<HTMLInputElement>("answer-save").checked = false;
  $("answer-save-row").hidden = !field || !!input.file;
  $("answer-go").hidden = !!input.file;
  $("answer-go").textContent = field ? "Fill in and continue" : "Answer and continue";
  $("answer-retry").hidden = !input.file;
  $("answer-skip").hidden = !field;
  if (!input.file) text.focus();
}

function render(state: TaskState | null): void {
  const busy = state?.status === "running" || state?.status === "confirm" || state?.status === "input";
  runEl.disabled = busy || !isWebPage();
  askEl.disabled = busy || !isWebPage();
  stopEl.disabled = !busy;
  taskEl.disabled = busy;

  const status = $("status");
  const steps = $("steps");
  steps.replaceChildren();
  $("confirm").classList.toggle("show", state?.status === "confirm");
  renderAnswer(state);
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
  $("status-msg").textContent =
    state.status === "confirm"
      ? `The agent wants to: ${state.pending ?? "do something"}`
      : state.status === "input"
        ? (state.input?.question ?? "")
        : (state.message ?? "");
  $("status-meta").textContent =
    state.mode === "ask" && state.hidden
      ? `Ask mode: nothing was clicked or typed. ${hiddenSummary(state.hidden)}.`
      : state.person
        ? `Using the details saved for ${state.person}. The AI saw only their names, not the values.`
        : "";

  for (const step of state.steps) {
    const li = document.createElement("li");
    if (!step.ok) li.className = "fail";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = `${step.index + 1}`;
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = step.summary + (step.confirmed === "user" ? " (allowed by you)" : "");
    const chips = document.createElement("span");
    chips.className = "chips";
    chips.append(...hiddenChips(step.redactions));
    if (step.vision) chips.append(chip("vision", `vision ${step.vision.found}/${step.vision.domCount} elements${step.vision.added ? `, +${step.vision.added} only it saw` : ""}`));
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${(step.ms / 1000).toFixed(1)} s` + (step.ok ? "" : ` · ${step.message ?? "failed"}`);
    li.append(n, what, chips, meta);
    steps.append(li);
  }
  steps.scrollTop = steps.scrollHeight;
}

function isWebPage(): boolean {
  return !!tab?.url && /^https?:/i.test(tab.url);
}

async function init(): Promise<void> {
  // popup.html?tab=<id> targets a given tab (used by e2e/popup-screens.mjs to drive the popup
  // from its own window); normally the popup acts on the active tab.
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  tab = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
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

  const answer = async (a: InputAnswer) => {
    if (tab?.id !== undefined) await send({ type: "ANSWER", tabId: tab.id, answer: a });
  };
  $("answer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $<HTMLInputElement>("answer-text");
    if (!text.value.trim()) {
      text.focus();
      return;
    }
    void answer({ kind: "fill", text: text.value, save: $<HTMLInputElement>("answer-save").checked });
  });
  $("answer-skip").addEventListener("click", () => void answer({ kind: "skip" }));
  $("answer-retry").addEventListener("click", () => void answer({ kind: "retry" }));

  $("demo").addEventListener("click", () => {
    taskEl.value = DEMO_TASK;
    updateHint();
    taskEl.focus();
  });
  $("demo-q").addEventListener("click", () => {
    taskEl.value = PAGE_QUESTIONS.find(([page]) => page.test(tab?.url ?? ""))?.[1] ?? DEMO_QUESTION;
    updateHint();
    taskEl.focus();
  });

  $("demo-info").addEventListener("click", () => {
    taskEl.value = DEMO_INFO_TASK;
    updateHint();
    taskEl.focus();
  });
  // Whose saved details to fill with, when more than one person is saved.
  const all = await loadPeople();
  const select = $<HTMLSelectElement>("person");
  const showSaved = () => {
    const person = all.people.find((p) => p.id === select.value) ?? all.people[0];
    const saved = person ? profileFieldNames(person.fields).length : 0;
    $("info").textContent = saved ? `My info (${saved} saved)` : "My info (add yours)";
  };
  for (const person of all.people) select.add(new Option(person.name, person.id, false, person.id === all.activeId));
  $("as-row").hidden = all.people.length < 2;
  select.addEventListener("change", async () => {
    await setActivePerson(select.value);
    showSaved();
  });
  showSaved();
  $("info").addEventListener("click", async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL("profile.html") });
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
