/**
 * Prints demo/statement-pdf.html to demo/statement.pdf, the bank statement shown on
 * demo/statement.html. Run again after editing the source page:  node e2e/make-statement.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "demo");
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(await readFile(path.join(demo, "statement-pdf.html"), "utf8"));
  await writeFile(path.join(demo, "statement.pdf"), await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  console.log("demo/statement.pdf written");
} finally {
  await browser.close();
}
