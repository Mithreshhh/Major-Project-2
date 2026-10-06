"""Evaluate and export an existing checkpoint, without training again.

Use it when a training run was interrupted after it had already saved a good `best.pt`:

    python finish.py [weights=runs/ui-detect/weights/best.pt]   # -> ../models/ui-detect.onnx, metrics.json
"""

import json
import shutil
import sys
from pathlib import Path

from ultralytics import YOLO

HERE = Path(__file__).resolve().parent
DATA = HERE / "dataset" / "data.yaml"
MODELS = HERE.parent / "models"


def main() -> None:
    weights = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "runs" / "ui-detect" / "weights" / "best.pt"
    model = YOLO(str(weights))

    metrics = {}
    for split in ("val", "test"):
        m = model.val(data=str(DATA), split=split, imgsz=640, device=0, plots=False, verbose=False,
                      project=str(HERE / "runs"), name=f"eval-{split}", exist_ok=True)
        metrics["synthetic_val" if split == "val" else "demo_page"] = {
            "mAP50": round(float(m.box.map50), 3),
            "mAP50_95": round(float(m.box.map), 3),
            "precision": round(float(m.box.mp), 3),
            "recall": round(float(m.box.mr), 3),
            "per_class_mAP50": {model.names[i]: round(float(v), 3) for i, v in enumerate(m.box.ap50)},
        }
    print(json.dumps(metrics, indent=2))
    (HERE / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")

    onnx = Path(model.export(format="onnx", imgsz=640, opset=17, simplify=True, dynamic=False, nms=False))
    target = MODELS / "ui-detect.onnx"
    shutil.copyfile(onnx, target)
    print(f"{target}: {target.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
