# server

FastAPI backend hosting the server-side VLM reasoning component.

```bash
cd server
python -m venv .venv
.venv\Scripts\activate          # Windows   (source .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
pytest -q
```

| Path | Purpose |
| --- | --- |
| `app/main.py` | FastAPI app: `GET /health`, `POST /process` |
| `app/schemas.py` | Pydantic mirror of `/shared` (request + response models) |
| `app/reasoning.py` | `MockReasoner` (active) and `VLMReasoner` (`TODO(vlm)`) |
| `tests/` | Contract tests against `shared/schema` + endpoint tests |

Set `REASONER=vlm` to select the (not yet implemented) VLM reasoner; it answers `501` until
the TODOs in `reasoning.py` are done.
