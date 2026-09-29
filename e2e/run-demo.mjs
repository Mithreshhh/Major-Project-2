/**
 * End-to-end proof run: the REAL extension in Chrome for Testing, the REAL server and the REAL
 * Gemma model, on the demo page. Nothing is mocked.
 *
 * Prerequisites (all running):
 *   Ollama with the model           ollama list
 *   the API server on :8000         cd server && .venv\Scripts\uvicorn app.main:app --port 8000
 *   the demo page on :5500          python -m http.server 5500 --bind 127.0.0.1 --directory demo
 *   a fresh build                   npm run build
 *
 *   npm run demo --workspace=e2e            (or `npm run e2e` from the repo root)
 *   HEADFUL=1 npm run demo --workspace=e2e  to watch it
 *
 * Saves proof into e2e/proof/:
 *   1-page-before.png        the demo page as the user sees it
 *   2-ai-saw-step1.jpg       the exact screenshot the server received (faces/PII blacked out)
 *   3-page-after.png         the page after the agent finished the task
 *   4-what-the-ai-sees.png   the server's debug view
 *   run.json                 task, every step, status, timings
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const extensionDir = path.join(root, "extension/dist/chrome");
const proofDir = path.join(here, "proof");
const SERVER = process.env.ODPA_SERVER ?? "http://127.0.0.1:8000";
const DEMO = process.env.ODPA_DEMO ?? "http://127.0.0.1:5500/";
const TASK =
  process.env.ODPA_TASK ??
  "Fill in the contact form with name John Doe, email john@example.com and message Hello from the agent, then submit it.";

const log = (...a) => console.log("[e2e]", ...a);

async function preflight() {
  const health = await fetch(`${SERVER}/health/gemma?warm=true`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  if (health.status !== "ok") throw new Error(`Gemma not ready: ${JSON.stringify(health)}`);
  log(`server ok, model ${health.model} loaded=${health.modelLoaded}`);
  const demo = await fetch(DEMO).catch(() => null);
  if (!demo?.ok) throw new Error(`demo page not reachable at ${DEMO}`);
  await fetch(`${SERVER}/debug/captures`, { method: "DELETE" });
}

async function main() {
  await preflight();
  await mkdir(proofDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: process.env.HEADFUL ? false : true,
    enableExtensions: [extensionDir],
    pipe: true,
    defaultViewport: null,
    args: ["--window-size=1366,860", "--no-first-run", "--no-default-browser-check"],
  });

  try {
    const workerTarget = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().endsWith("/background.js"),
      { timeout: 20_000 }
    );
    const worker = await workerTarget.worker();
    const extensionId = new URL(workerTarget.url()).host;
    log(`extension loaded: ${extensionId}`);

    const [page] = await browser.pages();
    await page.setViewport({ width: 1280, height: 780 });
    await page.goto(DEMO, { waitUntil: "networkidle0" });
    await page.bringToFront();
    await page.screenshot({ path: path.join(proofDir, "1-page-before.png") });

    const { tabId, windowId } = await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: `${url}*` });
      return { tabId: tab.id, windowId: tab.windowId };
    }, DEMO);
    log(`running task on tab ${tabId}: ${TASK}`);

    const started = Date.now();
    // Nobody is here to press "Allow" in the popup, so risky clicks (Submit) are allowed
    // automatically and marked as such in the log. A person running it clicks Allow instead.
    const state = await worker.evaluate(
      (tabId, windowId, task) => globalThis.odpa.runTask(tabId, windowId, task, { autoConfirm: true }),
      tabId,
      windowId,
      TASK
    );
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log(`status=${state.status} after ${state.steps.length} step(s) in ${seconds} s: ${state.message ?? ""}`);
    for (const s of state.steps) {
      const r = s.redactions;
      const v = s.vision ? `; vision found ${s.vision.found}/${s.vision.domCount}, precision ${s.vision.precision}, ${s.vision.ms} ms` : "; vision did not run";
      log(`  ${s.index + 1}. ${s.summary}${s.confirmed ? " (risky: confirmed " + s.confirmed + ")" : ""}  [${(s.ms / 1000).toFixed(1)} s; hid ${r.faces} face(s), ${r.photos ?? 0} photo(s), ${r.fields} field(s), ${r.text} text${v}]`);
    }

    await page.screenshot({ path: path.join(proofDir, "3-page-after.png") });
    const pageState = await page.evaluate(() => ({
      name: document.querySelector("#name").value,
      email: document.querySelector("#email").value,
      message: document.querySelector("#message").value,
      status: document.querySelector("#status").textContent,
      log: [...document.querySelectorAll("#log li")].map((li) => li.textContent).reverse(),
    }));
    log(`page now: name="${pageState.name}" email="${pageState.email}" message="${pageState.message}" status="${pageState.status}"`);

    // What the server actually received on the first step.
    const captures = await fetch(`${SERVER}/debug/captures`).then((r) => r.json());
    const first = captures.captures.at(-1);
    if (first?.hasScreenshot) {
      const img = Buffer.from(await (await fetch(`${SERVER}/debug/captures/${first.id}/screenshot`)).arrayBuffer());
      await writeFile(path.join(proofDir, "2-ai-saw-step1.jpg"), img);
      const byMethod = first.redactions.reduce((acc, r) => ((acc[r.method] = (acc[r.method] ?? 0) + 1), acc), {});
      log(`server received ${first.screenshotSize.join("x")} screenshot with ${first.redactions.length} redaction(s): ${JSON.stringify(byMethod)}`);
    }

    const view = await browser.newPage();
    await view.setViewport({ width: 1366, height: 900 });
    await view.goto(`${SERVER}/debug/view`, { waitUntil: "networkidle0" });
    await view.evaluate(() => new Promise((r) => setTimeout(r, 2000)));
    await view.screenshot({ path: path.join(proofDir, "4-what-the-ai-sees.png"), fullPage: true });

    const report = {
      date: new Date().toISOString(),
      task: TASK,
      status: state.status,
      message: state.message,
      seconds: Number(seconds),
      steps: state.steps,
      pageAfter: pageState,
      serverReceived: captures.captures.reverse().map((c) => ({
        step: c.stepIndex + 1,
        command: c.command,
        error: c.error,
        redactions: c.redactions.map((r) => `${r.method}:${r.category}`),
        elementsWithRedactedLabels: c.elements.filter((e) => e.redacted).map((e) => `${e.id} "${e.label}"`),
        reasoningMs: c.reasoningMs,
      })),
    };
    await writeFile(path.join(proofDir, "run.json"), JSON.stringify(report, null, 2));
    log(`proof written to ${path.relative(root, proofDir)}`);

    if (state.status !== "done") process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[e2e] failed:", err);
  process.exitCode = 1;
});
