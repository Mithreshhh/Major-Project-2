/** Semantic version of the wire protocol. Mirrored in server/app/schemas.py. */
export const PROTOCOL_VERSION = "0.1.0";

/** Default location of the reasoning server during local development. */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8000";

/** Path of the reasoning endpoint on the server. */
export const PROCESS_ENDPOINT = "/process";

/** Path of the health endpoint on the server. */
export const HEALTH_ENDPOINT = "/health";

/** Path of the read-only question endpoint: SanitizedContext (with pageText) -> AskResponse. */
export const ASK_ENDPOINT = "/ask";
