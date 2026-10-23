"""Amulet models and immutable vanilla resource generations; never opens a world."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import math
import os
import re
import shutil
import tempfile
import zipfile
from collections import OrderedDict
from pathlib import Path, PurePosixPath
from threading import RLock

from .paths import resource_pack_root
from .resource_network import open_resource as urlopen
from .resource_network import read_resource
from .resource_progress import report

MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
MAX_DOWNLOAD = 256 << 20
MAX_EXPANDED = 512 << 20
MODEL_BUDGET = 64 << 20
SIDES = ("east", "west", "up", "down", "south", "north", None)
OFFSETS = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
log = logging.getLogger(__name__)


def resource_root() -> Path:
    isolated = os.environ.get("BEDROCK_EDITOR_STATE_DIR")
    return (
        Path(isolated) / "render-resources"
        if isolated is not None
        else Path.cwd() / "data/render-resources"
    )


def read_url(url: str, limit: int) -> bytes:
    return read_resource(url, limit, opener=urlopen)


def migrate_resource_cache(root: Path) -> None:
    """Copy valid legacy packs once; publish complete directories only."""
    if os.environ.get("BEDROCK_EDITOR_STATE_DIR") is not None:
        return
    legacy = resource_pack_root() / "minecraft/amulet"
    markers = [*legacy.glob("*/source.json"), *legacy.glob("bedrock/*/source.json")]
    for marker in markers:
        pack = marker.parent
        target = root / pack.relative_to(legacy)
        required = (
            ("blocks.json", "textures/terrain_texture.json")
            if pack.parent.name == "bedrock"
            else ("assets/minecraft/blockstates/stone.json",)
        )
        if target.exists() or not all((pack / name).is_file() for name in required):
            continue
        report("正在迁移已有资源缓存…")
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="migration-", dir=target.parent) as temporary:
            staging = Path(temporary) / "pack"
            shutil.copytree(pack, staging)
            staging.rename(target)


def extract_client(data: bytes, target: Path) -> None:
    """Extract only resource inputs, rejecting traversal and oversized archives."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        selected = []
        total = 0
        for item in archive.infolist():
            path = PurePosixPath(item.filename)
            if (
                path.is_absolute()
                or ".." in path.parts
                or "\\" in item.orig_filename
                or "\x00" in item.orig_filename
                or any(":" in part for part in path.parts)
            ):
                raise ValueError("原版资源归档路径无效")
            keep = item.filename in ("pack.mcmeta", "pack.png") or (
                len(path.parts) >= 4
                and path.parts[0] == "assets"
                and path.parts[2] in ("textures", "models", "blockstates")
                and path.suffix in (".json", ".png", ".mcmeta")
            )
            if item.is_dir() or not keep:
                continue
            total += item.file_size
            if item.file_size > 16 << 20 or total > MAX_EXPANDED:
                raise ValueError("原版资源解压超过预算")
            selected.append(item)
        for item in selected:
            destination = target.joinpath(*PurePosixPath(item.filename).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(item))
    # Modern clients can omit pack.mcmeta or use min/max_format. Amulet 1.x
    # consumes the legacy field; this is metadata for our extracted pack only.
    meta = target / "pack.mcmeta"
    content = json.loads(meta.read_text()) if meta.is_file() else {"pack": {}}
    content["pack"].setdefault("pack_format", 46)
    content["pack"].setdefault("description", "Minecraft vanilla resources")
    meta.write_text(json.dumps(content), encoding="utf-8")
    if not (target / "assets/minecraft/blockstates/stone.json").is_file():
        raise ValueError("原版资源包缺少基础方块模型")


