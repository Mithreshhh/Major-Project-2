"""POST /ask answers questions about the page and never returns an action."""
from __future__ import annotations

from app.main import captures
from app.prompting import build_ask_messages

from test_gemma_reasoner import FakeOllama, make_context, run

PAGE_TEXT = "Sign in to Acme\nEmail [HIDDEN EMAIL]\nForgot password?\nNeed help? Call [HIDDEN PHONE]"


def test_ask_returns_an_answer_and_is_recorded(client, example_context):
    captures.clear()
    res = client.post("/ask", json={**example_context, "task": "What is this page?", "pageText": PAGE_TEXT})
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"answer"} and body["answer"].startswith("[mock]")

    cap = client.get("/debug/captures").json()["captures"][0]
    assert cap["command"] == {"action": "answer", "answer": body["answer"]}
    assert cap["pageText"] == PAGE_TEXT


def test_ask_rejects_oversized_page_text(client, example_context):
    res = client.post("/ask", json={**example_context, "pageText": "x" * 20001})
    assert res.status_code == 422


def test_ask_prompt_carries_question_text_and_what_was_hidden(example_context):
    ctx = make_context(example_context, task="Analyze this login page", pageText=PAGE_TEXT)
    system, user = (m["content"] for m in build_ask_messages(ctx))
    assert "you only answer" in system and "Never guess or reconstruct hidden values" in system
    assert "Question: Analyze this login page" in user
    assert "[HIDDEN EMAIL]" in user and "[HIDDEN PHONE]" in user
    assert "Hidden on the user's device before sending: 1 email address." in user
    assert "button: Submit" in user


def test_gemma_answer_is_plain_text_not_json(example_context):
    fake = FakeOllama(["This is a sign-in page for Acme. The email shown was hidden."])
    ctx = make_context(example_context, task="What is this page?", pageText=PAGE_TEXT)
    answer = run(fake.reasoner().answer(ctx))
    assert answer == "This is a sign-in page for Acme. The email shown was hidden."
    request = fake.chat_requests[0]
    assert "format" not in request, "answers are free text, not JSON mode"
    assert request["options"]["num_predict"] >= 600
