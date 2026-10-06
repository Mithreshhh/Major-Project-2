"""
Prompt construction and output parsing for the Gemma reasoner.

Small local models follow a rigid format most of the time, not all of the time, so both halves
are defensive:

  build_messages()  a strict, example-driven prompt that asks for exactly ONE JSON object
  parse_action()    a forgiving parser: tolerates code fences, prose around the JSON, alias key
                    names ("element_id"), alias action names ("press"), numeric or label targets,
                    then validates the result against the shared ActionCommand contract
"""
from __future__ import annotations

import ast
import json
import re
from typing import Any, Iterable, Optional

from pydantic import TypeAdapter, ValidationError

from .schemas import ActionCommand, BoundingBox, SanitizedContext, UIElement, Viewport

_ACTION_ADAPTER: TypeAdapter[ActionCommand] = TypeAdapter(ActionCommand)


class ActionParseError(ValueError):
    """The model's text could not be turned into a valid ActionCommand."""

    def __init__(self, message: str, raw: str = "") -> None:
        super().__init__(message)
        self.raw = raw


# ===========================================================================
# Prompt construction
# ===========================================================================

SYSTEM_PROMPT = """You are the decision module of a browser automation agent.
You receive the user's task, the current page, a list of visible UI elements, and the actions already taken.
Decide the single best next action.

Reply with ONE JSON object and nothing else: no markdown fences, no text before or after it.

Allowed shapes (choose exactly one):
{"action": "click", "target": "<element id>", "reasoning": "<short>"}
{"action": "type", "target": "<element id>", "text": "<text to type>", "submit": false, "reasoning": "<short>"}
{"action": "scroll", "direction": "down", "reasoning": "<short>"}
{"action": "navigate", "url": "<absolute url>", "reasoning": "<short>"}
{"action": "wait", "ms": 1000, "reasoning": "<short>"}
{"action": "done", "summary": "<what was accomplished>", "reasoning": "<short>"}
{"action": "ask_user", "question": "<what you need to know>", "reasoning": "<short>"}
{"action": "noop", "reason": "<why nothing can be done>", "reasoning": "<short>"}

Rules:
1. "target" must be an element id copied exactly from the list, such as "el_3". Never invent ids and never use labels as targets.
2. Only click or type into elements that are interactive.
3. Do not repeat an action already listed under previous actions. Every action in that list has already been carried out successfully.
4. Read "Page messages" first. If a message confirms the task succeeded (for example "submitted", "thank you", "saved", "success") or every part of the task is already in previous actions, reply with "done".
5. Use "ask_user" when you need information only the user has. Use "noop" when nothing on this page can move the task forward.
6. Never type into password fields unless the task gives the password.
7. If the task only asks for information (analyze, summarize, explain, describe, check, or a question), do not click or type anything: reply with "done" and put the answer in "summary".
8. Only type text that appears in the task, or a placeholder from "Saved details" such as "{{email}}". Never invent names, usernames, emails or passwords; use "ask_user" instead.
9. "Saved details" are the user's own information. Their values are hidden from you. To type one, set "text" to exactly its placeholder, for example {"action": "type", "target": "el_4", "text": "{{email}}"}. Match each form field to the saved detail with the closest meaning, fill one field per step, and skip fields that have no matching saved detail.
10. Do not log in, sign up, pay, buy, delete or send anything unless the task explicitly asks for it.
11. Keep "reasoning" under 20 words."""

ASK_SYSTEM_PROMPT = """You answer questions about the web page the user is looking at. You cannot click or type; you only answer.
You get the page title, address, visible text, and its buttons, links and fields.
Personal data was removed on the user's device before you received anything: values appear as placeholders such as [HIDDEN EMAIL], [HIDDEN PHONE], [HIDDEN CARD NUMBER], [HIDDEN AADHAAR] and [HIDDEN PAN], and faces and password fields were blacked out.

Rules:
1. Answer only from the page content given. If the page does not contain the answer, say so.
2. Never guess or reconstruct hidden values. You may say what kind of personal data the page shows and that it was hidden.
3. If the user wants something done on the page, explain what they would need to do; do not claim you did it.
4. If asked to analyze, describe, review or summarize the page, answer in 4 to 6 short bullet points ("- "): what the page is for, what it asks the user to enter, the main actions available, important notices or warnings, and which kinds of personal data were hidden.
5. Otherwise answer directly in at most 4 short sentences. Plain text, no headings, no bold."""