def download_pack(root: Path) -> Path:
    manifest = json.loads(read_url(MANIFEST, 8 << 20))
    version = manifest["latest"]["release"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", version):
        raise ValueError("原版资源版本无效")
    descriptor = next(v for v in manifest["versions"] if v["id"] == version)
    target = root / version
    if (target / "source.json").is_file():
        return target
    spec_bytes = read_url(descriptor["url"], 8 << 20)
    if hashlib.sha1(spec_bytes).hexdigest() != descriptor["sha1"]:
        raise ValueError("原版版本清单校验失败")
    client = json.loads(spec_bytes)["downloads"]["client"]
    if not 0 < client["size"] <= MAX_DOWNLOAD:
        raise ValueError("原版客户端资源大小无效")
    data = read_url(client["url"], client["size"])
    if len(data) != client["size"] or hashlib.sha1(data).hexdigest() != client["sha1"]:
        raise ValueError("原版资源校验失败")
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="download-", dir=root) as temporary:
        staging = Path(temporary) / "pack"
        staging.mkdir()
        report("正在解压模型资源包…")
        extract_client(data, staging)
        (staging / "source.json").write_text(
            json.dumps({"version": version, "url": client["url"], "sha1": client["sha1"]}),
            encoding="utf-8",
        )
        staging.rename(target)
    return target


def build_atlas(paths: tuple[str, ...]):
    """Keep native pixel dimensions, alpha, and first animation frame, as Amulet."""
    from PIL import Image

    images = []
    for path in dict.fromkeys(paths):
        with Image.open(path) as source:
            image = source.convert("RGBA")
        if image.height > image.width and image.height % image.width == 0:
            image = image.crop((0, 0, image.width, image.width))
        if max(image.size) > 1024:
            raise ValueError("单张 3D 贴图超过尺寸预算")
        alpha = image.getchannel("A").getextrema()
        kind = 0 if alpha == (255, 255) else 1
        images.append((path, image, kind))
    images.sort(key=lambda item: (-item[1].height, item[0]))
    area = sum((im.width + 4) * (im.height + 4) for _, im, _ in images)
    width = 2 ** math.ceil(math.log2(max(64, math.sqrt(area) * 1.3)))
    width = max(width, max(im.width + 4 for _, im, _ in images))
    x = y = row = 0
    placements = []
    for path, image, kind in images:
        if x + image.width + 4 > width:
            x, y, row = 0, y + row, 0
        placements.append((path, image, kind, x + 2, y + 2))
        x += image.width + 4
        row = max(row, image.height + 4)
    height = 2 ** math.ceil(math.log2(max(1, y + row)))
    if width > 8192 or height > 8192 or width * height * 4 > 128 << 20:
        raise ValueError("3D 材质图集超过 128 MB 预算")
    atlas = Image.new("RGBA", (width, height))
    bounds = {}
    for path, image, kind, x, y in placements:
        atlas.paste(image, (x, y))
        # Extrude RGBA, including transparent texels. No opaque black backing.
        for dx in (-2, -1, image.width, image.width + 1):
            edge = 0 if dx < 0 else image.width - 1
            atlas.paste(image.crop((edge, 0, edge + 1, image.height)), (x + dx, y))
        for dy in (-2, -1, image.height, image.height + 1):
            edge = 0 if dy < 0 else image.height - 1
            atlas.paste(image.crop((0, edge, image.width, edge + 1)), (x, y + dy))
        bounds[path] = (x / width, y / height, image.width / width, image.height / height, kind)
    buffer = io.BytesIO()
    atlas.save(buffer, format="PNG")
    return buffer.getvalue(), bounds, (width, height)


def index_pack(manager, pack: Path) -> None:
    """Feed Amulet's parser without persisting its transparency/model indexes."""
    from minecraft_model_reader.api.resource_pack.java.resource_pack_manager import (
        UselessImageGroups,
    )

    for namespace in sorted((pack / "assets").glob("*")):
        for image in sorted((namespace / "textures").rglob("*.png")):
            relative = image.relative_to(namespace / "textures")
            if relative.parts[0] not in UselessImageGroups:
                manager._textures[(namespace.name, relative.with_suffix("").as_posix())] = str(
                    image
                )
        for directory, destination in (
            ("blockstates", manager._blockstate_files),
            ("models", manager._model_files),
        ):
            for path in sorted((namespace / directory).rglob("*.json")):
                relative = path.relative_to(namespace / directory).with_suffix("").as_posix()
                destination[(namespace.name, relative)] = json.loads(
                    path.read_text(encoding="utf-8")
                )


