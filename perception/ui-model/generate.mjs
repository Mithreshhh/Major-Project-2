// Builds a YOLO dataset of web screenshots with buttons, inputs and links labelled for free.
//
// Every page is generated from a seed (random theme, fonts, layout, components) and rendered in
// headless Chrome. The generator tags each interactive element with data-cls, and the boxes come
// straight from getBoundingClientRect, so labels are exact and cost nothing.
//
// The demo page (../../demo/index.html) is NOT used for training. It is rendered separately into
// the "demo" split, labelled from its DOM, and used as a held-out test.
//
//   node generate.mjs [trainCount=700] [valCount=100]
//   node generate.mjs --demo-only          re-shoot only the held-out test pages

import { mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "dataset");
const ASSETS = path.join(OUT, "assets");
export const CLASSES = ["button", "input", "link"];

const trainCount = Number(process.argv[2] ?? 700);
const valCount = Number(process.argv[3] ?? 100);

// ---------------------------------------------------------------------------------------------
// Page generator (runs in Node, returns an HTML string)
// ---------------------------------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ("home about pricing features docs blog careers contact support login sign up account " +
  "settings profile orders cart search help news products services team privacy terms status " +
  "download learn more get started continue save cancel submit apply next back delete edit view " +
  "details subscribe buy now add to cart checkout register forgot password send message book demo " +
  "explore compare upgrade share follow reply open close filter sort export import create new").split(" ");
const SENTENCE = ("the quick service helps teams plan ship and track work across projects with simple " +
  "tools that stay out of the way while keeping every update visible to the people who need it " +
  "our platform runs in the browser and works on any device with secure storage and fast search").split(" ");
const FIELD_NAMES = ["Full name", "Email address", "Phone", "Company", "City", "Username", "Password",
  "Search", "Address", "Postcode", "Website", "Subject", "Coupon code", "First name", "Last name"];
const FONTS = ["system-ui, sans-serif", "Georgia, serif", "Arial, sans-serif", "'Segoe UI', sans-serif",
  "Verdana, sans-serif", "'Times New Roman', serif", "Tahoma, sans-serif", "'Courier New', monospace",
  "'Trebuchet MS', sans-serif", "Calibri, sans-serif"];
const ICONS = ["✕", "☰", "⌕", "♥", "★", "⚙", "↗", "⋯", "+", "›"];

