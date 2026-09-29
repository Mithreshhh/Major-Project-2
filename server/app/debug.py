"""
"What the AI sees": a record of the sanitized payloads /process received.

Everything here is data the server was already sent. It never holds anything the client did not
choose to send, so it is a faithful view of what crosses the trust boundary. Useful to prove
redaction works: open GET /debug/view next to the real page.

Captures are kept in memory (last N) and, if ODPA_DEBUG_SAVE_DIR is set, written to disk as
<n>.jpg + <n>.json for later inspection. Disable everything with ODPA_DEBUG_VIEW=0.
"""
from __future__ import annotations

import base64
import binascii
import itertools
import json
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import HTMLResponse

from .schemas import SanitizedContext

log = logging.getLogger("odpa.debug")


@dataclass
class Capture:
    id: int
    received_at: float
    task: str
    session_id: str
    step_index: int
    url: str
    title: str
    viewport: dict[str, float]
    elements: list[dict[str, Any]]
    redactions: list[dict[str, Any]]
    perception: dict[str, Any]
    screenshot_mime: Optional[str]
    screenshot_bytes: Optional[bytes] = field(repr=False, default=None)
    screenshot_size: Optional[tuple[int, int]] = None
    command: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    reasoning_ms: Optional[int] = None

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "receivedAt": self.received_at,
            "task": self.task,
            "sessionId": self.session_id,
            "stepIndex": self.step_index,
            "url": self.url,
            "title": self.title,
            "viewport": self.viewport,
            "elements": self.elements,
            "redactions": self.redactions,
            "perception": self.perception,
            "hasScreenshot": self.screenshot_bytes is not None,
            "screenshotMime": self.screenshot_mime,
            "screenshotSize": list(self.screenshot_size) if self.screenshot_size else None,
            "command": self.command,
            "error": self.error,
            "reasoningMs": self.reasoning_ms,
        }


class CaptureStore:
    def __init__(self, limit: int = 30, save_dir: Optional[Path] = None) -> None:
        self._items: deque[Capture] = deque(maxlen=limit)
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self.save_dir = save_dir
        if save_dir:
            save_dir.mkdir(parents=True, exist_ok=True)

    def record(
        self,
        context: SanitizedContext,
        *,
        command: Optional[dict[str, Any]] = None,
        error: Optional[str] = None,
        reasoning_ms: Optional[int] = None,
    ) -> Capture:
        shot = context.screenshot
        image: Optional[bytes] = None
        if shot is not None:
            try:
                image = base64.b64decode(shot.dataBase64, validate=True)
            except (binascii.Error, ValueError):
                image = None

        with self._lock:
            capture = Capture(
                id=next(self._ids),
                received_at=time.time(),
                task=context.task,
                session_id=context.sessionId,
                step_index=context.stepIndex,
                url=context.page.url,
                title=context.page.title,
                viewport=context.viewport.model_dump(),
                elements=[e.model_dump(exclude_none=True) for e in context.elements],
                redactions=[r.model_dump() for r in context.redactions],
                perception=context.perception.model_dump(exclude_none=True),
                screenshot_mime=shot.mimeType if shot else None,
                screenshot_bytes=image,
                screenshot_size=(shot.width, shot.height) if shot else None,
                command=command,
                error=error,
                reasoning_ms=reasoning_ms,
            )
            self._items.append(capture)

        if self.save_dir:
            try:
                stem = self.save_dir / f"{capture.id:04d}"
                if image is not None:
                    ext = {"image/png": ".png", "image/webp": ".webp"}.get(capture.screenshot_mime or "", ".jpg")
                    stem.with_suffix(ext).write_bytes(image)
                stem.with_suffix(".json").write_text(json.dumps(capture.summary(), indent=2), encoding="utf-8")
            except OSError as exc:  # never let debugging break /process
                log.warning("could not save capture %s: %s", capture.id, exc)
        return capture

    def list(self) -> list[Capture]:
        with self._lock:
            return list(self._items)

    def get(self, capture_id: int) -> Optional[Capture]:
        with self._lock:
            return next((c for c in self._items if c.id == capture_id), None)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


