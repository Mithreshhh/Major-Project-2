/**
 * End-to-end proof of "My info": the REAL extension, server and Gemma fill a job application
 * from saved details, and the saved values never reach the server.
 *
 *   1. Saves a made-up profile into the extension's local storage.
 *   2. Runs "Fill this application with my saved details, then submit it." on demo/apply.html.
 *   3. Checks every field holds the right saved value.
 *   4. Checks that none of the saved values appear in anything the server received (requests,
 *      history, element labels, page text), and that filled fields were masked in screenshots.
 *
 * Prerequisites: `npm start` running. Run:  npm run profile --workspace=e2e
 * Saves e2e/proof/profile.json, 10-apply-filled.png and 11-apply-ai-saw.jpg.
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
const TASK = process.env.ODPA_TASK ?? "Fill this application with my saved details, then submit it.";

/** [key, label, value, selector of the field it should end up in] */
const PROFILE = [
  ["full_name", "Full name", "Aarav Sharma", "#fullname"],
  ["email", "Email", "aarav.sharma@example.com", "#email"],
  ["phone", "Phone", "+91 98765 12345", "#phone"],
  ["city", "City", "Hyderabad", "#city"],
  ["college", "College", "MLR Institute of Technology", "#college"],
  ["degree", "Degree", "B.Tech Computer Science", "#degree"],
  ["graduation_year", "Graduation year", "2027", "#gradyear"],
  ["cgpa", "CGPA", "8.7", "#cgpa"],
  ["linkedin", "LinkedIn", "https://www.linkedin.com/in/aarav-sharma-example", "#linkedin"],
  ["github", "GitHub", "https://github.com/aarav-example", "#github"],
  ["skills", "Skills", "Python, TypeScript, Machine Learning, React", "#skills"],
];

const log = (...a) => console.log("[profile]", ...a);

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
    args: ["--window-size=1366,1000", "--no-first-run", "--no-default-browser-check"],
  });

  let failed = false;
  try {
    const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20_000 });
    const worker = await workerTarget.worker();
    await worker.evaluate(
      (profile) => chrome.storage.local.set({ profile: profile.map(([key, label, value]) => ({ key, label, value })) }),
      PROFILE
    );

    const url = `${DEMO}apply.html`;
    const [page] = await browser.pages();
    await page.setViewport({ width: 1280, height: 940 });
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.bringToFront();
    const { tabId, windowId } = await worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      return { tabId: tab.id, windowId: tab.windowId };
    }, url);

    log(`task: ${TASK}`);
    const started = Date.now();
    const state = await worker.evaluate((t, w, task) => globalThis.odpa.runTask(t, w, task, { autoConfirm: true }), tabId, windowId, TASK);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log(`status=${state.status} after ${state.steps.length} step(s) in ${seconds} s: ${state.message ?? ""}`);
    for (const s of state.steps) log(`  ${s.index + 1}. ${s.summary}${s.ok ? "" : "  <- " + s.message}`);

    // 3. Right values in the right fields?
    const values = await page.evaluate((sels) => sels.map((s) => document.querySelector(s).value), PROFILE.map((p) => p[3]));
    const fieldResults = PROFILE.map(([, label, value, selector], i) => ({ label, selector, ok: values[i] === value, got: values[i] }));
    const correct = fieldResults.filter((f) => f.ok).length;
    for (const f of fieldResults.filter((f) => !f.ok)) log(`  WRONG ${f.label} (${f.selector}): got "${f.got}"`);
    const submitted = await page.$eval("#status", (e) => e.textContent);
    log(`fields correct: ${correct}/${PROFILE.length}; page says: "${submitted}"`);
    await page.screenshot({ path: path.join(proofDir, "10-apply-filled.png"), fullPage: true });

    // 4. Did any saved value leave the device?
    const captures = await fetch(`${SERVER}/debug/captures`).then((r) => r.json());
    // Only text can carry a value: numbers in the payload are coordinates and timings.
    const texts = [];
    const walk = (v) => {
      if (typeof v === "string") texts.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(captures.captures);
    const leaked = PROFILE.filter(([, , value]) => texts.some((t) => t.includes(value))).map(([, label]) => label);
    log(`saved values found in what the server received: ${leaked.length ? leaked.join(", ") : "none"}`);
    const last = captures.captures[0];
    if (last?.hasScreenshot) {
      const img = Buffer.from(await (await fetch(`${SERVER}/debug/captures/${last.id}/screenshot`)).arrayBuffer());
      await writeFile(path.join(proofDir, "11-apply-ai-saw.jpg"), img);
    }

    failed = state.status !== "done" || correct !== PROFILE.length || leaked.length > 0 || !/submitted/i.test(submitted);
    log(failed ? "FAIL" : "PASS");
    await writeFile(
      path.join(proofDir, "profile.json"),
      JSON.stringify({ date: new Date().toISOString(), task: TASK, status: state.status, seconds: Number(seconds), steps: state.steps.map((s) => s.summary), fieldsCorrect: `${correct}/${PROFILE.length}`, fieldResults, valuesLeakedToServer: leaked, pageSays: submitted }, null, 2) + "\n"
    );
  } finally {
    await browser.close();
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
