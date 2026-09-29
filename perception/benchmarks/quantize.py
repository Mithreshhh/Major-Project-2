"""
Build compressed variants of the UltraFace face detector for the size/speed/accuracy study.

For each base model (RFB-320, RFB-640) this writes, into perception/models/compressed/:
  <name>.fp32-clean.onnx    same FP32 weights, export fixed so ORT can optimise the graph
                            (the upstream file lists every weight as a graph input, which
                            blocks constant folding and Conv+BatchNorm fusion)
  <name>.fp16.onnx          weights stored as float16 (graph I/O stays float32)
  <name>.int8-dynamic.onnx  8-bit weights, activations quantized on the fly
  <name>.int8-static.onnx   8-bit weights AND activations (QDQ), calibrated on sample images

All variants start from the cleaned graph upgraded to opset 13 (needed for per-channel QDQ).

Run from perception/:
  benchmarks/.venv/Scripts/python benchmarks/quantize.py      (Windows)
  benchmarks/.venv/bin/python benchmarks/quantize.py          (macOS/Linux)
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
import onnx
from onnx import version_converter
from onnxruntime.quantization import (
    CalibrationDataReader,
    CalibrationMethod,
    QuantFormat,
    QuantType,
    quantize_dynamic,
    quantize_static,
)
from onnxruntime.quantization.shape_inference import quant_pre_process
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"
OUT = MODELS / "compressed"
FIXTURES = ROOT / "test" / "fixtures"
EXTRA_CALIBRATION = ROOT.parent / "demo" / "profile.jpg"

BASES = {
    "version-RFB-320": (320, 240),
    "version-RFB-640": (640, 480),
}


def strip_initializer_inputs(model: onnx.ModelProto) -> onnx.ModelProto:
    """The upstream export lists every weight as a graph input; quantizers need them as constants."""
    names = {init.name for init in model.graph.initializer}
    keep = [i for i in model.graph.input if i.name not in names]
    del model.graph.input[:]
    model.graph.input.extend(keep)
    return model


def preprocess_image(path: Path, size: tuple[int, int]) -> np.ndarray:
    """Same normalisation as perception/src/preprocess.ts: RGB, (x - 127) / 128, NCHW."""
    img = Image.open(path).convert("RGB").resize(size, Image.BILINEAR)
    arr = (np.asarray(img, dtype=np.float32) - 127.0) / 128.0
    return arr.transpose(2, 0, 1)[None, ...]


class ImageReader(CalibrationDataReader):
    """Calibration batches: every fixture plus a mirrored and a brightened copy of each."""

    def __init__(self, input_name: str, size: tuple[int, int]) -> None:
        paths = sorted(FIXTURES.glob("*.jpg"))
        if EXTRA_CALIBRATION.exists():
            paths.append(EXTRA_CALIBRATION)
        batches = []
        for p in paths:
            x = preprocess_image(p, size)
            batches.append(x)
            batches.append(x[..., ::-1].copy())  # horizontal flip
            batches.append(np.clip(x * 1.2 + 0.1, -1.0, 1.0).astype(np.float32))  # brighter
        self._it = iter({input_name: b} for b in batches)
        self.count = len(batches)

    def get_next(self):
        return next(self._it, None)


def to_fp16(src: Path, dst: Path) -> None:
    from onnxconverter_common import float16

    model = onnx.load(str(src))
    fp16 = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(fp16, str(dst))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for name, size in BASES.items():
            src = MODELS / f"{name}.onnx"
            if not src.exists():
                print(f"missing {src}; run `npm run models:fetch` first", file=sys.stderr)
                return 1

            cleaned = OUT / f"{name}.fp32-clean.onnx"
            model = strip_initializer_inputs(onnx.load(str(src)))
            model = version_converter.convert_version(model, 13)
            onnx.checker.check_model(model)
            onnx.save(model, str(cleaned))
            print(f"wrote {cleaned.name} (opset {model.opset_import[0].version})")
            prepped = tmpdir / f"{name}.prep.onnx"
            quant_pre_process(str(cleaned), str(prepped), skip_symbolic_shape=True)
            input_name = onnx.load(str(prepped)).graph.input[0].name

            fp16 = OUT / f"{name}.fp16.onnx"
            to_fp16(cleaned, fp16)
            print(f"wrote {fp16.name}")

            dyn = OUT / f"{name}.int8-dynamic.onnx"
            quantize_dynamic(str(prepped), str(dyn), weight_type=QuantType.QUInt8)
            print(f"wrote {dyn.name}")

            static = OUT / f"{name}.int8-static.onnx"
            reader = ImageReader(input_name, size)
            quantize_static(
                str(prepped),
                str(static),
                reader,
                quant_format=QuantFormat.QDQ,
                activation_type=QuantType.QUInt8,
                weight_type=QuantType.QInt8,
                per_channel=True,
                calibrate_method=CalibrationMethod.MinMax,
            )
            print(f"wrote {static.name} (calibrated on {reader.count} images)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
