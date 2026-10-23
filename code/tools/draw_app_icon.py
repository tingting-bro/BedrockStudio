"""Draw the original pixel-style Bedrock Studio icon without external assets."""

from pathlib import Path

from PIL import Image, ImageDraw


def main() -> None:
    resources = Path(__file__).resolve().parents[1] / "resource_packs"
    # One shared geometry for the browser SVG and native PNG/ICO assets.
    shapes = [
        ("#18252d", [(4, 17), (29, 3), (54, 17), (54, 46), (29, 61), (4, 46)]),
        ("#a7d66e", [(7, 18), (29, 6), (51, 18), (29, 31)]),
        ("#78ae45", [(7, 18), (29, 31), (29, 38), (7, 25)]),
        ("#487d32", [(29, 31), (51, 18), (51, 26), (29, 39)]),
        ("#99704b", [(7, 25), (29, 38), (29, 57), (7, 44)]),
        ("#6b4a36", [(29, 39), (51, 26), (51, 44), (29, 57)]),
        ("#78ae45", [(7, 24), (13, 27), (13, 33), (7, 30)]),
        ("#78ae45", [(19, 31), (25, 35), (25, 42), (19, 38)]),
        ("#487d32", [(29, 37), (35, 34), (35, 43), (29, 46)]),
        ("#c18e5e", [(10, 36), (15, 39), (15, 43), (10, 40)]),
        ("#76513a", [(20, 44), (25, 47), (25, 51), (20, 48)]),
        ("#c4e58c", [(19, 16), (29, 11), (34, 14), (24, 19)]),
        ("#8bbd53", [(33, 21), (40, 17), (45, 20), (38, 24)]),
        # A large, high-contrast editing pencil, readable at title-bar sizes.
        ("#18252d", [(29, 45), (49, 16), (57, 15), (63, 22), (61, 29), (41, 56), (26, 61)]),
        ("#e9b84e", [(32, 46), (48, 23), (57, 30), (40, 53)]),
        ("#ffe398", [(32, 46), (48, 23), (51, 26), (35, 49)]),
        ("#c88830", [(38, 51), (54, 28), (57, 30), (40, 53)]),
        ("#e3e9e6", [(48, 23), (51, 19), (60, 26), (57, 30)]),
        ("#69aab2", [(51, 19), (54, 18), (60, 23), (60, 26)]),
        ("#f6d9a0", [(32, 46), (40, 53), (30, 57)]),
        ("#34414a", [(31, 53), (34, 56), (30, 57)]),
    ]
    image = Image.new("RGBA", (64, 64))
    draw = ImageDraw.Draw(image)
    paths = []
    for color, points in shapes:
        draw.polygon(points, fill=color)
        coordinates = " ".join(f"{x},{y}" for x, y in points)
        paths.append(f'<polygon fill="{color}" points="{coordinates}"/>')
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" '
        'shape-rendering="crispEdges">' + "".join(paths) + "</svg>\n"
    )
    (resources / "favicon.svg").write_text(svg, encoding="utf-8")
    large = image.resize((256, 256), Image.Resampling.NEAREST)
    large.save(resources / "app-icon.png")
    large.save(
        resources / "app-icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
