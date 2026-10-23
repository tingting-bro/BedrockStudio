"""Terrain decoding and staged creation/deletion of coordinate-keyed chunk records."""

from __future__ import annotations

import struct
from base64 import b64decode, b64encode
from bisect import bisect_left, bisect_right
from collections import OrderedDict
from functools import lru_cache
from io import BytesIO
from typing import TYPE_CHECKING, Any

import nbtlib

from . import storage
from .dimension_reset import DimensionReset
from .snapshots import Snapshot, pack, unpack
from .terrain_workers import TerrainDecoder, preview_limit

if TYPE_CHECKING:
    from .players import DatabaseStore

type Coordinate = tuple[int, int, int]
CHUNK_TAGS = frozenset(range(0x2B, 0x41)) | {0x76}
AIR = {"air", "cave_air", "void_air", "structure_void"}
COLORS = {
    "grass_block": (104, 153, 63),
    "grass": (104, 153, 63),
    "water": (48, 105, 175),
    "flowing_water": (48, 105, 175),
    "lava": (235, 107, 28),
    "flowing_lava": (235, 107, 28),
    "sand": (216, 204, 143),
    "red_sand": (187, 105, 49),
    "dirt": (137, 99, 65),
    "coarse_dirt": (119, 85, 57),
    "stone": (128, 130, 125),
    "bedrock": (82, 83, 83),
    "deepslate": (75, 77, 79),
    "gravel": (143, 135, 125),
    "snow": (231, 240, 242),
    "snow_layer": (231, 240, 242),
    "snow_block": (231, 240, 242),
    "ice": (145, 191, 220),
    "packed_ice": (131, 176, 221),
    "netherrack": (121, 55, 52),
    "soul_sand": (104, 81, 65),
    "soul_soil": (87, 67, 54),
    "end_stone": (215, 220, 159),
    "obsidian": (48, 39, 63),
    "clay": (150, 164, 178),
    "mud": (70, 65, 61),
}


def chunk_key(raw: bytes) -> tuple[Coordinate, int, int | None] | None:
    """Accept only exact Bedrock chunk key layouts, never named or entity keys."""
    if len(raw) not in (9, 10, 13, 14):
        return None
    # Custom int32 dimension IDs must not make printable named NBT keys look like chunks.
    try:
        name = raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    else:
        if not any(ord(char) < 32 or ord(char) == 127 for char in name):
            return None
    offset = 8 if len(raw) in (9, 10) else 12
    x, z = struct.unpack_from("<ii", raw)
    dimension = 0 if offset == 8 else struct.unpack_from("<i", raw, 8)[0]
    tag = raw[offset]
    if tag not in CHUNK_TAGS:
        return None
    has_index = len(raw) == offset + 2
    if has_index != (tag == 0x2F):
        return None
    return (dimension, x, z), tag, struct.unpack("b", raw[-1:])[0] if has_index else None


@lru_cache(maxsize=4096)
def block_color(name: str) -> tuple[int, int, int]:
    name = name.removeprefix("minecraft:")
    if name in COLORS:
        return COLORS[name]
    if "leaves" in name:
        return (61, 115, 43)
    if any(part in name for part in ("grass", "moss", "fern", "vine")):
        return (100, 145, 61)
    if "log" in name or "wood" in name or "planks" in name:
        return (143, 111, 67)
    if "sandstone" in name:
        return COLORS["sand"]
    if "terracotta" in name:
        return (171, 104, 75)
    if "basalt" in name or "blackstone" in name:
        return (62, 60, 65)
    if "warped" in name:
        return (45, 135, 129)
    if "crimson" in name:
        return (136, 47, 62)
    # Unknown names remain visible, without pretending to have a texture/color registry.
    return (155, 139, 163)


def _exact(stream: BytesIO, size: int) -> bytes:
    result = stream.read(size)
    if len(result) != size:
        raise ValueError("子区块数据不完整")
    return result


