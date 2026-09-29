# Demo guide

Everything you need to show the project to your mentors. It takes about 5 minutes.

## Before the meeting: 10 minutes

1. **Start Ollama.** It usually runs in the background already. Check with `ollama list`, which
   should show `ledgerguard-gemma4-e2b-q4-0:latest`.
2. **Start the server.** In a terminal, from the project folder:
   ```
   npm run server:dev
   ```
3. **Start the test page.** In a second terminal:
   ```
   python -m http.server 5500 --bind 127.0.0.1 --directory demo
   ```
4. **Warm up the AI.** Open <http://127.0.0.1:8000/health/gemma?warm=true>. It should say
   `"status":"ok"` and `"modelLoaded":true`.
5. **Build and reload the extension.** Run `npm run build`, then on `chrome://extensions` click
   the reload arrow on "On-Device Perception Agent". Pin its icon to the toolbar.
6. **Do one practice run** (steps 3 to 5 below) so the first slow step is out of the way.
7. **Open these tabs in order:**
   1. `README.md` on GitHub, showing the architecture diagram
   2. <http://127.0.0.1:5500>, the test page
   3. <http://127.0.0.1:8000/debug/view>, the "What the AI sees" page
   4. `perception/benchmarks/RESULTS.md` on GitHub
   5. The `e2e/proof/` folder, your backup if anything fails live

## The demo: 5 minutes

**1. The idea, 30 seconds.** Show the architecture diagram.
> "A browser agent that completes tasks for you, but personal data never leaves your laptop. The
> extension hides faces, passwords and personal details on the device, and the AI only sees the
> cleaned-up version."

**2. The test page, 20 seconds.** Show <http://127.0.0.1:5500>.
> "This page has everything sensitive: a face photo, an email, a phone number, a card number,
> Aadhaar, PAN, and a password field."

**3. Give it a task, 1 minute.** Click the extension icon, click **Demo task**, then **Run task**.
Watch the steps appear in the popup while the form fills itself in and gets submitted.
> "I just typed one instruction. The agent fills each field and submits, then stops by itself
> when it sees the confirmation message."

**4. Show what the AI saw, 1 minute.** Switch to the "What the AI sees" tab. It updates by itself.
> "This is exactly what the server received. The face, the password field, and all the
> personal details are black boxes. The labels show why each one was hidden: face from our
> on-device model, credential from the page structure, email and phone from text rules. The AI
> never saw the real values, and it still completed the task."

Click through the step buttons at the top to show each step's decision.

**5. The compression study, 1 minute.** Show `RESULTS.md`.
> "We tested eight versions of the on-device face model for size, speed, memory and accuracy.
> Cleaning up the model's graph made it 1.5 times faster with identical accuracy, so that's the
> version we ship. FP16 halves the size. INT8 makes the file smallest but is actually slower
> in the browser, which is a useful negative result."

**6. Proof that it's tested, 30 seconds.**
> "Over 110 automated tests across the extension, the ML module and the server, plus a
> full real-browser run that saves these screenshots." Show `e2e/proof/`.

**7. Be upfront about the gap, 30 seconds.**
> "Right now, buttons and inputs are found by reading the page's structure, not by a vision
> model. We chose that because it's more reliable, and we use vision where correctness matters
> most, which is privacy. The data format for vision-detected elements is already in place, so
> adding a UI-detection model is a model swap, not a redesign. That's our next milestone."

## If something goes wrong live

| Problem | Fix |
| --- | --- |
| Popup shows "server offline" | Start the server (`npm run server:dev`) |
| First step takes 8 to 10 seconds | Normal. The browser loads the face model once. Later steps take under 1 second |
| "This tab is not a normal web page" | You're on a Chrome page. Switch to the test page tab |
| Agent stops with "same action twice" | The loop guard worked. Click **Clear form** on the page and run again |
| Anything else | Show the saved proof in `e2e/proof/` and `run.json` |

To reset between runs: click **Clear form** on the test page.

## Likely questions

**"Why not just blur the faces?"** Blur can sometimes be partly reversed. A solid black box
destroys the information completely.

**"How do you know nothing leaks?"** There's an automated test that runs the real extension
code with the real model and checks every pixel sent to the server: black inside the hidden
areas, unchanged everywhere else. Personal data also never leaves as text, because labels are
replaced with `[REDACTED]`.

**"What if the face detector misses a face?"** It's one of three layers. The compression study
found all 4 faces in the test photos with no false positives. We can also lower the confidence
threshold to hide more, at the cost of occasional over-hiding.

**"Does it work on real websites?"** It works on normal http and https pages. Complex sites with
embedded frames, many pages or pop-ups are next. Chrome's own pages block every extension by
design.

**"Why a local Gemma model?"** It keeps everything on your machine, costs nothing per request,
and shows the design works even with a small 4.6B model. A larger model can be swapped in
through one setting.

**"What does 'on-device' mean here?"** The face model runs inside the browser extension with
ONNX Runtime on WebAssembly. The only thing that leaves the extension is the sanitized request.
