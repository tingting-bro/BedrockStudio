"""Prepare offline vanilla icons from Mojang's pinned Bedrock samples (requires Pillow)."""

import argparse
import hashlib
import json
import re
import zipfile
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError

from bedrock_editor.resource_network import read_resource
from PIL import Image

REVISION = "46ba6ea985fb5a92d79a9419198f10dda14c199d"
BASE = f"https://raw.githubusercontent.com/Mojang/bedrock-samples/{REVISION}/"
DESTINATION = Path(__file__).resolve().parents[1] / "resource_packs" / "minecraft"
PACK = DESTINATION / "vanilla"
BLOCKS = {
    "world": "grass_side",
    "chest": "chest_front",
    "ender_chest": "ender_chest_front",
    "barrel": "barrel_side",
    "furnace": "furnace_front_off",
    "blast_furnace": "blast_furnace_front_off",
    "smoker": "smoker_front_off",
    "mobspawner": "mob_spawner",
    "commandblock": "command_block",
    "beacon": "beacon",
    "structure_block": "structure_block",
    "portal": "obsidian",
    "shulkerbox": "shulker_top_white",
    "dispenser": "dispenser_front_horizontal",
    "dropper": "dropper_front_horizontal",
    "enchanting_table": "enchanting_table_side",
    "brewing_stand": "brewing_stand",
    "jukebox": "jukebox_side",
    "noteblock": "noteblock",
    "campfire": "campfire_log",
}
ITEMS = {
    "map": "map_filled",
    "timer": "clock_item",
    "spawn": "compass_item",
    "bed": "bed_red",
    "sign": "sign",
    "hangingsign": "oak_hanging_sign",
    "hopper": "hopper",
    "boat": "boat_oak",
    "chest_boat": "oak_chest_boat",
    "minecart": "minecart_normal",
    "chest_minecart": "minecart_chest",
    "armor_stand": "armor_stand",
    "item": "apple",
    **{
        name: name
        for name in (
            "apple",
            "diamond",
            "emerald",
            "coal",
            "iron_ingot",
            "gold_ingot",
            "netherite_ingot",
            "stick",
            "bone",
            "rotten_flesh",
            "ender_pearl",
            "ender_eye",
            "egg",
            "snowball",
            "arrow",
            "trident",
            "diamond_sword",
            "iron_sword",
            "diamond_pickaxe",
            "iron_pickaxe",
            "bread",
            "wheat",
            "carrot",
            "potato",
            "beef_raw",
            "porkchop_raw",
            "chicken_raw",
            "book_normal",
            "book_enchanted",
            "totem",
            "elytra",
            "experience_bottle",
            "saddle",
            "name_tag",
            "fireball",
            "fireworks",
        )
    },
    "bow": "bow_standby",
    "crossbow": "crossbow_standby",
}
# Front faces are projected from the official geometry UVs, including head child cubes.
ENTITIES = {
    "pig": ("pig/pig", "pig"),
    "cow": ("cow/cow", "cow"),
    "sheep": ("sheep/sheep", "sheep"),
    "chicken": ("chicken", "chicken"),
    "wolf": ("wolf/wolf", "wolf"),
    "cat": ("cat/ocelot", "ocelot"),
    "villager": ("villager/villager", "villager"),
    "zombie": ("zombie/zombie", "zombie"),
    "skeleton": ("skeleton/skeleton", "skeleton"),
    "creeper": ("creeper/creeper", "creeper"),
    "enderman": ("enderman/enderman", "enderman"),
    "spider": ("spider/spider", "spider"),
    "slime": ("slime/slime", "slime"),
    "ghast": ("ghast/ghast", "ghast"),
    "blaze": ("blaze", "blaze"),
    "witch": ("witch", "villager"),
    "iron_golem": ("iron_golem", "iron_golem"),
    "fox": ("fox/fox", "fox"),
    "bee": ("bee/bee", "bee"),
    "allay": ("allay/allay", "allay"),
    "warden": ("warden/warden", "warden"),
}