def _palette(stream: BytesIO) -> list[str]:
    header = _exact(stream, 1)[0]
    bits = header >> 1
    if header & 1 or bits not in (0, 1, 2, 3, 4, 5, 6, 8, 16):
        raise ValueError("不支持的子区块调色板格式")
    per_word = 32 // bits if bits else 0
    words = (
        struct.unpack(
            f"<{(4096 + per_word - 1) // per_word}I",
            _exact(stream, ((4096 + per_word - 1) // per_word) * 4),
        )
        if bits
        else ()
    )
    # Zero-bit storage can encode the singleton directly, without a palette count.
    marker = stream.read(1)
    stream.seek(-len(marker), 1)
    count = 1 if bits == 0 and marker == b"\x0a" else struct.unpack("<i", _exact(stream, 4))[0]
    if not 1 <= count <= 4096:
        raise ValueError("子区块调色板大小无效")
    palette = []
    for _ in range(count):
        start = stream.tell()
        try:
            tree = nbtlib.File.parse(stream, byteorder="little")
            encoded = BytesIO()
            tree.write(encoded, byteorder="little")
        except Exception as exc:
            raise ValueError("子区块方块 NBT 无法读取") from exc
        if encoded.getvalue() != stream.getbuffer()[start : stream.tell()]:
            raise ValueError("子区块方块 NBT 不完整或包含不支持的扩展数据")
        name = tree.get("name")
        if not isinstance(name, nbtlib.String):
            raise ValueError("子区块方块名称无效")
        palette.append(str(name).removeprefix("minecraft:"))
    if not bits:
        return [palette[0]] * 4096
    indices = [
        (words[i // per_word] >> ((i % per_word) * bits)) & ((1 << bits) - 1) if bits else 0
        for i in range(4096)
    ]
    if any(index >= count for index in indices):
        raise ValueError("子区块调色板索引越界")
    return [palette[index] for index in indices]


def _subchunk_layers(raw: bytes, index: int) -> list[list[str]]:
    stream = BytesIO(raw)
    version = _exact(stream, 1)[0]
    if version not in (8, 9):
        raise ValueError(f"暂不支持版本 {version} 的子区块预览；仍可选择并删除区块")
    count = _exact(stream, 1)[0]
    if not 0 <= count <= 2:
        raise ValueError("子区块存储层数量无效")
    if version == 9:
        stored_index = struct.unpack("b", _exact(stream, 1))[0]
        if stored_index != index:
            raise ValueError("子区块高度与数据库键不一致")
    layers = [_palette(stream) for _ in range(count)]
    if stream.read(1):
        raise ValueError("子区块含无法识别的尾随数据")
    return layers


def decode_subchunk(raw: bytes, index: int) -> tuple[int, list[str]]:
    layers = _subchunk_layers(raw, index)
    blocks = layers[0] if layers else ["air"] * 4096
    if len(layers) == 2:
        blocks = [layers[1][i] if block in AIR else block for i, block in enumerate(blocks)]
    return index, blocks


def terrain_tile(records: dict[str, bytes], ceiling: int, layer: str) -> bytes:
    surfaces: list[str | None] = [None] * 256
    heights = [-2048] * 256
    found = False
    subchunks = []
    for key, raw in records.items():
        decoded = chunk_key(bytes.fromhex(key))
        if decoded is None or decoded[1] != 0x2F:
            continue
        index = decoded[2]
        assert index is not None
        if index * 16 > ceiling:
            continue
        subchunks.append((index, raw))
    for index, raw in sorted(subchunks, reverse=True):
        _, blocks = decode_subchunk(raw, index)
        found = True
        for x in range(16):
            for z in range(16):
                pixel = z * 16 + x
                if surfaces[pixel] is not None:
                    continue
                for y in range(min(15, ceiling - index * 16), -1, -1):
                    block = blocks[x * 256 + z * 16 + y]
                    height = index * 16 + y
                    if block not in AIR and height > heights[pixel]:
                        surfaces[pixel], heights[pixel] = block, height
                        break
        if all(block is not None for block in surfaces):
            break
    if not found:
        raise ValueError("此区块没有可读取的现代子区块地形")
    pixels = bytearray(1024)
    for i, block in enumerate(surfaces):
        if block is None:
            continue
        color = block_color(block)
        if layer == "height":
            tone = max(35, min(235, 70 + (heights[i] + 64) * 0.4))
            color = (int(tone), int(tone), int(tone))
        else:
            neighbor = heights[i - 16] if i >= 16 and surfaces[i - 16] else heights[i]
            shade = max(0.72, min(1.18, 0.94 + (heights[i] - neighbor) * 0.035))
            color = tuple(min(255, int(channel * shade)) for channel in color)
        pixels[i * 4 : i * 4 + 4] = bytes((*color, 255))
    return bytes(pixels)


def terrain_kind(records: dict[str, bytes]) -> str:
    """Classify the entire stored height, independently of the viewport ceiling."""
    sections = [(chunk_key(bytes.fromhex(key)), raw) for key, raw in records.items()]
    if any(parsed and parsed[1] == 0x30 for parsed, _ in sections):
        return "unreadable"
    found, occupied = False, False
    for parsed, raw in sections:
        if parsed is None or parsed[1] != 0x2F:
            continue
        try:
            layers = _subchunk_layers(raw, parsed[2])
        except ValueError:
            return "unreadable"
        found = True
        occupied |= any(
            block not in ("air", "cave_air", "void_air") for blocks in layers for block in blocks
        )
    return ("terrain" if occupied else "air") if found else "unreadable"


@lru_cache(maxsize=8192)
def terrain_mip(rgba: bytes, resolution: int) -> bytes:
    """Box-filter one real chunk only; preserve partial coverage with premultiplied alpha."""
    if resolution not in (1, 2, 4, 8, 16) or len(rgba) != 1024:
        raise ValueError("地图缩略图尺寸或像素数据无效")
    if resolution == 16:
        return rgba
    step = 16 // resolution
    result = bytearray(resolution * resolution * 4)
    for z in range(resolution):
        for x in range(resolution):
            alpha = red = green = blue = 0
            for dz in range(step):
                for dx in range(step):
                    offset = ((z * step + dz) * 16 + x * step + dx) * 4
                    weight = rgba[offset + 3]
                    alpha += weight
                    red += rgba[offset] * weight
                    green += rgba[offset + 1] * weight
                    blue += rgba[offset + 2] * weight
            offset = (z * resolution + x) * 4
            if alpha:
                result[offset : offset + 4] = bytes(
                    (
                        (red + alpha // 2) // alpha,
                        (green + alpha // 2) // alpha,
                        (blue + alpha // 2) // alpha,
                        (alpha + step * step // 2) // (step * step),
                    )
                )
    return bytes(result)


def cleared_terrain(records: dict[str, bytes]) -> dict[str, bytes | None]:
    """Replace modern terrain with air; preserve entities, biomes and unknown records."""
    if terrain_kind(records) == "unreadable":
        raise ValueError("选区包含无法完整解析的地形，不能清空方块；可改用删除区块")
    writes: dict[str, bytes | None] = {}
    for key, raw in records.items():
        parsed = chunk_key(bytes.fromhex(key))
        assert parsed is not None
        _, tag, index = parsed
        if tag == 0x2F:
            replacement = bytes([raw[0], 0]) + (struct.pack("b", index) if raw[0] == 9 else b"")
            if replacement != raw:
                writes[key] = replacement
        elif tag in (0x31, 0x33, 0x34, 0x3A, 0x3B):
            # Block entities, scheduled/random ticks, legacy extra blocks and stale checksums.
            writes[key] = None
        elif tag in (0x2B, 0x2D, 0x2E):
            if len(raw) < 512:
                raise ValueError("区块高度图不完整，已取消清空方块")
            replacement = bytes(512) + raw[512:]
            if replacement != raw:
                writes[key] = replacement
    return writes


def air_chunk(coordinate: Coordinate, min_y: int, max_y: int) -> dict[str, bytes]:
    """Build finalized empty terrain without changing session state."""
    dimension, x, z = coordinate
    if not (-(2**31) <= x < 2**31 and -(2**31) <= z < 2**31):
        raise ValueError("区块坐标无效")
    biome = {0: 1, 1: 8, 2: 9}.get(dimension, 1)
    prefix = struct.pack("<ii", x, z)
    if dimension:
        prefix += struct.pack("<i", dimension)
    records = {
        (prefix + b"\x2c").hex(): b"\x29",
        (prefix + b"\x36").hex(): struct.pack("<i", 2),
        (prefix + b"\x2b").hex(): bytes(512)
        + (b"\x01" + struct.pack("<I", biome)) * ((max_y - min_y + 1) // 16),
    }
    for index in range(min_y // 16, max_y // 16 + 1):
        records[(prefix + b"\x2f" + struct.pack("b", index)).hex()] = b"\x09\x00" + struct.pack(
            "b", index
        )
    if any(chunk_key(bytes.fromhex(key)) is None for key in records):
        raise ValueError("坐标编码与命名记录冲突，不支持在该位置新增区块")
    return records


class ChunkEditor:
    """Keep indexes, preview caches and unsaved chunk changes in this session."""

    def __init__(self, store: DatabaseStore) -> None:
        self.store = store
        self._indices: dict[int, set[tuple[int, int]]] = {}
        self._ordered: dict[int, list[tuple[int, int]]] = {}
        self._indexed = False
        self._terrain_buckets: dict[int, dict[tuple[int, int], list[tuple[int, int]]]] = {}
        self._terrain_queries: OrderedDict[
            tuple[int, tuple[int, int, int, int], int], list[tuple[int, int]]
        ] = OrderedDict()
        self._terrain_query_size = 0
        self._tiles: OrderedDict[tuple[int, int, int, int, str], dict[str, Any]] = OrderedDict()
        self._tile_limit = preview_limit()
        self._decoder = TerrainDecoder()
        self.pending: dict[Coordinate, dict[str, Snapshot]] = {}
        self.created: dict[Coordinate, dict[str, bytes]] = {}
        self.cleared: dict[Coordinate, dict[str, Snapshot]] = {}
        self.replacements: dict[Coordinate, dict[str, bytes | None]] = {}
        self.reset: DimensionReset | None = None
        self.voxel_history: list[Any] = []
        self.voxel_index = 0
        self.clipboard = None
        self.actor_records: dict[str, tuple[Snapshot | None, Snapshot | None]] = {}

    def reset_voxel_history(self) -> None:
        self.voxel_history.clear()
        self.voxel_index = 0

    def edit_voxels(
        self,
        dimension: int,
        low: tuple[int, int, int],
        high: tuple[int, int, int],
        name: str,
        match: str | None,
        budget: int,
        sphere: tuple[int, int, int, int] | None = None,
        states: str | None = None,
        hollow: bool = False,
        clipboard: Any = None,
        chunk_mask=None,
    ) -> bool:
        from .voxels import (
            Change,
            apply_state,
            cell_inside,
            effective,
            prepare_edit,
            snapshot,
            state_bytes,
            validate_chunk_mask,
        )

        if self.reset:
            raise ValueError("请先保存或还原维度重置")
        if any(a > b for a, b in zip(low, high, strict=True)) or not (
            -2048 <= low[1] <= high[1] <= 2047
        ):
            raise ValueError("方块选区范围无效")
        if (high[0] // 16 - low[0] // 16 + 1) * (high[2] // 16 - low[2] // 16 + 1) > 1_000_000:
            raise ValueError("选区超过世界索引的 100 万区块保护范围")
        chunk_mask = validate_chunk_mask(chunk_mask, low, high, sphere, hollow)
        coords = [
            (dimension, x, z)
            for x in range(low[0] // 16, high[0] // 16 + 1)
            for z in range(low[2] // 16, high[2] // 16 + 1)
            if (chunk_mask is None or (x, z) in chunk_mask)
            and (
                sphere is None
                or cell_inside(
                    max(x * 16, min(sphere[0], x * 16 + 15)),
                    max(low[1], min(sphere[1], high[1])),
                    max(z * 16, min(sphere[2], z * 16 + 15)),
                    sphere,
                )
            )
        ]
        before = snapshot(self, coords)
        after = dict(before)
        retained = self.retained_bytes
        additions = 0
        for c in coords:
            if clipboard is not None and not clipboard.intersects(
                (c[1] * 16, low[1], c[2] * 16),
                (c[1] * 16 + 15, high[1], c[2] * 16 + 15),
            ):
                continue
            if c in self.pending:
                if getattr(clipboard, "clearing", False):
                    continue
                raise ValueError("选区包含暂存删除的区块")
            source = {} if c in self.created else self.read(c)
            records = effective(self, c, source)
            missing = not records
            if missing and getattr(clipboard, "clearing", False):
                continue
            if missing:
                min_y, max_y = {0: (-64, 319), 1: (0, 127), 2: (0, 255)}.get(
                    dimension, (low[1] // 16 * 16, high[1] // 16 * 16 + 15)
                )
                records = air_chunk(c, min_y, max_y)
                additions += 1
            if c in self.cleared and source != {k: unpack(v) for k, v in self.cleared[c].items()}:
                raise ValueError("区块已被外部程序修改")
            writes = prepare_edit(
                records,
                c,
                (max(low[0], c[1] * 16), low[1], max(low[2], c[2] * 16)),
                (min(high[0], c[1] * 16 + 15), high[1], min(high[2], c[2] * 16 + 15)),
                name,
                match,
                sphere,
                states,
                hollow,
                (low, high),
                clipboard,
                chunk_mask,
            )
            if not writes and not missing:
                continue
            if c in self.created or missing:
                updated = {**records, **writes}
                after[c] = (None, None, {k: pack(v) for k, v in updated.items() if v is not None})
            else:
                original = before[c][0] or {k: pack(v) for k, v in source.items()}
                merged = {**self.replacements.get(c, {}), **writes}
                after[c] = (
                    original,
                    {k: pack(v) if v is not None else None for k, v in merged.items()},
                    None,
                )
            retained += state_bytes(after[c]) - state_bytes(before[c])
            if retained > budget:
                raise ValueError("方块编辑超过共享 64 MB 预算，整批已取消")
        actors_before = dict(self.actor_records)
        actors_after = actors_before
        from .voxels import actor_bytes

        if clipboard is not None:
            from .clipboard_actors import prepare

            actors_after = prepare(
                self, clipboard, dimension, budget - retained + actor_bytes(actors_before)
            )

        retained += actor_bytes(actors_after) - actor_bytes(actors_before)
        if before == after and actors_before == actors_after:
            return False
        change = Change(before, after, actors_before, actors_after)
        history = self.voxel_history[: self.voxel_index][-49:]
        if retained + change.size > budget:
            raise ValueError("方块编辑及撤销快照超过共享 64 MB 预算，整批已取消")
        if additions:
            self.index(dimension)
            if sum(map(len, self._indices.values())) + additions > 1_000_000:
                raise ValueError("新增后区块索引超过 100 万个上限")
        apply_state(self, after)
        self.actor_records = actors_after
        self.voxel_history = history + [change]
        self.voxel_index = len(self.voxel_history)
        return True

    def move_voxels(self, dimension: int, paste: Any, budget: int) -> bool:
        """Preflight source clearing and destination paste privately; publish one undo step."""
        from copy import copy

        from .voxel_clipboard import EraseSelection, source_fingerprint
        from .voxels import Change, apply_state, effective, snapshot

        if paste.clipboard.actors:
            raise ValueError("移动方块选区不移动独立实体，请取消复制实体后重试")
        for coordinate, fingerprint in paste.clipboard.source_fingerprints.items():
            if source_fingerprint(effective(self, coordinate)) != fingerprint:
                raise ValueError("移动源区块已被外部程序修改，请重新剪切选区")
        trial = copy(self)
        for name in ("pending", "created", "cleared", "replacements", "actor_records"):
            setattr(trial, name, dict(getattr(self, name)))
        trial._indices = {d: set(points) for d, points in self._indices.items()}
        trial._ordered = dict(self._ordered)
        trial._tiles = OrderedDict()
        trial._terrain_buckets = {}
        trial._terrain_queries = OrderedDict()
        trial._terrain_query_size = 0
        # Each stage includes the original retained history in its budget check.
        trial.voxel_history = list(self.voxel_history)
        source = paste.clipboard
        erase = EraseSelection(source, source.low)
        changed = trial.edit_voxels(
            dimension, source.low, source.high, "air", None, budget, clipboard=erase
        )
        coordinates = set(trial.voxel_history[-1].after) if changed else set()
        # Temporary source state is still counted, but is not retained as another undo step.
        trial.voxel_history = list(self.voxel_history)
        trial.voxel_index = self.voxel_index
        pasted = trial.edit_voxels(dimension, *paste.bounds, "air", None, budget, clipboard=paste)
        if pasted:
            coordinates.update(trial.voxel_history[-1].after)
        before = snapshot(self, list(coordinates))
        after = snapshot(trial, list(coordinates))
        if before == after:
            return False
        change = Change(before, after, dict(self.actor_records), dict(trial.actor_records))
        history = self.voxel_history[: self.voxel_index][-49:] + [change]
        trial.voxel_history = history
        if trial.retained_bytes > budget:
            raise ValueError("移动选区及撤销快照超过共享 64 MB 预算，整批已取消")
        apply_state(self, after)
        self.actor_records = trial.actor_records
        self.voxel_history = history
        self.voxel_index = len(history)
        return True

    def map_operation(self, coordinates: list, budget: int, operation: Any) -> Any:
        from .voxels import MapChange, map_snapshot

        coordinates = list(
            set(coordinates) | self.cleared.keys() | self.created.keys() | self.replacements.keys()
        )
        self.index(0)
        before = map_snapshot(self, coordinates)
        original_indices = {dimension: set(points) for dimension, points in self._indices.items()}
        history, index = list(self.voxel_history), self.voxel_index
        try:
            result = operation()
            after = map_snapshot(self, coordinates)
            self.voxel_history, self.voxel_index = history, index
            if before == after:
                return result
            change = MapChange(before, after)
            self.voxel_history = history[:index][-49:] + [change]
            if self.retained_bytes > budget:
                raise ValueError("地图操作及撤销快照超过共享 64 MB 预算，整批已取消")
            self.voxel_index = len(self.voxel_history)
            return result
        except Exception:
            self.voxel_history, self.voxel_index = history, index
            before.restore(self, original_indices)
            raise

    def travel_voxels(self, step: int, budget: int) -> None:
        from .voxels import MapChange, actor_bytes, apply_state, snapshot, state_bytes

        target = self.voxel_index + step
        if step not in (-1, 1) or not 0 <= target <= len(self.voxel_history):
            raise ValueError("没有可撤销或重做的方块操作")
        change = self.voxel_history[target if step == -1 else self.voxel_index]
        state = change.before if step == -1 else change.after
        if isinstance(change, MapChange):
            retained = (
                sum(c.size for c in self.voxel_history)
                + state.active_bytes
                + (self.clipboard.budget_size if self.clipboard else 0)
            )
            if retained > budget:
                raise ValueError("恢复地图状态超过共享内存预算")
            state.restore(self)
            self.voxel_index = target
            return
        current = snapshot(self, list(state))
        actors = change.actors_before if step == -1 else change.actors_after
        retained = (
            self.retained_bytes
            + sum(state_bytes(parts) for parts in state.values())
            - sum(state_bytes(parts) for parts in current.values())
            + actor_bytes(actors)
            - actor_bytes(self.actor_records)
        )
        if retained > budget:
            raise ValueError("恢复方块状态超过共享内存预算")
        apply_state(self, state)
        self.actor_records = dict(actors)
        self.voxel_index = target

    def close(self) -> None:
        self.clipboard = None
        self._decoder.close()
        self._tiles.clear()

    def _invalidate_terrain_index(self) -> None:
        self._terrain_buckets.clear()
        self._terrain_queries.clear()
        self._terrain_query_size = 0

    @property
    def dirty(self) -> bool:
        return bool(
            self.pending or self.created or self.cleared or self.reset or self.actor_records
        )

    @property
    def pending_count(self) -> int:
        return (
            len(self.pending)
            + len(self.created)
            + len(self.cleared)
            + (1 if self.reset else 0)
            + sum(bytes.fromhex(key).startswith(b"actorprefix") for key in self.actor_records)
        )

    @property
    def retained_bytes(self) -> int:
        from .voxels import actor_bytes

        return (
            actor_bytes(self.actor_records)
            + (self.clipboard.budget_size if self.clipboard else 0)
            + sum(change.size for change in self.voxel_history)
            + (self.reset.retained_bytes if self.reset else 0)
            + sum(len(raw) for records in self.pending.values() for raw in records.values())
            + sum(len(raw) for records in self.created.values() for raw in records.values())
            + sum(len(raw) for records in self.cleared.values() for raw in records.values())
            + sum(
                len(raw)
                for records in self.replacements.values()
                for raw in records.values()
                if raw is not None
            )
        )

    def selection(
        self,
        dimension: int,
        bounds: tuple[int, int, int, int],
        kinds: set[str],
        shape: str = "rectangle",
        cursor: int = 0,
        page_size: int = 512,
    ) -> dict[str, Any]:
        min_x, max_x, min_z, max_z = bounds
        if not (-(2**31) <= min_x <= max_x < 2**31 and -(2**31) <= min_z <= max_z < 2**31):
            raise ValueError("选区坐标范围无效")
        if not kinds <= {"terrain", "air", "unreadable", "missing"} or shape not in (
            "rectangle",
            "circle",
        ):
            raise ValueError("选区类型无效")
        if shape == "circle" and max_x - min_x != max_z - min_z:
            raise ValueError("圆形选区须使用正方形边界")
        if cursor < 0 or not 1 <= page_size <= 4096:
            raise ValueError("选区分页无效")
        if page_size > 512 and not {"terrain", "air", "unreadable"} <= kinds:
            raise ValueError("需要读取地形分类时，每页最多 512 个候选")
        if not kinds:
            return {"items": [], "next_cursor": None}
        known = self.index(dimension)
        width, depth = max_x - min_x + 1, max_z - min_z + 1
        if "missing" in kinds:
            if width * depth > 1000000:
                raise ValueError("包含未生成位置的选区超过 100 万个网格，请缩小范围")
            total = width * depth
            candidates = (
                (min_x + i // depth, min_z + i % depth)
                for i in range(cursor, min(total, cursor + page_size))
            )
            end = min(total, cursor + page_size)
        else:
            if dimension not in self._ordered:
                self._ordered[dimension] = sorted(known)
            ordered = self._ordered[dimension]
            first = bisect_left(ordered, (min_x, -(2**31)))
            total = bisect_right(ordered, (max_x, 2**31)) - first
            end = min(total, cursor + page_size)
            candidates = iter(ordered[first + cursor : first + end])
        items = []
        for x, z in candidates:
            if not min_z <= z <= max_z or (dimension, x, z) in self.pending:
                continue
            if (
                shape == "circle"
                and (2 * x - min_x - max_x) ** 2 + (2 * z - min_z - max_z) ** 2 > width**2
            ):
                continue
            coordinate = dimension, x, z
            if (x, z) not in known:
                kind = "missing"
            elif not kinds & {"terrain", "air", "unreadable"}:
                continue
            elif {"terrain", "air", "unreadable"} <= kinds:
                kind = "terrain"  # All existing types enabled: use keys only.
            elif coordinate in self.created or coordinate in self.cleared:
                from .voxels import effective

                kind = terrain_kind(effective(self, coordinate))
            else:
                kind = terrain_kind(self.read(coordinate))
            if kind in kinds:
                items.append({"x": x, "z": z})
        return {"items": items, "next_cursor": end if end < total else None}

    def index(self, dimension: int) -> set[tuple[int, int]]:
        if not -(2**31) <= dimension < 2**31:
            raise ValueError("维度无效")
        if not self._indexed:
            indices: dict[int, set[tuple[int, int]]] = {}
            for item in self.store.request("chunks"):
                indices.setdefault(item["dimension"], set()).add((item["x"], item["z"]))
            self._indices = indices
            self._indexed = True
        return self._indices.setdefault(dimension, set())

    def dimensions(self) -> list[int]:
        self.index(0)
        return sorted({0, 1, 2} | self._indices.keys())

    def region(
        self,
        dimension: int,
        min_x: int,
        max_x: int,
        min_z: int,
        max_z: int,
        *,
        step: int = 1,
        limit: int = 1024,
        selection: bool = False,
        empty: bool = False,
    ) -> dict[str, Any]:
        """Query existing coordinates, never iterate every cell in a huge empty rectangle."""
        coords = self.index(dimension)
        if empty:
            if (max_x - min_x + 1) * (max_z - min_z + 1) > 1000000:
                raise ValueError("空白选区超过 100 万个网格，无法在内存中展开，请缩小空白范围")
            return {
                "items": [
                    {"x": x, "z": z}
                    for x in range(min_x, max_x + 1)
                    for z in range(min_z, max_z + 1)
                    if (x, z) not in coords
                ],
                "truncated": False,
            }
        if dimension not in self._ordered:
            self._ordered[dimension] = sorted(coords)
        ordered = self._ordered[dimension]
        start = bisect_left(ordered, (min_x, -(2**31)))
        end = bisect_right(ordered, (max_x, 2**31))
        items: dict[tuple[int, int], dict[str, Any]] = {}

        def result(truncated: bool) -> dict[str, Any]:
            values = list(items.values())
            if step == 1:
                values = [{"x": item["x"], "z": item["z"]} for item in values]
            return {"items": values, "truncated": truncated}

        for i in range(start, end):
            x, z = ordered[i]
            if not min_z <= z <= max_z:
                continue
            if selection and (dimension, x, z) in self.pending:
                continue
            cell = x // step * step, z // step * step
            if cell not in items:
                if not selection and len(items) >= limit:
                    return result(True)
                items[cell] = {
                    "x": cell[0],
                    "z": cell[1],
                    "span": step,
                    "count": 0,
                    "sample": {"x": x, "z": z},
                }
            items[cell]["count"] += 1
        return result(False)

    def terrain_page(
        self,
        dimension: int,
        bounds: tuple[int, int, int, int],
        cursor: int = 0,
        page_size: int = 512,
        span: int = 1,
    ) -> dict[str, Any]:
        """Page real coordinates, or one deterministic existing sample per display group."""
        min_x, max_x, min_z, max_z = bounds
        if not (-(2**31) <= min_x <= max_x < 2**31 and -(2**31) <= min_z <= max_z < 2**31):
            raise ValueError("地图坐标范围无效")
        if cursor < 0 or not 1 <= page_size <= 512 or not 1 <= span <= 2**32:
            raise ValueError("地图分页无效")
        known = self.index(dimension)
        query = dimension, bounds, span
        if query not in self._terrain_queries:
            if dimension not in self._terrain_buckets:
                buckets: dict[tuple[int, int], list[tuple[int, int]]] = {}
                for x, z in known:
                    buckets.setdefault((x // 32, z // 32), []).append((x, z))
                self._terrain_buckets[dimension] = buckets
            buckets = self._terrain_buckets[dimension]
            bx0, bx1, bz0, bz1 = min_x // 32, max_x // 32, min_z // 32, max_z // 32
            # Small windows query spatial buckets directly; huge sparse views scan only existing buckets.
            cells = (
                ((x, z) for x in range(bx0, bx1 + 1) for z in range(bz0, bz1 + 1))
                if (bx1 - bx0 + 1) * (bz1 - bz0 + 1) <= len(buckets)
                else ((x, z) for x, z in buckets if bx0 <= x <= bx1 and bz0 <= z <= bz1)
            )
            coords = sorted(
                (x, z)
                for cell in cells
                for x, z in buckets.get(cell, ())
                if min_x <= x <= max_x and min_z <= z <= max_z
            )
            if span > 1:
                # Choose from the key index only: never read unsampled member terrain.
                # Sorted order makes the first existing coordinate stable for every group.
                samples: dict[tuple[int, int], tuple[int, int]] = {}
                for x, z in coords:
                    samples.setdefault((x // span, z // span), (x, z))
                coords = list(samples.values())
            self._terrain_queries[query] = coords
            self._terrain_query_size += len(coords)
            while len(self._terrain_queries) > 256 or self._terrain_query_size > 1000000:
                _, removed = self._terrain_queries.popitem(last=False)
                self._terrain_query_size -= len(removed)
        self._terrain_queries.move_to_end(query)
        coords = self._terrain_queries[query]
        end = min(len(coords), cursor + page_size)
        return {
            "items": [{"x": x, "z": z} for x, z in coords[cursor:end]],
            "next_cursor": end if end < len(coords) else None,
        }

    def summary(self, dimension: int) -> dict[str, Any]:
        coords = self.index(dimension)
        return {
            "dimension": dimension,
            "total": len(coords),
            "focus": (
                dict(zip(("x", "z"), min(coords, key=lambda p: p[0] ** 2 + p[1] ** 2), strict=True))
                if coords
                else None
            ),
            "bounds": (
                {
                    "min_x": min(x for x, _ in coords),
                    "max_x": max(x for x, _ in coords),
                    "min_z": min(z for _, z in coords),
                    "max_z": max(z for _, z in coords),
                }
                if coords
                else None
            ),
            "pending": [{"dimension": d, "x": x, "z": z} for d, x, z in self.pending],
            "created": [{"dimension": d, "x": x, "z": z} for d, x, z in self.created],
            "cleared": [{"dimension": d, "x": x, "z": z} for d, x, z in self.cleared],
            "reset": self.reset.summary if self.reset else None,
        }

    def read(self, coordinate: Coordinate) -> dict[str, bytes]:
        result = self.store.request(
            "chunk", dimension=coordinate[0], x=coordinate[1], z=coordinate[2]
        )
        records = {item["key"]: b64decode(item["value"], validate=True) for item in result}
        if any(
            chunk_key(bytes.fromhex(key)) is None
            or chunk_key(bytes.fromhex(key))[0] != coordinate
            or len(raw) > storage.MAX_FILE_SIZE
            for key, raw in records.items()
        ):
            raise ValueError("区块记录无效，已取消操作")
        return records

    def stage(self, dimension: int, coords: list[tuple[int, int]], budget: int) -> None:
        if self.reset:
            raise ValueError("请先保存或还原维度重置")
        if not coords or len(set(coords)) != len(coords):
            raise ValueError("请选择不重复的区块")
        known = self.index(dimension)
        prepared = {}
        retained = self.retained_bytes - sum(
            len(raw) for x, z in coords for raw in self.created.get((dimension, x, z), {}).values()
        )
        retained -= sum(
            len(raw) for x, z in coords for raw in self.cleared.get((dimension, x, z), {}).values()
        ) + sum(
            len(raw)
            for x, z in coords
            for raw in self.replacements.get((dimension, x, z), {}).values()
            if raw is not None
        )
        for x, z in coords:
            coordinate = dimension, x, z
            if (x, z) not in known or coordinate in self.pending:
                raise ValueError("选中的区块不存在或已暂存删除")
            if coordinate in self.created:
                continue
            records = self.read(coordinate)
            if not records:
                raise ValueError("区块已被其他程序删除，请重新打开存档")
            if coordinate in self.cleared and records != {
                key: unpack(raw) for key, raw in self.cleared[coordinate].items()
            }:
                raise ValueError("区块已被其他程序修改，已取消操作")
            snapshots = {key: pack(raw) for key, raw in records.items()}
            retained += sum(map(len, snapshots.values()))
            if retained > budget:
                raise ValueError("区块删除快照超过共享 64 MB 预算，已取消整批操作")
            prepared[coordinate] = snapshots
        self.pending.update(prepared)
        self.reset_voxel_history()
        for x, z in coords:
            self.cleared.pop((dimension, x, z), None)
            self.replacements.pop((dimension, x, z), None)
            if self.created.pop((dimension, x, z), None) is not None:
                known.discard((x, z))
        self._ordered.clear()
        self._invalidate_terrain_index()

    def clear_blocks(self, dimension: int, coords: list[tuple[int, int]], budget: int) -> bool:
        from .voxels import effective

        if self.reset:
            raise ValueError("请先保存或还原维度重置")
        if not coords or len(set(coords)) != len(coords):
            raise ValueError("请选择不重复的区块")
        known = self.index(dimension)
        prepared, replacements, creations = {}, {}, {}
        retained = self.retained_bytes
        for x, z in coords:
            coordinate = dimension, x, z
            if coordinate in self.pending:
                raise ValueError("选区中有暂存删除的区块，请先保存或还原")
            if (x, z) not in known:
                continue
            source = {} if coordinate in self.created else self.read(coordinate)
            records = effective(self, coordinate, source)
            if not records:
                raise ValueError("区块已被其他程序删除，请重新打开存档")
            writes = cleared_terrain(records)
            if not writes:
                continue
            if coordinate in self.created:
                updated = {key: raw for key, raw in (records | writes).items() if raw is not None}
                retained += sum(map(len, updated.values())) - sum(
                    map(len, self.created[coordinate].values())
                )
                creations[coordinate] = updated
            else:
                if coordinate in self.cleared and source != {
                    key: unpack(raw) for key, raw in self.cleared[coordinate].items()
                }:
                    raise ValueError("区块已被其他程序修改，已取消整批操作")
                snapshots = self.cleared.get(coordinate) or {
                    key: pack(raw) for key, raw in source.items()
                }
                merged = self.replacements.get(coordinate, {}) | writes
                retained += (
                    (0 if coordinate in self.cleared else sum(map(len, snapshots.values())))
                    + sum(len(raw) for raw in merged.values() if raw is not None)
                    - sum(
                        len(raw)
                        for raw in self.replacements.get(coordinate, {}).values()
                        if raw is not None
                    )
                )
                prepared[coordinate], replacements[coordinate] = snapshots, merged
            if retained > budget:
                raise ValueError("清空方块快照超过共享 64 MB 预算，已取消整批操作")
        self.cleared.update(prepared)
        self.created.update(creations)
        if prepared or creations:
            self.reset_voxel_history()
        self.replacements.update(replacements)
        self._tiles.clear()
        return bool(prepared or creations)

    def blocks_cleared(self, key: str) -> bool:
        parsed = chunk_key(bytes.fromhex(key))
        return parsed is not None and key in self.replacements.get(parsed[0], {})

    def create(
        self, dimension: int, coords: list[tuple[int, int]], min_y: int, max_y: int, budget: int
    ) -> None:
        """Stage complete air sections, a singleton biome and finalized chunk metadata."""
        if self.reset:
            raise ValueError("请先保存或还原维度重置")
        if not coords or len(set(coords)) != len(coords):
            raise ValueError("请选择不重复的空白区块")
        if not (-2048 <= min_y <= max_y <= 2047 and min_y % 16 == 0 and max_y % 16 == 15):
            raise ValueError("高度范围须按完整子区块对齐：最低 Y 为 16 的倍数，最高 Y 末位为 15")
        standard_height = {0: (-64, 319), 1: (0, 127), 2: (0, 255)}.get(dimension)
        if standard_height is not None and (min_y, max_y) != standard_height:
            raise ValueError("标准维度须使用其默认高度范围；仅自定义维度可设置高度")
        known = self.index(dimension)
        if sum(map(len, self._indices.values())) + len(coords) > 1000000:
            raise ValueError("新增后区块索引超过 100 万个上限")
        prepared = {}
        retained = self.retained_bytes
        for x, z in coords:
            if not (-(2**31) <= x < 2**31 and -(2**31) <= z < 2**31):
                raise ValueError("区块坐标无效")
            coordinate = dimension, x, z
            if (x, z) in known or coordinate in self.pending or self.read(coordinate):
                raise ValueError("目标区块已有数据或暂存删除，不能覆盖；请先还原或保存")
            records = air_chunk(coordinate, min_y, max_y)
            retained += sum(map(len, records.values()))
            if retained > budget:
                raise ValueError("新增区块超过共享 64 MB 预算，已取消整批操作")
            prepared[coordinate] = records
        self.created.update(prepared)
        self.reset_voxel_history()
        known.update(coords)
        self._ordered.clear()
        self._invalidate_terrain_index()
        self._tiles.clear()

    def restore(self) -> None:
        self.reset_voxel_history()
        if self.reset:
            self.reset = None
            self._indexed = False
        for dimension, x, z in self.created:
            self._indices[dimension].discard((x, z))
        self.created.clear()
        self.cleared.clear()
        self.replacements.clear()
        self.pending.clear()
        self.actor_records.clear()
        self._ordered.clear()
        self._invalidate_terrain_index()
        self._tiles.clear()

    def writes(self) -> list[dict[str, Any]]:
        if self.reset:
            return self.reset.writes()
        return (
            [
                {
                    "key": key,
                    "value": b64encode(unpack(current)).decode() if current is not None else None,
                }
                for key, (_, current) in self.actor_records.items()
            ]
            + [{"key": key, "value": None} for records in self.pending.values() for key in records]
            + [
                {"key": key, "value": b64encode(raw).decode()}
                for records in self.created.values()
                for key, raw in records.items()
            ]
            + [
                {"key": key, "value": b64encode(raw).decode() if raw is not None else None}
                for records in self.replacements.values()
                for key, raw in records.items()
            ]
        )

    def checks(self) -> list[dict[str, Any]]:
        checks = []
        for (dimension, x, z), records in (self.pending | self.cleared).items():
            current = self.read((dimension, x, z))
            if current.keys() != records.keys() or any(
                current[key] != unpack(snapshot) for key, snapshot in records.items()
            ):
                raise ValueError("区块已被其他程序修改，已取消保存，请重新打开存档")
            checks.append(
                {
                    "dimension": dimension,
                    "x": x,
                    "z": z,
                    "hashes": {
                        key: storage.fingerprint(unpack(raw)) for key, raw in records.items()
                    },
                }
            )
        for dimension, x, z in self.created:
            if self.read((dimension, x, z)):
                raise ValueError("新增区块位置已被其他程序写入，已取消保存")
            checks.append({"dimension": dimension, "x": x, "z": z, "hashes": {}})
        return checks

    def actor_checks(self) -> list[dict[str, Any]]:
        from .chunk_markers import nbt_records

        checks = []
        for key, (original, current) in self.actor_records.items():
            raw_key = bytes.fromhex(key)
            actor = len(raw_key) == 19 and raw_key.startswith(b"actorprefix")
            digest = len(raw_key) in (12, 16) and raw_key.startswith(b"digp")
            if not (actor or digest) or current is None:
                raise ValueError("暂存实体记录类型无效")
            raw = unpack(current)
            if len(raw) > storage.MAX_FILE_SIZE:
                raise ValueError("暂存实体记录超过 16 MB")
            if actor:
                trees = nbt_records(raw)
                if (
                    len(trees) != 1
                    or not isinstance(trees[0].get("UniqueID"), nbtlib.Long)
                    or struct.pack("<q", int(trees[0]["UniqueID"])) != raw_key[11:]
                ):
                    raise ValueError("暂存实体身份与键不一致")
            elif len(raw) % 8:
                raise ValueError("暂存实体索引格式无效")
            expected = unpack(original) if original is not None else None
            # Bypass staged values for external-conflict checks.
            value = self.store.request("get", key=key, optional=True)
            actual = b64decode(value, validate=True) if value is not None else None
            if actual != expected:
                raise ValueError("实体或索引已被其他程序修改，已取消保存")
            checks.append(
                {
                    "key": key,
                    "hash": storage.fingerprint(expected) if expected is not None else None,
                }
            )
        return checks

    def saved(self) -> None:
        self.actor_records.clear()
        self.reset_voxel_history()
        if self.reset:
            self.reset = None
            self._indexed = False
        for dimension, x, z in self.pending:
            self._indices[dimension].discard((x, z))
        self.pending.clear()
        self.created.clear()
        self.cleared.clear()
        self.replacements.clear()
        self._ordered.clear()
        self._invalidate_terrain_index()
        self._tiles.clear()

    def reset_dimension(self, dimension: int, budget: int) -> None:
        self.index(dimension)
        if self.dirty:
            raise ValueError("请先保存或还原已有地图修改，再重置维度")
        prepared = DimensionReset.prepare(self.store, dimension, budget)
        self.reset = prepared
        self._indices[dimension] = set()
        self._ordered.clear()
        self._invalidate_terrain_index()
        self._tiles.clear()

    def tiles(
        self,
        dimension: int,
        coords: list[tuple[int, int]],
        ceiling: int,
        layer: str,
        resolution: int = 16,
        span: int = 1,
    ) -> list[dict[str, Any]]:
        if resolution not in (1, 2, 4, 8, 16):
            raise ValueError("地图缩略图尺寸无效")
        if not 1 <= span <= 2**32 or (span > 1 and resolution != 1):
            raise ValueError("地图聚合尺寸无效")
        known = self.index(dimension)
        requested = coords
        if span > 1:
            # Reuse only real samples inside the new world-aligned group. Never
            # spread an old aggregate pixel across a neighbouring group.
            groups = {(x // span, z // span) for x, z in coords}
            samples = {}
            for d, x, z, y, mode in self._tiles:
                group = x // span, z // span
                if (
                    d == dimension
                    and y == ceiling
                    and mode == layer
                    and group in groups
                    and (x, z) in known
                    and (d, x, z) not in self.pending
                    and (d, x, z) not in self.created
                    and (d, x, z) not in self.cleared
                ):
                    samples.setdefault(group, (x, z))
            coords = [
                samples.get((x // span, z // span), (x, z))
                if (x, z) in known
                and (dimension, x, z) not in self.pending
                and (dimension, x, z) not in self.created
                and (dimension, x, z) not in self.cleared
                else (x, z)
                for x, z in coords
            ]
        result = []
        missing = list(
            dict.fromkeys(
                (x, z)
                for x, z in coords
                if (x, z) in known
                and (dimension, x, z) not in self.pending
                and (dimension, x, z) not in self.created
                and (dimension, x, z) not in self.cleared
                and (dimension, x, z, ceiling, layer) not in self._tiles
            )
        )
        records = (
            self.store.request(
                "chunk-terrains",
                dimension=dimension,
                ceiling=ceiling,
                full_height=True,
                chunks=[{"x": x, "z": z} for x, z in missing],
            )
            if missing
            else []
        )
        jobs = []
        for items in records:
            jobs.append(
                (
                    {item["key"]: b64decode(item["value"], validate=True) for item in items},
                    ceiling,
                    layer,
                )
            )
        decoded = self._decoder.decode(jobs) if jobs else []
        for (x, z), preview in zip(missing, decoded, strict=True):
            self._tiles[dimension, x, z, ceiling, layer] = {
                "x": x,
                "z": z,
                **preview,
            }
        for (target_x, target_z), (x, z) in zip(requested, coords, strict=True):
            if (x, z) not in known:
                continue
            tile: dict[str, Any] = {"x": x, "z": z}
            if (dimension, x, z) in self.pending:
                tile["deleted"] = True
            elif (dimension, x, z) in self.created or (dimension, x, z) in self.cleared:
                from .voxels import effective

                staged = effective(self, (dimension, x, z))
                tile["created" if (dimension, x, z) in self.created else "cleared"] = True
                tile["kind"] = terrain_kind(staged)
                tile["rgba"] = b64encode(terrain_tile(staged, ceiling, layer)).decode()
            else:
                cache_key = dimension, x, z, ceiling, layer
                tile = self._tiles[cache_key]
                self._tiles.move_to_end(cache_key)
            if resolution != 16 and "rgba" in tile:
                tile = {
                    **tile,
                    "rgba": b64encode(terrain_mip(b64decode(tile["rgba"]), resolution)).decode(),
                }
            result.append({**tile, "x": target_x, "z": target_z})
        # Keep every initial cache hit available until the entire batch consumes it.
        # Those hits were excluded from `missing`, so evicting one mid-batch loses its terrain.
        while len(self._tiles) > self._tile_limit:
            self._tiles.popitem(last=False)
        return result
