# Models

Drop the exported ONNX ViT here (e.g. `vit-tiny-ui-v0.onnx`). Files in `public/` are copied
verbatim into `dist/<browser>/`, so the model is then reachable at
`chrome.runtime.getURL("models/vit-tiny-ui-v0.onnx")`.

`*.onnx` is git-ignored. Set `CONFIG.perception.modelUrl` in `src/shared/config.ts` to enable it.