_CATEGORY_WORDS = {
    "face": "face",
    "photo": "photo",
    "credential": "password or other secret field",
    "payment_card": "card number",
    "email": "email address",
    "phone": "phone number",
    "pii_text": "ID number",
    "address": "address",
    "other": "other sensitive item",
}
_ASK_TEXT_MAX = 6000
_ASK_ELEMENTS_MAX = 40

_LABEL_MAX = 60
_PROMPT_ATTRS = ("type", "placeholder", "name", "title")


def _trunc(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def describe_location(bbox: BoundingBox, viewport: Viewport) -> str:
    """Coarse 3x3 grid position of the element's centre within the viewport."""
    if viewport.width <= 0 or viewport.height <= 0:
        return "unknown"
    cx = (bbox.x + bbox.width / 2) / viewport.width
    cy = (bbox.y + bbox.height / 2) / viewport.height
    col = "left" if cx < 1 / 3 else "right" if cx > 2 / 3 else "center"
    row = "top" if cy < 1 / 3 else "bottom" if cy > 2 / 3 else "middle"
    if row == "middle" and col == "center":
        return "center"
    if row == "middle":
        return col
    if col == "center":
        return row
    return f"{row}-{col}"


def format_element(el: UIElement, viewport: Viewport) -> str:
    b = el.bbox
    parts = [
        el.id,
        el.role,
        f'"{_trunc(el.label, _LABEL_MAX)}"' if el.label else '""',
        f"{describe_location(b, viewport)} (x={round(b.x)}, y={round(b.y)}, w={round(b.width)}, h={round(b.height)})",
    ]
    line = " | ".join(parts)

    notes: list[str] = []
    if el.attributes:
        attrs = [f"{k}={_trunc(v, 40)}" for k in _PROMPT_ATTRS if (v := el.attributes.get(k))]
        notes.extend(attrs)
        if el.attributes.get("filled"):
            notes.append("ALREADY FILLED")
        if el.attributes.get("checked"):
            notes.append("checked")
    if not el.isInteractive:
        notes.append("not interactive")
    if el.redacted:
        notes.append("label redacted")
    if notes:
        line += " [" + ", ".join(notes) + "]"
    return line


def select_elements(elements: list[UIElement], limit: int) -> tuple[list[UIElement], int]:
    """Keep at most `limit` elements, preferring interactive+visible ones, in original order."""
    if limit <= 0 or len(elements) <= limit:
        return list(elements), 0
    order = {id(el): i for i, el in enumerate(elements)}
    interactive = [e for e in elements if e.isInteractive and e.isVisible]
    rest = [e for e in elements if not (e.isInteractive and e.isVisible)]
    chosen = (interactive + rest)[:limit]
    chosen.sort(key=lambda e: order[id(e)])
    return chosen, len(elements) - len(chosen)


def describe_command(cmd: ActionCommand) -> str:
    a = cmd.action
    if a == "click":
        return f"click {cmd.target}"
    if a == "type":
        return f'type "{_trunc(cmd.text, 40)}" into {cmd.target}' + (" and submit" if cmd.submit else "")
    if a == "scroll":
        return f"scroll {cmd.direction}"
    if a == "navigate":
        return f"navigate to {cmd.url}"
    if a == "wait":
        return f"wait {cmd.ms} ms"
    if a == "done":
        return f"done: {_trunc(cmd.summary, 80)}"
    if a == "ask_user":
        return f"ask_user: {_trunc(cmd.question, 80)}"
    return f"noop: {_trunc(cmd.reason, 80)}"


def build_user_prompt(context: SanitizedContext, *, max_elements: int) -> str:
    elements, omitted = select_elements(context.elements, max_elements)
    vp = context.viewport

    lines: list[str] = [f"Task: {context.task.strip() or '(none given)'}", ""]
    lines.append(f'Page: "{_trunc(context.page.title, 80)}" ({context.page.url})')
    lines.append(
        f"Viewport: {round(vp.width)}x{round(vp.height)} CSS px. "
        "Locations are approximate: a 3x3 grid word, then x, y, width, height."
    )
    lines.append(f"Step: {context.stepIndex}")

    if context.history:
        lines.append("Previous actions (all already done successfully):")
        lines.extend(f"  {i + 1}. {describe_command(c)}" for i, c in enumerate(context.history))
    else:
        lines.append("Previous actions: none")

    # Status/alert text ("Form submitted. Thanks!") is the clearest completion signal a small
    # model gets, so it is listed on its own instead of being buried in the element list.
    messages = [e.label.strip() for e in context.elements if e.role == "text" and e.label.strip()]
    if messages:
        lines.append("Page messages:")
        lines.extend(f'  "{_trunc(m, 120)}"' for m in messages[:5])

    if context.profileFields:
        lines.append("Saved details (values hidden; type one by using its placeholder as the text):")
        lines.extend(f"  {{{{{f.key}}}}} = {_trunc(f.label, 40)}" for f in context.profileFields)
        used = [c.text for c in context.history if c.action == "type" and "{{" in c.text]
        if used:
            lines.append(f"Already typed: {', '.join(used)}. Do not type these again.")
        # Small models lose track of a long form, so the remaining work is spelled out.
        empty = [
            e
            for e in context.elements
            if e.role == "textbox" and e.isInteractive and not (e.attributes or {}).get("filled")
            and (e.attributes or {}).get("type") != "password"
        ]
        if empty:
            lines.append("Empty fields still to fill, in order (fill the first one that has a matching saved detail):")
            lines.extend(f'  {e.id} "{_trunc(e.label, _LABEL_MAX)}"' for e in empty[:12])
        else:
            lines.append('Every field is filled. If the task asks to submit, click the submit button; otherwise reply "done".')

    if context.redactions:
        lines.append(
            f"Redacted regions: {len(context.redactions)} area(s) hidden for privacy; their contents are unavailable."
        )
    if context.screenshot is None:
        lines.append("Screenshot: not provided; rely on the element list.")

    lines.append("")
    lines.append("UI elements (id | role | label | location [notes]):")
    if elements:
        lines.extend(format_element(e, vp) for e in elements)
    else:
        lines.append("(no visible elements)")
    if omitted:
        lines.append(f"({omitted} more elements omitted)")

    lines.append("")
    lines.append("Choose the single next action. Reply with ONLY the JSON object.")
    return "\n".join(lines)


def build_messages(
    context: SanitizedContext,
    *,
    max_elements: int,
    include_screenshot: bool,
) -> list[dict[str, Any]]:
    user: dict[str, Any] = {"role": "user", "content": build_user_prompt(context, max_elements=max_elements)}
    if include_screenshot and context.screenshot is not None:
        user["images"] = [context.screenshot.dataBase64]
    return [{"role": "system", "content": SYSTEM_PROMPT}, user]


def describe_redactions(context: SanitizedContext) -> str:
    """"1 face, 1 password or other secret field, 2 email addresses" from the redaction list."""
    counts: dict[str, int] = {}
    for r in context.redactions:
        counts[r.category] = counts.get(r.category, 0) + 1
    parts = [f"{n} {_CATEGORY_WORDS.get(cat, cat)}{'' if n == 1 else 's'}" for cat, n in counts.items()]
    return ", ".join(parts) if parts else "nothing"


def build_ask_prompt(context: SanitizedContext) -> str:
    lines: list[str] = [f"Question: {context.task.strip() or 'Describe this page.'}", ""]
    lines.append(f'Page: "{_trunc(context.page.title, 80)}" ({context.page.url})')
    lines.append(f"Hidden on the user's device before sending: {describe_redactions(context)}.")

    controls = [e for e in context.elements if e.isInteractive and e.isVisible][:_ASK_ELEMENTS_MAX]
    if controls:
        lines.append("")
        lines.append("Buttons, links and fields on screen:")
        for e in controls:
            kind = e.attributes.get("type") if e.attributes and e.role == "textbox" else None
            lines.append(f"  - {e.role}{f' ({kind})' if kind else ''}: {_trunc(e.label, _LABEL_MAX) or '(no label)'}")

    text = (context.pageText or "").strip()
    lines.append("")
    if text:
        if len(text) > _ASK_TEXT_MAX:
            text = text[:_ASK_TEXT_MAX] + "\n[... page text truncated]"
        lines.append('Visible page text:\n"""')
        lines.append(text)
        lines.append('"""')
    else:
        lines.append("Visible page text: not provided.")
    lines.append("")
    lines.append("Answer the question.")
    return "\n".join(lines)


def build_ask_messages(context: SanitizedContext) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": ASK_SYSTEM_PROMPT},
        {"role": "user", "content": build_ask_prompt(context)},
    ]


