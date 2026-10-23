"""Versioned Mojang Bedrock assets and native classic-rendering primitives."""

from __future__ import annotations

import hashlib
import io
import json
import re
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from .resource_progress import report

REFS = "https://github.com/Mojang/bedrock-samples.git/info/refs?service=git-upload-pack"
ENTITY_ASSET_VERSION = 1


def release_tags(read_url) -> list[dict]:
    """Read all official tags in one Git advertisement, without REST API quotas."""
    data = read_url(REFS, 2 << 20)
    refs = {}
    offset = 0
    while offset < len(data):
        header = data[offset : offset + 4]
        if not re.fullmatch(rb"[0-9a-fA-F]{4}", header):
            raise ValueError("无法读取 Mojang 基岩版资源版本列表")
        size = int(header, 16)
        offset += 4
        if size == 0:
            continue
        if size < 4 or offset + size - 4 > len(data):
            raise ValueError("无法读取 Mojang 基岩版资源版本列表")
        line = data[offset : offset + size - 4].split(b"\x00", 1)[0].rstrip(b"\n")
        offset += size - 4
        match = re.fullmatch(rb"([a-f0-9]{40}) refs/tags/(v\d+\.\d+\.\d+(?:\.\d+)?)(\^\{\})?", line)
        if match:
            name = match[2].decode("ascii")
            # Annotated tags advertise both the tag object and its peeled commit.
            if name not in refs or match[3]:
                refs[name] = {"name": name, "commit": {"sha": match[1].decode("ascii")}}
    return list(refs.values())


def read_pack_json(path: Path):
    """Bedrock ships JSON with comments/trailing commas; preserve quoted text."""
    text = path.read_text(encoding="utf-8-sig")
    text = re.sub(
        r'"(?:\\.|[^"\\])*"|//[^\r\n]*|/\*[\s\S]*?\*/',
        lambda m: m[0] if m[0].startswith('"') else "",
        text,
    )
    text = re.sub(r'"(?:\\.|[^"\\])*"|,(\s*[}\]])', lambda m: m[1] if m[1] else m[0], text)
    return json.loads(text)


def world_version(tree) -> tuple[int, ...]:
    """The last client to open the world is distinct from its storage format."""
    raw = tree.get("lastOpenedWithVersion")
    if raw is None:
        raise ValueError("level.dat 缺少 lastOpenedWithVersion，无法选择基岩版资源")
    try:
        version = tuple(int(n) for n in raw)
    except (ValueError, TypeError, OverflowError):
        raise ValueError("level.dat 的游戏版本无效") from None
    if len(version) < 3 or version[0] != 1 or any(n < 0 or n > 65535 for n in version):
        raise ValueError("level.dat 的游戏版本无效")
    return version[:4]


