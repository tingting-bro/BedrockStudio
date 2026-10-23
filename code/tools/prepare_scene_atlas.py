"""Build the offline 3D terrain atlas from the checked-in vanilla resource pack."""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps
from prepare_minecraft_icons import read_json

ROOT = Path(__file__).resolve().parents[1] / "resource_packs" / "minecraft"


def main() -> None:
    vanilla = ROOT / "vanilla"
    blocks = read_json(vanilla / "blocks.json")
    terrain = read_json(vanilla / "textures/terrain_texture.json")["texture_data"]
    images = []
    entries = {}
    missing = Image.new("RGBA", (16, 16), "#111111")
    draw = ImageDraw.Draw(missing)
    draw.rectangle((0, 0, 7, 7), fill="#e300d6")
    draw.rectangle((8, 8, 15, 15), fill="#e300d6")
    images.append(missing)
    for name, entry in sorted(terrain.items()):
        paths = entry.get("textures", [])
        paths = paths if isinstance(paths, list) else [paths]
        ids = []
        for value in paths:
            path = value.get("path", "") if isinstance(value, dict) else value
            source = (
                next(
                    (
                        vanilla / (path + ext)
                        for ext in (".png", ".tga")
                        if (vanilla / (path + ext)).is_file()
                    ),
                    None,
                )
                if isinstance(path, str)
                else None
            )
            if source is None:
                ids.append(0)
                continue
            with Image.open(source) as original:
                image = original.convert("RGBA")
                image = image.crop((0, 0, image.width, min(image.width, image.height))).resize(
                    (16, 16), Image.Resampling.NEAREST
                )
            # These textures are grayscale in Bedrock and receive the biome tint in-game.
            # short_grass points at the legacy tallgrass asset, so match both the
            # terrain key and the source path instead of relying on one name.
            if any(
                token in name or token in str(path)
                for token in ("grass_top", "short_grass", "leaves", "fern", "tallgrass", "vine")
            ):
                alpha = image.getchannel("A")
                if alpha.getextrema() == (0, 0):
                    alpha = Image.new("L", image.size, 255)
                image = ImageOps.colorize(ImageOps.grayscale(image), "#163816", "#83bf52").convert(
                    "RGBA"
                )
                image.putalpha(alpha)
            elif "water" in name and "lily" not in name:
                image = ImageOps.colorize(ImageOps.grayscale(image), "#143a80", "#79b3e8").convert(
                    "RGBA"
                )
            ids.append(len(images))
            images.append(image)
        entries[name] = ids or [0]
    side = 2 ** math.ceil(math.log2(math.ceil(math.sqrt(len(images))) * 20))
    atlas = Image.new("RGBA", (side, side))
    columns = side // 20
    for i, image in enumerate(images):
        x, y = i % columns * 20, i // columns * 20
        atlas.paste(image, (x + 2, y + 2))
        # Edge extrusion; mipmaps are disabled in the editor to keep pixel art crisp.
        atlas.paste(image.crop((0, 0, 1, 16)).resize((2, 16)), (x, y + 2))
        atlas.paste(image.crop((15, 0, 16, 16)).resize((2, 16)), (x + 18, y + 2))
        atlas.paste(image.crop((0, 0, 16, 1)).resize((16, 2)), (x + 2, y))
        atlas.paste(image.crop((0, 15, 16, 16)).resize((16, 2)), (x + 2, y + 18))
    output = ROOT / "scene"
    output.mkdir(exist_ok=True)
    atlas.save(output / "atlas.png", optimize=True)
    mapping = {
        name: value["textures"]
        for name, value in blocks.items()
        if isinstance(value, dict) and "textures" in value
    }
    (output / "atlas.json").write_text(
        json.dumps(
            {"size": side, "columns": columns, "textures": entries, "blocks": mapping},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"3D atlas: {len(images)} tiles, {side}×{side}; {len(mapping)} block definitions")


if __name__ == "__main__":
    main()