def fetch(path: str) -> bytes:
    if path.startswith("resource_pack/"):
        return (PACK / path.removeprefix("resource_pack/")).read_bytes()
    if path == "LICENSE.md" and (DESTINATION / path).is_file():
        return (DESTINATION / path).read_bytes()
    return read_resource(BASE + path, 16 << 20)


def parse_json(text: str) -> dict:
    # Vanilla includes JSON with comments and trailing commas. Preserve strings,
    # including URLs, while removing only syntax outside quoted values.
    string = r'"(?:\\.|[^"\\])*"'
    text = re.sub(
        f"({string})|//[^\\r\\n]*|/\\*.*?\\*/",
        lambda match: match.group(1) or " ",
        text,
        flags=re.S,
    )
    text = re.sub(f"({string})|,\\s*(?=[}}\\]])", lambda match: match.group(1) or "", text)
    return json.loads(text)


def read_json(path: Path) -> dict:
    return parse_json(path.read_text(encoding="utf-8-sig"))


def install_pack(archive: Path) -> None:
    if not archive.is_file():
        archive.parent.mkdir(parents=True, exist_ok=True)
        data = read_resource(
            f"https://codeload.github.com/Mojang/bedrock-samples/zip/{REVISION}", 256 << 20
        )
        archive.write_bytes(data)
    prefix = f"bedrock-samples-{REVISION}/"
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            if entry.is_dir() or not entry.filename.startswith(prefix):
                continue
            relative = entry.filename.removeprefix(prefix)
            if relative == "LICENSE.md":
                target = DESTINATION / relative
            elif relative.startswith("resource_pack/"):
                target = PACK / relative.removeprefix("resource_pack/")
            else:
                continue
            if not target.resolve().is_relative_to(DESTINATION.resolve()):
                raise ValueError("Unsafe archive path")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read(entry))


def texture_path(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, list) and value:
        return texture_path(value[0])
    if isinstance(value, dict):
        return texture_path(value.get("path"))
    return None


def texture_paths(value: object) -> list[str]:
    if isinstance(value, list):
        return [path for item in value for path in texture_paths(item)]
    path = texture_path(value)
    return [path] if path else []


