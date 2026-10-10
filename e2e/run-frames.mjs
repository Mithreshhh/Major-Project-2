/**
 * End-to-end proof that the agent works inside embedded frames: the REAL extension, server and
 * Gemma, on demo/checkout.html.
 *
 * The payment widget (pay-frame.html) comes from another origin (127.0.0.1 <-> localhost). The
 * extension's content script runs inside it too and answers the page's hello, so the widget's
 * fields and its Pay button join the element list (ids "el_f1_..."), its card number, email and
 * phone are hidden by the same text rules as the page's own (no OCR needed), and a click on Pay
 * is delivered inside the frame.
 *
 * Prerequisites as for run-demo.mjs. Run:  npm run frames --workspace=e2e
 * Saves e2e/proof/frames.json and 18-frames-paid.png.
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
const URL = `${DEMO}checkout.html`;
const TASK = process.env.ODPA_TASK ?? "Pay for the order with the Pay button in the payment box.";
const SECRETS = ["4111", "98765", "jane.doe@example.com"];

const log = (...a) => console.log("[frames]", ...a);

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
    const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20_000 });
    const worker = await workerTarget.worker();
    const [page] = await browser.pages();
    await page.setViewport({ width: 1280, height: 860 });
    await page.goto(URL, { waitUntil: "networkidle0" });
    await page.bringToFront();
    const { tabId, windowId } = await worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      return { tabId: tab.id, windowId: tab.windowId };
    }, URL);
    const payFrame = page.frames().find((f) => f.url().endsWith("/pay-frame.html"));
    if (!payFrame) throw new Error("the payment frame did not load");

    log(`task: ${TASK}`);
    const started = Date.now();
    const state = await worker.evaluate((t, w, task) => globalThis.odpa.runTask(t, w, task, { autoConfirm: true, maxSteps: 6 }), tabId, windowId, TASK);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const paid = await payFrame.evaluate(() => ({ paid: window.paid, status: document.getElementById("paid").textContent }));

    const captures = (await fetch(`${SERVER}/debug/captures`).then((r) => r.json())).captures.slice().reverse();
    const first = captures[0];
    const inFrame = first.elements.filter((e) => e.attributes?.frame === "embedded");
    const hidden = first.redactions.filter((r) => r.method === "heuristic").map((r) => r.category).sort();
    const leaked = SECRETS.filter((s) => JSON.stringify(captures).includes(s));
    const steps = captures.map((c) => {
      const el = c.elements.find((e) => e.id === c.command?.target);
      return { action: c.command?.action, target: c.command?.target, label: el?.label, inFrame: el?.attributes?.frame === "embedded" };
    });
    for (const [i, s] of steps.entries()) log(`step ${i + 1}: ${s.action}${s.target ? ` ${s.target} "${s.label ?? ""}"${s.inFrame ? "  <- inside the frame" : ""}` : ""}`);
    log(`elements from inside the frame: ${inFrame.map((e) => `${e.id} "${e.label}"`).join(", ")}`);
    log(`hidden by the text rules: ${hidden.join(", ")}; OCR used: ${first.perception.ocrModelId ? "yes" : "no"}; values on the wire: ${leaked.length ? leaked.join(", ") : "none"}`);

    ok = paid.paid === true && steps.some((s) => s.inFrame && s.action === "click") && leaked.length === 0 &&
      ["email", "payment_card", "phone"].every((c) => hidden.includes(c));
    log(`${ok ? "PASS" : "FAIL"} in ${seconds} s: status=${state.status} "${state.message ?? ""}"; frame says: "${paid.status}"`);

    await page.screenshot({ path: path.join(proofDir, "18-frames-paid.png") });
    await writeFile(path.join(proofDir, "frames.json"), JSON.stringify({
      date: new Date().toISOString(), url: URL, task: TASK, pass: ok, seconds: Number(seconds), status: state.status, message: state.message,
      paid, elementsFromFrame: inFrame.map((e) => ({ id: e.id, role: e.role, label: e.label })), hidden, ocrUsed: Boolean(first.perception.ocrModelId), leaked, steps,
    }, null, 2) + "\n");
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
