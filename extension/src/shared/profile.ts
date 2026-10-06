/**
 * "My info": details the user saves once (name, email, college...) so the agent can fill forms.
 *
 * Privacy model: values live only in chrome.storage.local. The reasoner is told the *names* of
 * the saved details and answers with placeholders ("type {{email}} into el_4"); the extension
 * swaps in the real value on the device just before typing. Values are never put in a request.
 */

export interface ProfileField {
  /** Placeholder name, e.g. "full_name" for {{full_name}}. Lowercase letters, digits, underscores. */
  key: string;
  /** What the user sees and what the reasoner is told, e.g. "Full name". */
  label: string;
  value: string;
}

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

export async function loadProfile(): Promise<ProfileField[]> {
  try {
    const stored = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
    const list = stored?.[PROFILE_STORAGE_KEY];
    if (!Array.isArray(list)) return [];
    return list.filter((f): f is ProfileField => !!f && typeof f.key === "string" && typeof f.label === "string" && typeof f.value === "string");
  } catch {
    return [];
  }
}

export async function saveProfile(fields: ProfileField[]): Promise<void> {
  await chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: fields });
}

/** Names only (never values) of the details that have a value: this is all the reasoner gets. */
export function profileFieldNames(profile: ProfileField[]): Array<{ key: string; label: string }> {
  return profile.filter((f) => f.key && f.value.trim()).map(({ key, label }) => ({ key, label }));
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
}

/** Replace placeholders with saved values. Runs on the device, right before typing. */
export function resolvePlaceholders(text: string, profile: ProfileField[]): ResolvedText {
  const used: string[] = [];
  const missing: string[] = [];
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
    return field.value;
  });
  return { text: out, used, missing };
}

export function hasPlaceholder(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(text);
}