function makePage(seed, images) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const int = (a, b) => a + Math.floor(r() * (b - a + 1));
  const chance = (p) => r() < p;
  const words = (a, b) => Array.from({ length: int(a, b) }, () => pick(WORDS)).join(" ");
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const sentence = (a, b) => cap(Array.from({ length: int(a, b) }, () => pick(SENTENCE)).join(" ")) + ".";
  const hsl = (h, s, l) => `hsl(${h} ${s}% ${l}%)`;

  const dark = chance(0.25);
  const hue = int(0, 359);
  const accent = hsl(hue, int(45, 90), int(35, 55));
  const accent2 = hsl((hue + int(90, 200)) % 360, int(40, 80), int(40, 55));
  const bg = dark ? hsl(int(200, 240), int(5, 25), int(6, 16)) : hsl(int(0, 359), int(0, 30), int(94, 100));
  const surface = dark ? hsl(int(200, 240), int(5, 20), int(14, 22)) : hsl(0, 0, int(97, 100));
  const text = dark ? hsl(0, 0, int(82, 95)) : hsl(int(200, 230), int(5, 20), int(8, 22));
  const muted = dark ? hsl(0, 0, 60) : hsl(0, 0, 42);
  const border = dark ? hsl(0, 0, int(26, 36)) : hsl(0, 0, int(78, 88));
  // "Modern" pages: tinted soft inputs, gradient buttons with a glow, muted nav links, a
  // gradient page backdrop. Added after a redesigned test page (same controls, new styling)
  // dropped the detector from 11/12 to 8/12.
  const modern = chance(0.45);
  const radius = pick([0, 2, 4, 6, 8, 12, 999]);
  const inputRadius = radius === 999 ? pick([4, 8, 999]) : radius;
  const font = pick(FONTS);
  const size = int(13, 18);
  // Links always look like links (coloured and/or underlined): plain-coloured "links" would teach
  // the model that any short text is clickable. Only nav bars use text-coloured links.
  const linkColor = chance(0.75) ? accent : pick([accent2, "#0645ad"]);
  const underline = chance(0.5) ? "underline" : "none";

  const btn = (label, kind = pick(modern ? ["gradient", "gradient", "solid", "outline", "ghost", "soft"] : ["solid", "solid", "outline", "ghost", "soft", "link-like"])) => {
    if (modern && kind === "solid" && chance(0.6)) kind = "gradient";
    const pad = modern ? `${int(9, 13)}px ${int(16, 24)}px` : `${int(5, 12)}px ${int(10, 24)}px`;
    const styles = {
      solid: `background:${pick([accent, accent2])};color:#fff;border:1px solid transparent`,
      gradient: `background:linear-gradient(135deg,${accent},${pick([accent2, hsl(hue, 70, 35)])});color:#fff;border:1px solid transparent;` +
        `box-shadow:0 ${int(4, 10)}px ${int(14, 26)}px ${hsl(hue, 70, 50)}55`,
      outline: `background:transparent;color:${accent};border:${int(1, 2)}px solid ${accent}`,
      ghost: `background:transparent;color:${text};border:1px solid ${border}`,
      soft: `background:${hsl(hue, 70, dark ? 25 : 92)};color:${accent};border:none`,
      "link-like": `background:${dark ? "#333" : "#e9ecef"};color:${text};border:none`,
    };
    const tag = chance(0.2) ? "a" : "button";
    const extra = tag === "a" ? ' href="#"' : "";
    return `<${tag}${extra} data-cls="button" style="display:inline-block;text-decoration:none;cursor:pointer;` +
      `font:inherit;font-size:${int(size - 2, size + 2)}px;font-weight:${pick([400, 500, 600, 700])};` +
      `padding:${pad};border-radius:${modern ? pick([9, 10, 11, 12, 999]) : radius === 999 ? 999 : int(0, radius)}px;${styles[kind]};margin:${int(2, 8)}px">` +
      `${label}</${tag}>`;
  };
  const iconBtn = () => `<button data-cls="button" style="font:inherit;font-size:${int(14, 20)}px;width:${int(28, 40)}px;` +
    `height:${int(28, 40)}px;border-radius:${pick([4, 8, 999])}px;border:1px solid ${border};background:${surface};` +
    `color:${text};cursor:pointer;margin:4px">${pick(ICONS)}</button>`;
  const link = (label) => `<a href="#" data-cls="link" style="color:${linkColor};text-decoration:${underline}">${label}</a>`;
  // Soft field look: a faint tint instead of a white box, large radius, generous padding.
  const softBg = dark ? hsl(int(200, 240), int(10, 25), int(10, 16)) : hsl(int(200, 240), int(20, 50), int(96, 98));
  const softBorder = dark ? hsl(0, 0, int(22, 30)) : hsl(int(200, 240), int(15, 30), int(84, 90));
  const input = (placeholder) => {
    const h = int(28, 44);
    if (modern) {
      return `<input data-cls="input" type="${pick(["text", "text", "email", "password", "tel"])}" placeholder="${chance(0.6) ? placeholder : ""}" ` +
        `${chance(0.3) ? `value="${words(1, 3)}"` : ""} style="font:inherit;font-size:${int(size - 1, size + 1)}px;height:${int(40, 48)}px;` +
        `padding:0 ${int(11, 14)}px;width:${pick(["100%", "100%", `${int(200, 380)}px`])};border:1px solid ${softBorder};` +
        `border-radius:${pick([9, 10, 11, 12, 14])}px;background:${softBg};color:${text};margin:4px 0 ${int(10, 16)}px">`;
    }
    return `<input data-cls="input" type="text" placeholder="${chance(0.7) ? placeholder : ""}" ` +
      `${chance(0.3) ? `value="${words(1, 3)}"` : ""} style="font:inherit;font-size:${int(size - 1, size + 1)}px;` +
      `height:${h}px;padding:0 ${int(6, 14)}px;width:${pick(["100%", `${int(160, 360)}px`])};` +
      `border:${chance(0.85) ? `1px solid ${border}` : "none"};border-bottom:${int(1, 2)}px solid ${border};` +
      `border-radius:${inputRadius}px;background:${chance(0.7) ? surface : bg};color:${text};margin:4px 0 ${int(6, 14)}px">`;
  };
  const field = () => {
    const name = pick(FIELD_NAMES);
    return `<div style="margin-bottom:${int(4, 12)}px"><label style="display:block;font-size:${size - 1}px;` +
      `font-weight:${pick([400, 600])};color:${chance(0.5) ? text : muted}">${name}</label>${input(name.toLowerCase())}</div>`;
  };
  const textarea = () => `<textarea data-cls="input" rows="${int(2, 5)}" placeholder="${chance(0.8) ? sentence(2, 4) : ""}" ` +
    `style="font:inherit;width:100%;padding:${modern ? 11 : 8}px;border:1px solid ${modern ? softBorder : border};border-radius:${modern ? pick([10, 12, 14]) : inputRadius}px;` +
    `background:${modern ? softBg : surface};color:${text};margin:4px 0 10px"></textarea>`;
  const select = () => `<select data-cls="input" style="font:inherit;height:${int(28, 40)}px;padding:0 8px;` +
    `border:1px solid ${border};border-radius:${inputRadius}px;background:${surface};color:${text};margin:4px">` +
    `<option>${cap(words(1, 2))}</option></select>`;
  const checkbox = () => `<label style="display:inline-flex;align-items:center;gap:6px;margin:6px 12px 6px 0">` +
    `<input data-cls="input" type="${pick(["checkbox", "radio"])}" ${chance(0.4) ? "checked" : ""} ` +
    `style="width:${int(14, 18)}px;height:${int(14, 18)}px;margin:0">${cap(words(1, 3))}</label>`;
  const para = () => {
    const parts = Array.from({ length: int(2, 4) }, () => sentence(6, 16));
    if (chance(0.7)) parts.splice(int(0, parts.length), 0, link(words(1, 3)));
    return `<p style="color:${chance(0.6) ? text : muted};margin:8px 0">${parts.join(" ")}</p>`;
  };
  const image = (w, h) => chance(0.6) && images.length
    ? `<img src="${pick(images)}" style="width:${w};height:${h}px;object-fit:cover;border-radius:${int(0, 12)}px;display:block">`
    : `<div style="width:${w};height:${h}px;border-radius:${int(0, 12)}px;background:linear-gradient(${int(0, 360)}deg,` +
      `${hsl(int(0, 359), 60, 70)},${hsl(int(0, 359), 60, 45)})"></div>`;
  // Coloured or gradient words inside a heading are decoration, not links.
  const fancy = (t) => chance(0.5)
    ? `<span style="background:linear-gradient(90deg,${accent},${accent2});-webkit-background-clip:text;background-clip:text;color:transparent">${t}</span>`
    : `<span style="color:${accent}">${t}</span>`;
  const heading = (lvl) => `<h${lvl} style="margin:${int(6, 16)}px 0;font-size:${size + (4 - lvl) * int(3, 7)}px">` +
    `${cap(words(2, 4))}${modern && lvl <= 2 && chance(0.5) ? " " + fancy(words(1, 3)) : " " + words(0, 2)}</h${lvl}>`;
  // A pill badge next to a name or title ("Pro plan"): rounded and coloured like a button, but
  // small, bold and not interactive.
  const badge = () => `<span style="display:inline-block;font-size:${int(11, 13)}px;font-weight:700;color:${accent};` +
    `background:${hsl(hue, 70, dark ? 22 : 93)};border-radius:99px;padding:${int(2, 4)}px ${int(9, 12)}px;margin-left:8px">${cap(words(1, 2))}</span>`;
  const card = (inner) => `<div style="background:${surface};border:${chance(0.7) ? `1px solid ${border}` : "none"};` +
    `border-radius:${radius === 999 ? 16 : radius}px;padding:${int(12, 24)}px;${chance(0.4) ? "box-shadow:0 2px 10px rgba(0,0,0,.12);" : ""}">${inner}</div>`;

  const nav = () => {
    const plainNav = chance(modern ? 0.75 : 0.3);
    const navColor = modern && chance(0.7) ? muted : text;
    const items = Array.from({ length: int(3, 7) }, () => link(cap(pick(WORDS))))
      .map((a) => plainNav ? a.replace(`color:${linkColor};text-decoration:${underline}`, `color:${navColor};text-decoration:none;font-weight:500${modern ? `;padding:${int(5, 8)}px ${int(6, 12)}px` : ""}`) : a)
      .join(`<span style="width:${int(10, 28)}px;display:inline-block"></span>`);
    const name = `${cap(pick(WORDS))}${pick(["", "ly", "io", " Hub", " Co"])}`;
    const mark = `<span style="display:inline-grid;place-items:center;width:${int(26, 34)}px;height:${int(26, 34)}px;border-radius:${pick([6, 8, 10, 99])}px;` +
      `background:linear-gradient(135deg,${accent},${accent2});color:#fff;font-weight:800;font-size:${size}px;margin-right:${int(6, 10)}px;vertical-align:middle">${name[0]}</span>`;
    // Most sites link their logo home. The mark is square and coloured, but the whole thing is a link.
    const brand = chance(0.6)
      ? `<a href="#" data-cls="link" style="display:inline-flex;align-items:center;font-weight:700;font-size:${size + 4}px;color:${text};text-decoration:none;margin-right:${int(10, 40)}px">${chance(0.7) ? mark : ""}${name}</a>`
      : `<strong style="font-size:${size + 4}px;margin-right:${int(10, 40)}px">${name}</strong>`;
    const plainLogin = `<a href="#" data-cls="link" style="color:${chance(0.6) ? accent : navColor};text-decoration:none;font-weight:500">${pick(["Log in", "Sign in", "Account", "Help"])}</a>`;
    const right = [chance(0.3) ? plainLogin : "", chance(0.5) ? btn(cap(words(1, 2)), "solid") : "", chance(0.3) ? btn("Log in", pick(["ghost", "outline"])) : "",
      chance(0.4) ? iconBtn() : "", chance(0.3) ? input("Search") .replace(/width:[^;]+;/, "width:180px;") : ""].join("");
    return `<header style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;padding:${int(8, 18)}px ${int(12, 40)}px;` +
      `background:${chance(0.5) ? surface : bg};border-bottom:1px solid ${border}">${brand}<nav>${items}</nav>` +
      `<div style="margin-left:auto;display:flex;align-items:center;gap:${int(6, 16)}px">${right}</div></header>`;
  };
  const hero = () => `<section style="padding:${int(20, 50)}px 0;display:flex;gap:30px;align-items:center;flex-wrap:wrap">` +
    `<div style="flex:1;min-width:280px">${heading(1)}${para()}<div>${btn(cap(words(1, 3)), "solid")}${chance(0.6) ? btn(cap(words(1, 2)), pick(["outline", "ghost"])) : ""}</div></div>` +
    `${chance(0.6) ? `<div style="flex:1;min-width:240px">${image("100%", int(160, 300))}</div>` : ""}</section>`;
  const form = () => {
    const fields = Array.from({ length: int(2, 5) }, field).join("");
    const extras = [chance(0.4) ? textarea() : "", chance(0.4) ? select() : "", chance(0.5) ? checkbox() + (chance(0.5) ? checkbox() : "") : ""].join("");
    const cols = chance(0.4) ? `display:grid;grid-template-columns:1fr 1fr;gap:0 16px` : "";
    return card(`${heading(3)}<div style="${cols}">${fields}</div>${extras}<div style="margin-top:8px">` +
      `${btn(cap(pick(["submit", "send", "save", "continue", "sign up", "register", "apply", "log in"])), "solid")}` +
      `${chance(0.5) ? btn(cap(pick(["cancel", "reset", "back", "clear"])), pick(["ghost", "outline", "link-like"])) : ""}` +
      `${chance(0.4) ? `<span style="margin-left:10px">${link(cap(words(2, 3)))}</span>` : ""}</div>`);
  };
  const cards = () => {
    const n = int(2, 4);
    return `<div style="display:grid;grid-template-columns:repeat(${n},1fr);gap:${int(10, 24)}px;margin:18px 0">` +
      Array.from({ length: n }, () => card(`${chance(0.7) ? image("100%", int(80, 150)) : ""}${heading(4)}` +
        `<p style="color:${muted};margin:6px 0">${sentence(5, 12)}</p>${chance(0.6) ? btn(cap(words(1, 2))) : link(cap(words(1, 3)) + " ›")}` +
        `${chance(0.3) ? iconBtn() : ""}`)).join("") + `</div>`;
  };
  const table = () => {
    const rows = Array.from({ length: int(3, 7) }, () => `<tr>${[link(cap(words(1, 2))), words(1, 2), String(int(1, 9999)),
      chance(0.5) ? btn(cap(pick(["edit", "view", "delete", "open"])), pick(["ghost", "soft", "outline"])) : link(pick(["Edit", "View", "Details"]))]
      .map((c) => `<td style="padding:6px 10px;border-bottom:1px solid ${border}">${c}</td>`).join("")}</tr>`).join("");
    return card(`${heading(3)}<table style="width:100%;border-collapse:collapse;font-size:${size - 1}px">${rows}</table>`);
  };
  const searchBar = () => `<div style="display:flex;gap:8px;align-items:center;margin:14px 0">${input("Search " + pick(WORDS)).replace(/width:[^;]+;/, "width:100%;")}${btn("Search", "solid")}${chance(0.5) ? select() : ""}</div>`;
  const article = () => `<article>${heading(2)}${para()}${para()}${chance(0.5) ? para() : ""}</article>`;
  const sidebar = () => card(`${heading(4)}` + Array.from({ length: int(3, 8) }, () => `<div style="margin:6px 0">${link(cap(words(1, 3)))}</div>`).join(""));
  const pager = () => `<div style="margin:14px 0">${btn("‹ Prev", "ghost")}${Array.from({ length: int(3, 6) }, (_, i) => link(String(i + 1))).join(" &nbsp; ")}${btn("Next ›", "ghost")}</div>`;
  const footerRow = () => `<footer style="margin-top:24px;padding:${int(14, 24)}px 0;border-top:1px solid ${border};display:flex;gap:${int(14, 26)}px;flex-wrap:wrap;` +
    `align-items:center;color:${muted};font-size:${size - 2}px"><span style="margin-right:auto">© 2026 ${cap(pick(WORDS))} ${pick(["Labs", "Inc", "Ltd"])}</span>` +
    Array.from({ length: int(2, 5) }, () => `<a href="#" data-cls="link" style="color:${chance(0.6) ? accent : muted};text-decoration:none">${cap(words(1, 2))}</a>`).join("") + `</footer>`;
  const footer = () => chance(0.45) ? footerRow() : `<footer style="margin-top:24px;padding:${int(14, 30)}px 0;border-top:1px solid ${border};display:flex;gap:40px;flex-wrap:wrap;color:${muted}">` +
    Array.from({ length: int(2, 4) }, () => `<div><strong style="color:${text}">${cap(pick(WORDS))}</strong>` +
      Array.from({ length: int(2, 5) }, () => `<div style="margin:4px 0">${link(cap(words(1, 2)))}</div>`).join("") + `</div>`).join("") + `</footer>`;
  const banner = () => `<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;margin:10px 0;border-radius:${radius === 999 ? 12 : radius}px;` +
    `background:${hsl(int(0, 359), 70, dark ? 20 : 92)}">${sentence(5, 10)} ${link(cap(words(1, 2)))}<span style="margin-left:auto">${btn(cap(words(1, 1)), "solid")}${chance(0.6) ? iconBtn() : ""}</span></div>`;

  // Hard negatives: things that look a bit like links or inputs but are not interactive.
  const details = () => card(`${chance(0.6) ? image(`${int(120, 260)}px`, int(120, 260)) : ""}` +
    `<div style="display:flex;align-items:center;justify-content:${pick(["space-between", "flex-start"])}"><strong style="font-size:${size + 2}px">${cap(words(1, 2))}</strong>${chance(0.7) ? badge() : ""}</div>` +
    `<dl style="display:grid;grid-template-columns:auto 1fr;gap:${int(2, 8)}px ${int(8, 20)}px;margin:8px 0;font-size:${size - 1}px">` +
    Array.from({ length: int(3, 7) }, () => `<dt style="color:${muted}">${cap(pick(WORDS))}</dt>` +
      `<dd style="margin:0;font-variant-numeric:tabular-nums">${chance(0.5) ? String(int(1000, 99999)) + " " + String(int(1000, 9999)) : cap(words(1, 3))}</dd>`).join("") +
    `</dl><p style="font-size:${size - 3}px;color:${muted};margin:6px 0">${sentence(6, 14)}</p>`);
  const logPanel = () => card(`<strong>${cap(words(1, 2))}</strong><ul style="margin:6px 0 0;padding:0;list-style:none;` +
    `font-family:ui-monospace,monospace;font-size:${int(11, 13)}px">` +
    Array.from({ length: int(1, 6) }, () => `<li style="padding:2px 0;border-bottom:1px dashed ${border}">${int(1, 12)}:${int(10, 59)}:${int(10, 59)} ${words(2, 6)}</li>`).join("") +
    `</ul>`);
  const codeBox = () => `<pre style="background:${dark ? "#0b0f14" : "#f3f4f6"};border:1px solid ${border};border-radius:${inputRadius}px;` +
    `padding:10px 12px;font-size:${int(11, 13)}px;overflow:hidden;margin:10px 0">${words(3, 8)}\n${words(2, 6)}</pre>`;
  const stats = () => `<div style="display:flex;gap:${int(12, 30)}px;flex-wrap:wrap;margin:14px 0">` +
    Array.from({ length: int(2, 5) }, () => `<div style="border:1px solid ${border};border-radius:${radius === 999 ? 12 : radius}px;padding:10px 16px;min-width:120px">` +
      `<div style="font-size:${size + int(6, 14)}px;font-weight:700">${int(1, 999)}${pick(["", "%", "k", " ms"])}</div>` +
      `<div style="font-size:${size - 2}px;color:${muted}">${cap(words(1, 2))}</div></div>`).join("") + `</div>`;
  const tags = () => `<div style="margin:8px 0">` + Array.from({ length: int(2, 6) }, () =>
    `<span style="display:inline-block;font-size:${size - 3}px;padding:1px 8px;margin:2px;border-radius:99px;background:${hsl(int(0, 359), 50, dark ? 25 : 90)}">${pick(WORDS)}</span>`).join("") + `</div>`;

  // More look-alikes that are not controls: a dark console of timestamped lines, a row of
  // rounded info chips, a small "eyebrow" pill above a heading.
  const consolePanel = () => `<div style="background:#0b1020;border:1px solid #1b2340;border-radius:${int(10, 18)}px;overflow:hidden;margin:14px 0">` +
    `<div style="padding:10px 14px;border-bottom:1px solid #1b2340;color:#c7d0e6;font-weight:600;font-size:${size - 2}px">${cap(words(1, 2))}</div>` +
    `<ul style="margin:0;padding:8px 14px 12px;list-style:none;font-family:ui-monospace,Consolas,monospace;font-size:${int(11, 13)}px">` +
    Array.from({ length: int(2, 7) }, () => `<li style="color:#9fb0d4;padding:2px 0;border-bottom:1px dashed #18203a">${int(1, 12)}:${int(10, 59)}:${int(10, 59)} PM  ` +
      `${pick(["click", "input", "submit", "change"])} &lt;${pick(["button", "input", "a"])}&gt; #${pick(WORDS)} "${words(1, 4)}"</li>`).join("") + `</ul></div>`;
  const successBanner = () => `<div style="margin:12px 0;padding:${int(8, 12)}px ${int(10, 14)}px;border-radius:${int(6, 12)}px;font-weight:600;` +
    `color:hsl(150 70% ${dark ? 60 : 25}%);background:hsl(150 60% ${dark ? 14 : 95}%);border:1px solid hsl(150 50% ${dark ? 30 : 80}%)">${sentence(2, 5)}</div>`;
  const chipsRow = () => `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0">` + Array.from({ length: int(2, 4) }, () =>
    `<span style="font-size:${size - 2}px;color:${muted};background:${surface};border:1px solid ${border};border-radius:99px;padding:4px 12px">` +
    `<b style="color:${text}">${pick([String(int(1, 99)), cap(pick(WORDS)), "No"])}</b> ${words(1, 2)}</span>`).join("") + `</div>`;
  const eyebrow = () => `<div style="margin:14px 0 6px"><span style="display:inline-block;font-size:${size - 3}px;font-weight:600;color:${accent};` +
    `background:${hsl(hue, 70, dark ? 20 : 94)};border-radius:99px;padding:3px 12px">${cap(words(1, 2))}</span></div>${heading(pick([1, 2]))}${para()}`;

  // Round 5: choice groups built from scripted <div>s (time slots, day tiles, size pickers,
  // segmented controls, option tiles), labelled as buttons. Real booking and shop widgets are
  // made this way and the extension can only find them from pixels. Unlike the info chips above
  // they come as a row of uniform, bolder tiles, often with one highlighted.
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const choiceGroup = () => {
    const kind = pick(["slots", "slots", "days", "sizes", "segmented", "options"]);
    const n = kind === "segmented" ? int(2, 4) : int(3, 6);
    const rad = kind === "segmented" ? int(6, 10) : pick([6, 8, 10, 12, 999]);
    const selected = chance(0.6) ? int(0, n - 1) : -1;
    const tileBg = pick([surface, surface, softBg, bg]);
    const tileBorder = pick([border, softBorder, hsl(0, 0, dark ? 35 : 82)]);
    const month = pick(MONTHS);
    const start = int(0, 6);
    const label = (i) => ({
      slots: () => `${String(int(8, 18)).padStart(2, "0")}:${pick(["00", "15", "30", "45"])}${chance(0.2) ? pick([" am", " pm"]) : ""}`,
      days: () => DAYS[(start + i) % 7],
      sizes: () => ["XS", "S", "M", "L", "XL", "XXL", "38", "40", "42", "44"][i + (chance(0.5) ? 0 : 4)] ?? "M",
      segmented: () => cap(pick(["monthly", "yearly", "list", "grid", "all", "open", "closed", "day", "week", "month", "video call", "phone"])),
      options: () => cap(words(1, 2)),
    })[kind]();
    const tiles = Array.from({ length: n }, (_, i) => {
      const on = i === selected;
      const look = on
        ? `background:${accent};color:#fff;border:1px solid ${accent}`
        : `background:${tileBg};color:${text};border:1px solid ${tileBorder}`;
      const content = kind === "days"
        ? `${label(i)}<small style="display:block;font-weight:500;font-size:${size - 3}px;color:${on ? "#ffffffcc" : muted}">${int(1, 28)} ${month}</small>`
        : label(i);
      const box = kind === "days" ? `width:${int(64, 96)}px;text-align:center;padding:${int(8, 12)}px 0;` : `padding:${int(7, 12)}px ${int(12, 22)}px;`;
      const shape = kind === "segmented"
        ? (i === 0 ? `border-radius:${rad}px 0 0 ${rad}px;` : i === n - 1 ? `border-radius:0 ${rad}px ${rad}px 0;margin-left:-1px;` : "border-radius:0;margin-left:-1px;")
        : `border-radius:${rad}px;`;
      return `<div data-cls="button" style="display:inline-block;cursor:pointer;user-select:none;line-height:1.3;` +
        `font-weight:${pick([500, 600, 600, 700])};font-size:${int(size - 1, size + 1)}px;${box}${shape}${look}">${content}</div>`;
    });
    const title = chance(0.7)
      ? `<div style="font-size:${size - 2}px;font-weight:700;color:${muted};${chance(0.5) ? "text-transform:uppercase;letter-spacing:.06em;" : ""}margin-bottom:8px">${cap(words(1, 3))}</div>`
      : "";
    return `<div style="margin:14px 0">${title}<div style="display:flex;flex-wrap:wrap;gap:${kind === "segmented" ? 0 : int(6, 12)}px">${tiles.join("")}</div></div>`;
  };

  const blocks = [hero, form, cards, table, searchBar, article, pager, banner, form, cards, details, details, logPanel, codeBox, stats, tags,
    consolePanel, chipsRow, eyebrow, form, successBanner, details, choiceGroup, choiceGroup];
  const body = [];
  if (chance(0.9)) body.push(nav());
  const withSidebar = chance(0.35);
  const main = Array.from({ length: int(3, 6) }, () => pick(blocks)());
  if (chance(0.7)) main.push(footer());
  const maxW = pick([900, 1000, 1100, 1200, 1400, "100%"]);
  const mainHtml = withSidebar
    ? `<div style="display:grid;grid-template-columns:${int(180, 260)}px 1fr;gap:24px">${sidebar()}<div>${main.join("")}</div></div>`
    : main.join("");
  body.push(`<main style="max-width:${typeof maxW === "number" ? maxW + "px" : maxW};margin:0 auto;padding:${int(8, 30)}px ${int(12, 40)}px">${mainHtml}</main>`);

  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}` +
    `body{margin:0;font-family:${font};font-size:${size}px;line-height:${pick([1.3, 1.45, 1.6])};color:${text};background:` +
    (modern ? `radial-gradient(900px 500px at ${int(0, 20)}% -8%,${hsl(hue, 80, dark ? 30 : 88)},transparent 62%),radial-gradient(800px 480px at ${int(80, 100)}% 0%,${hsl((hue + 120) % 360, 80, dark ? 26 : 90)},transparent 60%),` : "") +
    `${bg}}` +
    `</style></head><body>${body.join("")}</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Labelling (runs in the page)
