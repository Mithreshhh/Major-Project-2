# Demo guide

Everything you need to show the project to your mentors. It takes about 7 minutes.

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
   5. `perception/ui-model/RESULTS.md` on GitHub
   6. The `e2e/proof/` folder, your backup if anything fails live

## The demo: 7 minutes

**1. The idea, 30 seconds.** Show the architecture diagram.
> "A browser agent that completes tasks for you, but personal data never leaves your laptop. The
> extension hides faces, passwords and personal details on the device, and the AI only sees the
> cleaned-up version."

**2. The test page, 20 seconds.** Show <http://127.0.0.1:5500>.
> "This page has everything sensitive: a face photo, an email, a phone number, a card number,
> Aadhaar, PAN, and a password field."

**3. Give it a task, 1 minute.** Click the extension icon, click **Demo task**, then **Run task**.
Watch the steps appear in the popup while the form fills itself in. Before it submits, the popup
shows **"Allow this action? The agent wants to: Click "Submit""**. Click **Allow**.
> "I just typed one instruction. The agent fills each field, but before anything with real
> consequences, like submitting, logging in, paying or deleting, it stops and asks me. Then it
> submits and stops by itself when it sees the confirmation message."

**3b. Ask it about a page, 1 minute.** Open <http://127.0.0.1:5500/login.html> (a fake bank login
page). In the popup type **Analyze this login page** and press **Run task**. The hint under the box
says it looks like a question. The username and password fields stay empty.
> "If I ask a question, it switches to ask mode. It can only answer, it can't click or type. Here it
> explains the login page, and it never touches the fields."

Go back to the test page, click **Demo question**, then **Ask about page**.
> "It knows the page shows an email, phone, card, Aadhaar and PAN, but the AI never saw the real
> values. It only received placeholders like HIDDEN EMAIL."

On "What the AI sees", scroll to **Page text the AI read** to show the red `[HIDDEN …]` placeholders.

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

**7. Buttons, inputs and links from the screenshot, 1 minute.** On "What the AI sees", point at
the dashed boxes and the "Found from pixels" section.
> "This is our second on-device model. It finds buttons, inputs and links from the screenshot
> alone: blue dashed boxes are buttons, green are inputs, orange are links. We trained it
> ourselves. Instead of labelling images by hand, we generated 1,700 random web pages and read
> the exact position of every button from the page code, so the labels were free and perfect.
> The test page was never used in training. On every step the extension checks the model
> against the real page, and here it found 10 out of 10 elements."

Then show `perception/ui-model/RESULTS.md` for the numbers across thresholds.
> "We also tried Microsoft's OmniParser model first. It was 77 MB and couldn't even load in the
> browser, so we trained a model 7 times smaller."

If asked what's still missing: the agent still clicks using the page's code, because it's exact.
The vision boxes are measured and shown, and merging them in (for canvas apps or images of
buttons) is the next milestone.

## If something goes wrong live

| Problem | Fix |
| --- | --- |
| Popup shows "server offline" | Start the server (`npm run server:dev`) |
| First step takes 10 to 20 seconds | Normal. The browser loads both on-device models once and Gemma warms up. Later steps take 2 to 4 seconds |
| "This tab is not a normal web page" | You're on a Chrome page. Switch to the test page tab |
| Agent stops with "same action twice" | The loop guard worked. Click **Clear form** on the page and run again |
| Popup says "Allow this action?" | That's the safety check. Click **Allow** (or **Don't allow** to show it stops) |
| Popup says a text "is not in your task" | The agent tried to type something you didn't give it. Put the exact text in the task |
| Popup was closed during "Allow this action?" | Click the extension icon again; the Allow button is still there (it waits 2 minutes) |
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

**"Can it log in or pay by mistake?"** Three guards. Questions like "analyze this page" go to ask
mode, which can only answer. The agent may only type text that is in your task, so it can't
invent a username or password. And clicks like Log in, Submit, Pay, Delete or Send wait for you to
press Allow.

**"Can it answer questions about a page?"** Yes, in ask mode. It reads the page's visible text
with personal data replaced on the laptop by placeholders like [HIDDEN EMAIL], so it can say what
kind of personal data is there without ever seeing it.

**"Does Gemma see the screenshot?"** This Gemma build is text-only, so it reasons from the cleaned
element list and page text. The redacted screenshot is still sent and shown on "What the AI sees",
ready for a vision model.

**"Why is the UI model trained on fake pages?"** Labelling thousands of real screenshots by hand
takes weeks. Generated pages give perfect labels in minutes, and we test on a page it never
saw. Real sites are harder (icons, custom widgets), which is why the extension measures it
against the page on every step instead of trusting it blindly.

**"Why does the agent still use the page code to click?"** It's exact and it's free. The vision
model matters when there is no usable page code: canvas apps, images of buttons, embedded
frames. That merge is the next step.

**"What does 'on-device' mean here?"** The face model runs inside the browser extension with
ONNX Runtime on WebAssembly. The only thing that leaves the extension is the sanitized request.
