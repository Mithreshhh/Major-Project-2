/**
 * HTTP client for the reasoning server. The only place in the extension that talks to the
 * network, which keeps the "what leaves the device" audit surface small.
 */
import {
  HEALTH_ENDPOINT,
  PROCESS_ENDPOINT,
  type ActionCommand,
  type HealthResponse,
  type SanitizedContext,
} from "@odpa/shared";

import { CONFIG } from "../shared/config";

async function resolveServerUrl(): Promise<string> {
  const stored = await chrome.storage.local.get("serverUrl");
  const url = typeof stored.serverUrl === "string" && stored.serverUrl ? stored.serverUrl : CONFIG.serverUrl;
  return url.replace(/\/+$/, "");
}

export async function checkHealth(): Promise<HealthResponse> {
  const res = await fetch(`${await resolveServerUrl()}${HEALTH_ENDPOINT}`);
  if (!res.ok) throw new Error(`health check failed: HTTP ${res.status}`);
  return (await res.json()) as HealthResponse;
}

/** POST a SanitizedContext and get back the next ActionCommand. */
export async function requestAction(context: SanitizedContext): Promise<ActionCommand> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

  try {
    const res = await fetch(`${await resolveServerUrl()}${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(context),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`/process failed: HTTP ${res.status} ${text}`.trim());
    }

    const command = (await res.json()) as ActionCommand;
    if (!command || typeof command.action !== "string") {
      throw new Error("/process returned a malformed ActionCommand");
    }
    return command;
  } finally {
    clearTimeout(timer);
  }
}
