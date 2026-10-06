/**
 * "My info": details and files that people save once so the agent can fill forms for them.
 *
 * Privacy model: values live only in chrome.storage.local, file contents only in IndexedDB
 * (./files.ts). The reasoner is told the *names* of the saved details and answers with
 * placeholders ("type {{email}} into el_4"); the extension swaps in the real value, or attaches
 * the real file, on the device just before acting. Nothing saved here is put in a request.
 *
 * Several people can be saved (you, a parent, a friend). One is active; a task that names
 * another ("fill this with my father's details") uses that person instead.
 */

export interface ProfileField {
  /** Placeholder name, e.g. "full_name" for {{full_name}}. Lowercase letters, digits, underscores. */
  key: string;
  /** What the user sees and what the reasoner is told, e.g. "Full name". */
  label: string;
  /** The detail itself. For a file: its file name. */
  value: string;
  /** "file" entries are attached to file-upload fields instead of typed. Default "text". */
  kind?: "text" | "file";
  /** IndexedDB key of the file's contents (kind "file"). */
  fileId?: string;
  mime?: string;
  size?: number;
}

export interface Person {
  id: string;
  /** Shown in the popup and matched against the task, e.g. "Me", "Father", "Riya". */
  name: string;
  fields: ProfileField[];
}

export interface People {
  people: Person[];
  activeId: string;
}

const PEOPLE_KEY = "people";
const ACTIVE_KEY = "activePersonId";
/** Single-person storage from the first version; read once and treated as a person called "Me". */
export const PROFILE_STORAGE_KEY = "profile";

/** Starting set shown on the My info page. Users can add their own. No passwords on purpose. */
export const DEFAULT_PROFILE_FIELDS: Array<Pick<ProfileField, "key" | "label">> = [
  { key: "full_name", label: "Full name" },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "date_of_birth", label: "Date of birth" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "pin_code", label: "PIN code" },
  { key: "country", label: "Country" },
  { key: "college", label: "College" },
  { key: "degree", label: "Degree" },
  { key: "graduation_year", label: "Graduation year" },
  { key: "cgpa", label: "CGPA" },
  { key: "skills", label: "Skills" },
  { key: "experience", label: "Experience" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "github", label: "GitHub" },
  { key: "about_me", label: "About me" },
];

export function toKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function validFields(list: unknown): ProfileField[] {
  if (!Array.isArray(list)) return [];
  return list.filter((f): f is ProfileField => !!f && typeof f.key === "string" && typeof f.label === "string" && typeof f.value === "string");
}

/** Everyone saved on this device, plus who is active. Never throws; empty when nothing is saved. */
export async function loadPeople(): Promise<People> {
  try {
    const stored = await chrome.storage.local.get([PEOPLE_KEY, ACTIVE_KEY, PROFILE_STORAGE_KEY]);
    let people: Person[] = Array.isArray(stored?.[PEOPLE_KEY])
      ? (stored[PEOPLE_KEY] as Person[])
          .filter((p) => !!p && typeof p.id === "string" && typeof p.name === "string")
          .map((p) => ({ id: p.id, name: p.name, fields: validFields(p.fields) }))
      : [];
    if (people.length === 0) {
      const legacy = validFields(stored?.[PROFILE_STORAGE_KEY]);
      if (legacy.length) people = [{ id: "me", name: "Me", fields: legacy }];
    }
    const wanted = typeof stored?.[ACTIVE_KEY] === "string" ? (stored[ACTIVE_KEY] as string) : "";
    const activeId = people.some((p) => p.id === wanted) ? wanted : (people[0]?.id ?? "");
    return { people, activeId };
  } catch {
    return { people: [], activeId: "" };
  }
}

export async function savePeople(people: Person[], activeId: string): Promise<void> {
  await chrome.storage.local.set({ [PEOPLE_KEY]: people, [ACTIVE_KEY]: activeId });
}

export async function setActivePerson(activeId: string): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_KEY]: activeId });
}

/** Names too generic to mean "use this person" when they appear in a task. */
const GENERIC_NAMES = new Set(["me", "my", "i", "self", "myself", "mine", "default"]);

/**
 * Who a task is for: a saved person whose name appears in the task as a whole word ("my
 * father's details" -> the person called "Father"), otherwise the active person.
 */
export function pickPerson(task: string, { people, activeId }: People): Person | undefined {
  const text = ` ${task.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const named = people
    .filter((p) => {
      const name = p.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return name.length >= 2 && !GENERIC_NAMES.has(name) && (text.includes(` ${name} `) || text.includes(` ${name} s `));
    })
    .sort((a, b) => b.name.length - a.name.length)[0];
  return named ?? people.find((p) => p.id === activeId) ?? people[0];
}

/** The active person's details (kept for callers that do not care about other people). */
export async function loadProfile(): Promise<ProfileField[]> {
  const all = await loadPeople();
  return all.people.find((p) => p.id === all.activeId)?.fields ?? [];
}

/** Names only (never values) of the details that have a value: this is all the reasoner gets. */
export function profileFieldNames(profile: ProfileField[]): Array<{ key: string; label: string }> {
  return profile
    .filter((f) => f.key && f.value.trim())
    .map(({ key, label, kind }) => ({ key, label: kind === "file" ? `${label} (file to upload)` : label }));
}

// {{email}}, {{ Email }}, {email}: small models are not exact about braces or case.
const PLACEHOLDER = /\{\{?\s*([A-Za-z0-9_ .-]{1,40}?)\s*\}?\}/g;

export interface ResolvedText {
  /** Text with every known placeholder replaced by its saved value. */
  text: string;
  /** Labels of the saved details that were used. */
  used: string[];
  /** Placeholder names with no saved value. */
  missing: string[];
  /** Set when the placeholder names a saved file: attach it instead of typing. */
  file?: ProfileField;
}

/** Replace placeholders with saved values. Runs on the device, right before typing. */
export function resolvePlaceholders(text: string, profile: ProfileField[]): ResolvedText {
  const used: string[] = [];
  const missing: string[] = [];
  let file: ProfileField | undefined;
  const find = (name: string) => {
    const key = toKey(name);
    return profile.find((f) => f.key === key || toKey(f.label) === key);
  };
  const out = text.replace(PLACEHOLDER, (whole, name: string) => {
    const field = find(name);
    if (!field || !field.value.trim()) {
      missing.push(name.trim());
      return whole;
    }
    used.push(field.label);
    if (field.kind === "file") file = field;
    return field.value;
  });
  return { text: out, used, missing, ...(file ? { file } : {}) };
}

export function hasPlaceholder(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(text);
}
