/**
 * End-to-end proof of on-device OCR: the REAL extension, server and Gemma.
 *
 *   1. demo/statement.html shows a bank statement in Chrome's PDF viewer, which no extension can
 *      enter: its name, email, phone and card number exist only as pixels. They are read on the
 *      device: each line with personal data is blacked out, and a question about the statement
 *      is answered from its text with placeholders instead of the values.
 *   2. demo/arcade.html draws its whole game menu on a <canvas>. The UI detector finds the
 *      buttons, OCR reads their labels, and "Choose Hard, then start the game." is carried out.
 *
 * Prerequisites as for run-demo.mjs. Run:  npm run ocr --workspace=e2e
 * Saves e2e/proof/ocr.json, 16-ocr-pdf-ai-saw.jpg and 17-ocr-what-the-ai-sees.png.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import jpeg from "jpeg-js";
import puppeteer from "puppeteer";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const extensionDir = path.join(root, "extension/dist/chrome");
const proofDir = path.join(here, "proof");
const SERVER = process.env.ODPA_SERVER ?? "http://127.0.0.1:8000";
const DEMO = process.env.ODPA_DEMO ?? "http://127.0.0.1:5500/";
const SECRETS = ["4111", "98765", "jane.doe@example.com"];
const QUESTION = "How much was the salary on this statement, and which personal details does it show?";
const TASK = "Choose Hard, then start the game.";

const log = (...a) => console.log("[ocr]", ...a);

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

  const proof = { date: new Date().toISOString() };
  let ok = true;
  try {
    const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20_000 });
    const worker = await workerTarget.worker();
    const [page] = await browser.pages();
    await page.setViewport({ width: 1280, height: 860 });
    const open = async (file) => {
      const url = `${DEMO}${file}`;
      await page.goto(url, { waitUntil: "networkidle0" });
      await page.bringToFront();
      return worker.evaluate(async (u) => {
        const [tab] = await chrome.tabs.query({ url: u });
        return { tabId: tab.id, windowId: tab.windowId };
      }, url);
    };
    const captures = async () => (await fetch(`${SERVER}/debug/captures`).then((r) => r.json())).captures.slice().reverse();

    // 1. The PDF statement (the viewer needs a moment to draw the page)
    const t1 = await open("statement.html");
    await new Promise((r) => setTimeout(r, 2500));
    const started = Date.now();
    const answer = await worker.evaluate((t, w, q) => globalThis.odpa.runTask(t, w, q), t1.tabId, t1.windowId, QUESTION);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const [cap] = await captures();
    const hidden = cap.redactions.filter((r) => r.method === "ocr");
    const wire = JSON.stringify(cap);
    const leaked = SECRETS.filter((s) => wire.includes(s));

    // The screenshot the server stored: each hidden line must be black there.
    const shot = Buffer.from(await (await fetch(`${SERVER}/debug/captures/${cap.id}/screenshot`)).arrayBuffer());
    await writeFile(path.join(proofDir, "16-ocr-pdf-ai-saw.jpg"), shot);
    const img = jpeg.decode(shot, { useTArray: true });
    const sx = img.width / cap.viewport.width;
    const dark = hidden.every((r) => {
      const i = (Math.round((r.bbox.y + r.bbox.height / 2) * sx) * img.width + Math.round((r.bbox.x + r.bbox.width / 2) * sx)) * 4;
      return img.data[i] + img.data[i + 1] + img.data[i + 2] < 60;
    });
    const categories = hidden.map((r) => r.category).sort();
    const salary = /85,000/.test(answer.message ?? "");
    const frameOk = cap.perception.ocrLines >= 8 && salary && answer.mode === "ask" && answer.status === "answered" && leaked.length === 0 && dark &&
      ["email", "payment_card", "phone"].every((c) => categories.includes(c));
    ok &&= frameOk;
    log(`${frameOk ? "PASS" : "FAIL"} PDF statement (${seconds} s): OCR read ${cap.perception.ocrLines} lines in ${cap.perception.ocrLatencyMs} ms; answer names the salary: ${salary}`);
    log(`  hidden from pixels: ${categories.join(", ")}; black in the sent screenshot: ${dark}; values on the wire: ${leaked.length ? leaked.join(", ") : "none"}`);
    log(`  text the AI read from the PDF: ${JSON.stringify((cap.pageText ?? "").split("[Text inside an embedded frame, read from the screenshot]")[1]?.trim() ?? "")}`);
    log(`  answer: ${answer.message}`);
    proof.pdf = { url: `${DEMO}statement.html`, question: QUESTION, pass: frameOk, seconds: Number(seconds), ocrLines: cap.perception.ocrLines, ocrMs: cap.perception.ocrLatencyMs, hidden: categories, blackInScreenshot: dark, leaked, answer: answer.message };

    // 2. The canvas game
    await fetch(`${SERVER}/debug/captures`, { method: "DELETE" });
    const t2 = await open("arcade.html");
    const started2 = Date.now();
    const state = await worker.evaluate((t, w, task) => globalThis.odpa.runTask(t, w, task, { autoConfirm: true, maxSteps: 8 }), t2.tabId, t2.windowId, TASK);
    const seconds2 = ((Date.now() - started2) / 1000).toFixed(1);
    const game = await page.evaluate(() => ({ ...window.game, status: document.getElementById("status").textContent }));
    const steps = (await captures()).map((c) => {
      const target = c.command?.target;
      const el = c.elements.find((e) => e.id === target);
      return { action: c.command?.action, target, label: el?.label, labelFrom: el?.attributes?.labelFrom, drawn: c.elements.filter((e) => e.attributes?.labelFrom === "ocr").map((e) => e.label) };
    });
    for (const [i, s] of steps.entries()) log(`step ${i + 1}: ${s.action}${s.target ? ` ${s.target} "${s.label ?? ""}"${s.labelFrom === "ocr" ? " (name read by OCR)" : ""}` : ""}`);
    const gameOk = game.level === "Hard" && game.started && steps.some((s) => s.labelFrom === "ocr");
    ok &&= gameOk;
    log(`${gameOk ? "PASS" : "FAIL"} canvas game (${seconds2} s): status=${state.status}; page: ${JSON.stringify(game)}`);
    log(`  controls named by OCR: ${JSON.stringify(steps[0]?.drawn ?? [])}`);
    proof.canvas = { url: `${DEMO}arcade.html`, task: TASK, pass: gameOk, seconds: Number(seconds2), status: state.status, game, steps };

    const view = await browser.newPage();
    await view.setViewport({ width: 1366, height: 900 });
    await fetch(`${SERVER}/debug/captures`, { method: "DELETE" });
    await page.bringToFront();
    await page.goto(`${DEMO}statement.html`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 2500));
    await worker.evaluate((t, w) => globalThis.odpa.runTask(t, w, "Look at this statement page and reply done.", { autoConfirm: true, maxSteps: 1 }), t1.tabId, t1.windowId);
    await view.goto(`${SERVER}/debug/view`, { waitUntil: "networkidle0" });
    await view.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
    await view.screenshot({ path: path.join(proofDir, "17-ocr-what-the-ai-sees.png"), fullPage: true });

    await writeFile(path.join(proofDir, "ocr.json"), JSON.stringify(proof, null, 2) + "\n");
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
