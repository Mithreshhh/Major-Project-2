# Models

Nothing needs to be placed here. ONNX models live in `perception/models/` and the build script
copies them into `dist/<browser>/models/`, where the background worker loads them with
`chrome.runtime.getURL("models/<file>.onnx")` (see `src/shared/config.ts`).

`*.onnx` dropped into this folder is git-ignored and would also be copied to `dist/` at build.
