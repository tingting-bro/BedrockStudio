"""Lossless persistent palettes and bounded, atomic voxel edits (no game simulation)."""

from __future__ import annotations

import json
import struct
from copy import deepcopy
from dataclasses import dataclass, field
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Any

import nbtlib
import numpy as np

from . import storage
from .paths import resource_pack_root
from .snapshots import pack, unpack


def exact(stream: BytesIO, count: int) -> bytes:
    raw = stream.read(count)
    if len(raw) != count:
        raise ValueError("子区块数据不完整")
    return raw


@dataclass
class Layer:
    palette: list[nbtlib.File]
    indices: list[int]


@dataclass
class Section:
    version: int
    index: int
    layers: list[Layer]
    tail: bytes = b""


def decode(raw: bytes, index: int) -> Section:
    stream = BytesIO(raw)
    version, count = exact(stream, 2)
    if version not in (8, 9) or count > 2:
        raise ValueError("3D 仅支持完整的 v8/v9 持久化子区块")
    if version == 9 and struct.unpack("b", exact(stream, 1))[0] != index:
        raise ValueError("子区块高度与数据库键不一致")
    layers = []
    for _ in range(count):
        header = exact(stream, 1)[0]
        bits = header >> 1
        if header & 1 or bits not in (0, 1, 2, 3, 4, 5, 6, 8, 16):
            raise ValueError("不支持的方块存储格式")
        per = 32 // bits if bits else 0
        words = (
            struct.unpack(
                f"<{(4096 + per - 1) // per}I", exact(stream, ((4096 + per - 1) // per) * 4)
            )
            if bits
            else ()
        )
        marker = stream.read(1)
        stream.seek(-len(marker), 1)
        size = 1 if not bits and marker == b"\x0a" else struct.unpack("<i", exact(stream, 4))[0]
        if not 1 <= size <= 4096:
            raise ValueError("方块调色板大小无效")
        palette = []
        for _ in range(size):
            try:
                tree = nbtlib.File.parse(stream, byteorder="little")
            except Exception as exc:
                raise ValueError("方块 NBT 无法读取") from exc
            if not isinstance(tree.get("name"), nbtlib.String) or not isinstance(
                tree.get("states", nbtlib.Compound()), nbtlib.Compound
            ):
                raise ValueError("方块名称或状态无效")
            palette.append(tree)
        indices = (
            [(words[i // per] >> ((i % per) * bits)) & ((1 << bits) - 1) for i in range(4096)]
            if bits
            else [0] * 4096
        )
        if any(i >= size for i in indices):
            raise ValueError("方块索引越界")
        layers.append(Layer(palette, indices))
    # Unknown extension bytes belong to the source section; retain them on edit.
    return Section(version, index, layers, stream.read())


def encode(section: Section) -> bytes:
    out = BytesIO(
        bytes([section.version, len(section.layers)])
        + (struct.pack("b", section.index) if section.version == 9 else b"")
    )
    out.seek(0, 2)
    for layer in section.layers:
        size = len(layer.palette)
        if not size or len(layer.indices) != 4096:
            raise ValueError("方块调色板或索引数量无效")
        values = np.asarray(layer.indices)
        if np.any(values < 0) or np.any(values >= size):
            raise ValueError("方块索引越界")
        if size > 4096:
            used = sorted(set(layer.indices))
            remap = {old: i for i, old in enumerate(used)}
            layer.palette = [layer.palette[i] for i in used]
            layer.indices = [remap[i] for i in layer.indices]
            size = len(layer.palette)
        bits = next(b for b in (0, 1, 2, 3, 4, 5, 6, 8, 16) if size <= 2**b)
        out.write(bytes([bits << 1]))
        if bits:
            per = 32 // bits
            # Vectorized unsigned packing avoids thousands of Python/NumPy scalar shifts.
            values = np.asarray(layer.indices, dtype=np.uint32)
            padded = np.zeros(((4096 + per - 1) // per) * per, dtype=np.uint32)
            padded[:4096] = values
            words = np.bitwise_or.reduce(
                padded.reshape(-1, per) << (np.arange(per, dtype=np.uint32) * bits), axis=1
            )
            out.write(words.astype("<u4", copy=False).tobytes())
        out.write(struct.pack("<i", size))
        for tree in layer.palette:
            tree.write(out, byteorder="little")
    out.write(section.tail)
    result = out.getvalue()
    if len(result) > storage.MAX_FILE_SIZE:
        raise ValueError("子区块超过单记录 16 MB 上限")
    return result


def descriptor(tree: nbtlib.File) -> dict[str, Any]:
    return {
        "name": str(tree["name"]),
        "states": {
            str(k): str(v) if v.tag_id in (4, 8) else int(v) if v.tag_id in (1, 2, 3) else str(v)
            for k, v in tree.get("states", {}).items()
        },
    }


def render_descriptor(tree: nbtlib.File) -> dict[str, Any]:
    """Keep source state types/version for translation; never changes stored NBT."""
    return {
        **descriptor(tree),
        "version": int(tree.get("version", 0)),
        "stateTypes": {str(k): v.tag_id for k, v in tree.get("states", {}).items()},
    }


# State-free, single-cell blocks: no inventories, paired structures or ticking behaviour.
PLACEABLE = tuple(
    "air stone cobblestone dirt grass_block bedrock sand sandstone red_sandstone gravel obsidian crying_obsidian glass tinted_glass white_wool black_wool red_wool blue_wool white_concrete black_concrete red_concrete blue_concrete gold_block iron_block diamond_block emerald_block netherite_block netherrack end_stone bricks stone_bricks deepslate cobbled_deepslate moss_block clay snow_block packed_ice blue_ice glowstone sea_lantern oak_planks spruce_planks birch_planks jungle_planks acacia_planks dark_oak_planks mangrove_planks cherry_planks bamboo_planks crimson_planks warped_planks".split()
)
ALIASES = {"grass_block": "grass", "bricks": "brick_block", "snow_block": "snow"}


def new_block(name: str, records: dict[str, bytes] | None = None) -> nbtlib.File:
    name = name.removeprefix("minecraft:")
    name = ALIASES.get(name, name)
    if name not in {ALIASES.get(n, n) for n in PLACEABLE}:
        from .chunks import chunk_key

        if name not in known_blocks():
            raise ValueError("未知方块名，请使用原版方块标识")
        # Reuse a real persistent state rather than inventing defaults for stateful blocks.
        for key, raw in (records or {}).items():
            parsed = chunk_key(bytes.fromhex(key))
            if parsed and parsed[1] == 0x2F:
                for layer in decode(raw, parsed[2]).layers:
                    for tree in layer.palette:
                        if str(tree["name"]) == f"minecraft:{name}":
                            return deepcopy(tree)
        state = default_states().get(name)
        if state is None:
            raise ValueError("此版本没有该方块的可靠状态数据，请复制已有方块或编辑 NBT")
        tags = {1: nbtlib.Byte, 3: nbtlib.Int, 8: nbtlib.String}
        return nbtlib.File(
            {
                "name": nbtlib.String(f"minecraft:{name}"),
                "states": nbtlib.Compound(
                    {k: tags[v["type"]](v["value"]) for k, v in state["states"].items()}
                ),
                "version": nbtlib.Int(state["version"]),
            }
        )
    return nbtlib.File(
        {
            "name": nbtlib.String(f"minecraft:{name}"),
            "states": nbtlib.Compound(
                {"pillar_axis": nbtlib.String("y")} if name == "deepslate" else {}
            ),
            "version": nbtlib.Int(18168865),
        }
    )


def block_at(records: dict[str, bytes], point: tuple[int, int, int]) -> nbtlib.File:
    from .chunks import chunk_key

    found = []
    for key, raw in records.items():
        parsed = chunk_key(bytes.fromhex(key))
        if parsed and parsed[1:] == (0x2F, point[1] // 16):
            section = decode(raw, parsed[2])
            if not section.layers:
                found.append(new_block("air"))
            else:
                layer = section.layers[0]
                i = (point[0] % 16) * 256 + (point[2] % 16) * 16 + point[1] % 16
                found.append(deepcopy(layer.palette[layer.indices[i]]))
    if len(found) != 1:
        raise ValueError("方块所在子区块缺失或有歧义")
    return found[0]


def cell_inside(x: int, y: int, z: int, sphere: tuple[int, int, int, int] | None) -> bool:
    return sphere is None or (
        (x - sphere[0]) ** 2 + (y - sphere[1]) ** 2 + (z - sphere[2]) ** 2 <= sphere[3] ** 2
    )


def selected_cell(x, y, z, low, high, sphere=None, hollow=False, chunk_mask=None) -> bool:
    if chunk_mask is not None and (x // 16, z // 16) not in chunk_mask:
        return False
    if not all(a <= v <= b for a, v, b in zip(low, (x, y, z), high, strict=True)):
        return False
    if not cell_inside(x, y, z, sphere):
        return False
    if not hollow:
        return True
    if sphere is None:
        return any(v in (a, b) for a, v, b in zip(low, (x, y, z), high, strict=True))
    # A digital shell: a selected cell has a six-connected neighbour outside the ball.
    return any(
        not cell_inside(x + dx, y + dy, z + dz, sphere)
        for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
    )


def selection_intersects(
    low, high, outer_low, outer_high, sphere=None, hollow=False, chunk_mask=None
):
    low = tuple(max(a, b) for a, b in zip(low, outer_low, strict=True))
    high = tuple(min(a, b) for a, b in zip(high, outer_high, strict=True))
    if any(a > b for a, b in zip(low, high, strict=True)):
        return False
    if chunk_mask is not None and not any(
        (x, z) in chunk_mask
        for x in range(low[0] // 16, high[0] // 16 + 1)
        for z in range(low[2] // 16, high[2] // 16 + 1)
    ):
        return False
    if sphere is None:
        return not hollow or any(
            a == c or b == d for a, b, c, d in zip(low, high, outer_low, outer_high, strict=True)
        )
    nearest = tuple(max(a, min(c, b)) for a, b, c in zip(low, high, sphere[:3], strict=True))
    if not cell_inside(*nearest, sphere):
        return False
    if not hollow:
        return True
    distances = [max(abs(a - c), abs(b - c)) for a, b, c in zip(low, high, sphere[:3], strict=True)]
    return sum(d * d for d in distances) + 2 * max(distances) + 1 > sphere[3] ** 2


def validate_chunk_mask(points, low, high, sphere=None, hollow=False):
    if points is None:
        return None
    mask = frozenset(points)
    if not mask or len(mask) != len(points) or sphere is not None or hollow:
        raise ValueError("区块选区必须包含不重复的完整区块")
    if (
        any(v % 16 for v in (low[0], low[2]))
        or any(v % 16 != 15 for v in (high[0], high[2]))
        or any(not (low[0] <= x * 16 <= high[0] and low[2] <= z * 16 <= high[2]) for x, z in mask)
    ):
        raise ValueError("区块选区范围无效")
    return mask


def effective(
    chunks: Any, coordinate: tuple[int, int, int], source: dict[str, bytes] | None = None
) -> dict[str, bytes]:
    if coordinate in chunks.pending or chunks.reset and chunks.reset.dimension == coordinate[0]:
        return {}
    if coordinate in chunks.created:
        return dict(chunks.created[coordinate])
    records = dict(source) if source is not None else chunks.read(coordinate)
    for key, raw in chunks.replacements.get(coordinate, {}).items():
        if raw is None:
            records.pop(key, None)
        else:
            records[key] = raw
    return records


def scene_data(chunks: Any, coordinate: tuple[int, int, int]) -> bytes:
    from .chunks import chunk_key

    records = effective(chunks, coordinate)
    if sum(map(len, records.values())) > 16 * 1024 * 1024:
        raise ValueError("3D 区块源数据超过 16 MB 读取预算")
    metadata: dict[str, Any] = {
        "x": coordinate[1],
        "z": coordinate[2],
        "missing": not records,
        "sections": [],
    }
    buffers = []
    size = 0
    for key, raw in sorted(records.items()):
        parsed = chunk_key(bytes.fromhex(key))
        if parsed is None or parsed[1] != 0x2F:
            continue
        index = parsed[2]
        item: dict[str, Any] = {"y": index, "layers": []}
        try:
            section = decode(raw, index)
            for layer in section.layers:
                item["layers"].append(
                    {"palette": [render_descriptor(p) for p in layer.palette], "offset": size}
                )
                buf = struct.pack("<4096H", *layer.indices)
                buffers.append(buf)
                size += len(buf)
        except ValueError as exc:
            item["error"] = str(exc)
        metadata["sections"].append(item)
    header = json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode()
    if len(header) + size > 8 * 1024 * 1024:
        raise ValueError("3D 区块响应超过 8 MB 预算")
    return struct.pack("<I", len(header)) + header + b"".join(buffers)


@lru_cache(maxsize=1)
def default_states() -> dict:
    return json.loads(Path(__file__).with_name("block_states.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def known_blocks() -> frozenset[str]:
    source = resource_pack_root() / "minecraft/scene/atlas.json"
    blocks = json.loads(source.read_text(encoding="utf-8"))["blocks"]
    return (
        frozenset(blocks)
        | frozenset(default_states())
        | frozenset(PLACEABLE)
        | {"cave_air", "void_air", "structure_void"}
    )


def prepare_edit(
    records: dict[str, bytes],
    coordinate: tuple[int, int, int],
    low: tuple[int, int, int],
    high: tuple[int, int, int],
    name: str,
    match: str | None,
    sphere: tuple[int, int, int, int] | None = None,
    states: str | None = None,
    hollow: bool = False,
    selection: tuple | None = None,
    clipboard: Any = None,
    chunk_mask=None,
) -> dict[str, bytes | None]:
    from .chunks import AIR, chunk_key

    preserving_state = False
    if states is not None:
        if low != high:
            raise ValueError("NBT 状态编辑仅支持单个方块")
        target = block_at(records, low)
        parsed_states = nbtlib.parse_nbt(states)
        if not isinstance(parsed_states, nbtlib.Compound) or any(
            value.tag_id not in (1, 3, 8) for value in parsed_states.values()
        ):
            raise ValueError("states 必须是仅包含 Byte、Int、String 的 SNBT Compound")
        short = name.removeprefix("minecraft:")
        short = ALIASES.get(short, short)
        if short not in known_blocks() and str(target["name"]) != name:
            raise ValueError("未知方块名")
        target_name = f"minecraft:{short}" if short in known_blocks() else name
        preserving_state = str(target["name"]) == target_name
        target["name"] = nbtlib.String(target_name)
        target["states"] = parsed_states
    else:
        target = new_block(name, records) if clipboard is None else new_block("air")
    deleting = clipboard is None and states is None and str(target["name"]) == "minecraft:air"
    if match is not None and ":" not in match:
        raise ValueError("源方块名称无效或不受支持")
    if match is not None and match.startswith("minecraft:"):
        match = "minecraft:" + ALIASES.get(
            match.removeprefix("minecraft:"), match.removeprefix("minecraft:")
        )
    sections = {}
    prefix = None
    legacy_prefix = None
    for key, raw in records.items():
        parsed = chunk_key(bytes.fromhex(key))
        assert parsed is not None
        tag, index = parsed[1:]
        if tag == 0x2F:
            if index in sections:
                raise ValueError("存在重复高度的子区块键，整批已取消")
            sections[index] = (key, decode(raw, index))
            prefix = bytes.fromhex(key)[:-2]
        elif tag in (0x30, 0x33, 0x34, 0x3A) and raw:
            # These records are outside the modern voxel palette. Continue
            # with the editable subchunks instead of rejecting the whole edit.
            if tag == 0x30:
                legacy_prefix = bytes.fromhex(key)[:-1]
    if prefix is None:
        # An indexed chunk may contain only metadata (all-air terrain). Build
        # the missing modern storage lazily; retain all sibling records.
        dimension, cx, cz = coordinate
        prefix = legacy_prefix or (
            struct.pack("<ii", cx, cz) + (struct.pack("<i", dimension) if dimension else b"")
        )
    writes: dict[str, bytes | None] = {}
    touched: dict[int, int] = {}
    columns = set()
    outer_low, outer_high = selection or (low, high)

    def was_touched(pos):
        x, y, z = pos
        if (x // 16, z // 16) != coordinate[1:]:
            return False
        i = (x % 16) * 256 + (z % 16) * 16 + y % 16
        return bool(touched.get(y // 16, 0) & (1 << i))

    for sy in range(low[1] // 16, high[1] // 16 + 1):
        section_low = (low[0], max(low[1], sy * 16), low[2])
        section_high = (high[0], min(high[1], sy * 16 + 15), high[2])
        if not selection_intersects(
            section_low, section_high, outer_low, outer_high, sphere, hollow
        ):
            continue
        if clipboard is not None and not clipboard.intersects(section_low, section_high):
            continue
        if sphere is not None and not cell_inside(
            max(low[0], min(sphere[0], high[0])),
            max(low[1], sy * 16, min(sphere[1], high[1], sy * 16 + 15)),
            max(low[2], min(sphere[2], high[2])),
            sphere,
        ):
            continue
        if sy not in sections:
            # Materialize missing modern storage only when a cell changes;
            # legacy terrain and unrelated records remain byte-for-byte intact.
            sections[sy] = ((prefix + b"\x2f" + struct.pack("b", sy)).hex(), Section(9, sy, []))
        key, section = sections[sy]
        if not section.layers:
            section.layers.append(Layer([new_block("air")], [0] * 4096))
        base = section.layers[0]
        target_id = next((i for i, value in enumerate(base.palette) if value == target), None)
        if target_id is None:
            target_id = len(base.palette)
            base.palette.append(target)
        changed = False
        palette_ids = {}
        palette_refs = []
        for x in range(low[0], high[0] + 1):
            for z in range(low[2], high[2] + 1):
                for y in range(max(low[1], sy * 16), min(high[1], sy * 16 + 15) + 1):
                    if not selected_cell(
                        x, y, z, outer_low, outer_high, sphere, hollow, chunk_mask
                    ):
                        continue
                    copied = clipboard.cell(x, y, z) if clipboard is not None else None
                    if clipboard is not None and copied is None:
                        continue
                    i = (x % 16) * 256 + (z % 16) * 16 + y % 16
                    if copied is not None:
                        if not clipboard.replace_existing and any(
                            str(layer.palette[layer.indices[i]]["name"]) != "minecraft:air"
                            for layer in section.layers
                        ):
                            continue
                        for layer_index, tree in enumerate(copied):
                            while len(section.layers) <= layer_index:
                                section.layers.append(Layer([new_block("air")], [0] * 4096))
                            layer = section.layers[layer_index]
                            cache_key = (layer_index, id(tree))
                            if cache_key not in palette_ids:
                                palette_refs.append(tree)
                                index = next(
                                    (
                                        j
                                        for j, p in enumerate(layer.palette)
                                        if p == tree and p.root_name == tree.root_name
                                    ),
                                    None,
                                )
                                if index is None:
                                    index = len(layer.palette)
                                    layer.palette.append(tree)
                                palette_ids[cache_key] = index
                            layer.indices[i] = palette_ids[cache_key]
                        if len(copied) < len(section.layers):
                            water = section.layers[1]
                            air = new_block("air")
                            index = next((j for j, p in enumerate(water.palette) if p == air), None)
                            if index is None:
                                index = len(water.palette)
                                water.palette.append(air)
                            water.indices[i] = index
                        touched[sy] = touched.get(sy, 0) | (1 << i)
                        columns.add((x, z))
                        changed = True
                        continue
                    old = str(base.palette[base.indices[i]]["name"])
                    if match is not None and old != match:
                        continue
                    if (
                        old == str(target["name"])
                        and base.palette[base.indices[i]] == target
                        and (
                            preserving_state
                            or len(section.layers) < 2
                            or str(
                                section.layers[1].palette[section.layers[1].indices[i]]["name"]
                            ).removeprefix("minecraft:")
                            in AIR
                        )
                    ):
                        if deleting:
                            # Air may still have an orphan block-entity record.
                            # Include selected cells in entity cleanup even when
                            # their terrain already matches the deletion target.
                            touched[sy] = touched.get(sy, 0) | (1 << i)
                        continue
                    if len(section.layers) == 2 and not preserving_state:
                        water = section.layers[1]
                        air_id = next(
                            (
                                j
                                for j, p in enumerate(water.palette)
                                if str(p["name"]) == "minecraft:air"
                            ),
                            None,
                        )
                        if air_id is None:
                            air_id = len(water.palette)
                            water.palette.append(new_block("air"))
                        water.indices[i] = air_id
                    base.indices[i] = target_id
                    touched[sy] = touched.get(sy, 0) | (1 << i)
                    columns.add((x, z))
                    changed = True
        if changed:
            writes[key] = encode(section)
    if not touched:
        return {}
    # Remove only block entities at cells actually replaced; retain all sibling bytes.
    for key, raw in records.items():
        tag = chunk_key(bytes.fromhex(key))[1]
        if tag == 0x31:
            stream, kept = BytesIO(raw), []
            while stream.tell() < len(raw):
                start = stream.tell()
                try:
                    tree = nbtlib.File.parse(stream, byteorder="little")
                    pos = tuple(int(tree[k]) for k in ("x", "y", "z"))
                except Exception as exc:
                    raise ValueError("方块实体无法完整校验，整批已取消") from exc
                original = raw[start : stream.tell()]
                # Retain untouched records verbatim, including noncanonical NBT.
                if not was_touched(pos) or preserving_state:
                    kept.append(original)
            if clipboard is not None:
                kept.extend(clipboard.entities(coordinate, was_touched))
            result = b"".join(kept)
            if len(result) > storage.MAX_FILE_SIZE:
                raise ValueError("粘贴后的方块实体超过单记录 16 MB 上限")
            if result != raw:
                writes[key] = result or None
        elif tag == 0x3B and columns:
            writes[key] = None
        elif tag in (0x2B, 0x2D, 0x2E):
            if len(raw) < 512:
                raise ValueError("高度图损坏，整批已取消")
            # Recompute touched columns from both storage layers, preserving biome bytes.
            heights = bytearray(raw[:512])
            for x, z in columns:
                top = -65
                for sy, (_, section) in sorted(sections.items(), reverse=True):
                    for y in range(15, -1, -1):
                        i = (x % 16) * 256 + (z % 16) * 16 + y
                        if any(
                            str(layer.palette[layer.indices[i]]["name"]).removeprefix("minecraft:")
                            not in AIR
                            for layer in section.layers
                        ):
                            top = sy * 16 + y
                            break
                    if top != -65:
                        break
                # Bedrock Data3D height values are offset by the world's minimum height.
                minimum = -64 if coordinate[0] == 0 else 0
                struct.pack_into(
                    "<H", heights, ((z % 16) * 16 + x % 16) * 2, max(0, top + 1 - minimum)
                )
            result = bytes(heights) + raw[512:]
            if result != raw:
                writes[key] = result
    if clipboard is not None and not any(chunk_key(bytes.fromhex(k))[1] == 0x31 for k in records):
        entities = b"".join(clipboard.entities(coordinate, was_touched))
        if entities:
            if len(entities) > storage.MAX_FILE_SIZE:
                raise ValueError("粘贴后的方块实体超过单记录 16 MB 上限")
            writes[(prefix + b"\x31").hex()] = entities
    return writes


@dataclass
class Change:
    before: dict[tuple[int, int, int], tuple[Any, Any, Any]]
    after: dict[tuple[int, int, int], tuple[Any, Any, Any]]
    actors_before: dict = field(default_factory=dict)
    actors_after: dict = field(default_factory=dict)

    @property
    def size(self) -> int:
        return (
            sum(
                len(raw)
                for state in (self.before, self.after)
                for parts in state.values()
                for records in parts
                if records
                for raw in records.values()
                if raw is not None
            )
            + actor_bytes(self.actors_before)
            + actor_bytes(self.actors_after)
        )


def actor_bytes(records):
    return sum(len(raw) for parts in records.values() for raw in parts if raw is not None)


def snapshot(chunks: Any, coordinates: list[tuple[int, int, int]]) -> dict:
    return {
        c: (
            dict(chunks.cleared[c]) if c in chunks.cleared else None,
            {k: pack(v) if v is not None else None for k, v in chunks.replacements[c].items()}
            if c in chunks.replacements
            else None,
            {k: pack(v) for k, v in chunks.created[c].items()} if c in chunks.created else None,
        )
        for c in coordinates
    }


def state_bytes(parts: tuple[Any, Any, Any]) -> int:
    """History is packed; active replacements/creations are retained as raw bytes."""
    original, writes, created = parts
    return sum(len(raw) for raw in (original or {}).values()) + sum(
        len(unpack(raw))
        for records in (writes, created)
        if records
        for raw in records.values()
        if raw is not None
    )


def apply_state(chunks: Any, state: dict) -> None:
    creation_changes = [
        c for c, parts in state.items() if (c in chunks.created) != (parts[2] is not None)
    ]
    # Load the fallible index before changing staged data, including on undo/redo.
    for dimension in {c[0] for c in creation_changes}:
        chunks.index(dimension)
    for coordinate, (original, writes, created) in state.items():
        for mapping, records, packed in (
            (chunks.cleared, original, False),
            (chunks.replacements, writes, True),
            (chunks.created, created, True),
        ):
            if records is None:
                mapping.pop(coordinate, None)
            else:
                mapping[coordinate] = {
                    k: unpack(v) if packed and v is not None else v for k, v in records.items()
                }
    for dimension, x, z in creation_changes:
        known = chunks._indices[dimension]
        if state[dimension, x, z][2] is None:
            known.discard((x, z))
        else:
            known.add((x, z))
    if creation_changes:
        chunks._ordered.clear()
        chunks._invalidate_terrain_index()
    chunks._tiles.clear()


@dataclass
class MapState:
    blocks: dict
    pending: dict
    reset: Any
    actors: dict = field(default_factory=dict)

    @property
    def size(self) -> int:
        return (
            Change(self.blocks, {}).size
            + sum(len(raw) for records in self.pending.values() for raw in records.values())
            + (self.reset.retained_bytes if self.reset else 0)
            + actor_bytes(self.actors)
        )

    @property
    def active_bytes(self) -> int:
        return (
            sum(state_bytes(parts) for parts in self.blocks.values())
            + sum(len(raw) for records in self.pending.values() for raw in records.values())
            + (self.reset.retained_bytes if self.reset else 0)
            + actor_bytes(self.actors)
        )

    def restore(self, chunks: Any, indices: dict | None = None) -> None:
        # Read a fallible index before changing any staged state.
        if indices is None:
            indices = {}
            for item in chunks.store.request("chunks"):
                indices.setdefault(item["dimension"], set()).add((item["x"], item["z"]))
        for (dimension, x, z), parts in self.blocks.items():
            if parts[2] is not None:
                indices.setdefault(dimension, set()).add((x, z))
        if self.reset:
            indices[self.reset.dimension] = set()
        apply_state(chunks, self.blocks)
        chunks.pending = {c: dict(records) for c, records in self.pending.items()}
        chunks.reset = self.reset
        chunks.actor_records = dict(self.actors)
        chunks._indices = indices
        chunks._indexed = True
        chunks._ordered.clear()
        chunks._invalidate_terrain_index()


@dataclass
class MapChange:
    before: MapState
    after: MapState

    @property
    def size(self) -> int:
        return self.before.size + self.after.size


def map_snapshot(chunks: Any, coordinates: list) -> MapState:
    return MapState(
        snapshot(chunks, coordinates),
        {c: dict(records) for c, records in chunks.pending.items()},
        chunks.reset,
        dict(chunks.actor_records),
    )
