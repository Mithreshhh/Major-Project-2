/**
 * Contents of the files saved under "My info" (resume, certificates, photo), in the extension's
 * own IndexedDB. chrome.storage.local is capped at about 10 MB in total; IndexedDB is not.
 * Works in the background worker and in extension pages (same origin). Nothing here is sent
 * anywhere: a file only ever goes into a file-upload field on the page the user is on.
 */

const DB_NAME = "odpa-files";
const STORE = "files";
/** Per-file limit. Files travel to the content script as base64 in one message. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface StoredFile {
  name: string;
  type: string;
  bytes: ArrayBuffer;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function putFile(id: string, file: File): Promise<void> {
  const stored: StoredFile = { name: file.name, type: file.type || "application/octet-stream", bytes: await file.arrayBuffer() };
  await run("readwrite", (s) => s.put(stored, id));
}

export async function getFile(id: string): Promise<StoredFile | undefined> {
  return run<StoredFile | undefined>("readonly", (s) => s.get(id));
}

export async function deleteFile(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}

/** ArrayBuffer -> base64, in chunks so large files do not overflow the call stack. */
export function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
