# @odpa/shared

The data contract between the browser extension and the FastAPI server.

| File | Purpose |
| --- | --- |
| `src/types.ts` | TypeScript types (`SanitizedContext`, `ActionCommand`, ...) |
| `src/constants.ts` | `PROTOCOL_VERSION`, default server URL, endpoint paths |
| `schema/*.schema.json` | JSON Schema (draft 2020-12) form of the same contract |
| `examples/*.json` | Canonical example payloads used by the server test-suite |

The TypeScript types and the JSON Schemas must be kept in sync by hand. The server's
Pydantic models (`server/app/schemas.py`) mirror them too, and `server/tests` validates the
example payloads against both the JSON Schemas and the Pydantic models so drift is caught early.

Bump `PROTOCOL_VERSION` (here and in `server/app/schemas.py`) on any breaking change.

This package has no build step: consumers import the `.ts` sources directly
(the extension bundles them with esbuild).