class AmuletResources:
    def __init__(self, pack: Path, bedrock_pack: Path | None = None):
        import PyMCTranslate
        from minecraft_model_reader.api.resource_pack.java import (
            JavaResourcePack,
            JavaResourcePackManager,
        )
        from minecraft_model_reader.api.resource_pack.java.download_resources import (
            get_java_vanilla_fix,
        )

        self.lock = RLock()
        self.version = pack.name
        self.native = None
        self.bedrock_version = None
        self.entity_catalog = None
        if bedrock_pack is not None:
            from .bedrock_resources import BedrockPrimitives

            self.native = BedrockPrimitives(bedrock_pack)
            self.bedrock_version = bedrock_pack.name
            self.version = "bedrock-" + bedrock_pack.name + "-java-" + pack.name
        packs = [JavaResourcePack(str(pack)), get_java_vanilla_fix()]
        self.manager = JavaResourcePackManager(packs, load=False)
        self.manager._textures[("minecraft", "missing_no")] = self.manager.missing_no
        for resource in packs:
            if not resource.valid_pack:
                raise ValueError("Amulet 无法识别原版资源包")
            index_pack(self.manager, Path(resource.root_dir))
        self.translator = PyMCTranslate.new_translation_manager()
        self.java = self.translator.get_version("java", (999, 0, 0)).block
        self._translators = {self.java}
        native_paths = tuple(self.native.paths.values()) if self.native else ()
        self.image, self.bounds, self.size = build_atlas(self.manager.textures + native_paths)
        self.manager._texture_is_transparent = {
            path: (0, bool(bound[4])) for path, bound in self.bounds.items()
        }
        self.cache = OrderedDict()
        self.cache_bytes = 0

    def entities(self):
        from .entity_resources import prepare_entities

        with self.lock:
            if self.entity_catalog is None:
                if self.native is None:
                    raise ValueError("未准备基岩版实体资源")
                self.entity_catalog = prepare_entities(self.native.pack)
            return self.entity_catalog

    def source_block(self, value):
        import amulet_nbt as nbt
        from amulet.api.block import Block

        name = value["name"]
        namespace, _, base = name.partition(":")
        if not base:
            namespace, base = "minecraft", namespace
        version = value.get("version")
        version = (
            tuple((version >> shift) & 255 for shift in (24, 16, 8)) if version else (999, 0, 0)
        )
        translator = self.translator.get_version("bedrock", version).block
        try:
            defaults = translator.get_specification(namespace, base).get("defaults", {})
        except KeyError:
            # A palette's NBT format version can predate a newly added block.
            latest = self.translator.get_version("bedrock", (999, 0, 0)).block
            try:
                defaults = latest.get_specification(namespace, base).get("defaults", {})
                translator = latest
            except KeyError:
                defaults = {}
        properties = {}
        types = value.get("stateTypes", {})
        for key, raw in value.get("states", {}).items():
            tag_id = types.get(key)
            if tag_id in (1, 2, 3, 4):
                tag = {1: nbt.ByteTag, 2: nbt.ShortTag, 3: nbt.IntTag, 4: nbt.LongTag}[tag_id]
                properties[key] = tag(int(raw))
            elif tag_id == 8 or isinstance(raw, str):
                properties[key] = nbt.StringTag(str(raw))
            elif str(defaults.get(key, "")).endswith("b"):
                properties[key] = nbt.ByteTag(int(raw))
            else:
                properties[key] = nbt.IntTag(int(raw))
        self._translators.add(translator)
        return Block(namespace, base, properties), translator

    def java_block(self, query):
        import amulet_nbt as nbt
        from amulet.api.block import Block

        source, translator = self.source_block(query["block"])
        source_neighbors = {
            tuple(OFFSETS[i]): self.source_block(b)
            for i, b in enumerate(query.get("neighbors", []))
            if b
        }
        empty = Block("minecraft", "air")

        def get_source(offset):
            return (
                source
                if offset == (0, 0, 0)
                else source_neighbors.get(offset, (empty, translator))[0]
            ), None

        def get_universal(offset):
            b, converter = (
                (source, translator)
                if offset == (0, 0, 0)
                else source_neighbors.get(offset, (empty, translator))
            )

            def relative_neighbor(delta):
                return get_source(tuple(a + b for a, b in zip(offset, delta, strict=True)))

            return converter.to_universal(b, get_block_callback=relative_neighbor)[0], None

        result = self.java.from_universal(
            get_universal((0, 0, 0))[0], get_block_callback=get_universal
        )[0]
        if not isinstance(result, Block):
            return empty
        properties = dict(result.properties)
        neighbors = {}
        for offset in source_neighbors:
            candidate = self.java.from_universal(get_universal(offset)[0])[0]
            if isinstance(candidate, Block):
                neighbors[offset] = candidate
        horizontal = (
            ("east", (1, 0, 0)),
            ("west", (-1, 0, 0)),
            ("south", (0, 0, 1)),
            ("north", (0, 0, -1)),
        )
        name = result.base_name
        if (
            name.endswith("_fence")
            or name in ("glass_pane", "iron_bars")
            or name.endswith("_stained_glass_pane")
        ):
            fence = name.endswith("_fence")
            for direction, offset in horizontal:
                neighbor = neighbors.get(offset, empty)
                other = neighbor.base_name
                full = (
                    other not in ("air", "cave_air", "void_air")
                    and int(self.manager.get_block_model(neighbor).is_transparent) == 0
                )
                connects = full or (
                    (
                        other.endswith("_fence_gate")
                        or (
                            other.endswith("_fence")
                            and (name == "nether_brick_fence") == (other == "nether_brick_fence")
                        )
                    )
                    if fence
                    else (other == "iron_bars" or other.endswith("glass_pane"))
                )
                properties[direction] = nbt.StringTag("true" if connects else "false")
        if name.endswith("_stairs"):
            directions = ("north", "east", "south", "west")
            vectors = {direction: offset for direction, offset in horizontal}
            facing = str(properties.get("facing", nbt.StringTag("north")))
            half = properties.get("half")
            turn = directions.index(facing)

            def matching(block):
                return block.base_name.endswith("_stairs") and block.properties.get("half") == half

            def clear_side(direction):
                candidate = neighbors.get(vectors[direction], empty)
                return not (
                    matching(candidate) and str(candidate.properties.get("facing")) == facing
                )

            shape = "straight"
            for delta, prefix in ((0, "outer"), (2, "inner")):
                candidate = neighbors.get(vectors[directions[(turn + delta) % 4]], empty)
                other_facing = str(candidate.properties.get("facing", ""))
                if matching(candidate) and other_facing in directions:
                    other_turn = directions.index(other_facing)
                    side = directions[(other_turn + (2 if delta == 0 else 0)) % 4]
                    if other_turn % 2 != turn % 2 and clear_side(side):
                        shape = prefix + ("_left" if other_turn == (turn - 1) % 4 else "_right")
                        break
            properties["shape"] = nbt.StringTag(shape)
        result = Block(result.namespace, result.base_name, properties, result.extra_blocks)
        return result

    def model(self, query):
        import numpy as np

        key = json.dumps(query, sort_keys=True, separators=(",", ":"))
        with self.lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key][0]
            if self.native:
                native = self.native.model(query["block"], self.bounds, query.get("neighbors", ()))
                if native is not None:
                    return native
            block = self.java_block(query)
            mesh = self.manager.get_block_model(block)
            parts = []
            for side, face_indices in mesh.faces.items():
                indices = face_indices.reshape(-1, mesh.face_mode)
                positions = mesh.verts[side].reshape(-1, 3)
                uvs = mesh.texture_coords[side].reshape(-1, 2)
                tints = mesh.tint_verts[side].reshape(-1, 3)
                for face, texture_id in zip(indices, mesh.texture_index[side], strict=True):
                    texture = mesh.textures[texture_id]
                    u, v, w, h, kind = self.bounds[texture]
                    # Glass/water blending is distinct from cutout alpha. Preserve
                    # the original texture alpha instead of a global opacity.
                    if kind and re.search(r"(?:glass|ice|water|portal)", block.base_name):
                        kind = 2
                    order = (0, 1, 2, 0, 2, 3) if mesh.face_mode == 4 else (0, 1, 2)
                    face = face[list(order)]
                    p = positions[face]
                    normal = np.cross(p[1] - p[0], p[2] - p[0]).astype(float)
                    length = np.linalg.norm(normal)
                    if not length:
                        continue
                    normal /= length
                    # Classic directional lighting, without artificial height bands.
                    shade = {
                        None: 1,
                        "up": 1,
                        "north": 0.8,
                        "south": 0.8,
                        "east": 0.6,
                        "west": 0.6,
                        "down": 0.5,
                    }[side]
                    colors = tints[face] * shade
                    mapped = [[u + float(a) * w, 1 - (v + float(b) * h)] for a, b in uvs[face]]
                    parts.append(
                        {
                            "cull": SIDES.index(side),
                            "kind": kind + 3,
                            "p": p.ravel().tolist(),
                            "u": np.array(mapped).ravel().tolist(),
                            "n": normal.tolist(),
                            "c": colors.ravel().tolist(),
                        }
                    )
            result = {
                "solid": int(mesh.is_transparent) == 0,
                "transparency": int(mesh.is_transparent),
                "parts": parts,
                "name": block.namespaced_name,
            }
            size = len(json.dumps(result)) * 2
            if size > 2 << 20:
                raise ValueError("单个 Amulet 方块模型超过预算")
            while self.cache and self.cache_bytes + size > MODEL_BUDGET:
                _, (_, old_size) = self.cache.popitem(last=False)
                self.cache_bytes -= old_size
            self.cache[key] = result, size
            self.cache_bytes += size
            # Upstream has a second, otherwise unbounded mesh cache.
            if len(self.manager._cached_models) > 2048:
                self.manager._cached_models.clear()
            for translator in self._translators:
                if sum(map(len, translator._cache.values())) > 2048:
                    for cache in translator._cache.values():
                        cache.clear()
                if len(translator._error_cache) > 2048:
                    translator._error_cache.clear()
            return result


