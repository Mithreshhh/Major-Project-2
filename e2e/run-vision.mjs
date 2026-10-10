/**
 * End-to-end proof that the agent can act on controls only the vision model sees: the REAL
 * extension, server and Gemma, on demo/book.html.
 *
 * Every control in that page's booking card (day tiles, time slots, call type, "Confirm
 * booking") is a <div> with a click handler: no <button>, no role. The extension's DOM scan does
 * not list them. The on-device UI detector finds them in the screenshot, the content script
 * checks that the page under each box is clickable, and they reach Gemma as "vis_N" elements
 * that are clicked by position.
 *
 * Passes when the page's own state shows Thursday, 11:30, a video call and a confirmed booking,
 * and at least one of those clicks went to a vis_ target.
 *
 * Prerequisites as for run-demo.mjs. Run:  npm run vision --workspace=e2e
 * Saves e2e/proof/vision.json, 14-vision-what-the-ai-sees.png and 15-vision-booked.png.
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
const URL = `${DEMO}book.html`;
// Options named one by one. With "Book a video call on Thursday at 11:30" the 2B Gemma treats
// "video call" as the goal, not an option to pick, and skips it (see README).
const TASK = process.env.ODPA_TASK ?? "Choose Thursday, 11:30 and Video call, then confirm the booking.";
const EXPECT = { day: "Thu 16", time: "11:30", kind: "Video call", confirmed: true };

const log = (...a) => console.log("[vision]", ...a);

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
    args: ["--window-size=1366,900", "--no-first-run", "--no-default-browser-check"],
  });

  let ok = false;
  try {
    const workerTarget = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().endsWith("/background.js"),
      { timeout: 20_000 }
    );
    const worker = await workerTarget.worker();
    const [page] = await browser.pages();
    await page.setViewport({ width: 1280, height: 860 });
    await page.goto(URL, { waitUntil: "networkidle0" });
    await page.bringToFront();
    const { tabId, windowId } = await worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      return { tabId: tab.id, windowId: tab.windowId };
    }, URL);

    log(`task: ${TASK}`);
    const started = Date.now();
    const state = await worker.evaluate((t, w, task) => globalThis.odpa.runTask(t, w, task, { autoConfirm: true, maxSteps: 12 }), tabId, windowId, TASK);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const booking = await page.evaluate(() => ({ ...window.booking, status: document.getElementById("status").textContent }));

    const captures = (await fetch(`${SERVER}/debug/captures`).then((r) => r.json())).captures.slice().reverse();
    const steps = captures.map((c, i) => {
      const vis = c.elements.filter((e) => e.id.startsWith("vis_"));
      const target = c.command?.target;
      return {
        step: i + 1,
        action: c.command?.action,
        target,
        targetLabel: c.elements.find((e) => e.id === target)?.label,
        visionOnlyTarget: typeof target === "string" && target.startsWith("vis_"),
        listedByDom: c.elements.filter((e) => !e.id.startsWith("vis_") && e.isInteractive).length,
        addedFromVision: vis.map((e) => `${e.id} "${e.label}"${e.attributes?.checked ? " (selected)" : ""}`),
        reasoning: c.command?.reasoning,
      };
    });
    for (const s of steps) {
      log(`step ${s.step}: ${s.action}${s.target ? ` ${s.target} "${s.targetLabel ?? ""}"` : ""}${s.visionOnlyTarget ? "  <- found by vision only" : ""}`);
      log(`  listed by the DOM scan: ${s.listedByDom}; added from vision: ${s.addedFromVision.length} [${s.addedFromVision.join(", ")}]`);
    }

    const visionClicks = steps.filter((s) => s.visionOnlyTarget).length;
    ok = Object.entries(EXPECT).every(([k, v]) => booking[k] === v) && visionClicks > 0;
    log(`${ok ? "PASS" : "FAIL"} in ${seconds} s: status=${state.status} "${state.message ?? ""}"`);
    log(`page state: ${JSON.stringify(booking)}`);
    log(`${visionClicks} of ${steps.length} steps acted on a control only vision found`);

    await page.screenshot({ path: path.join(proofDir, "15-vision-booked.png") });
    const view = await browser.newPage();
    await view.setViewport({ width: 1366, height: 900 });
    // The step where vision added the most controls shows the idea best.
    const best = captures.reduce((a, c) => (c.elements.filter((e) => e.id.startsWith("vis_")).length > a.elements.filter((e) => e.id.startsWith("vis_")).length ? c : a), captures[0]);
    await view.goto(`${SERVER}/debug/view`, { waitUntil: "networkidle0" });
    await view.evaluate(() => new Promise((r) => setTimeout(r, 2000)));
    if (best) await view.click(`#history button[data-id="${best.id}"]`).catch(() => {});
    await view.evaluate(() => new Promise((r) => setTimeout(r, 800)));
    await view.screenshot({ path: path.join(proofDir, "14-vision-what-the-ai-sees.png"), fullPage: true });

    await writeFile(
      path.join(proofDir, "vision.json"),
      JSON.stringify({ date: new Date().toISOString(), url: URL, task: TASK, pass: ok, seconds: Number(seconds), status: state.status, message: state.message, booking, visionClicks, steps }, null, 2) + "\n"
    );
    log(`proof written to ${path.relative(root, proofDir)}`);
  } finally {
    await browser.close();
  }
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
