/**
 * Drives the REAL popup UI (not the worker API) and saves screenshots of it:
 *   6-popup-confirm.png   the task paused on "Allow this action?" (then Allow is clicked in the popup)
 *   7-popup-done.png      the finished task with its steps
 *   8-popup-answer.png    ask mode answering the demo question
 *   0-test-page.png       the test page itself
 *   12-my-info.png        the My info page with sample details saved
 *
 * The popup normally reads the active tab; here it opens in its own window with ?tab=<id>, so
 * the test page stays the visible tab that gets captured.
 *
 *   npm run popup --workspace=e2e
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const extensionDir = path.join(root, "extension/dist/chrome");
const proofDir = path.join(here, "proof");
const DEMO = process.env.ODPA_DEMO ?? "http://127.0.0.1:5500/";
const log = (...a) => console.log("[popup]", ...a);

async function main() {
  await mkdir(proofDir, { recursive: true });
  const browser = await puppeteer.launch({
    headless: process.env.HEADFUL ? false : true,
    enableExtensions: [extensionDir],
    pipe: true,
    defaultViewport: null,
    args: ["--window-size=1366,900", "--no-first-run", "--no-default-browser-check"],
  });
  try {
    const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20_000 });
    const extensionId = new URL(workerTarget.url()).host;
    const worker = await workerTarget.worker();

    const [page] = await browser.pages();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(DEMO, { waitUntil: "networkidle0" });
    await page.screenshot({ path: path.join(proofDir, "0-test-page.png") });
    const tab = await worker.evaluate(async (u) => {
      const [t] = await chrome.tabs.query({ url: `${u}*` });
      return { id: t.id, windowId: t.windowId, url: t.url };
    }, DEMO);

    // Own window, so the test page stays the visible tab that gets captured.
    const popupUrl = `chrome-extension://${extensionId}/popup.html?tab=${tab.id}`;
    await worker.evaluate((url) => chrome.windows.create({ url, type: "popup", width: 420, height: 720 }), popupUrl);
    const popupTarget = await browser.waitForTarget((t) => t.url() === popupUrl, { timeout: 10_000 });
    const popup = await popupTarget.page();
    await popup.setViewport({ width: 400, height: 640 });
    await popup.waitForFunction(() => document.getElementById("page")?.textContent !== "…");

    // 1. Run the demo task from the popup and stop at the Allow prompt.
    await popup.click("#demo");
    await popup.click("#run");
    try {
      await popup.waitForSelector("#status.confirm", { timeout: 120_000 });
    } catch (err) {
      await popup.screenshot({ path: path.join(proofDir, "popup-debug.png"), fullPage: true });
      log(`no confirm prompt; popup shows: ${await popup.$eval("#status", (e) => `${e.className} | ${e.textContent}`)}`);
      throw err;
    }
    await popup.screenshot({ path: path.join(proofDir, "6-popup-confirm.png"), fullPage: true });
    log(`confirm prompt: ${await popup.$eval("#status-msg", (e) => e.textContent)}`);
    await popup.click("#allow");
    await popup.waitForSelector("#status.done, #status.failed, #status.stopped, #status.needs_user", { timeout: 120_000 });
    await popup.screenshot({ path: path.join(proofDir, "7-popup-done.png"), fullPage: true });
    log(`task: ${await popup.$eval("#status-title", (e) => e.textContent)} - ${await popup.$eval("#status-msg", (e) => e.textContent)}`);

    // 2. Ask the demo question.
    await popup.click("#demo-q");
    await popup.click("#ask");
    await popup.waitForSelector("#status.answered, #status.failed", { timeout: 120_000 });
    await popup.screenshot({ path: path.join(proofDir, "8-popup-answer.png"), fullPage: true });
    log(`answer: ${await popup.$eval("#status-msg", (e) => e.textContent)}`);

    // 3. The My info page: fill the sample data through its own UI and save.
    const info = await browser.newPage();
    await info.setViewport({ width: 1000, height: 1100 });
    await info.goto(`chrome-extension://${extensionId}/profile.html`, { waitUntil: "load" });
    await info.waitForSelector("#f-full_name");
    await info.click("#sample");
    await info.click("#save");
    await info.waitForFunction(() => document.getElementById("saved").textContent.startsWith("Saved"));
    await info.screenshot({ path: path.join(proofDir, "12-my-info.png"), fullPage: true });
    log(`my info: ${await info.$eval("#saved", (e) => e.textContent)}`);
    log(`saved popup screenshots to ${path.relative(root, proofDir)}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