// ---------------------------------------------------------------------------------------------

/** Collects boxes for tagged elements, or infers the class from the tag on unseen pages. */
function collectBoxes(infer) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const classOf = (el) => {
    if (!infer || el.hasAttribute("data-cls")) return el.getAttribute("data-cls");
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "button" || (tag === "input" && ["submit", "button", "reset"].includes(type)) || el.getAttribute("role") === "button") return "button";
    if (tag === "input" || tag === "textarea" || tag === "select") return type === "hidden" ? null : "input";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    return null;
  };
  const nodes = infer
    // [data-cls] on a test page marks a scripted control (a <div> booking tile) as ground truth.
    ? document.querySelectorAll("button, input, textarea, select, a[href], [role=button], [data-cls]")
    : document.querySelectorAll("[data-cls]");
  const out = [];
  for (const el of nodes) {
    const cls = classOf(el);
    if (!cls) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    // Inline links can wrap onto several lines: one box per line fragment.
    const rects = cls === "link" ? [...el.getClientRects()] : [el.getBoundingClientRect()];
    for (const r of rects) {
      const x1 = Math.max(0, r.left), y1 = Math.max(0, r.top);
      const x2 = Math.min(vw, r.right), y2 = Math.min(vh, r.bottom);
      const w = x2 - x1, h = y2 - y1;
      if (w < 4 || h < 4) continue;
      if (w * h < 0.5 * r.width * r.height) continue; // mostly off-screen
      out.push({ cls, x: x1, y: y1, w, h });
    }
  }
  return { boxes: out, vw, vh };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function toYolo({ boxes, vw, vh }) {
  return boxes.map((b) => [CLASSES.indexOf(b.cls), (b.x + b.w / 2) / vw, (b.y + b.h / 2) / vh, b.w / vw, b.h / vh]
    .map((v, i) => (i === 0 ? v : v.toFixed(6))).join(" ")).join("\n");
}

