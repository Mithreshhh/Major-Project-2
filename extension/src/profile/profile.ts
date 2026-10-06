/**
 * "My info" page: edit the details the agent may type into forms. Everything is read from and
 * written to chrome.storage.local; nothing on this page talks to the network.
 */
import { DEFAULT_PROFILE_FIELDS, loadProfile, saveProfile, toKey, type ProfileField } from "../shared/profile";

/** Made-up person for demos. */
const SAMPLE: Record<string, string> = {
  full_name: "Aarav Sharma",
  first_name: "Aarav",
  last_name: "Sharma",
  email: "aarav.sharma@example.com",
  phone: "+91 98765 12345",
  date_of_birth: "14 March 2004",
  address: "42 Lake View Road, Banjara Hills",
  city: "Hyderabad",
  state: "Telangana",
  pin_code: "500034",
  country: "India",
  college: "MLR Institute of Technology",
  degree: "B.Tech Computer Science",
  graduation_year: "2027",
  cgpa: "8.7",
  skills: "Python, TypeScript, Machine Learning, React",
  experience: "6 months internship in web development",
  linkedin: "https://www.linkedin.com/in/aarav-sharma-example",
  github: "https://github.com/aarav-example",
  about_me: "Final-year student who enjoys building privacy-friendly AI tools.",
};

const WIDE = new Set(["address", "skills", "experience", "about_me"]);
const DEFAULT_KEYS = new Set(DEFAULT_PROFILE_FIELDS.map((f) => f.key));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let fields: ProfileField[] = [];

function render(): void {
  const grid = $("fields");
  grid.replaceChildren();
  for (const field of fields) {
    const wrap = document.createElement("div");
    wrap.className = `field${WIDE.has(field.key) ? " wide" : ""}`;

    const label = document.createElement("label");
    label.htmlFor = `f-${field.key}`;
    label.append(field.label);
    const code = document.createElement("code");
    code.textContent = `{{${field.key}}}`;
    label.append(code);
    if (!DEFAULT_KEYS.has(field.key)) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.textContent = "Remove";
      del.addEventListener("click", () => {
        fields = fields.filter((f) => f !== field);
        render();
        flash("Removed. Press Save to keep the change.");
      });
      label.append(del);
    }

    const input = WIDE.has(field.key) ? document.createElement("textarea") : document.createElement("input");
    if (input instanceof HTMLInputElement) input.type = "text";
    input.id = `f-${field.key}`;
    input.value = field.value;
    input.autocomplete = "off";
    input.addEventListener("input", () => {
      field.value = input.value;
      flash("");
    });
    wrap.append(label, input);
    grid.append(wrap);
  }
}

function flash(text: string): void {
  $("saved").textContent = text;
}

async function save(): Promise<void> {
  await saveProfile(fields.map((f) => ({ ...f, value: f.value.trim() })));
  const filled = fields.filter((f) => f.value.trim()).length;
  flash(`Saved on this device: ${filled} detail${filled === 1 ? "" : "s"}.`);
}

async function init(): Promise<void> {
  const stored = await loadProfile();
  const byKey = new Map(stored.map((f) => [f.key, f]));
  fields = [
    ...DEFAULT_PROFILE_FIELDS.map((d) => ({ ...d, value: byKey.get(d.key)?.value ?? "" })),
    ...stored.filter((f) => !DEFAULT_KEYS.has(f.key)),
  ];
  render();

  $("save").addEventListener("click", () => void save());
  $("add").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("new-label");
    const label = input.value.trim();
    const key = toKey(label);
    if (!key) return;
    if (/pass(word|code)|\bpin\b|cvv|otp/i.test(label)) return flash("Passwords, PINs and OTPs are not stored here.");
    if (fields.some((f) => f.key === key)) return flash(`“${label}” is already in the list.`);
    fields.push({ key, label, value: "" });
    input.value = "";
    render();
    document.getElementById(`f-${key}`)?.focus();
  });
  $("sample").addEventListener("click", () => {
    for (const f of fields) if (SAMPLE[f.key]) f.value = SAMPLE[f.key]!;
    render();
    flash("Sample data filled in. Press Save.");
  });
  $("clear").addEventListener("click", async () => {
    for (const f of fields) f.value = "";
    render();
    await save();
  });
}

void init();
