/**
 * One command to run the whole project:  npm start   (or double-click start.bat on Windows)
 *
 *   1. checks Ollama is running (starts `ollama serve` if it is not)
 *   2. creates the server's Python environment the first time
 *   3. rebuilds the extension when its source is newer than the build
 *   4. starts the API server on :8000 and the test pages on :5500
 *   5. loads Gemma into memory so the first step is not slow
 *   6. opens the test page and "What the AI sees" in Chrome
 *
 * Anything already running is reused. Ctrl+C stops what this script started.
 *
 *   npm start -- --no-open     do not open browser tabs
 *   npm start -- --build       force a rebuild of the extension
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const args = new Set(process.argv.slice(2));

const SERVER = "http://127.0.0.1:8000";
const PAGES = "http://127.0.0.1:5500";
const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const python = path.join(root, "server", ".venv", win ? "Scripts/python.exe" : "bin/python");
const dist = path.join(root, "extension", "dist", "chrome");

const children = [];
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const info = (msg) => console.log(`  \x1b[36m…\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
  shutdown(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await getJson(url, 1500)) return true;
    await sleep(500);
  }
  return false;
}

function run(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, { cwd: root, stdio: "ignore", shell: win, ...options });
  children.push(child);
  return child;
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (child.killed || child.exitCode !== null) continue;
    if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ---------------------------------------------------------------------------------------------

async function ollama() {
  if (!(await getJson(`${OLLAMA}/api/version`))) {
    info("Ollama is not running, starting it");
    run("ollama", ["serve"]);
    if (!(await waitFor(`${OLLAMA}/api/version`, 20))) fail("Ollama did not start. Open the Ollama app, then run this again.");
  }
  ok("Ollama is running");
}

function serverEnvironment() {
  if (existsSync(python)) return;
  info("first run: creating the server's Python environment (about a minute)");
  const made = spawnSync("python", ["-m", "venv", path.join("server", ".venv")], { cwd: root, stdio: "inherit", shell: win });
  if (made.status !== 0) fail("could not create server/.venv. Is Python 3.11+ installed?");
  const pip = spawnSync(python, ["-m", "pip", "install", "-q", "-r", path.join("server", "requirements.txt")], { cwd: root, stdio: "inherit" });
  if (pip.status !== 0) fail("pip install failed for the server");
}

function extension() {
  const built = path.join(dist, "background.js");
  if (!existsSync(path.join(root, "node_modules"))) {
    info("first run: installing npm packages");
    if (spawnSync("npm", ["install"], { cwd: root, stdio: "inherit", shell: win }).status !== 0) fail("npm install failed");
  }
  const sources = ["extension/src", "perception/src", "shared/src"].map((d) => newestMtime(path.join(root, d)));
  const stale = !existsSync(built) || Math.max(...sources) > statSync(built).mtimeMs;
  if (!stale && !args.has("--build")) return ok("extension build is up to date");
  info("building the extension");
  if (spawnSync("npm", ["run", "build"], { cwd: root, stdio: "ignore", shell: win }).status !== 0) fail("extension build failed: run `npm run build` to see why");
  ok("extension rebuilt: press the reload arrow on it in chrome://extensions");
}

async function apiServer() {
  if ((await getJson(`${SERVER}/health`))?.status === 200) return ok(`API server already running on ${SERVER}`);
  // Keep Gemma in memory for a whole session: with the 10-minute default it unloads while you
  // are talking, and the next step then waits for a full reload.
  const env = { ...process.env, OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE ?? "3h" };
  run(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"], { cwd: path.join(root, "server"), shell: false, env });
  if (!(await waitFor(`${SERVER}/health`, 30))) fail("the API server did not start: run `npm run server:dev` to see why");
  ok(`API server on ${SERVER}`);
}

const MIME = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".css": "text/css", ".js": "text/javascript" };

async function testPages() {
  if (await getJson(`${PAGES}/`, 1500).then((r) => r !== null)) return ok(`test pages already served on ${PAGES}`);
  const demoDir = path.join(root, "demo");
  const server = http.createServer(async (req, res) => {
    const name = decodeURIComponent(new URL(req.url ?? "/", PAGES).pathname);
    const file = path.join(demoDir, name === "/" ? "index.html" : name);
    if (!file.startsWith(demoDir)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(5500, "127.0.0.1", resolve)).catch(() => fail("port 5500 is busy"));
  ok(`test pages on ${PAGES}`);
}

async function gemma() {
  info("loading Gemma into memory (up to a minute or two after a restart)");
  const res = await getJson(`${SERVER}/health/gemma?warm=true`, 300_000);
  if (res?.body?.status === "ok") return ok(`Gemma ready (${res.body.model})`);
  if (res?.body?.status === "model_missing") fail(res.body.detail);
  // Still loading or slow: everything else is up, and the first task will finish the load.
  console.log(`  \x1b[33m!\x1b[0m Gemma is still loading (${res?.body?.detail ?? "no answer yet"}). The first step will be slow.`);
}

function openTabs() {
  if (args.has("--no-open")) return;
  const urls = [`${PAGES}/`, `${SERVER}/debug/view`];
  const opened = win
    ? spawnSync("cmd", ["/c", "start", "", "chrome", ...urls], { stdio: "ignore" }).status === 0
    : spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [urls[0]], { stdio: "ignore" }).status === 0;
  if (opened) ok("opened the test page and “What the AI sees”");
}

console.log("\nOn-Device Perception Agent\n");
await ollama();
serverEnvironment();
extension();
await apiServer();
await testPages();
await gemma();
openTabs();

console.log(`
  Ready.
    Test page         ${PAGES}/
    Login page        ${PAGES}/login.html
    Chat page         ${PAGES}/chat.html
    What the AI sees  ${SERVER}/debug/view

  First time only: chrome://extensions → Developer mode → Load unpacked → extension/dist/chrome
  Then click the extension icon on the test page and press Demo task → Run task.

  Keep this window open. Press Ctrl+C to stop.
`);