def download_bedrock_pack(root: Path, version: tuple[int, ...], read_url) -> Path:
    """Prefer an exact release, otherwise pin the nearest official release."""
    requested = version[:3]

    def cached(target: Path) -> bool:
        marker = target / "source.json"
        try:
            metadata = json.loads(marker.read_text(encoding="utf-8"))
            return (
                isinstance(metadata, dict)
                and metadata.get("release") == target.name
                and (target / "textures/terrain_texture.json").is_file()
                and (target / "blocks.json").is_file()
                and metadata.get("entity_assets") == ENTITY_ASSET_VERSION
            )
        except (OSError, ValueError):
            return False

    def remember(target: Path) -> Path:
        marker = target / "source.json"
        metadata = json.loads(marker.read_text(encoding="utf-8"))
        requests = metadata.setdefault("requested_versions", [])
        if list(requested) not in requests:
            requests.append(list(requested))
            with tempfile.TemporaryDirectory(prefix="metadata-", dir=target.parent) as temporary:
                update = Path(temporary) / "source.json"
                update.write_text(json.dumps(metadata), encoding="utf-8")
                update.replace(marker)
        report("正在读取本地资源包…")
        return target

    target = root / "bedrock" / ".".join(map(str, requested))
    if cached(target):
        return target
    # A previously resolved fallback remains usable offline on later launches.
    for marker in sorted((root / "bedrock").glob("*/source.json")):
        if cached(marker.parent):
            metadata = json.loads(marker.read_text(encoding="utf-8"))
            if list(requested) in metadata.get("requested_versions", []):
                return marker.parent
    report("正在查找匹配的基岩版资源…")
    # Old block-only packs already pin a release. Upgrade that same commit
    # directly instead of resolving tags again (and changing its provenance).
    pinned = None
    for marker in [target / "source.json", *sorted((root / "bedrock").glob("*/source.json"))]:
        try:
            metadata = json.loads(marker.read_text(encoding="utf-8"))
            tag = metadata["tag"]
            commit = metadata["commit"]
            release = metadata["release"]
            if (
                release == marker.parent.name
                and re.fullmatch(r"\d+\.\d+\.\d+", release)
                and re.fullmatch(re.escape("v" + release) + r"(?:\.\d+)?", tag)
                and re.fullmatch(r"[a-f0-9]{40}", commit)
                and (
                    marker.parent == target
                    or list(requested) in metadata.get("requested_versions", [])
                )
            ):
                pinned = {"name": tag, "commit": {"sha": commit}}
                break
        except (OSError, ValueError, KeyError, TypeError):
            continue
    matches = []
    for tag in [pinned] if pinned else release_tags(read_url):
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?", tag["name"])
        if match:
            matches.append((tuple(map(int, match.groups()[:3])), int(match[4] or 0), tag))
    if not matches:
        raise ValueError("Mojang 尚未提供可用的基岩版正式发布资源")

    def distance(item):
        release, build, _ = item
        # Stay in the same major/minor series whenever possible. At equal
        # distance prefer the older release, then its highest resource build.
        return (
            *[abs(a - b) for a, b in zip(release, requested, strict=True)],
            release > requested,
            -build,
        )

    selected, _, tag = min(matches, key=distance)
    release = ".".join(map(str, selected))
    target = root / "bedrock" / release
    if cached(target):
        return remember(target)
    commit = tag["commit"]["sha"]
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("基岩版资源提交标识无效")
    url = f"https://codeload.github.com/Mojang/bedrock-samples/zip/{commit}"
    data = read_url(url, 256 << 20)
    report("正在解压基岩版资源包…")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bedrock-download-", dir=target.parent) as temporary:
        staging = Path(temporary) / "pack"
        staging.mkdir()
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            selected, total = [], 0
            for item in archive.infolist():
                path = PurePosixPath(item.filename)
                if (
                    path.is_absolute()
                    or ".." in path.parts
                    or "\\" in item.orig_filename
                    or "\x00" in item.orig_filename
                    or any(":" in p for p in path.parts)
                ):
                    raise ValueError("基岩版资源归档路径无效")
                if (
                    len(path.parts) < 3
                    or path.parts[1] not in ("resource_pack", "behavior_pack")
                    or item.is_dir()
                ):
                    continue
                relative = PurePosixPath(*path.parts[2:])
                behavior = path.parts[1] == "behavior_pack"
                if behavior:
                    keep = relative.parts[0] == "entities" and relative.suffix == ".json"
                    relative = PurePosixPath("behavior_pack", *relative.parts)
                else:
                    keep = (
                        relative.as_posix() in ("blocks.json", "manifest.json")
                        or (
                            relative.parts[0] == "textures"
                            and relative.suffix in (".png", ".tga", ".json")
                        )
                        or (
                            relative.parts[0]
                            in (
                                "entity",
                                "models",
                                "animations",
                                "render_controllers",
                                "animation_controllers",
                                "materials",
                            )
                            and relative.suffix in (".json", ".material")
                        )
                    )
                if not keep:
                    continue
                total += item.file_size
                if item.file_size > 16 << 20 or total > 512 << 20:
                    raise ValueError("基岩版资源解压超过预算")
                selected.append((item, relative))
            for item, relative in selected:
                destination = staging.joinpath(*relative.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.read(item))
        for required in ("blocks.json", "textures/terrain_texture.json"):
            if not (staging / required).is_file():
                raise ValueError("基岩版资源包不完整")
        (staging / "source.json").write_text(
            json.dumps(
                {
                    "release": release,
                    "tag": tag["name"],
                    "commit": commit,
                    "url": url,
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "requested_versions": [list(requested)],
                    "entity_assets": ENTITY_ASSET_VERSION,
                }
            ),
            encoding="utf-8",
        )
        if target.exists():
            # Upgrade old block-only caches atomically, preserving a usable pack on failure.
            previous = Path(temporary) / "previous"
            target.rename(previous)
            try:
                staging.rename(target)
            except BaseException:
                previous.rename(target)
                raise
        else:
            staging.rename(target)
    return target