_lock = RLock()
_resources: AmuletResources | None = None


def prepare_resources(version: tuple[int, ...] | None = None) -> AmuletResources:
    global _resources
    with _lock:
        root = resource_root()
        report("正在检查本地资源缓存…")
        migrate_resource_cache(root)
        if version is not None:
            from .bedrock_resources import download_bedrock_pack

            release = ".".join(map(str, version[:3]))
            if _resources is not None and _resources.bedrock_version == release:
                return _resources
            bedrock = download_bedrock_pack(root, version, read_url)
            if _resources is not None and _resources.bedrock_version == bedrock.name:
                return _resources
            # Complex models retain their existing adapter until native equivalents
            # exist. Use its local cache rather than update Java with every world.
            candidates = sorted(
                root.glob("*/source.json"), key=lambda p: p.stat().st_mtime, reverse=True
            )
            java_pack = candidates[0].parent if candidates else download_pack(root)
            report("正在构建材质图集与方块模型…")
            candidate = AmuletResources(java_pack, bedrock)
            candidate.model({"block": {"name": "minecraft:stone", "states": {}}})
            _resources = candidate
            return candidate
        try:
            pack = download_pack(root)
            if _resources is None or _resources.version != pack.name:
                candidate = AmuletResources(pack)
                candidate.model({"block": {"name": "minecraft:stone", "states": {}}})
                _resources = candidate
        except Exception:
            if _resources is not None:
                log.warning("原版资源更新失败，继续使用已有资源", exc_info=True)
                return _resources
            candidates = sorted(
                root.glob("*/source.json"), key=lambda p: p.stat().st_mtime, reverse=True
            )
            if not candidates:
                raise ValueError("无法下载原版 3D 资源，且没有可用缓存") from None
            for marker in candidates:
                try:
                    _resources = AmuletResources(marker.parent)
                    break
                except Exception:
                    log.warning("原版资源缓存不可用：%s", marker.parent.name, exc_info=True)
            if _resources is None:
                raise ValueError("本地原版 3D 资源损坏，请联网重新准备资源") from None
        return _resources
