/**
 * End-to-end proof of "My info": the REAL extension, server and Gemma fill a job application
 * from saved details and a saved file, for two different people, and nothing saved reaches the
 * server.
 *
 *   1. Saves two made-up people ("Me" and "Father") into the extension's local storage.
 *   2. Adds a PDF resume for "Me" through the real My info page (its own file chooser).
 *   3. Runs "Fill this application with my saved details, then submit it." on demo/apply.html
 *      and checks every field holds the right value and the PDF was attached.
 *   4. Reloads the form and runs "Fill this application with Father's details." and checks the
 *      second person's details were used.
 *   5. Checks that no saved value or file name appears in anything the server received.
 *
 * Prerequisites: `npm start` running. Run:  npm run profile --workspace=e2e
 * Saves e2e/proof/profile.json, 10-apply-filled.png, 11-apply-ai-saw.jpg, 13-my-info-files.png.
 */
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const extensionDir = path.join(root, "extension/dist/chrome");
const proofDir = path.join(here, "proof");
const SERVER = process.env.ODPA_SERVER ?? "http://127.0.0.1:8000";
const DEMO = process.env.ODPA_DEMO ?? "http://127.0.0.1:5500/";
const RESUME_NAME = "Aarav_Sharma_Resume.pdf";

/** [key, label, value, selector of the field it should end up in] */
const ME = [
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
const FATHER = [
  ["full_name", "Full name", "Rajesh Sharma", "#fullname"],
  ["email", "Email", "rajesh.sharma@example.com", "#email"],
  ["phone", "Phone", "+91 91234 00011", "#phone"],
  ["city", "City", "Warangal", "#city"],
];

const log = (...a) => console.log("[profile]", ...a);
const toFields = (rows) => rows.map(([key, label, value]) => ({ key, label, value }));

/** A tiny but valid one-page PDF. */
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 100 Td (Sample resume) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;

async function main() {
  const health = await fetch(`${SERVER}/health/gemma?warm=true`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  if (health.status !== "ok") throw new Error(`Gemma not ready: ${JSON.stringify(health)}`);
  await fetch(`${SERVER}/debug/captures`, { method: "DELETE" });
  await mkdir(proofDir, { recursive: true });
  const resumePath = path.join(os.tmpdir(), RESUME_NAME);
  await writeFile(resumePath, PDF);

  const browser = await puppeteer.launch({
    headless: process.env.HEADFUL ? false : true,
    enableExtensions: [extensionDir],
    pipe: true,
    defaultViewport: null,
    args: ["--window-size=1366,1100", "--no-first-run", "--no-default-browser-check"],
  });

  const report = { date: new Date().toISOString(), runs: [] };
  let failed = false;
  try {
    const workerTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20_000 });
    const worker = await workerTarget.worker();
    const extensionId = new URL(workerTarget.url()).host;

    // 1. Two people, stored the way the My info page stores them.
    await worker.evaluate(
      (me, father) => chrome.storage.local.set({ people: [{ id: "p1", name: "Me", fields: me }, { id: "p2", name: "Father", fields: father }], activePersonId: "p1" }),
      toFields(ME),
      toFields(FATHER)
    );

    // 2. Add the resume through the real My info page.
    const info = await browser.newPage();
    await info.setViewport({ width: 1000, height: 1200 });
    await info.goto(`chrome-extension://${extensionId}/profile.html`, { waitUntil: "load" });
    await info.waitForSelector("#f-full_name");
    await info.type("#file-label", "Resume");
    await (await info.$("#file-input")).uploadFile(resumePath);
    await info.click("#add-file button[type=submit]");
    await info.waitForFunction(() => document.querySelectorAll("#files li .meta").length === 1);
    const people = await info.$$eval("#people .chip:not(.add)", (chips) => chips.map((c) => c.textContent));
    log(`My info: people ${JSON.stringify(people)}; file saved: ${await info.$eval("#files .meta span", (e) => e.textContent)}`);
    await info.screenshot({ path: path.join(proofDir, "13-my-info-files.png"), fullPage: true });
    await info.close();

    const url = `${DEMO}apply.html`;
    const [page] = await browser.pages();
    await page.setViewport({ width: 1280, height: 1040 });

    const fill = async (task, rows, expectFile) => {
      await page.goto(url, { waitUntil: "networkidle0" });
      await page.bringToFront();
      const { tabId, windowId } = await worker.evaluate(async (u) => {
        const [tab] = await chrome.tabs.query({ url: u });
        return { tabId: tab.id, windowId: tab.windowId };
      }, url);

      log(`task: ${task}`);
      const started = Date.now();
      const state = await worker.evaluate((t, w, text) => globalThis.odpa.runTask(t, w, text, { autoConfirm: true }), tabId, windowId, task);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      log(`  status=${state.status} as "${state.person}" after ${state.steps.length} step(s) in ${seconds} s: ${state.message ?? ""}`);
      for (const s of state.steps) log(`    ${s.index + 1}. ${s.summary}${s.ok ? "" : "  <- " + s.message}`);

      const values = await page.evaluate((sels) => sels.map((s) => document.querySelector(s).value), rows.map((r) => r[3]));
      const wrong = rows.map(([, label, value], i) => ({ label, ok: values[i] === value, got: values[i] })).filter((f) => !f.ok);
      for (const f of wrong) log(`    WRONG ${f.label}: got "${f.got}"`);
      const file = await page.evaluate(async () => {
        const f = document.querySelector("#resume").files[0];
        return f ? { name: f.name, size: f.size, type: f.type, head: new TextDecoder().decode((await f.arrayBuffer()).slice(0, 8)) } : null;
      });
      const fileOk = expectFile ? file?.name === RESUME_NAME && file.size === PDF.length && file.head.startsWith("%PDF-") : file === null;
      log(`  fields correct: ${rows.length - wrong.length}/${rows.length}; resume attached: ${file ? `${file.name} (${file.size} bytes)` : "none"}`);
      const ok = (state.status === "done" || state.status === "needs_user" || state.status === "stopped") && wrong.length === 0 && fileOk;
      report.runs.push({ task, person: state.person, status: state.status, seconds: Number(seconds), steps: state.steps.map((s) => s.summary), fieldsCorrect: `${rows.length - wrong.length}/${rows.length}`, file, ok });
      return { state, ok };
    };

    // 3. Me: every detail, the resume, then submit.
    const mine = await fill("Fill this application with my saved details, then submit it.", ME, true);
    const submitted = await page.$eval("#status", (e) => e.textContent);
    log(`  page says: "${submitted}"`);
    await page.screenshot({ path: path.join(proofDir, "10-apply-filled.png"), fullPage: true });
    failed ||= !mine.ok || mine.state.status !== "done" || mine.state.person !== "Me" || !/submitted/i.test(submitted);

    // 4. The second person, named in the task. They have four details and no resume.
    const fathers = await fill("Fill this application with Father's details.", FATHER, false);
    failed ||= !fathers.ok || fathers.state.person !== "Father";

    // 5. Did anything saved leave the device? Only text can carry a value.
    const captures = await fetch(`${SERVER}/debug/captures`).then((r) => r.json());
    const texts = [];
    const walk = (v) => {
      if (typeof v === "string") texts.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(captures.captures.map(({ id, ...rest }) => rest));
    const secrets = [...ME, ...FATHER].map(([, label, value]) => [label, value]).concat([["Resume file name", RESUME_NAME]]);
    const leaked = [...new Set(secrets.filter(([, value]) => texts.some((t) => t.includes(value))).map(([label]) => label))];
    log(`saved values or file names found in what the server received: ${leaked.length ? leaked.join(", ") : "none"}`);
    const afterSubmit = captures.captures.find((c) => c.command?.action === "done" && c.hasScreenshot);
    if (afterSubmit) {
      const img = Buffer.from(await (await fetch(`${SERVER}/debug/captures/${afterSubmit.id}/screenshot`)).arrayBuffer());
      await writeFile(path.join(proofDir, "11-apply-ai-saw.jpg"), img);
    }
    failed ||= leaked.length > 0;
    report.leakedToServer = leaked;

    log(failed ? "FAIL" : "PASS");
    await writeFile(path.join(proofDir, "profile.json"), JSON.stringify(report, null, 2) + "\n");
  } finally {
    await browser.close();
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
