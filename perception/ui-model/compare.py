"""Compare checkpoints on the held-out test pages (dataset/images/demo) at the extension's threshold.

    python compare.py name=path.pt [name=path.pt ...]
"""

import sys
from pathlib import Path

from ultralytics import YOLO

HERE = Path(__file__).resolve().parent


def main() -> None:
    for arg in sys.argv[1:]:
        name, weights = arg.split("=", 1)
        m = YOLO(weights).val(data=str(HERE / "dataset" / "data.yaml"), split="test", imgsz=640, device=0, workers=0,
                              plots=False, verbose=False, conf=0.5, project=str(HERE / "runs"), name="compare", exist_ok=True)
        per_class = ", ".join(f"{k} {v:.2f}" for k, v in zip(["button", "input", "link"], m.box.ap50))
        print(f"RESULT {name}: precision {m.box.mp:.3f} recall {m.box.mr:.3f} | mAP50 per class: {per_class}")


if __name__ == "__main__":
    main()