async function main() {
  // --demo-only: keep the training pages, re-shoot only the held-out test pages (after the test
  // site's design changed, for example).
  const demoOnly = process.argv.includes("--demo-only");
  if (demoOnly) {
    await rm(path.join(OUT, "images", "demo"), { recursive: true, force: true });
    await rm(path.join(OUT, "labels", "demo"), { recursive: true, force: true });
  } else {
    await rm(OUT, { recursive: true, force: true });
  }
  for (const split of ["train", "val", "demo"]) {
    await mkdir(path.join(OUT, "images", split), { recursive: true });
    await mkdir(path.join(OUT, "labels", split), { recursive: true });
  }
  await mkdir(ASSETS, { recursive: true });
  // Photos only from the face fixtures, never the demo page's profile photo.
  const images = [];
  for (const f of ["apollo11-crew.jpg", "astronaut.jpg", "chelsea-cat.jpg", "coffee.jpg"]) {
    await copyFile(path.join(ROOT, "perception/test/fixtures", f), path.join(ASSETS, f));
    images.push(f);
  }
  const blank = path.join(ASSETS, "blank.html");
  await writeFile(blank, "<!doctype html><html><head><meta charset=utf-8></head><body></body></html>");

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const stats = { train: 0, val: 0, demo: 0, boxes: { button: 0, input: 0, link: 0 } };
  const started = Date.now();

  const shoot = async (split, name, infer) => {
    const labels = await page.evaluate(collectBoxes, infer);
    for (const b of labels.boxes) stats.boxes[b.cls] += 1;
    await page.screenshot({ path: path.join(OUT, "images", split, `${name}.jpg`), type: "jpeg", quality: 85 });
    await writeFile(path.join(OUT, "labels", split, `${name}.txt`), toYolo(labels));
    stats[split] += 1;
  };

  const total = demoOnly ? 0 : trainCount + valCount;
  for (let i = 0; i < total; i++) {
    const split = i < trainCount ? "train" : "val";
    const r = rng(i * 7919 + 17);
    const width = [1024, 1280, 1366, 1440, 1536, 1600, 1920, 900, 800][Math.floor(r() * 9)];
    const height = Math.round(width * (0.5 + r() * 0.3));
    const dpr = r() < 0.3 ? 1.25 : 1;
    await page.setViewport({ width, height, deviceScaleFactor: dpr });
    await page.goto(pathToFileURL(blank).href);
    const html = makePage(i + 1, images);
    await page.evaluate((h) => { document.open(); document.write(h); document.close(); }, html);
    await page.evaluate(() => Promise.all([...document.images].map((im) => im.complete ? 0 : new Promise((ok) => { im.onload = im.onerror = ok; }))));
    // Sometimes look further down the page, like a user who scrolled.
    if (r() < 0.35) await page.evaluate((f) => window.scrollTo(0, (document.body.scrollHeight - innerHeight) * f), r());
    await shoot(split, `page_${String(i).padStart(4, "0")}`, false);
    if ((i + 1) % 100 === 0) console.log(`${i + 1}/${total} pages (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }

  // Held-out test: the real demo page at several window sizes, empty, filled and scrolled.
  const demoUrl = pathToFileURL(path.join(ROOT, "demo/index.html")).href;
  let n = 0;
  for (const [width, height] of [[1280, 720], [1366, 768], [1536, 864], [1920, 1080], [1024, 768], [1440, 900], [800, 900]]) {
    for (const state of ["empty", "filled", "scrolled"]) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.goto(demoUrl, { waitUntil: "load" });
      if (state !== "empty") {
        await page.type("#name", "John Doe");
        await page.type("#email", "john@example.com");
        await page.type("#message", "Hello from the agent");
      }
      if (state === "scrolled") await page.evaluate(() => window.scrollTo(0, 250));
      await shoot("demo", `demo_${String(n++).padStart(2, "0")}_${width}x${height}_${state}`, true);
    }
  }
  // The rest of the test site (also never trained on): top of the page and scrolled down.
  for (const file of ["apply.html", "store.html", "pricing.html", "features.html", "login.html", "book.html"]) {
    for (const [width, height] of [[1280, 720], [1536, 864], [1024, 768]]) {
      for (const scroll of [0, 420]) {
        await page.setViewport({ width, height, deviceScaleFactor: 1 });
        await page.goto(pathToFileURL(path.join(ROOT, "demo", file)).href, { waitUntil: "load" });
        if (scroll) await page.evaluate((y) => window.scrollTo(0, y), scroll);
        await shoot("demo", `site_${String(n++).padStart(2, "0")}_${file.replace(".html", "")}_${width}x${height}_${scroll ? "scrolled" : "top"}`, true);
      }
    }
  }

  await browser.close();
  if (!demoOnly) await writeFile(path.join(OUT, "data.yaml"),
    `path: ${OUT.replace(/\\/g, "/")}\ntrain: images/train\nval: images/val\ntest: images/demo\nnames:\n` +
    CLASSES.map((c, i) => `  ${i}: ${c}`).join("\n") + "\n");
  console.log(JSON.stringify(stats), `${((Date.now() - started) / 1000).toFixed(0)} s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
