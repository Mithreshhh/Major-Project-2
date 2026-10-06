/**
 * "My info" page: the people, details and files the agent may use to fill forms. Everything is
 * read from and written to this browser (chrome.storage.local and IndexedDB); nothing on this
 * page talks to the network.
 */
import { MAX_FILE_BYTES, deleteFile, formatSize, putFile } from "../shared/files";
import { DEFAULT_PROFILE_FIELDS, loadPeople, newId, savePeople, toKey, type Person, type ProfileField } from "../shared/profile";

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
const SECRET = /pass(word|code)|\bpin\b|cvv|otp/i;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let people: Person[] = [];
let activeId = "";
let selectedId = "";

const blankFields = (): ProfileField[] => DEFAULT_PROFILE_FIELDS.map((d) => ({ ...d, value: "" }));
const selected = (): Person => people.find((p) => p.id === selectedId) ?? people[0]!;
const textFields = (p: Person) => p.fields.filter((f) => f.kind !== "file");
const fileFields = (p: Person) => p.fields.filter((f) => f.kind === "file");

function flash(text: string, bad = false): void {
  const el = $("saved");
  el.textContent = text;
  el.className = bad ? "bad" : "";
}

function renderPeople(): void {
  const bar = $("people");
  bar.replaceChildren();
  for (const person of people) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `chip${person.id === selectedId ? " on" : ""}`;
    chip.textContent = person.name || "(no name)";
    if (person.id === activeId) {
      const star = document.createElement("span");
      star.className = "star";
      star.textContent = "default";
      chip.append(star);
    }
    chip.addEventListener("click", () => {
      selectedId = person.id;
      render();
    });
    bar.append(chip);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.id = "add-person";
  add.className = "chip add";
  add.textContent = "+ Add a person";
  add.addEventListener("click", () => {
    const person: Person = { id: newId(), name: `Person ${people.length + 1}`, fields: blankFields() };
    people.push(person);
    selectedId = person.id;
    render();
    const name = $<HTMLInputElement>("person-name");
    name.focus();
    name.select();
    flash("New person added. Give them a name, fill in their details, then Save.");
  });
  bar.append(add);
}

