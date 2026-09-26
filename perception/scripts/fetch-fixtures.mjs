/**
 * Download the public-domain / CC0 sample images used by the detector tests and store them as
 * JPEGs in test/fixtures/. The results are committed, so this only needs re-running to refresh.
 *
 *   node scripts/fetch-fixtures.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../test/fixtures");
const USER_AGENT = "on-device-perception-agent/0.1 (test fixture fetch)";

const SOURCES = [
  {
    out: "astronaut.jpg",
    url: "https://gitlab.com/scikit-image/data/-/raw/master/astronaut.png",
    note: "Eileen Collins, NASA photo (public domain), via the scikit-image data repository",
  },
  {
    out: "chelsea-cat.jpg",
    url: "https://gitlab.com/scikit-image/data/-/raw/master/chelsea.png",
    note: "Chelsea the cat, Stefan van der Walt (CC0), via the scikit-image data repository",
  },
  {
    out: "apollo11-crew.jpg",
    url: "https://commons.wikimedia.org/wiki/Special:FilePath/Apollo_11_Crew.jpg?width=960",
    note: "Apollo 11 crew portrait, NASA (public domain), via Wikimedia Commons",
  },
  {
    out: "coffee.jpg",
    url: "https://gitlab.com/scikit-image/data/-/raw/master/coffee.png",
    note: "Coffee cup, Rachel Michetti (CC0), via the scikit-image data repository; true negative",
  },
];

async function download(url) {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function toJpeg(bytes, url) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return bytes; // already JPEG
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const png = PNG.sync.read(bytes);
    return jpeg.encode({ data: png.data, width: png.width, height: png.height }, 88).data;
  }
  throw new Error(`${url}: unrecognised image format (first bytes ${bytes[0]}, ${bytes[1]})`);
}

await mkdir(fixturesDir, { recursive: true });
for (const source of SOURCES) {
  const bytes = await download(source.url);
  const out = toJpeg(bytes, source.url);
  const target = path.join(fixturesDir, source.out);
  await writeFile(target, out);
  const { width, height } = jpeg.decode(out, { useTArray: true });
  console.log(`${source.out}: ${width}x${height}, ${out.length} bytes  <- ${source.url}`);
}