def build_router(store: CaptureStore) -> APIRouter:
    router = APIRouter(prefix="/debug", tags=["debug"])

    @router.get("/captures")
    async def captures() -> dict[str, Any]:
        items = store.list()
        return {"count": len(items), "captures": [c.summary() for c in reversed(items)]}

    @router.get("/captures/{capture_id}/screenshot")
    async def screenshot(capture_id: int) -> Response:
        capture = store.get(capture_id)
        if capture is None or capture.screenshot_bytes is None:
            raise HTTPException(status_code=404, detail="no screenshot for that capture")
        return Response(
            content=capture.screenshot_bytes,
            media_type=capture.screenshot_mime or "image/jpeg",
            headers={"cache-control": "no-store"},
        )

    @router.delete("/captures")
    async def clear() -> dict[str, bool]:
        store.clear()
        return {"ok": True}

    @router.get("/view", response_class=HTMLResponse)
    async def view() -> HTMLResponse:
        return HTMLResponse(VIEW_HTML)

    return router


VIEW_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>What the AI sees</title>
<style>
:root{--bg:#f6f8fa;--card:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--ml:#cf222e;--dom:#8250df;--heuristic:#bf8700;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#151b23;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--ml:#f85149;--dom:#ab7df8;--heuristic:#d29922;--ok:#3fb950}}
*{box-sizing:border-box}body{margin:0;padding:20px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 16px}
.grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px}@media (max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px}
.shot{position:relative;line-height:0;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:#000}
.shot img{width:100%;height:auto;display:block}.box{position:absolute;border:2px solid var(--ml);pointer-events:none}
.box span{position:absolute;top:-1px;left:-1px;transform:translateY(-100%);font:600 11px/1.6 system-ui;padding:0 5px;color:#fff;background:var(--ml);white-space:nowrap}
.box.dom{border-color:var(--dom)}.box.dom span{background:var(--dom)}.box.heuristic{border-color:var(--heuristic)}.box.heuristic span{background:var(--heuristic)}
.hide-boxes .box{display:none}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0}.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.decision{font-size:16px;font-weight:600;color:var(--ok)}.error{color:var(--ml);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:4px 6px;border-top:1px solid var(--border);vertical-align:top}th{color:var(--muted);font-weight:500}
.red{color:var(--ml);font-weight:600}.pill{display:inline-block;padding:0 8px;border-radius:99px;font-size:12px;border:1px solid var(--border);margin:0 4px 4px 0}
.pill.ml{border-color:var(--ml);color:var(--ml)}.pill.dom{border-color:var(--dom);color:var(--dom)}.pill.heuristic{border-color:var(--heuristic);color:var(--heuristic)}
.history{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}.history button{flex:none;border:1px solid var(--border);background:var(--card);color:var(--fg);border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit;font-size:12px}
.history button.on{border-color:var(--fg);font-weight:600}.muted{color:var(--muted)}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
h2{font-size:15px;margin:14px 0 6px}h2:first-child{margin-top:0}
</style></head><body><main>
<h1>What the AI sees</h1>
<p class="sub">Exactly what the reasoning server received from the browser extension: the already-redacted screenshot, the element list, and what Gemma decided. Updates live.</p>
<div class="row"><label><input type="checkbox" id="boxes" checked> Outline redacted regions</label><span class="muted" id="count"></span></div>
<div class="history" id="history"></div>
<div id="empty" class="card" style="margin-top:12px">No requests yet. Run a task from the extension popup.</div>
<div class="grid" id="content" hidden style="margin-top:12px">
 <div class="card"><div class="shot" id="shot"><img id="img" alt="Sanitized screenshot received by the server"></div><p class="muted" id="noshot" hidden>No screenshot was sent for this step.</p></div>
 <div class="card">
  <h2>Decision</h2><div id="decision"></div>
  <h2>Request</h2><dl class="kv" id="req"></dl>
  <h2>Hidden before sending</h2><div id="pills"></div>
  <h2>Elements the model was given</h2><table><thead><tr><th>id</th><th>role</th><th>label</th></tr></thead><tbody id="els"></tbody></table>
 </div>
</div>
</main>
<script>
const $=id=>document.getElementById(id);let selected=null,latestId=null,data=[];
const NAMES={ml:"face (on-device model)",dom:"sensitive field",heuristic:"personal text"};
function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function describe(c){if(!c)return"";switch(c.action){case"click":return`Click ${c.target}`;case"type":return`Type "${c.text}" into ${c.target}`;case"scroll":return`Scroll ${c.direction}`;case"navigate":return`Go to ${c.url}`;case"wait":return`Wait ${c.ms} ms`;case"done":return`Done: ${c.summary}`;case"ask_user":return`Ask user: ${c.question}`;default:return`No action: ${c.reason}`}}
function render(){const c=data.find(x=>x.id===selected)||data[0];$("empty").hidden=!!c;$("content").hidden=!c;
 $("count").textContent=data.length?`${data.length} request(s) recorded`:"";
 $("history").innerHTML=data.map(x=>`<button data-id="${x.id}" class="${x.id===(c&&c.id)?"on":""}">#${x.id} · step ${x.stepIndex+1} · ${esc((x.command&&x.command.action)||"error")}</button>`).join("");
 if(!c)return;
 const shot=$("shot");shot.querySelectorAll(".box").forEach(b=>b.remove());
 if(c.hasScreenshot){$("img").src=`/debug/captures/${c.id}/screenshot`;shot.hidden=false;$("noshot").hidden=true;
  const vw=c.viewport.width||1,vh=c.viewport.height||1;
  for(const r of c.redactions){const d=document.createElement("div");d.className=`box ${r.method}`;const b=r.bbox;
   Object.assign(d.style,{left:`${b.x/vw*100}%`,top:`${b.y/vh*100}%`,width:`${b.width/vw*100}%`,height:`${b.height/vh*100}%`});
   d.innerHTML=`<span>${esc(r.category.replace("_"," "))}</span>`;shot.appendChild(d)}}
 else{shot.hidden=true;$("noshot").hidden=false}
 $("decision").innerHTML=c.error?`<div class="error">${esc(c.error)}</div>`:`<div class="decision">${esc(describe(c.command))}</div><div class="muted">${esc(c.command&&c.command.reasoning)}</div><div class="muted">Gemma took ${((c.reasoningMs||0)/1000).toFixed(1)} s</div>`;
 $("req").innerHTML=`<dt>Task</dt><dd>${esc(c.task)}</dd><dt>Step</dt><dd>${c.stepIndex+1}</dd><dt>Page</dt><dd>${esc(c.title)}<br><span class="muted">${esc(c.url)}</span></dd><dt>Screenshot</dt><dd>${c.hasScreenshot?`${c.screenshotSize[0]}×${c.screenshotSize[1]} ${esc(c.screenshotMime)}`:"none"}</dd><dt>On-device model</dt><dd>${esc(c.perception.modelId)} · ${c.perception.latencyMs} ms</dd>`;
 const by={};for(const r of c.redactions)by[r.method]=(by[r.method]||0)+1;
 $("pills").innerHTML=Object.keys(by).length?Object.entries(by).map(([m,n])=>`<span class="pill ${m}">${n} × ${NAMES[m]||m}</span>`).join(""):`<span class="muted">Nothing sensitive found on this screen.</span>`;
 $("els").innerHTML=c.elements.map(e=>`<tr><td>${esc(e.id)}</td><td>${esc(e.role)}</td><td class="${e.redacted?"red":""}">${esc(e.label)}</td></tr>`).join("")}
$("history").addEventListener("click",e=>{const b=e.target.closest("button");if(b){selected=+b.dataset.id;render()}});
$("boxes").addEventListener("change",e=>$("shot").classList.toggle("hide-boxes",!e.target.checked));
async function poll(){try{const r=await fetch("/debug/captures",{cache:"no-store"});const j=await r.json();data=j.captures;
 const newest=data[0]&&data[0].id;if(newest!==latestId){if(selected===null||selected===latestId)selected=newest;latestId=newest;render()}}catch(e){}setTimeout(poll,1500)}
poll();
</script></body></html>
"""
