/**
 * End-to-end check of the agent's reasoning on the store and pricing pages: the REAL extension,
 * server and Gemma. Each case has an answer that must contain a specific fact, or a cart that
 * must end up in a specific state, so a wrong answer fails.
 *
 * Questions (ask mode: nothing is clicked)
 *   store    Two books, or add a third?                  -> ₹1,078 for two, ₹999 for three
 *   store    Which laptop for a student who travels?     -> AeroBook 14
 *   pricing  How much does paying yearly for Pro save?   -> ₹998
 *   pricing  Team of 7 needing priority support?         -> Team plan
 * Tasks (act mode)
 *   store    Add Deep Work to the cart                   -> that book only; total ₹498 (₹449 + ₹49 delivery)
 *
 * Prerequisites: `npm start` running. Run:  npm run smart --workspace=e2e
 * Saves e2e/proof/smart.json and 14-store-cart.png.
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

const QUESTIONS = [
  { page: "store.html", q: "Which three books are the cheapest, and what do they cost together?", must: [/alchemist/i, /atomic habits/i, /deep work/i], note: "₹299, ₹399, ₹449; ₹999 with the offer" },
  { page: "store.html", q: "How much do Clean Code and The Pragmatic Programmer cost together? Would I pay less if I add The Alchemist as a third book?", must: [/1,?078/, /999/], note: "529 + 549 = 1,078 for two; three books cost 999 with the offer" },
  { page: "store.html", q: "I am a student who writes code and travels a lot. Which laptop do you recommend under ₹60,000, and why?", must: [/aerobook/i], note: "lightest, longest battery, under budget" },
  { page: "pricing.html", q: "How much do I save in one year if I pay yearly for the Pro plan instead of monthly?", must: [/998/], note: "12 x 499 = 5,988 vs 4,990" },
  { page: "pricing.html", q: "We are a team of 7 people and we need priority support. Which plan should we choose?", must: [/team/i], note: "only Team has priority support" },
];
// One named item works reliably. Several items in one task do not with this small model: asked
// for three named books it added one twice, or stopped after two; asked for "the three cheapest"
// it picked a ₹529 book over a ₹449 one. Ask first, then add items one at a time.
const TASK = { page: "store.html", task: "Add Deep Work to the cart.", cart: ["Deep Work"], total: "₹498" };

const log = (...a) => console.log("[smart]", ...a);

async function main() {
  const health = await fetch(`${SERVER}/health/gemma?warm=true`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  if (health.status !== "ok") throw new Error(`Gemma not ready: ${JSON.stringify(health)}`);
  await mkdir(proofDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: process.env.HEADFUL ? false : true,
    enableExtensions: [extensionDir],
    pipe: true,
    defaultViewport: null,
    args: ["--window-size=1366,960", "--no-first-run", "--no-default-browser-check"],
  });
  const report = { date: new Date().toISOString(), questions: [], task: null };
  let failed = 0;
  try {
    const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20_000 });
    const worker = await workerTarget.worker();
    const [page] = await browser.pages();
    await page.setViewport({ width: 1280, height: 900 });
    const tabFor = async (file) => {
      const url = `${DEMO}${file}`;
      await page.goto(url, { waitUntil: "networkidle0" });
      await page.bringToFront();
      return worker.evaluate(async (u) => {
        const [tab] = await chrome.tabs.query({ url: u });
        return { tabId: tab.id, windowId: tab.windowId };
      }, url);
    };

    for (const { page: file, q, must, note } of QUESTIONS) {
      const { tabId, windowId } = await tabFor(file);
      const started = Date.now();
      const state = await worker.evaluate((t, w, text) => globalThis.odpa.runTask(t, w, text), tabId, windowId, q);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const answer = state.message ?? "";
      const ok = state.mode === "ask" && state.status === "answered" && must.every((re) => re.test(answer));
      if (!ok) failed += 1;
      log(`${ok ? "PASS" : "FAIL"}  [${file}] ${q}`);
      log(`      expected: ${note}  (${seconds} s)`);
      for (const line of answer.split("\n")) log(`      | ${line}`);
      report.questions.push({ page: file, question: q, expected: note, answer, seconds: Number(seconds), ok });
    }

    const { tabId, windowId } = await tabFor(TASK.page);
    const state = await worker.evaluate((t, w, text) => globalThis.odpa.runTask(t, w, text, { autoConfirm: true }), tabId, windowId, TASK.task);
    const cart = await page.$$eval("#cart-items li:not(.empty) span:first-child", (els) => els.map((e) => e.textContent).sort());
    const total = await page.$eval("#total", (e) => e.textContent);
    const taskOk = JSON.stringify(cart) === JSON.stringify([...TASK.cart].sort()) && total === TASK.total;
    if (!taskOk) failed += 1;
    log(`${taskOk ? "PASS" : "FAIL"}  [${TASK.page}] ${TASK.task}`);
    log(`      status=${state.status}: ${state.message ?? ""}`);
    for (const s of state.steps) log(`      ${s.index + 1}. ${s.summary}${s.ok ? "" : "  <- " + s.message}`);
    log(`      cart: ${cart.join(", ") || "(empty)"}; total ${total} (expected ${TASK.cart.join(", ")}; ${TASK.total})`);
    await page.screenshot({ path: path.join(proofDir, "14-store-cart.png") });
    report.task = { task: TASK.task, status: state.status, steps: state.steps.map((s) => s.summary), cart, total, ok: taskOk };

    await writeFile(path.join(proofDir, "smart.json"), JSON.stringify(report, null, 2) + "\n");
    log(`${QUESTIONS.length + 1 - failed}/${QUESTIONS.length + 1} passed`);
  } finally {
    await browser.close();
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
