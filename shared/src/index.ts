/**
 * @odpa/shared
 *
 * Single source of truth for the extension <-> server data contract.
 *
 *   - `types.ts`        TypeScript view of the contract (consumed by /extension and /perception).
 *   - `schema/*.json`   JSON Schema view of the same contract (consumed by /server tests and
 *                       any non-TS client). Keep the two in sync; the server test-suite validates
 *                       the example payloads in `examples/` against the JSON Schemas.
 *
 * Bump PROTOCOL_VERSION whenever a breaking change is made to either payload.
 */
export * from "./types";
export * from "./constants";