function renderFields(): void {
  const person = selected();
  const grid = $("fields");
  grid.replaceChildren();
  for (const field of textFields(person)) {
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
        person.fields = person.fields.filter((f) => f !== field);
        renderFields();
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

function renderFiles(): void {
  const person = selected();
  const list = $("files");
  list.replaceChildren();
  const files = fileFields(person);
  if (files.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No files saved for this person yet.";
    list.append(li);
    return;
  }
  for (const field of files) {
    const li = document.createElement("li");
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = (field.value.split(".").pop() ?? "file").slice(0, 4).toUpperCase();
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("b");
    name.textContent = field.label;
    const code = document.createElement("code");
    code.textContent = `  {{${field.key}}}`;
    name.append(code);
    const detail = document.createElement("span");
    detail.textContent = `${field.value} · ${formatSize(field.size ?? 0)}`;
    meta.append(name, detail);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "Remove";
    del.addEventListener("click", async () => {
      person.fields = person.fields.filter((f) => f !== field);
      if (field.fileId) await deleteFile(field.fileId).catch(() => undefined);
      await save();
      renderFiles();
    });
    li.append(icon, meta, del);
    list.append(li);
  }
}

function render(): void {
  renderPeople();
  const person = selected();
  $<HTMLInputElement>("person-name").value = person.name;
  $("make-default").textContent = person.id === activeId ? "Used by default ✓" : "Use by default";
  $("delete-person").style.visibility = people.length > 1 ? "visible" : "hidden";
  renderFields();
  renderFiles();
}

async function save(): Promise<void> {
  for (const p of people) {
    p.name = p.name.trim() || "Me";
    for (const f of p.fields) f.value = f.value.trim();
  }
  await savePeople(people, activeId);
  const p = selected();
  const details = textFields(p).filter((f) => f.value).length;
  const files = fileFields(p).length;
  flash(`Saved on this device: ${p.name} has ${details} detail${details === 1 ? "" : "s"} and ${files} file${files === 1 ? "" : "s"}.`);
  renderPeople();
}

async function init(): Promise<void> {
  const stored = await loadPeople();
  people = stored.people.map((p) => {
    const byKey = new Map(p.fields.map((f) => [f.key, f]));
    return {
      ...p,
      // Defaults first and in a fixed order, then the person's own details and files.
      fields: [
        ...DEFAULT_PROFILE_FIELDS.map((d) => ({ ...d, value: byKey.get(d.key)?.value ?? "" })),
        ...p.fields.filter((f) => !DEFAULT_KEYS.has(f.key)),
      ],
    };
  });
  if (people.length === 0) people = [{ id: newId(), name: "Me", fields: blankFields() }];
  activeId = people.some((p) => p.id === stored.activeId) ? stored.activeId : people[0]!.id;
  selectedId = activeId;
  render();

  $("save").addEventListener("click", () => void save());

  $<HTMLInputElement>("person-name").addEventListener("input", (e) => {
    selected().name = (e.target as HTMLInputElement).value;
    renderPeople();
    flash("");
  });
  $("make-default").addEventListener("click", async () => {
    activeId = selectedId;
    await save();
    render();
  });
  $("delete-person").addEventListener("click", async () => {
    if (people.length <= 1) return;
    const gone = selected();
    if (!confirm(`Delete ${gone.name} and everything saved for them?`)) return;
    for (const f of fileFields(gone)) if (f.fileId) await deleteFile(f.fileId).catch(() => undefined);
    people = people.filter((p) => p !== gone);
    if (activeId === gone.id) activeId = people[0]!.id;
    selectedId = activeId;
    await save();
    render();
  });

  $("add").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("new-label");
    const label = input.value.trim();
    const key = toKey(label);
    if (!key) return;
    if (SECRET.test(label)) return flash("Passwords, PINs and OTPs are not stored here.", true);
    const person = selected();
    if (person.fields.some((f) => f.key === key)) return flash(`“${label}” is already in the list.`, true);
    // Keep text details together, before the files.
    const firstFile = person.fields.findIndex((f) => f.kind === "file");
    person.fields.splice(firstFile === -1 ? person.fields.length : firstFile, 0, { key, label, value: "" });
    input.value = "";
    renderFields();
    document.getElementById(`f-${key}`)?.focus();
    flash(`“${label}” added. Type its value, then Save.`);
  });

  $("add-file").addEventListener("submit", async (e) => {
    e.preventDefault();
    const chooser = $<HTMLInputElement>("file-input");
    const labelInput = $<HTMLInputElement>("file-label");
    const file = chooser.files?.[0];
    if (!file) return flash("Choose a file first.", true);
    if (file.size > MAX_FILE_BYTES) return flash(`That file is ${formatSize(file.size)}. The limit is ${formatSize(MAX_FILE_BYTES)}.`, true);
    const label = labelInput.value.trim() || file.name.replace(/\.[^.]+$/, "");
    const key = toKey(label);
    if (!key) return flash("Give the file a name, e.g. Resume.", true);
    const person = selected();
    const existing = person.fields.find((f) => f.key === key);
    if (existing && existing.kind !== "file") return flash(`“${label}” is already a detail. Pick another name.`, true);

    const fileId = existing?.fileId ?? newId();
    await putFile(fileId, file);
    const entry: ProfileField = { key, label, value: file.name, kind: "file", fileId, mime: file.type, size: file.size };
    if (existing) Object.assign(existing, entry);
    else person.fields.push(entry);
    chooser.value = "";
    labelInput.value = "";
    await save();
    renderFiles();
  });

  $("sample").addEventListener("click", () => {
    for (const f of textFields(selected())) if (SAMPLE[f.key]) f.value = SAMPLE[f.key]!;
    renderFields();
    flash("Sample data filled in. Press Save.");
  });
  $("clear").addEventListener("click", async () => {
    const person = selected();
    for (const f of fileFields(person)) if (f.fileId) await deleteFile(f.fileId).catch(() => undefined);
    person.fields = person.fields.filter((f) => f.kind !== "file");
    for (const f of person.fields) f.value = "";
    await save();
    render();
  });
}

void init();
