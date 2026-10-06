/**
 * Screenshots of the test pages, for slides and for checking the design by eye.
 * No extension, server or model needed; only the pages on :5500.
 *
 *   npm run pages --workspace=e2e      -> e2e/proof/pages/*.png
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "proof", "pages");
const DEMO = process.env.ODPA_DEMO ?? "http://127.0.0.1:5500/";
const PAGES = [
  ["index.html", "contact", 1280, 860],
  ["apply.html", "apply", 1280, 1000],
  ["login.html", "login", 1280, 780],
  ["chat.html", "chat", 1280, 780],
  ["store.html", "store", 1280, 900],
  ["pricing.html", "pricing", 1280, 900],
  ["features.html", "features", 1280, 900],
];

await mkdir(outDir, { recursive: true });
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const [file, name, width, height] of PAGES) {
    await page.setViewport({ width, height });
    await page.goto(`${DEMO}${file}`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log(`[pages] ${name}.png`);
  }
} finally {
  await browser.close();
}
