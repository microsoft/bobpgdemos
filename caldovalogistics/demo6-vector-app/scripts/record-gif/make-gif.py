"""Turn frames/frames.json + PNGs into an optimized looping GIF."""
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops

root = Path(__file__).parent / "frames"
out = Path(sys.argv[1])
spec = json.loads((root / "frames.json").read_text())

images, durations = [], []
previous = None
for item in spec:
    image = Image.open(root / item["file"]).convert("RGB")
    if previous is not None and ImageChops.difference(image, previous).getbbox() is None:
        durations[-1] += item["ms"]
        continue
    images.append(image)
    durations.append(item["ms"])
    previous = image

durations[-1] = max(durations[-1], 4000)
# GIF delays are in 10 ms units; keep every frame at least 60 ms.
durations = [max(60, round(ms / 10) * 10) for ms in durations]
# One shared palette (built from a sample of frames) keeps unchanged pixels
# identical between frames, so each GIF frame only stores the region that changed.
sample = images[:: max(1, len(images) // 24)]
sheet = Image.new("RGB", (images[0].width, images[0].height * len(sample)))
for index, image in enumerate(sample):
    sheet.paste(image, (0, index * image.height))
palette = sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
palette_frames = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in images]
palette_frames[0].save(
    out,
    save_all=True,
    append_images=palette_frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
    disposal=1,
)
print(f"{len(images)} unique frames, {sum(durations) / 1000:.1f} s, {out.stat().st_size / 1_048_576:.1f} MB")