def retry_prompt(error: str) -> str:
    return (
        f"Your previous reply could not be used: {error}. "
        "Reply again with ONLY one JSON object in one of the allowed shapes. "
        'Use "target" ids exactly as listed (for example "el_2").'
    )


# ===========================================================================
# Output parsing
# ===========================================================================

_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*(.*?)```", re.DOTALL)
_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")
_TARGET_RE = re.compile(r"^\s*#?\s*(?:el|elem|element|id)?[\s_\-:#]*(\d+)\s*$", re.IGNORECASE)

_ACTION_ALIASES: dict[str, str] = {
    # click
    "click": "click", "press": "click", "tap": "click", "select": "click", "choose": "click",
    "check": "click", "toggle": "click", "submit": "click", "click_element": "click",
    "left_click": "click", "push": "click", "activate": "click",
    # type
    "type": "type", "type_text": "type", "input": "type", "input_text": "type", "fill": "type",
    "fill_in": "type", "enter_text": "type", "write": "type", "set_value": "type", "send_keys": "type",
    # scroll
    "scroll": "scroll", "scroll_down": "scroll", "scroll_up": "scroll", "scrolldown": "scroll", "scrollup": "scroll",
    # navigate
    "navigate": "navigate", "navigate_to": "navigate", "go_to": "navigate", "goto": "navigate",
    "open": "navigate", "open_url": "navigate", "visit": "navigate", "load": "navigate",
    # wait
    "wait": "wait", "sleep": "wait", "pause": "wait", "delay": "wait",
    # done
    "done": "done", "finish": "done", "finished": "done", "complete": "done", "completed": "done",
    "stop": "done", "end": "done", "task_complete": "done", "task_done": "done", "success": "done",
    # ask_user
    "ask_user": "ask_user", "ask": "ask_user", "question": "ask_user", "clarify": "ask_user",
    "ask_human": "ask_user", "request_input": "ask_user", "need_input": "ask_user",
    # noop
    "noop": "noop", "no_op": "noop", "none": "noop", "nothing": "noop", "idle": "noop",
    "no_action": "noop", "skip": "noop", "null": "noop",
}
_ACTION_IMPLIED: dict[str, dict[str, Any]] = {
    "scroll_down": {"direction": "down"},
    "scrolldown": {"direction": "down"},
    "scroll_up": {"direction": "up"},
    "scrollup": {"direction": "up"},
}

_KEY_ALIASES: dict[str, tuple[str, ...]] = {
    "target": ("target", "element", "element_id", "elementid", "target_id", "targetid", "target_element",
               "id", "selector", "element_index", "index"),
    "text": ("text", "value", "input", "input_text", "content", "query", "keys", "text_to_type"),
    "direction": ("direction", "dir"),
    "amountPx": ("amountpx", "amount_px", "amount", "pixels", "px", "distance"),
    "url": ("url", "href", "link", "address"),
    "ms": ("ms", "milliseconds", "millis", "duration", "duration_ms", "time_ms", "seconds"),
    "summary": ("summary", "result_summary"),
    "question": ("question",),
    "reason": ("reason",),
    "reasoning": ("reasoning", "explanation", "rationale", "thought", "thoughts", "why", "justification"),
    "confidence": ("confidence", "score", "probability"),
    "submit": ("submit", "press_enter", "enter_after", "hit_enter"),
}
_ALIAS_TO_KEY: dict[str, str] = {alias: key for key, aliases in _KEY_ALIASES.items() for alias in aliases}

_WRAPPER_KEYS = ("command", "action_command", "actioncommand", "next_action", "response", "result", "output", "data")

_COMMON_FIELDS = {"action", "reasoning", "confidence"}
_ACTION_FIELDS: dict[str, set[str]] = {
    "click": {"target"},
    "type": {"target", "text", "submit"},
    "scroll": {"direction", "amountPx"},
    "navigate": {"url"},
    "wait": {"ms"},
    "done": {"summary"},
    "ask_user": {"question"},
    "noop": {"reason"},
}


# ---------------------------------------------------------------- JSON extraction

def _balanced_spans(text: str) -> Iterable[str]:
    depth, start, in_str, esc = 0, None, False, False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start is not None:
                yield text[start : i + 1]
                start = None


def _loads_lenient(snippet: str) -> Any:
    snippet = snippet.strip()
    if not snippet:
        raise ValueError("empty")
    try:
        return json.loads(snippet)
    except ValueError:
        pass
    fixed = _TRAILING_COMMA_RE.sub(r"\1", snippet)
    try:
        return json.loads(fixed)
    except ValueError:
        pass
    # Last resort: Python-style dict (single quotes, True/False/None).
    pythonish = re.sub(r"\btrue\b", "True", fixed)
    pythonish = re.sub(r"\bfalse\b", "False", pythonish)
    pythonish = re.sub(r"\bnull\b", "None", pythonish)
    try:
        return ast.literal_eval(pythonish)
    except (ValueError, SyntaxError, MemoryError, RecursionError) as exc:
        raise ValueError("not JSON") from exc


def _candidates(text: str) -> Iterable[str]:
    yield text
    fenced = _FENCE_RE.search(text)
    if fenced:
        yield fenced.group(1)
    yield from _balanced_spans(text)


def extract_json_object(text: str) -> dict[str, Any]:
    """Find the first JSON object in free-form model output."""
    if not text or not text.strip():
        raise ActionParseError("model returned empty output", text)
    for candidate in _candidates(text):
        try:
            value = _loads_lenient(candidate)
        except ValueError:
            continue
        if isinstance(value, list):
            value = next((v for v in value if isinstance(v, dict)), None)
        if isinstance(value, dict):
            return value
    raise ActionParseError("no JSON object found in model output", text)


# ---------------------------------------------------------------- normalisation

def _norm_key(key: Any) -> str:
    return str(key).strip().lower().replace("-", "_").replace(" ", "_")


def _unwrap(obj: dict[str, Any]) -> dict[str, Any]:
    """{"command": {...}} -> {...}, repeated while the wrapper has no action of its own."""
    for _ in range(3):
        keys = {_norm_key(k): k for k in obj}
        if "action" in keys or "type" in keys:
            return obj
        for wrapper in _WRAPPER_KEYS:
            if wrapper in keys and isinstance(obj[keys[wrapper]], dict):
                obj = obj[keys[wrapper]]
                break
        else:
            return obj
    return obj


def _normalise_action(value: Any) -> tuple[Optional[str], dict[str, Any]]:
    """Map alias action names; also split "click el_1" style values."""
    if not isinstance(value, str) or not value.strip():
        return None, {}
    tokens = value.strip().lower().split()
    head = tokens[0].replace("-", "_").strip(".:,")
    rest = " ".join(tokens[1:])
    joined = "_".join(t.replace("-", "_") for t in tokens)

    extras: dict[str, Any] = {}
    for candidate in (joined, head):
        action = _ACTION_ALIASES.get(candidate)
        if action:
            extras.update(_ACTION_IMPLIED.get(candidate, {}))
            if candidate == head and rest:
                if action == "scroll" and rest in ("up", "down"):
                    extras["direction"] = rest
                elif action in ("click", "type"):
                    extras["target"] = rest
            return action, extras
    return None, {}


def _infer_action(obj: dict[str, Any]) -> Optional[str]:
    """Guess the action when the model forgot the key but the other fields make it obvious."""
    if "text" in obj and "target" in obj:
        return "type"
    if "target" in obj:
        return "click"
    if "url" in obj:
        return "navigate"
    if "question" in obj:
        return "ask_user"
    if "summary" in obj:
        return "done"
    if "direction" in obj:
        return "scroll"
    return None


def _resolve_target(value: Any, elements: list[UIElement]) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return f"el_{int(value)}"
    if isinstance(value, dict):
        value = value.get("id") or value.get("target") or value.get("label")
    if not isinstance(value, str):
        return value
    s = value.strip().strip("\"'")
    ids = {e.id for e in elements}
    if s in ids:
        return s
    m = _TARGET_RE.match(s)
    if m:
        return f"el_{int(m.group(1))}"
    low = s.lower()
    exact = [e.id for e in elements if e.label.strip().lower() == low]
    if len(exact) == 1:
        return exact[0]
    partial = [e.id for e in elements if low and low in e.label.lower()]
    if len(partial) == 1:
        return partial[0]
    return s


def _to_bool(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        low = value.strip().lower()
        if low in {"true", "yes", "y", "1", "on"}:
            return True
        if low in {"false", "no", "n", "0", "off", ""}:
            return False
    return value


def _to_confidence(value: Any) -> Optional[float]:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if 1 < f <= 100:
        f /= 100
    return f if 0 <= f <= 1 else None


def _to_ms(value: Any, from_seconds: bool) -> Any:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return value
    if from_seconds:
        f *= 1000
    return int(round(f))


def normalise_command(obj: dict[str, Any], elements: list[UIElement]) -> dict[str, Any]:
    """Coerce a loosely-shaped dict into the exact field set the contract expects."""
    obj = _unwrap(obj)

    # 1. canonical keys
    fields: dict[str, Any] = {}
    raw_keys: dict[str, str] = {}
    for key, value in obj.items():
        nk = _norm_key(key)
        if nk == "action":
            fields["action"] = value
            continue
        if nk == "type" and "action" not in fields and isinstance(value, str) and "action" not in {
            _norm_key(k) for k in obj
        }:
            fields["action"] = value
            continue
        canonical = _ALIAS_TO_KEY.get(nk)
        if canonical and canonical not in fields:
            fields[canonical] = value
            raw_keys[canonical] = nk

    # 2. action
    action, extras = _normalise_action(fields.get("action"))
    for k, v in extras.items():
        fields.setdefault(k, v)
    if action is None:
        action = _infer_action(fields) if fields.get("action") in (None, "") else None
        if action is None:
            raise ActionParseError(f"unknown action {fields.get('action')!r}")
    fields["action"] = action

    # 3. reason vs reasoning
    if action != "noop" and "reason" in fields:
        fields.setdefault("reasoning", fields.pop("reason"))
    if action == "noop" and not fields.get("reason"):
        fallback = fields.get("reasoning") or fields.get("summary") or fields.get("text")
        fields["reason"] = str(fallback) if fallback else "no reason given"

    # 4. per-action coercions and fallbacks
    if "target" in fields:
        fields["target"] = _resolve_target(fields["target"], elements)
    if action == "type" and "text" in fields and not isinstance(fields["text"], str):
        fields["text"] = "" if fields["text"] is None else str(fields["text"])
    if action == "type" and "submit" in fields:
        fields["submit"] = _to_bool(fields["submit"])
    if action == "scroll":
        d = fields.get("direction")
        d = d.strip().lower() if isinstance(d, str) else d
        fields["direction"] = {"top": "up", "bottom": "down", None: "down", "": "down"}.get(d, d)
    if action == "wait":
        fields["ms"] = _to_ms(fields.get("ms", 1000), raw_keys.get("ms") == "seconds")
    if action == "done" and not fields.get("summary"):
        fallback = fields.get("reasoning") or fields.get("text")
        fields["summary"] = str(fallback) if fallback else "Task reported complete."
    if action == "ask_user" and not fields.get("question"):
        fallback = fields.get("text") or fields.get("reasoning")
        if fallback:
            fields["question"] = str(fallback)
    if "confidence" in fields:
        conf = _to_confidence(fields["confidence"])
        if conf is None:
            fields.pop("confidence")
        else:
            fields["confidence"] = conf
    if "reasoning" in fields and fields["reasoning"] is not None and not isinstance(fields["reasoning"], str):
        fields["reasoning"] = str(fields["reasoning"])

    # 5. keep only what the contract allows for this action; drop nulls
    allowed = _COMMON_FIELDS | _ACTION_FIELDS[action]
    return {k: v for k, v in fields.items() if k in allowed and v is not None}


# ---------------------------------------------------------------- validation

def _summarise_validation_error(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors()[:3]:
        loc = ".".join(str(p) for p in err.get("loc", ()) if p not in ("function-after",))
        parts.append(f"{loc}: {err.get('msg')}" if loc else str(err.get("msg")))
    return "; ".join(parts) or "invalid command"


def _describe_ids(ids: list[str]) -> str:
    if not ids:
        return "none (the page has no listed elements)"
    if len(ids) <= 8:
        return ", ".join(ids)
    return f"{ids[0]} .. {ids[-1]}"


def parse_action(raw: str, context: SanitizedContext) -> ActionCommand:
    """Free-form model text -> validated ActionCommand, or ActionParseError explaining why not."""
    obj = extract_json_object(raw)
    fields = normalise_command(obj, context.elements)
    try:
        command = _ACTION_ADAPTER.validate_python(fields)
    except ValidationError as exc:
        raise ActionParseError(_summarise_validation_error(exc), raw) from exc

    target = getattr(command, "target", None)
    if target is not None:
        ids = [e.id for e in context.elements]
        if target not in ids:
            raise ActionParseError(f"unknown target '{target}'; valid ids are {_describe_ids(ids)}", raw)
    return command
