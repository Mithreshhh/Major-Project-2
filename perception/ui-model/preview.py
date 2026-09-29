"""Draw YOLO labels on dataset images:  python preview.py dataset/images/train/page_0000.jpg [...]"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

COLORS = {0: (230, 40, 40), 1: (30, 140, 255), 2: (20, 170, 60)}
NAMES = {0: "button", 1: "input", 2: "link"}

for arg in sys.argv[1:]:
    img_path = Path(arg)
    label_path = Path(str(img_path).replace("images", "labels")).with_suffix(".txt")
    img = Image.open(img_path).convert("RGB")
    draw = ImageDraw.Draw(img)
    w, h = img.size
    for line in label_path.read_text().splitlines():
        c, cx, cy, bw, bh = line.split()
        c = int(c)
        cx, cy, bw, bh = float(cx) * w, float(cy) * h, float(bw) * w, float(bh) * h
        box = (cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2)
        draw.rectangle(box, outline=COLORS[c], width=2)
        draw.text((box[0] + 2, box[1] - 11), NAMES[c], fill=COLORS[c])
    out = img_path.with_name(img_path.stem + ".preview.png")
    img.save(out)
    print(out)
