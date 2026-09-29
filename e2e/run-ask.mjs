/**
 * End-to-end proof that questions never act: the REAL extension, server and Gemma.
 *
 *   1. On the login test page, "Analyze this login page" must be answered in ask mode, and the
 *      username/password fields must stay empty (the bug this guards against: the agent used
 *      to fill them and press "Log in").
 *   2. On the demo page, "What personal information is shown on this page?" must be answered
 *      without the model ever receiving the values.
 *
 * Prerequisites as for run-demo.mjs. Run:  npm run ask --workspace=e2e
 * Saves e2e/proof/ask.json and e2e/proof/5-ask-what-the-ai-read.png.
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

const CASES = [
  { url: `${DEMO}login.html`, question: "Analyze this login page" },
  { url: DEMO, question: "What personal information is shown on this page?" },
];

const log = (...a) => console.log("[ask]", ...a);

async function main() {
  const health = await fetch(`${SERVER}/health/gemma?warm=true`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  if (health.status !== "ok") throw new Error(`Gemma not ready: ${JSON.stringify(health)}`);
  await fetch(`${SERVER}/debug/captures`, { method: "DELETE" });
  await mkdir(proofDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: process.env.HEADFUL ? false : true,
    enableExtensions: [extensionDir],
    pipe: true,
    defaultViewport: null,
    args: ["--window-size=1366,860", "--no-first-run", "--no-default-browser-check"],
  });

  const results = [];
  let failed = false;
  try {
    const workerTarget = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().endsWith("/background.js"),
      { timeout: 20_000 }
    );
    const worker = await workerTarget.worker();
    const [page] = await browser.pages();
    await page.setViewport({ width: 1280, height: 780 });

    for (const { url, question } of CASES) {
      await page.goto(url, { waitUntil: "networkidle0" });
      await page.bringToFront();
      const { tabId, windowId } = await worker.evaluate(async (u) => {
        const [tab] = await chrome.tabs.query({ url: u });
        return { tabId: tab.id, windowId: tab.windowId };
      }, url);

      const readFields = () =>
        page.evaluate(() => JSON.stringify([...document.querySelectorAll("input, textarea")].map((el) => [el.value, el.checked])));
      const before = await readFields();
      const started = Date.now();
      // Called through runTask (the "Run task" button), not runAsk: routing must pick ask mode.
      const state = await worker.evaluate((t, w, q) => globalThis.odpa.runTask(t, w, q), tabId, windowId, question);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const untouched = (await readFields()) === before;
      const ok = state.mode === "ask" && state.status === "answered" && untouched;
      failed ||= !ok;

      log(`${ok ? "PASS" : "FAIL"}  ${url}`);
      log(`  question: ${question}`);
      log(`  mode=${state.mode} status=${state.status} in ${seconds} s; fields untouched: ${untouched}`);
      log(`  hidden before sending: ${JSON.stringify(state.hidden)}`);
      log(`  answer: ${state.message}`);
      results.push({ url, question, mode: state.mode, status: state.status, seconds: Number(seconds), fieldsUntouched: untouched, hidden: state.hidden, answer: state.message });
    }

    const captures = await fetch(`${SERVER}/debug/captures`).then((r) => r.json());
    const lastText = captures.captures[0]?.pageText ?? "";
    log(`page text the AI read contains the real email? ${lastText.includes("jane.doe@example.com")}; placeholders: ${(lastText.match(/\[HIDDEN [A-Z ]+\]/g) ?? []).join(", ")}`);

    const view = await browser.newPage();
    await view.setViewport({ width: 1366, height: 900 });
    await view.goto(`${SERVER}/debug/view`, { waitUntil: "networkidle0" });
    await view.evaluate(() => new Promise((r) => setTimeout(r, 2000)));
    await view.screenshot({ path: path.join(proofDir, "5-ask-what-the-ai-read.png"), fullPage: true });

    await writeFile(path.join(proofDir, "ask.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2) + "\n");
    log(`proof written to ${path.relative(root, proofDir)}`);
  } finally {
    await browser.close();
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
