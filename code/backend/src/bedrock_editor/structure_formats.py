"""Minecraft structure format conversion for the voxel clipboard.

The editor keeps one lossless internal representation (``Clipboard``).  This
module only translates the common interchange formats to and from that
representation; it never writes a world directly.
"""

from __future__ import annotations

import gzip
from array import array
from copy import deepcopy
from dataclasses import dataclass, field
from io import BytesIO
from itertools import chain
from typing import Any

import nbtlib
import numpy as np

from .players import encode_player
from .resources import memory_headroom, parallel_map, structure_workers
from .snapshots import pack, unpack
from .voxel_clipboard import Clipboard, entities
from .voxels import Layer, Section, encode, new_block

MAX_PALETTE = 65_536
FORMATS = ("mcstructure", "schematic", "schem")


@dataclass
class Structure:
    size: tuple[int, int, int]
    blocks: dict[tuple[int, int, int], nbtlib.File] = field(default_factory=dict)
    block_entities: list[nbtlib.File] = field(default_factory=list)
    entities: list[nbtlib.File] = field(default_factory=list)
    secondary_blocks: dict[tuple[int, int, int], nbtlib.File] = field(default_factory=dict)
    native_source: tuple[list[nbtlib.File], np.ndarray] | None = None
    selected_columns: list[tuple[int, int, int, int]] | None = None


def _tag(value: Any, cls: type[nbtlib.Base] | None = None):
    if cls is not None:
        return cls(value)
    if isinstance(value, nbtlib.Base):
        return value
    if isinstance(value, bool):
        return nbtlib.Byte(int(value))
    if isinstance(value, int):
        return nbtlib.Int(value)
    if isinstance(value, float):
        return nbtlib.Double(value)
    return nbtlib.String(str(value))


def _compound(value: Any) -> nbtlib.Compound:
    if isinstance(value, nbtlib.Compound):
        return value
    if isinstance(value, nbtlib.File):
        return nbtlib.Compound(value)
    if not isinstance(value, dict):
        raise ValueError("结构调色板项不是 Compound")
    return nbtlib.Compound({str(k): _tag(v) for k, v in value.items()})


def _read_nbt(
    raw: bytes,
    compressed: bool | None = None,
    *,
    byteorder: str = "little",
) -> nbtlib.File:
    if compressed is None:
        compressed = raw[:2] == b"\x1f\x8b"
    elif compressed and raw[:2] != b"\x1f\x8b":
        # Sponge and Litematica normally use gzip, but both ecosystems also
        # accept a plain NBT payload in practice.
        compressed = False
    if compressed:
        try:
            raw = gzip.decompress(raw)
        except OSError as exc:
            raise ValueError("结构文件 gzip 数据无效") from exc
    stream = BytesIO(raw)
    try:
        tree = nbtlib.File.parse(stream, byteorder=byteorder)
    except Exception as exc:
        raise ValueError("结构文件 NBT 无法解析") from exc
    if stream.tell() != len(raw):
        raise ValueError("结构文件 NBT 含尾随数据")
    return tree


def _write_nbt(
    tree: nbtlib.File,
    compressed: bool = False,
    *,
    byteorder: str = "little",
) -> bytes:
    stream = BytesIO()
    tree.write(stream, byteorder=byteorder)
    raw = stream.getvalue()
    if compressed:
        raw = gzip.compress(raw, mtime=0)
    return raw


def _size(value: Any) -> tuple[int, int, int]:
    if not isinstance(value, (nbtlib.List, nbtlib.IntArray, tuple, list)) or len(value) != 3:
        raise ValueError("结构尺寸无效")
    result = tuple(int(v) for v in value)
    if any(v <= 0 for v in result):
        raise ValueError("结构尺寸无效")
    return result


def _block(name: str, states: Any = None, version: Any = None) -> nbtlib.File:
    name = str(name)
    if not name.startswith("minecraft:"):
        name = f"minecraft:{name}"
    if states is None:
        states = nbtlib.Compound()
    elif not isinstance(states, nbtlib.Compound):
        states = nbtlib.Compound({str(k): _tag(v) for k, v in dict(states).items()})
    return nbtlib.File(
        {
            "name": nbtlib.String(name),
            "states": deepcopy(states),
            "version": nbtlib.Int(int(version)) if version is not None else nbtlib.Int(18168865),
        }
    )


def _points(tree: Any, *, block: bool = False) -> tuple[int, int, int] | None:
    value = tree.get("Pos") if isinstance(tree, (dict, nbtlib.Compound, nbtlib.File)) else None
    if value is None:
        value = tree.get("pos") if isinstance(tree, (dict, nbtlib.Compound, nbtlib.File)) else None
    if value is None:
        values = [tree.get(axis) for axis in ("x", "y", "z")]
    else:
        values = list(value)
    if len(values) != 3:
        return None
    try:
        return tuple(int(float(v)) for v in values)
    except (TypeError, ValueError):
        return None