def automatic_entries(existing: set[str], archive: Path) -> tuple[list[tuple], list[dict]]:
    entries = {}
    skipped = []
    # The game's texture atlas keys provide names, rather than a UI whitelist.
    atlases = {}
    for atlas in ("item_texture.json", "terrain_texture.json"):
        data_by_name = read_json(PACK / "textures" / atlas)["texture_data"]
        atlases.update(data_by_name)
        for name, data in data_by_name.items():
            path = texture_path(data.get("textures"))
            if path and re.fullmatch(r"[a-z0-9_]+", name) and name not in existing:
                entries.setdefault(name, (name, f"resource_pack/{path}.png", None))
            # Array atlases contain individual material variants (tools, boats, etc.).
            for path in texture_paths(data.get("textures")):
                stem = Path(path).stem
                names = {stem}
                if atlas == "item_texture.json":
                    names.add(re.sub(r"^wood_", "wooden_", re.sub(r"^gold_", "golden_", stem)))
                    if stem.endswith("_raw"):
                        names.add(stem.removesuffix("_raw"))
                    if stem.endswith("_cooked"):
                        names.add("cooked_" + stem.removesuffix("_cooked"))
                for variant in names:
                    if re.fullmatch(r"[a-z0-9_]+", variant) and variant not in existing:
                        entries.setdefault(variant, (variant, f"resource_pack/{path}.png", None))
    for name, data in read_json(PACK / "blocks.json").items():
        if not isinstance(data, dict):
            continue
        texture = data.get("textures")
        if isinstance(texture, dict):
            texture = next(
                (texture[face] for face in ("front", "south", "side", "up") if face in texture),
                None,
            )
        path = (
            texture_path(atlases.get(texture, {}).get("textures"))
            if isinstance(texture, str)
            else None
        )
        if path and re.fullmatch(r"[a-z0-9_]+", name) and name not in existing:
            entries.setdefault(name, (name, f"resource_pack/{path}.png", None))
    # Where supplied, item definitions provide the authoritative identifier/icon link.
    prefix = f"bedrock-samples-{REVISION}/behavior_pack/items/"
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            if not entry.filename.startswith(prefix) or not entry.filename.endswith(".json"):
                continue
            item = parse_json(source.read(entry).decode("utf-8-sig")).get("minecraft:item", {})
            name = item.get("description", {}).get("identifier", "").removeprefix("minecraft:")
            icon = item.get("components", {}).get("minecraft:icon")
            if isinstance(icon, dict):
                icon = icon.get("texture") or icon.get("textures", {}).get("default")
            path = (
                texture_path(atlases.get(icon, {}).get("textures"))
                if isinstance(icon, str)
                else None
            )
            if path and re.fullmatch(r"[a-z0-9_]+", name) and name not in existing:
                entries[name] = (name, f"resource_pack/{path}.png", None)
    # Client entity definitions resolve identifiers to their actual textures/models.
    geometries = {}
    geometry_sources = {}
    for path in sorted((PACK / "models/entity").rglob("*.json")):
        model = read_json(path)
        for geometry in model.get("minecraft:geometry", []):
            identifier = geometry["description"]["identifier"]
            geometries[identifier] = geometry
            geometry_sources[identifier] = f"resource_pack/{path.relative_to(PACK).as_posix()}"
        for name, geometry in model.items():
            if isinstance(geometry, dict) and "bones" in geometry:
                geometries[name] = geometry
                geometry_sources[name] = f"resource_pack/{path.relative_to(PACK).as_posix()}"
    for path in sorted((PACK / "entity").rglob("*.json")):
        description = read_json(path).get("minecraft:client_entity", {}).get("description", {})
        identifier = description.get("identifier", "")
        name = identifier.removeprefix("minecraft:")
        if not identifier.startswith("minecraft:") or name in existing:
            continue
        textures = description.get("textures", {})
        models = description.get("geometry", {})
        texture = textures.get("default") or next(iter(textures.values()), None)
        model_id = models.get("default") or next(iter(models.values()), None)
        model = geometries.get(model_id)
        # Do not use a whole UV sheet as a creature icon if no face is available.
        if (
            not texture
            or not model
            or not any("head" in bone["name"].lower() for bone in model["bones"])
        ):
            skipped.append({"name": name, "reason": "No resolvable head geometry"})
            continue
        entries[name] = (
            name,
            f"resource_pack/{texture}.png",
            {"minecraft:geometry": [model], "source": geometry_sources[model_id]},
        )
    return list(entries.values()), skipped


def head(texture: Image.Image, geometry: dict) -> Image.Image:
    models = geometry.get("minecraft:geometry") or [
        value for value in geometry.values() if isinstance(value, dict) and "bones" in value
    ]
    model = models[0]
    bones = model["bones"]
    names = {bone["name"] for bone in bones if "head" in bone["name"].lower()}
    include_children = bool(names) or bones[0]["name"] == "cube"
    if not names:
        names = {bones[0]["name"]}  # Slime and ghast have one cubic body/face.
    if include_children:
        for _ in bones:
            names.update(bone["name"] for bone in bones if bone.get("parent") in names)
    description = model.get("description", {})
    sx = texture.width / description.get("texture_width", model.get("texturewidth", texture.width))
    sy = texture.height / description.get(
        "texture_height", model.get("textureheight", texture.height)
    )
    faces = []
    for bone in bones:
        if bone["name"] not in names:
            continue
        for cube in bone.get("cubes", []):
            x, y, z = cube["origin"]
            w, h, depth = cube["size"]
            uv = cube.get("uv")
            if not w or not h or uv is None:
                continue
            if isinstance(uv, dict):
                face = uv.get("north")
                if not face:
                    continue
                u, v = face["uv"]
                tw, th = face.get("uv_size", [w, h])
            else:
                u, v = uv[0] + depth, uv[1] + depth
                tw, th = w, h
            image = texture.crop((int(u * sx), int(v * sy), int((u + tw) * sx), int((v + th) * sy)))
            image = image.resize((int(w), int(h)), Image.Resampling.NEAREST)
            faces.append((z, x, y, w, h, image))
    if not faces:
        raise ValueError("No head face in geometry")
    left, bottom = min(f[1] for f in faces), min(f[2] for f in faces)
    right, top = max(f[1] + f[3] for f in faces), max(f[2] + f[4] for f in faces)
    result = Image.new("RGBA", (int(right - left), int(top - bottom)))
    for _, x, y, _, h, image in sorted(faces, reverse=True, key=lambda f: f[0]):
        result.alpha_composite(image, (int(x - left), int(top - y - h)))
    return result


