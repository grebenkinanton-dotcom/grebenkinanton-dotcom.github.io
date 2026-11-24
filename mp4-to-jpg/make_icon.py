"""Generate icon.ico / icon.png for MP4 to JPG Sequence.

Idea: a film frame (the video) showing a small picture (the JPG), with two
more frames stacked behind it (the sequence). Small sizes get fewer details
so the icon stays crisp at 16 px.

    python make_icon.py      -> icon.ico (16-256 px), icon.png (256 px)
"""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SS = 4  # supersampling factor

BLUE = (0, 103, 192, 255)        # Windows accent blue
BLUE_MID = (64, 150, 225, 255)
BLUE_LIGHT = (150, 199, 242, 255)
SKY = (226, 242, 255, 255)
HILL_BACK = (108, 203, 95, 255)
HILL_FRONT = (16, 124, 65, 255)
SUN = (255, 185, 0, 255)
WHITE = (255, 255, 255, 255)


def draw(size: int) -> Image.Image:
    n = size * SS
    k = n / 256.0  # design is in a 256x256 grid
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def R(x0, y0, x1, y1):
        return [x0 * k, y0 * k, x1 * k, y1 * k]

    small = size <= 24
    holes = 3 if small else 5
    gap = 0 if small else 7  # white outline between stacked cards

    # Main frame box in the 256 grid; stacked frames go up and to the right
    X0, Y0, X1, Y1 = (8, 76, 208, 248) if small else (16, 68, 200, 236)

    # Stacked frames behind (the "sequence")
    backs = [(BLUE_LIGHT, 40)] if small else [(BLUE_LIGHT, 48), (BLUE_MID, 24)]
    for color, off in backs:
        box = R(X0 + off, Y0 - off, X1 + off, Y1 - off)
        d.rounded_rectangle(box, radius=18 * k, fill=color, outline=WHITE if gap else None,
                            width=int(gap * k))

    # Main film frame
    d.rounded_rectangle(R(X0, Y0, X1, Y1), radius=20 * k, fill=BLUE,
                        outline=WHITE if gap else None, width=int(gap * k))
    # Sprocket holes, top and bottom
    band = 22 if small else 18
    left, right = X0 + 20, X1 - 20
    hole_w = 32 if small else 18
    step = (right - left - hole_w) / (holes - 1)
    for i in range(holes):
        x = left + i * step
        d.rounded_rectangle(R(x, Y0 + 12, x + hole_w, Y0 + 12 + band), radius=4 * k, fill=WHITE)
        d.rounded_rectangle(R(x, Y1 - 12 - band, x + hole_w, Y1 - 12), radius=4 * k, fill=WHITE)

    # Picture inside the frame (the JPG)
    px0, py0, px1, py1 = X0 + 16, Y0 + 24 + band, X1 - 16, Y1 - 24 - band
    pic = R(px0, py0, px1, py1)
    d.rectangle(pic, fill=SKY)
    clip = Image.new("L", (n, n), 0)
    ImageDraw.Draw(clip).rectangle(pic, fill=255)
    scene = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    sc = ImageDraw.Draw(scene)
    w, h = px1 - px0, py1 - py0
    P = lambda fx, fy: ((px0 + fx * w) * k, (py0 + fy * h) * k)
    sr = 0.2 * h if not small else 0.26 * h
    cx, cy = P(0.78, 0.3)
    sc.ellipse([cx - sr * k, cy - sr * k, cx + sr * k, cy + sr * k], fill=SUN)
    if not small:
        sc.polygon([P(0.45, 1), P(0.75, 0.42), P(1.05, 1)], fill=HILL_BACK)
    sc.polygon([P(-0.05, 1), P(0.33, 0.22 if not small else 0.15), P(0.75, 1)], fill=HILL_FRONT)
    img.paste(scene, (0, 0), Image.composite(scene, Image.new("RGBA", (n, n)), clip))

    return img.resize((size, size), Image.LANCZOS)


def main():
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [draw(s) for s in sizes]
    frames[-1].save(HERE / "icon.png")
    frames[-1].save(HERE / "icon.ico", sizes=[(s, s) for s in sizes],
                    append_images=frames[:-1])
    print("wrote icon.ico and icon.png")


if __name__ == "__main__":
    main()
