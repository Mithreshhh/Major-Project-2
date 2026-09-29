"""Train the on-device UI detector (YOLO11n, 3 classes) and export it for the extension.

    node generate.mjs 1500 200          # dataset/ (synthetic pages + held-out demo page)
    python train.py [epochs=40] [init=yolo11n.pt]   # -> ../models/ui-detect.onnx, results in runs/

YOLO11n starts from the COCO-pretrained checkpoint (AGPL-3.0, Ultralytics), or from an earlier
run's weights to fine-tune on a regenerated dataset. Horizontal flips are off: mirrored text does
not occur on real screens.
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
    epochs = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    model = YOLO(sys.argv[2] if len(sys.argv) > 2 else "yolo11n.pt")
    model.train(
        data=str(DATA), imgsz=640, epochs=epochs, batch=32, device=0, workers=4,
        fliplr=0.0, degrees=0.0, mosaic=1.0, close_mosaic=5, patience=15,
        project=str(HERE / "runs"), name="ui-detect", exist_ok=True, plots=True, verbose=False,
    )
    best = HERE / "runs" / "ui-detect" / "weights" / "best.pt"
    model = YOLO(str(best))

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