def _normalise_entity(tree: Any, point: tuple[int, int, int] | None = None) -> nbtlib.File:
    out = nbtlib.File(deepcopy(_compound(tree)))
    point = point or _points(out)
    if point is not None:
        for key, value in zip(("x", "y", "z"), point, strict=True):
            out[key] = nbtlib.Int(value)
    return out


def _parse_mcstructure(tree: nbtlib.File) -> Structure:
    from .mcstructure_codec import load_layers

    size = _size(tree.get("size"))
    palette, layers, position_data, actors = load_layers(tree, size)
    blocks = [nbtlib.File(deepcopy(item)) for item in palette]
    result = Structure(size)
    if size[0] * size[1] * size[2] > 1_000_000:
        result.native_source = blocks, layers
    for point in () if result.native_source is not None else np.ndindex(size):
        primary = int(layers[(0, *point)])
        secondary = int(layers[(1, *point)]) if len(layers) > 1 else -1
        if primary == -1:
            primary, secondary = secondary, -1
        if primary == -1:
            result.blocks[point] = _block("structure_void")
        if primary >= 0 and str(blocks[primary]["name"]) != "minecraft:air":
            result.blocks[point] = blocks[primary]
        if secondary >= 0 and str(blocks[secondary]["name"]) != "minecraft:air":
            result.secondary_blocks[point] = blocks[secondary]
    origin = tuple(int(v) for v in tree.get("structure_world_origin", [0, 0, 0]))
    if len(origin) != 3:
        raise ValueError("mcstructure 世界原点无效")
    for raw_index, entry in position_data.items():
        # Tick-only entries are not block entities; clipboard operations do not
        # copy scheduled events. Some third-party writers omit the wrapper.
        if "block_entity_data" not in entry and "id" not in entry:
            continue
        try:
            index = int(raw_index)
        except (TypeError, ValueError) as exc:
            raise ValueError("mcstructure 方块实体索引无效") from exc
        if not 0 <= index < size[0] * size[1] * size[2]:
            raise ValueError("mcstructure 方块实体索引越界")
        point = (index // (size[1] * size[2]), index // size[2] % size[1], index % size[2])
        entity = _normalise_entity(entry.get("block_entity_data", entry), point)
        for key, axis in (("pairx", 0), ("pairz", 2)):
            if key in entity:
                entity[key] = nbtlib.Int(int(entity[key]) - origin[axis])
        result.block_entities.append(entity)
    for item in actors:
        entity = _normalise_entity(item)
        if "Pos" in entity:
            entity["Pos"] = type(entity["Pos"])(
                [type(v)(float(v) - origin[i]) for i, v in enumerate(entity["Pos"])]
            )
        result.entities.append(entity)
    return result


def parse(raw: bytes, format: str) -> Structure:
    if format not in FORMATS:
        raise ValueError("不支持的结构格式")
    tree = _read_nbt(raw, byteorder="little" if format == "mcstructure" else "big")
    if format == "mcstructure":
        return _parse_mcstructure(tree)
    from .amulet_structures import convert

    source = "schematic" if "Blocks" in tree else "schem"
    converted = convert(tree, source, "mcstructure", as_tree=True)
    return _parse_mcstructure(converted)


def _structure_from_clipboard(clipboard: Clipboard) -> Structure:
    size = tuple(b - a + 1 for a, b in zip(clipboard.low, clipboard.high, strict=True))
    result = Structure(size)
    if clipboard.chunk_mask is not None:
        result.selected_columns = [
            (
                x * 16 - clipboard.low[0],
                x * 16 + 16 - clipboard.low[0],
                z * 16 - clipboard.low[2],
                z * 16 + 16 - clipboard.low[2],
            )
            for x, z in clipboard.chunk_mask
        ]
    # Allocate the dense format once; never build a dictionary per voxel.
    needed = 8 * int(np.prod(size, dtype=object))
    if needed * 3 > memory_headroom():
        raise ValueError("结构导出所需内存超过当前可用预算，请缩小选区后重试")
    air = new_block("air")
    palette, lookup = [air], {encode_player(air): 0}
    layers = np.full((2, *size), -1, dtype=np.int32)
    if result.selected_columns is None:
        layers[0].fill(0)
    else:
        for x0, x1, z0, z1 in result.selected_columns:
            layers[0, max(0, x0) : max(0, x1), :, max(0, z0) : max(0, z1)] = 0
    items = list(clipboard.sections.items())
    groups = (items[i : i + 8] for i in range(0, len(items), 8))
    decoded = parallel_map(_decode_export_sections, groups, workers=structure_workers(len(items)))
    for group in decoded:
        for (cx, sy, cz), section in group:
            origin = (
                cx * 16 - clipboard.low[0],
                sy * 16 - clipboard.low[1],
                cz * 16 - clipboard.low[2],
            )
            lo = tuple(max(0, -v) for v in origin)
            hi = tuple(min(16, size[i] - origin[i]) for i in range(3))
            if any(a >= b for a, b in zip(lo, hi, strict=True)):
                continue
            target = tuple(slice(origin[i] + lo[i], origin[i] + hi[i]) for i in range(3))
            source = tuple(slice(lo[i], hi[i]) for i in range(3))
            for number, layer in enumerate(section.layers[:2]):
                mapping = []
                for block in layer.palette:
                    identity = encode_player(block)
                    if identity not in lookup:
                        if len(palette) >= MAX_PALETTE:
                            raise ValueError("结构调色板过大")
                        lookup[identity] = len(palette)
                        palette.append(block)
                    mapping.append(
                        -1 if str(block["name"]) == "minecraft:structure_void" else lookup[identity]
                    )
                values = np.asarray(mapping, dtype=np.int32)[
                    np.asarray(layer.indices).reshape(16, 16, 16).transpose(0, 2, 1)
                ]
                layers[(number, *target)] = values[source]
    result.native_source = (palette, layers)
    for raw in clipboard.block_entities:
        for point, tree, _ in entities(unpack(raw)):
            entity = _normalise_entity(tree, tuple(point[i] - clipboard.low[i] for i in range(3)))
            for key, axis in (("pairx", 0), ("pairz", 2)):
                if key in entity:
                    entity[key] = nbtlib.Int(int(entity[key]) - clipboard.low[axis])
            result.block_entities.append(entity)
    for raw in clipboard.actors:
        from .chunk_markers import nbt_records

        for tree in nbt_records(unpack(raw)):
            point = _points(tree)
            if point is not None:
                entity = _normalise_entity(
                    tree, tuple(point[i] - clipboard.low[i] for i in range(3))
                )
                if "Pos" in entity:
                    entity["Pos"] = type(entity["Pos"])(
                        [type(v)(float(v) - clipboard.low[i]) for i, v in enumerate(entity["Pos"])]
                    )
                result.entities.append(entity)
    return result


def _palette(structure: Structure):
    air = new_block("air")
    items = [air]
    identity = encode_player
    lookup = {identity(air): 0}
    seen = set()
    for block in chain(structure.blocks.values(), structure.secondary_blocks.values()):
        if id(block) in seen:
            continue
        seen.add(id(block))
        key = identity(block)
        if key not in lookup:
            if len(items) >= MAX_PALETTE:
                raise ValueError("结构调色板过大")
            lookup[key] = len(items)
            items.append(block)
    return items, lookup


def _export_mcstructure(structure: Structure) -> bytes:
    from .mcstructure_codec import dump_tree

    if structure.native_source is not None:
        palette, layers = structure.native_source
    else:
        palette, lookup = _palette(structure)
        layers = np.full((2, *structure.size), -1, dtype=np.int32)
        if structure.selected_columns is None:
            layers[0].fill(0)
        else:
            for x0, x1, z0, z1 in structure.selected_columns:
                layers[0, x0:x1, :, z0:z1] = 0
        palette_ids = {id(block): lookup[encode_player(block)] for block in palette}
        for number, blocks in enumerate((structure.blocks, structure.secondary_blocks)):
            for point, block in blocks.items():
                if id(block) not in palette_ids:
                    palette_ids[id(block)] = lookup[encode_player(block)]
                layers[(number, *point)] = (
                    -1
                    if str(block["name"]) == "minecraft:structure_void"
                    else palette_ids[id(block)]
                )
    position_data = nbtlib.Compound()
    for entity in structure.block_entities:
        point = _points(entity)
        if point is None or not all(0 <= point[i] < structure.size[i] for i in range(3)):
            raise ValueError("导出方块实体坐标越界")
        x, y, z = point
        index = (x * structure.size[1] + y) * structure.size[2] + z
        position_data[str(index)] = nbtlib.Compound({"block_entity_data": nbtlib.Compound(entity)})
    return _write_nbt(
        dump_tree(structure.size, palette, layers, position_data, structure.entities),
        byteorder="little",
    )


def export_clipboard(clipboard: Clipboard, format: str) -> bytes:
    if format not in FORMATS:
        raise ValueError("不支持的结构格式")
    structure = _structure_from_clipboard(clipboard)
    raw = _export_mcstructure(structure)
    if format == "mcstructure":
        return raw
    if any(value > 32_767 for value in structure.size):
        raise ValueError("schem/schematic 单轴最大 32767；请改用 mcstructure")
    from .amulet_structures import convert

    return convert(_read_nbt(raw), "mcstructure", format)


def _decode_export_sections(items):
    from .voxels import decode

    return [(key, decode(unpack(raw), key[1])) for key, raw in items]


def _encode_native_group(job):
    palette, parts = job
    air, void = new_block("air"), _block("structure_void")
    result = []
    for (cx, sy, cz), cells in parts:
        cells = cells.copy()
        missing = cells[0] == -1
        if len(cells) > 1:
            cells[0][missing] = cells[1][missing]
            cells[1][missing] = -1
        layers, populated = [], False
        for number, values in enumerate(cells):
            ids, inverse = np.unique(values, return_inverse=True)
            blocks = [air] + [
                (void if number == 0 else air) if value == -1 else palette[int(value)]
                for value in ids
            ]
            populated |= any(str(block["name"]) != "minecraft:air" for block in blocks)
            indices = np.zeros((16, 16, 16), dtype=np.uint16)
            sx, sh, sz = values.shape
            indices[:sx, :sz, :sh] = (inverse.reshape(values.shape) + 1).transpose(0, 2, 1)
            layers.append(Layer(blocks, indices.ravel()))
        if populated:
            result.append(((cx, sy, cz), pack(encode(Section(9, sy, layers)))))
    return result


def _compact_sections(structure):
    """Send small section batches, never the complete dense structure, to workers."""
    palette, source = structure.native_source
    w, h, length = structure.size

    def groups():
        parts = []
        for cx in range((w + 15) // 16):
            for sy in range((h + 15) // 16):
                for cz in range((length + 15) // 16):
                    region = (
                        slice(cx * 16, min(w, cx * 16 + 16)),
                        slice(sy * 16, min(h, sy * 16 + 16)),
                        slice(cz * 16, min(length, cz * 16 + 16)),
                    )
                    parts.append(((cx, sy, cz), source[(slice(None), *region)]))
                    if len(parts) == 8:
                        yield palette, parts
                        parts = []
        if parts:
            yield palette, parts

    count = ((w + 15) // 16) * ((h + 15) // 16) * ((length + 15) // 16)
    for group in parallel_map(_encode_native_group, groups(), workers=structure_workers(count)):
        yield from group


def to_clipboard(structure: Structure, budget: int | None = 64 * 1024**2) -> Clipboard:
    w, h, length = structure.size
    air = new_block("air")
    sections = {}
    for key, raw in _compact_sections(structure) if structure.native_source is not None else ():
        sections[key] = raw
    # Empty sections are implicit air.  Keeping only populated sections makes
    # sparse high-rise schematics practical without changing paste semantics.
    builders = {}
    identities = {}
    for number, cells in enumerate((structure.blocks, structure.secondary_blocks)):
        for (x, y, z), block in cells.items():
            if not 0 <= x < w or not 0 <= y < h or not 0 <= z < length:
                raise ValueError("导入结构方块坐标越界")
            layers = builders.setdefault((x // 16, y // 16, z // 16), {})
            if number not in layers:
                layers[number] = ([air], {encode_player(air): 0}, array("H", [0]) * 4096)
            palette, lookup, indices = layers[number]
            if id(block) not in identities:
                identities[id(block)] = encode_player(block)
            key = identities[id(block)]
            if key not in lookup:
                lookup[key] = len(palette)
                palette.append(block)
            indices[(x % 16) * 256 + (z % 16) * 16 + y % 16] = lookup[key]
    for (cx, sy, cz), layers in builders.items():
        encoded = []
        for number in range(max(layers) + 1):
            palette, _, indices = layers.get(number, ([air], {}, array("H", [0]) * 4096))
            encoded.append(Layer(palette, indices))
        sections[(cx, sy, cz)] = pack(encode(Section(9, sy, encoded)))
    block_entities = []
    for tree in structure.block_entities:
        raw = encode_player(_normalise_entity(tree))
        block_entities.append(pack(raw))
    actors = []
    for tree in structure.entities:
        out = _normalise_entity(tree)
        if "Pos" not in out:
            point = _points(out)
            if point is None:
                continue
            out["Pos"] = nbtlib.List[nbtlib.Double]([float(v) + 0.5 for v in point])
        if "UniqueID" not in out:
            out["UniqueID"] = nbtlib.Long(-len(actors) - 1)
        actors.append(pack(encode_player(out)))
    clip = Clipboard(
        (0, 0, 0),
        (w - 1, h - 1, length - 1),
        None,
        False,
        sections,
        block_entities,
        actors,
        True,
    )
    if budget is not None and clip.size > budget:
        raise ValueError("导入结构超过共享 64 MB 预算")
    return clip
