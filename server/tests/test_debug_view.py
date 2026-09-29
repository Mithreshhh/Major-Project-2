"""The "What the AI sees" recorder shows exactly what /process received."""
import base64

from app.main import captures

# 1x1 white JPEG
PIXEL_JPEG = base64.b64encode(
    bytes.fromhex(
        "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbd3ffd9"
    )
).decode()


def test_process_is_recorded_with_screenshot_and_decision(client, example_context):
    assert captures is not None
    captures.clear()
    shot = {"mimeType": "image/jpeg", "dataBase64": PIXEL_JPEG, "width": 1, "height": 1}
    ctx = {**example_context, "screenshot": shot}

    res = client.post("/process", json=ctx)
    assert res.status_code == 200

    listing = client.get("/debug/captures").json()
    assert listing["count"] == 1
    cap = listing["captures"][0]
    assert cap["task"] == ctx["task"]
    assert cap["hasScreenshot"] is True
    assert cap["command"] == res.json()
    assert cap["redactions"] == ctx["redactions"]
    assert [e["id"] for e in cap["elements"]] == ["el_0", "el_1"]

    img = client.get(f"/debug/captures/{cap['id']}/screenshot")
    assert img.status_code == 200
    assert img.headers["content-type"] == "image/jpeg"
    assert img.content == base64.b64decode(PIXEL_JPEG)


def test_failed_process_is_recorded_with_error(client, swap_state, example_context):
    class Boom:
        name = "boom"

        async def decide(self, context):
            from app.reasoning import ModelOutputError

            raise ModelOutputError("model said nonsense twice")

    captures.clear()
    swap_state(reasoner=Boom())
    res = client.post("/process", json=example_context)
    assert res.status_code == 502
    cap = client.get("/debug/captures").json()["captures"][0]
    assert cap["command"] is None
    assert "nonsense" in cap["error"]


def test_view_page_and_missing_screenshot(client, example_context):
    captures.clear()
    client.post("/process", json=example_context)  # screenshot: null
    page = client.get("/debug/view")
    assert page.status_code == 200
    assert "What the AI sees" in page.text
    cap_id = client.get("/debug/captures").json()["captures"][0]["id"]
    assert client.get(f"/debug/captures/{cap_id}/screenshot").status_code == 404