class BedrockPrimitives:
    """Own geometry for fluids and aquatic plants, using the Bedrock palette."""

    def __init__(self, pack: Path):
        self.pack = pack
        self.terrain = read_pack_json(pack / "textures/terrain_texture.json")["texture_data"]
        self.paths = {}
        definitions = read_pack_json(pack / "blocks.json")
        cube_names = (
            "stone",
            "dirt",
            "sand",
            "red_sand",
            "gravel",
            "clay",
            "bedrock",
            "netherrack",
            "end_stone",
            "obsidian",
            "crying_obsidian",
            "cobblestone",
            "mossy_cobblestone",
            "granite",
            "diorite",
            "andesite",
            "polished_granite",
            "polished_diorite",
            "polished_andesite",
            "blackstone",
            "cobbled_deepslate",
            "calcite",
            "tuff",
            "sandstone",
            "red_sandstone",
            "soul_sand",
            "soul_soil",
            "magma",
            "gold_block",
            "iron_block",
            "diamond_block",
            "emerald_block",
            "coal_block",
            "netherite_block",
            "coal_ore",
            "iron_ore",
            "gold_ore",
            "diamond_ore",
            "emerald_ore",
            "lapis_ore",
        )
        self.cubes = {
            name: definitions[name]["textures"]
            for name in cube_names
            if isinstance(definitions.get(name), dict) and "textures" in definitions[name]
        }
        keys = {
            "still_water",
            "flowing_water",
            "still_water_grey",
            "flowing_water_grey",
            "still_lava",
            "flowing_lava",
            "seagrass_short",
            "seagrass_tall_bot_a",
            "seagrass_tall_top_a",
            "kelp_a",
            "kelp_top",
        }
        for textures in self.cubes.values():
            keys.update((textures,) if isinstance(textures, str) else textures.values())
        for key in keys:
            entry = self.terrain.get(key, {}).get("textures")
            if isinstance(entry, list):
                entry = entry[0] if entry else None
            if isinstance(entry, dict):
                entry = entry.get("path")
            if not isinstance(entry, str):
                continue
            relative = PurePosixPath(entry)
            if relative.is_absolute() or ".." in relative.parts or "\\" in entry or ":" in entry:
                raise ValueError("基岩版贴图路径无效")
            for suffix in (".png", ".tga"):
                path = pack / (entry + suffix)
                if path.is_file():
                    self.paths[key] = str(path)
                    break

    def model(self, value, bounds, neighbors=()):
        name = value["name"]
        if ":" in name and not name.startswith("minecraft:"):
            return None
        name = name.removeprefix("minecraft:")
        states = value.get("states", {})

        def texture(*keys):
            for key in keys:
                path = self.paths.get(key)
                if path in bounds:
                    return list(bounds[path][:4])
            raise ValueError(f"对应基岩版资源缺少 {name} 贴图")

        if name in self.cubes and not states:
            materials = self.cubes[name]
            parts = []
            quads = (
                ((1, 0, 1), (1, 0, 0), (1, 1, 0), (1, 1, 1)),
                ((0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)),
                ((0, 1, 1), (1, 1, 1), (1, 1, 0), (0, 1, 0)),
                ((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)),
                ((0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)),
                ((1, 0, 0), (0, 0, 0), (0, 1, 0), (1, 1, 0)),
            )
            normals = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
            for side, direction in enumerate(("east", "west", "up", "down", "south", "north")):
                material = (
                    materials
                    if isinstance(materials, str)
                    else materials.get(direction, materials.get("side"))
                )
                u, v, w, h = texture(material)
                uv = ((u, 1 - v - h), (u + w, 1 - v - h), (u + w, 1 - v), (u, 1 - v))
                order = (0, 1, 2, 0, 2, 3)
                parts.append(
                    {
                        "cull": side,
                        "kind": 3,
                        "p": [n for i in order for n in quads[side][i]],
                        "u": [n for i in order for n in uv[i]],
                        "n": list(normals[side]),
                        "c": [[0.6, 0.6, 1.0, 0.5, 0.8, 0.8][side]] * 18,
                    }
                )
            return {
                "name": "minecraft:" + name,
                "solid": True,
                "transparency": 0,
                "ambientOcclusion": True,
                "parts": parts,
            }
        if name in ("water", "flowing_water", "lava", "flowing_lava"):
            water = "water" in name
            return {
                "name": "minecraft:" + ("water" if water else "lava"),
                "solid": False,
                "parts": [],
                "fluid": {
                    "family": "water" if water else "lava",
                    "still": texture("still_water", "still_water_grey")
                    if water
                    else texture("still_lava"),
                    "flow": texture("flowing_water", "flowing_water_grey")
                    if water
                    else texture("flowing_lava"),
                },
            }
        if name not in ("seagrass", "kelp"):
            return None
        if name == "seagrass":
            kind = str(states.get("sea_grass_type", "default"))
            key = {"double_bot": "seagrass_tall_bot_a", "double_top": "seagrass_tall_top_a"}.get(
                kind, "seagrass_short"
            )
        else:
            above = neighbors[2] if len(neighbors) > 2 else None
            key = "kelp_a" if above and above["name"] in ("kelp", "minecraft:kelp") else "kelp_top"
        u, v, w, h = texture(key)
        parts = []
        for corners in (
            ((0, 0, 0), (1, 0, 1), (1, 1, 1), (0, 1, 0)),
            ((1, 0, 0), (0, 0, 1), (0, 1, 1), (1, 1, 0)),
        ):
            order = (0, 1, 2, 0, 2, 3)
            uv = ((u, 1 - v - h), (u + w, 1 - v - h), (u + w, 1 - v), (u, 1 - v))
            parts.append(
                {
                    "cull": 6,
                    "kind": 4,
                    "p": [n for i in order for n in corners[i]],
                    "u": [n for i in order for n in uv[i]],
                    "n": [0, 1, 0],
                    "c": [1.0] * 18,
                }
            )
        return {"name": "minecraft:" + name, "solid": False, "parts": parts}
