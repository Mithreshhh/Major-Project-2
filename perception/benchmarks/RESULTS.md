# Face detector compression study

Measured 2026-09-29 on win32/x64, Node v24.13.0, onnxruntime-web on single-threaded WASM (the same runtime and code the extension ships). Latency is the median / mean / 95th percentile of 30 runs on a 960x754 photo, including resize and NMS; speed-up compares medians, which ignore one-off stalls. Memory is the resident-set growth of a fresh process. Each variant runs in its own process.

| Variant | Size | vs FP32 | Load | Latency median / mean / p95 | Speed-up (median) | Memory (peak growth) | Recall | False positives | Box IoU vs FP32 |
| --- | ---: | ---: | ---: | --- | ---: | ---: | :---: | :---: | ---: |
| RFB-320 FP32 original export | 1241 KB | 100% | 287 ms | 25.4 / 25.9 / 31 ms | 1x | 92.2 MB | 4/4 | 0 | 1.000 |
| RFB-320 FP32 cleaned graph | 1238 KB | 100% | 273 ms | 19.1 / 19.6 / 22.3 ms | 1.33x | 84.3 MB | 4/4 | 0 | 1.000 |
| RFB-320 FP16 | 638 KB | 51% | 314 ms | 20.2 / 20.4 / 22.7 ms | 1.26x | 274 MB | 4/4 | 0 | 0.995 |
| RFB-320 INT8 dynamic | 480 KB | 39% | 321 ms | 30.5 / 31.6 / 39.5 ms | 0.83x | 162.2 MB | 4/4 | 0 | 0.982 |
| RFB-320 INT8 static | 550 KB | 44% | 373 ms | 24.7 / 27.4 / 35.7 ms | 1.03x | 82.2 MB | 4/4 | 0 | 0.936 |
| RFB-640 FP32 original export | 1551 KB | 100% | 272 ms | 81.5 / 101 / 192.1 ms | 1x | 114.2 MB | 4/4 | 0 | 1.000 |
| RFB-640 FP32 cleaned graph | 1547 KB | 100% | 277 ms | 54.3 / 55.1 / 61.6 ms | 1.5x | 118.1 MB | 4/4 | 0 | 1.000 |
| RFB-640 FP16 | 793 KB | 51% | 312 ms | 55.6 / 56.2 / 62.5 ms | 1.47x | 218.9 MB | 4/4 | 0 | 0.996 |
| RFB-640 INT8 dynamic | 790 KB | 51% | 315 ms | 102.5 / 123.9 / 181.9 ms | 0.8x | 134.9 MB | 4/4 | 0 | 0.986 |
| RFB-640 INT8 static | 860 KB | 55% | 343 ms | 173.5 / 163.7 / 234.8 ms | 0.47x | 124.3 MB | 4/4 | 0 | 0.930 |

Recall counts faces found on the portrait (1 face) and the Apollo 11 crew photo (3 faces). False positives are detections on a coffee-cup photo with no face. Box IoU compares each variant's boxes with the FP32 model of the same input size (1.000 = identical boxes).

Cat photo (a known confuser for human-face detectors, not scored): RFB-320 FP32 original export 2, RFB-320 FP32 cleaned graph 2, RFB-320 FP16 2, RFB-320 INT8 dynamic 2, RFB-320 INT8 static 2, RFB-640 FP32 original export 1, RFB-640 FP32 cleaned graph 1, RFB-640 FP16 1, RFB-640 INT8 dynamic 1, RFB-640 INT8 static 0.

Reproduce: `benchmarks/.venv/Scripts/python benchmarks/quantize.py` then `npm run benchmark` (from `perception/`).