def prepare(entry: tuple[str, str, str | dict | None]) -> dict:
    name, path, model = entry
    try:
        raw = fetch(path)
    except (HTTPError, FileNotFoundError) as error:
        if (isinstance(error, HTTPError) and error.code != 404) or not path.endswith(".png"):
            raise
        path = path.removesuffix(".png") + ".tga"
        raw = fetch(path)
    image = Image.open(BytesIO(raw)).convert("RGBA")
    if name == "sheep":
        # Sheep's alpha channel is a game shader tint mask, not UI transparency.
        image = image.convert("RGB").convert("RGBA")
    extra = None
    if name == "player":
        image = image.crop((8, 8, 16, 16))
    elif isinstance(model, dict):
        extra = model["source"]
        image = head(image, model)
    elif model:
        extra = f"resource_pack/models/entity/{model}.geo.json"
        text = fetch(extra).decode("utf-8-sig")
        image = head(image, parse_json(text))
    # Animated block textures use the first frame.
    elif image.height > image.width:
        image = image.crop((0, 0, image.width, image.width))
    scale = min(32 / image.width, 32 / image.height)
    image = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.NEAREST,
    )
    icon = Image.new("RGBA", (32, 32))
    icon.alpha_composite(image, ((32 - image.width) // 2, (32 - image.height) // 2))
    target = DESTINATION / "icons" / f"{name}.png"
    icon.save(target)
    return {
        "name": name,
        "source": BASE + path,
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "geometry": BASE + extra if extra else None,
        "file": f"icons/{name}.png",
        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--archive",
        type=Path,
        default=DESTINATION.parents[2] / "_references" / f"bedrock-vanilla-{REVISION[:7]}.zip",
    )
    args = parser.parse_args()
    install_pack(args.archive)
    (DESTINATION / "icons").mkdir(parents=True, exist_ok=True)
    (DESTINATION / "LICENSE.md").write_bytes(fetch("LICENSE.md"))
    entries = [
        (name, f"resource_pack/textures/blocks/{path}.png", None) for name, path in BLOCKS.items()
    ]
    entries += [
        (name, f"resource_pack/textures/items/{path}.png", None) for name, path in ITEMS.items()
    ]
    entries += [
        (name, f"resource_pack/textures/entity/{path}.png", model)
        for name, (path, model) in ENTITIES.items()
    ]
    entries.append(("player", "resource_pack/textures/entity/steve.png", None))
    automatic, skipped = automatic_entries({entry[0] for entry in entries}, args.archive)
    entries += automatic

    def prepare_available(entry: tuple) -> dict | None:
        try:
            return prepare(entry)
        except (FileNotFoundError, ValueError):
            if entry in automatic:
                skipped.append(
                    {"name": entry[0], "reason": "Missing texture or unreadable head geometry"}
                )
                return None
            raise

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = [result for result in pool.map(prepare_available, entries) if result]
    index = {row["name"]: f"/minecraft/{row['file']}" for row in results}
    (DESTINATION.parents[1] / "frontend/src/lib/minecraft-textures.json").write_text(
        json.dumps(dict(sorted(index.items())), indent=2) + "\n", encoding="utf-8"
    )
    (DESTINATION / "manifest.json").write_text(
        json.dumps(
            {
                "repository": "https://github.com/Mojang/bedrock-samples",
                "revision": REVISION,
                "archive_sha256": hashlib.sha256(args.archive.read_bytes()).hexdigest(),
                "unmapped": sorted(skipped, key=lambda row: row["name"]),
                "icons": sorted(results, key=lambda row: row["name"]),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Prepared {len(results)} offline icons in {DESTINATION}")


if __name__ == "__main__":
    main()
