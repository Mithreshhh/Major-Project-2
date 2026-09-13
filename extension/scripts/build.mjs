/**
 * Extension build script (esbuild).
 *
 * Produces one unpacked extension per browser:
 *   dist/chrome/   -> load via chrome://extensions  (Developer mode -> Load unpacked)
 *   dist/firefox/  -> load via about:debugging      (This Firefox -> Load Temporary Add-on)
 *
 * Both bundles are identical except for manifest.json:
 *   - Chrome MV3 wants  background.service_worker
 *   - Firefox MV3 wants background.scripts + browser_specific_settings.gecko.id
 *
 * Content scripts and service workers cannot use ES-module imports at runtime, so everything
 * is bundled as self-contained IIFEs. Workspace packages (@odpa/shared, @odpa/perception) are
 * bundled straight from their TypeScript sources.
 *
 * Usage:  node scripts/build.mjs [--watch]
 */
import * as esbuild from "esbuild";
import { cp, mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const targets = ["chrome", "firefox"];

const entryPoints = {
  background: path.join(extensionRoot, "src/background/index.ts"),
  content: path.join(extensionRoot, "src/content/index.ts"),
};

/** Directory of onnxruntime-web's prebuilt artifacts (.wasm + .mjs glue). */
// (package.json is not in the package's `exports`, so resolve the main entry, which lives in dist/)
const ortDist = path.dirname(require.resolve("onnxruntime-web"));

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function writeManifest(target, outdir) {
  const base = JSON.parse(await readFile(path.join(extensionRoot, "src/manifest.base.json"), "utf8"));
  const manifest = structuredClone(base);

  if (target === "firefox") {
    delete manifest.minimum_chrome_version;
    manifest.background = { scripts: ["background.js"] };
    manifest.browser_specific_settings = {
      gecko: {
        // Any stable, unique id works for temporary add-ons; change before publishing.
        id: "on-device-perception-agent@example.com",
        strict_min_version: "128.0",
      },
    };
  }

  await writeFile(path.join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Copy the ONNX Runtime WASM binaries into <outdir>/ort so `ort.env.wasm.wasmPaths` can point
 * at chrome.runtime.getURL("ort/"). The JS glue is already inlined in the bundled ORT build we
 * import, so only the .wasm files are needed at runtime.
 */
async function copyOrtAssets(outdir) {
  const dest = path.join(outdir, "ort");
  await mkdir(dest, { recursive: true });
  // The plain wasm EP loads only this file; .jsep (WebGPU), .jspi and .asyncify variants are not
  // needed until an offscreen-document/WebGPU path is added. Each is ~20 MB, so skip them.
  const files = (await readdir(ortDist)).filter((f) => f === "ort-wasm-simd-threaded.wasm");
  await Promise.all(files.map((f) => cp(path.join(ortDist, f), path.join(dest, f))));
  return files.length;
}

/** Static assets (icons, ONNX models, options page, ...) live in extension/public. */
async function copyPublic(outdir) {
  const publicDir = path.join(extensionRoot, "public");
  if (await exists(publicDir)) {
    await cp(publicDir, outdir, { recursive: true });
  }
}

async function buildTarget(target) {
  const outdir = path.join(extensionRoot, "dist", target);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  await writeManifest(target, outdir);
  await copyPublic(outdir);
  const ortFiles = await copyOrtAssets(outdir);

  const ctx = await esbuild.context({
    entryPoints,
    outdir,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: target === "chrome" ? ["chrome120"] : ["firefox128"],
    sourcemap: watch ? "inline" : false,
    minify: false,
    legalComments: "none",
    logLevel: "info",
    define: {
      "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
      __BROWSER__: JSON.stringify(target),
    },
  });

  if (watch) {
    await ctx.watch();
    console.log(`[build] watching ${target} -> ${path.relative(extensionRoot, outdir)}`);
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log(`[build] ${target} -> ${path.relative(extensionRoot, outdir)} (${ortFiles} ORT files)`);
  }
}

for (const target of targets) {
  await buildTarget(target);
}

if (!watch) {
  console.log("[build] done");
}
