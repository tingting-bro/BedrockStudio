"""Index the already-installed vanilla entity models; never downloads resources."""

import json
from pathlib import Path

from bedrock_editor.entity_resources import build_catalog
from bedrock_editor.entity_resources import setup_pose as setup_pose
from bedrock_editor.entity_resources import static_number as static_number
from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "resource_packs/minecraft"
PACK = ROOT / "vanilla"


def prepare() -> dict:
    def texture_url(texture, opaque=False):
        if not isinstance(texture, str):
            return None
        png = PACK / f"{texture}.png"
        tga = PACK / f"{texture}.tga"
        source = png if png.is_file() else tga
        if not source.is_file():
            return None
        destination = None
        url = f"/minecraft/vanilla/{texture}.png"
        if source.suffix == ".tga" or opaque:
            destination = ROOT / "scene/entity-textures" / f"{texture}.png"
            destination.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as image:
            size = image.size
            if destination is not None:
                image.convert("RGB" if opaque else "RGBA").save(destination)
        if destination is not None:
            url = "/minecraft/" + destination.relative_to(ROOT).as_posix()
        return url, size

    return build_catalog(PACK, texture_url)


if __name__ == "__main__":
    result = prepare()
    destination = ROOT / "scene/entity-models.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(
        f"Indexed {len(result['entities'])} entity types and {len(result['geometries'])} geometries"
    )
