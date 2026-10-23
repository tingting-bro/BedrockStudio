"""Session-local compressed terrain clipboard, including lossless block-entity NBT."""

from __future__ import annotations

import json
import struct
from copy import deepcopy
from dataclasses import dataclass, field
from functools import lru_cache
from hashlib import sha256
from io import BytesIO
from itertools import product
from math import ceil
from typing import Any

import nbtlib
import numpy as np

from .chunks import chunk_key
from .snapshots import pack, unpack
from .voxel_transform import GridTransform, transform_block
from .voxels import (
    Layer,
    Section,
    decode,
    descriptor,
    effective,
    encode,
    new_block,
    selected_cell,
    selection_intersects,
)

_PREVIEW_LIMIT = 8 * 1024**2
_VIEW_PREVIEW_LIMIT = 64 * 1024**2


class _PreviewBudgetExceeded(ValueError):
    pass


def entities(raw: bytes):
    stream = BytesIO(raw)
    while stream.tell() < len(raw):
        start = stream.tell()
        try:
            tree = nbtlib.File.parse(stream, byteorder="little")
            point = tuple(int(tree[k]) for k in ("x", "y", "z"))
        except Exception as exc:
            raise ValueError("方块实体无法无损读取，整批已取消") from exc
        original = raw[start : stream.tell()]
        # Keep original bytes for untouched records. Parsed extensions are retained;
        # noncanonical serialization alone must not reject an entire import.
        yield point, tree, original


@dataclass
class Clipboard:
    low: tuple[int, int, int]
    high: tuple[int, int, int]
    sphere: tuple[int, int, int, int] | None
    hollow: bool
    sections: dict
    block_entities: list
    actors: list = field(default_factory=list)
    budgeted: bool = True
    source_dimension: int | None = None
    source_revision: int | None = None
    source_fingerprints: dict = field(default_factory=dict)
    chunk_mask: frozenset | None = None

    @property
    def size(self):
        return (
            sum(map(len, self.sections.values()))
            + sum(map(len, self.block_entities))
            + sum(map(len, self.actors))
            + len(self.source_fingerprints) * 32
            + (len(self.chunk_mask) * 16 if self.chunk_mask is not None else 0)
        )

    @property
    def budget_size(self):
        return self.size if self.budgeted else 0


def copy_selection(
    chunks,
    dimension,
    low,
    high,
    sphere=None,
    hollow=False,
    budget=64 * 1024**2,
    *,
    include_block_entities=True,
    include_entities=True,
    allow_large=False,
    source_revision=None,
    chunk_mask=None,
):
    from .voxels import validate_chunk_mask

    chunk_mask = validate_chunk_mask(chunk_mask, low, high, sphere, hollow)
    if chunks.reset:
        raise ValueError("请先保存或还原维度重置")
    if any(a > b for a, b in zip(low, high, strict=True)) or not -2048 <= low[1] <= high[1] <= 2047:
        raise ValueError("方块选区范围无效")
    if (
        not allow_large
        and (high[0] // 16 - low[0] // 16 + 1) * (high[2] // 16 - low[2] // 16 + 1) > 1_000_000
    ):
        raise ValueError("选区超过世界索引保护范围")
    clip = Clipboard(
        low,
        high,
        sphere,
        hollow,
        {},
        [],
        source_dimension=dimension,
        source_revision=source_revision,
        chunk_mask=chunk_mask,
    )
    retained = chunks.retained_bytes - (chunks.clipboard.budget_size if chunks.clipboard else 0)
    size = len(chunk_mask) * 16 if chunk_mask is not None else 0
    if budget is not None and retained + size > budget:
        raise ValueError("复制超过共享 64 MB 预算，原剪贴板已保留")

    def inside(x, y, z):
        return selected_cell(x, y, z, low, high, sphere, hollow, chunk_mask)

    def add(raw, destination, key=None):
        nonlocal size
        packed = pack(raw)
        size += len(packed)
        if budget is not None and retained + size > budget:
            raise ValueError("复制超过共享 64 MB 预算，原剪贴板已保留")
        if key is None:
            destination.append(packed)
        else:
            destination[key] = packed

    for cx in range(low[0] // 16, high[0] // 16 + 1):
        for cz in range(low[2] // 16, high[2] // 16 + 1):
            if chunk_mask is not None and (cx, cz) not in chunk_mask:
                continue
            if not selection_intersects(
                (cx * 16, low[1], cz * 16),
                (cx * 16 + 15, high[1], cz * 16 + 15),
                low,
                high,
                sphere,
                hollow,
            ):
                continue
            records = effective(chunks, (dimension, cx, cz))
            clip.source_fingerprints[dimension, cx, cz] = source_fingerprint(records)
            size += 32
            if budget is not None and retained + size > budget:
                raise ValueError("复制超过共享 64 MB 预算，原剪贴板已保留")
            tags = {chunk_key(bytes.fromhex(key))[1] for key in records}
            if records and not tags.intersection((0x2F, 0x30)):
                raise ValueError("源区块没有可读取的地形记录，整批已取消")
            found = set()
            seen = set()
            # Missing or staged-deleted chunks have no blocks or block entities.
            # Materialize selected air sections below, using the same budget and shape checks.
            for key, raw in records.items():
                parsed = chunk_key(bytes.fromhex(key))
                if parsed[1] == 0x2F:
                    if parsed[2] in seen:
                        raise ValueError("存在重复高度的子区块键，整批已取消")
                    seen.add(parsed[2])
                    decode(raw, parsed[2])
                # Legacy terrain and pending-event records have no modern
                # voxel representation. Modern sections are still copied;
                # unavailable selected cells are materialized as air below.
                if parsed[1] == 0x2F and low[1] // 16 <= parsed[2] <= high[1] // 16:
                    sy = parsed[2]
                    if not selection_intersects(
                        (cx * 16, sy * 16, cz * 16),
                        (cx * 16 + 15, sy * 16 + 15, cz * 16 + 15),
                        low,
                        high,
                        sphere,
                        hollow,
                    ):
                        continue
                    found.add(sy)
                    add(raw, clip.sections, (cx, sy, cz))
                elif parsed[1] == 0x31 and include_block_entities:
                    for point, _tree, original in entities(raw):
                        if not inside(*point):
                            continue
                        add(original, clip.block_entities)
            if not allow_large:
                for sy in range(low[1] // 16, high[1] // 16 + 1):
                    if sy in found:
                        continue
                    if selection_intersects(
                        (cx * 16, sy * 16, cz * 16),
                        (cx * 16 + 15, sy * 16 + 15, cz * 16 + 15),
                        low,
                        high,
                        sphere,
                        hollow,
                    ):
                        add(encode(Section(9, sy, [])), clip.sections, (cx, sy, cz))
    if include_entities:
        from .clipboard_actors import capture

        clip.actors = capture(chunks, dimension, low, high, sphere, hollow, add, chunk_mask)
    chunks.clipboard = clip
    return {
        "size": [b - a + 1 for a, b in zip(low, high, strict=True)],
        "bytes": size,
        "block_entities": len(clip.block_entities),
        "entities": len(clip.actors),
    }


def source_fingerprint(records):
    digest = sha256()
    for key, raw in sorted(records.items()):
        encoded = bytes.fromhex(key)
        digest.update(struct.pack("<II", len(encoded), len(raw)))
        digest.update(encoded)
        digest.update(raw)
    return digest.digest()


class Paste:
    def __init__(
        self,
        clipboard: Clipboard,
        origin: tuple[int, int, int],
        rotation=(0, 0, 0),
        mirror=(False, False, False),
        skip_unsupported=False,
        axis_order="xyz",
        replace_existing=True,
        paste_air=True,
        scale=1,
    ):
        self.clipboard = clipboard
        self.transform = GridTransform(
            clipboard.low, clipboard.high, origin, rotation, mirror, axis_order, scale
        )
        self.replace_existing = replace_existing
        self.paste_air = paste_air
        self.bounds = self.transform.bounds
        self.skip_unsupported = skip_unsupported
        high = self.bounds[1]
        if not -2048 <= origin[1] <= high[1] <= 2047 or any(
            not -(2**35) <= v < 2**35 for v in (origin[0], origin[2], high[0], high[2])
        ):
            raise ValueError("粘贴范围超过坐标或高度限制")
        self.air = new_block("air")
        # Per-operation cache, bounded independently of the selection volume.
        self.section = lru_cache(maxsize=32)(self._section)
        self.moved_entities: dict[tuple[int, int], list] = {}
        self.scaled_entities = []
        for raw in clipboard.block_entities:
            for point, tree, _ in entities(unpack(raw)):
                tree = deepcopy(tree)
                position = self.transform.point(point)
                for axis, value in zip(("x", "y", "z"), position, strict=True):
                    if not -(2**31) <= value < 2**31:
                        raise ValueError("方块实体坐标超过 NBT Int 范围")
                    tree[axis] = nbtlib.Int(value)
                if "pairx" in tree or "pairz" in tree:
                    pair_fields = all(
                        getattr(tree.get(k), "tag_id", None) in (1, 2, 3, 4)
                        for k in ("pairx", "pairz")
                    )
                    paired = None
                    if pair_fields:
                        paired = (int(tree["pairx"]), point[1], int(tree["pairz"]))
                    if (
                        paired is None
                        or self.cell(*self.transform.point(paired)) is None
                        or self.transform.point(paired)[1] != position[1]
                        or self.transform.scale != 1
                    ):
                        for key in ("pairx", "pairz", "pairlead"):
                            tree.pop(key, None)
                    else:
                        pair = self.transform.point(paired)
                        for axis, value in (("pairx", pair[0]), ("pairz", pair[2])):
                            if not -(2**31) <= value < 2**31:
                                raise ValueError("双箱坐标超过 NBT Int 范围")
                            tree[axis] = nbtlib.Int(value)
                if not self.transform.orientation_identity:
                    if "Rot" in tree:
                        heading = nbtlib.File(
                            {
                                "name": nbtlib.String("minecraft:standing_sign"),
                                "states": nbtlib.Compound({"ground_sign_direction": tree["Rot"]}),
                            }
                        )
                        tree["Rot"] = transform_block(heading, self.transform, allow_unknown=True)[
                            "states"
                        ]["ground_sign_direction"]
                    for key in ("facing", "Facing", "facing_direction"):
                        if key in tree:
                            facing = nbtlib.File(
                                {
                                    "name": nbtlib.String("minecraft:dispenser"),
                                    "states": nbtlib.Compound({"facing_direction": tree[key]}),
                                }
                            )
                            tree[key] = transform_block(facing, self.transform, allow_unknown=True)[
                                "states"
                            ]["facing_direction"]
                if self.transform.scale != 1:
                    self.scaled_entities.append((point, tree))
                    continue
                out = BytesIO()
                tree.write(out, byteorder="little")
                self.moved_entities.setdefault((position[0] // 16, position[2] // 16), []).append(
                    (position, out.getvalue())
                )

    def _section(self, cx, sy, cz):
        raw = self.clipboard.sections.get((cx, sy, cz))
        return decode(unpack(raw), sy) if raw is not None else Section(9, sy, [])

    def cell(self, x, y, z) -> tuple[Any, ...] | None:
        point = self.transform.inverse((x, y, z))
        c = self.clipboard
        if not selected_cell(*point, c.low, c.high, c.sphere, c.hollow, c.chunk_mask):
            return None
        x, y, z = point
        section = self.section(x // 16, y // 16, z // 16)
        i = (x % 16) * 256 + (z % 16) * 16 + y % 16
        values = []
        for layer in section.layers:
            index = layer.indices[i]
            if not hasattr(layer, "transformed"):
                layer.transformed = {}
            if index not in layer.transformed:
                # Unsupported direction states retain their original typed NBT.
                layer.transformed[index] = transform_block(
                    layer.palette[index], self.transform, allow_unknown=True
                )
            values.append(layer.transformed[index])
        if values and str(values[0]["name"]) == "minecraft:structure_void":
            return None
        if not self.paste_air and all(str(v["name"]) == "minecraft:air" for v in values):
            return None
        return tuple(values) or (self.air,)

    def includes(self, x, y, z):
        point = self.transform.inverse((x, y, z))
        c = self.clipboard
        return selected_cell(*point, c.low, c.high, c.sphere, c.hollow, c.chunk_mask)

    def intersects(self, low, high):
        c = self.clipboard
        a, b = self.transform.inverse(low), self.transform.inverse(high)
        low = tuple(min(x, y) for x, y in zip(a, b, strict=True))
        high = tuple(max(x, y) for x, y in zip(a, b, strict=True))
        return selection_intersects(low, high, c.low, c.high, c.sphere, c.hollow, c.chunk_mask)

    def entities(self, coordinate, touched):
        total = 0
        for point, raw in self.moved_entities.get(coordinate[1:], []):
            if touched(point):
                total += len(raw)
                if total > 16 << 20:
                    raise ValueError("粘贴后的方块实体超过单记录 16 MB 上限")
                yield raw
        # Expand containers only for the chunk being processed; never allocate
        # a scale-cubed list before the operation's shared budget preflight.
        for point, template in self.scaled_entities:
            v = self.transform.vector(
                tuple(a - b for a, b in zip(point, self.clipboard.low, strict=True))
            )
            ranges = []
            for i, (a, b, c, size) in enumerate(
                zip(
                    v,
                    self.transform.minimum,
                    self.transform.origin,
                    self.transform.size,
                    strict=True,
                )
            ):
                low, high = (
                    c + ceil((a - b) * self.transform.scale),
                    c + min(size, ceil((a - b + 1) * self.transform.scale)),
                )
                if i != 1:
                    chunk = coordinate[1 if i == 0 else 2] * 16
                    low, high = max(low, chunk), min(high, chunk + 16)
                ranges.append(range(low, high))
            for position in product(*ranges):
                if not touched(position):
                    continue
                tree = deepcopy(template)
                for axis, value in zip(("x", "y", "z"), position, strict=True):
                    if not -(2**31) <= value < 2**31:
                        raise ValueError("方块实体坐标超过 NBT Int 范围")
                    tree[axis] = nbtlib.Int(value)
                out = BytesIO()
                tree.write(out, byteorder="little")
                raw = out.getvalue()
                total += len(raw)
                if total > 16 << 20:
                    raise ValueError("粘贴后的方块实体超过单记录 16 MB 上限")
                yield raw


class EraseSelection(Paste):
    """Use the exact clipboard shape and pair validation when clearing a move source."""

    clearing = True

    def cell(self, x, y, z):
        return (self.air,) if self.includes(x, y, z) else None

    def entities(self, coordinate, touched):
        return []


def transformed_preview(
    clipboard,
    rotation,
    mirror,
    skip_unsupported=False,
    view=None,
    required=None,
    axis_order="xyz",
    scale=1,
):
    """Rebuild the bounded preview from the same typed states used at commit."""
    # Preview only terrain: do not transform/validate unrelated container NBT.
    terrain = Clipboard(
        clipboard.low,
        clipboard.high,
        clipboard.sphere,
        clipboard.hollow,
        clipboard.sections,
        [],
        chunk_mask=clipboard.chunk_mask,
    )
    paste = Paste(
        terrain, (0, -2048, 0), rotation, mirror, skip_unsupported, axis_order, scale=scale
    )
    limit = _VIEW_PREVIEW_LIMIT if view is not None else _PREVIEW_LIMIT
    sections = {}
    palette_ids = {}
    transformed = {}
    used = 0

    def finish(truncated=False):
        sphere = (
            (*paste.transform.point(clipboard.sphere[:3]), clipboard.sphere[3])
            if clipboard.sphere and paste.transform.scale == 1
            else None
        )
        result = Clipboard(
            *paste.bounds,
            sphere,
            clipboard.hollow if paste.transform.scale == 1 else False,
            {key: pack(encode(section)) for key, section in sections.items()},
            [],
        )
        result.preview_truncated = truncated
        return result

    local = np.indices((16, 16, 16)).reshape(3, -1)[[0, 2, 1]].T
    matrix = np.asarray(paste.transform.columns, dtype=np.int64)
    shift = np.asarray(paste.transform.origin) - np.asarray(paste.transform.minimum)
    source_sections = list(clipboard.sections.items())
    if view is not None:
        center_x, center_z = (view[0] + view[1]) / 2, (view[2] + view[3]) / 2

        def distance(item):
            (cx, sy, cz), _ = item
            point = paste.transform.point((cx * 16 + 8, sy * 16 + 8, cz * 16 + 8))
            return (point[0] - center_x) ** 2 + (point[2] - center_z) ** 2

        source_sections.sort(key=distance)

    def samples():
        if paste.transform.scale == 1:
            for (cx, sy, cz), raw in source_sections:
                source = local + (cx * 16, sy * 16, cz * 16)
                yield sy, raw, source, (source - clipboard.low) @ matrix + shift
            return
        low, high = map(list, paste.bounds)
        if view is not None:
            low[0], high[0] = max(low[0], view[0]), min(high[0], view[1])
            low[2], high[2] = max(low[2], view[2]), min(high[2], view[3])
        for cx, sy, cz in product(
            *(range(a // 16, b // 16 + 1) for a, b in zip(low, high, strict=True))
        ):
            if required is not None and (cx, cz) not in required:
                continue
            destination = local + (cx * 16, sy * 16, cz * 16)
            destination = destination[np.all((destination >= low) & (destination <= high), axis=1)]
            if not len(destination):
                continue
            # Pull destination samples, so enlarging fills every voxel and
            # shrinking cannot collide or overwrite samples in iteration order.
            relative = destination - paste.transform.origin
            numerator, denominator = paste.transform.numerator, paste.transform.denominator
            maximum = np.iinfo(np.int64).max
            if (
                denominator <= maximum
                and denominator * int(np.max(np.abs(relative))) <= maximum
                and numerator <= maximum
            ):
                oriented = relative * denominator // numerator
            else:
                oriented = np.asarray(
                    [[int(v) * denominator // numerator for v in point] for point in relative],
                    dtype=np.int64,
                )
            source = (oriented + paste.transform.minimum) @ matrix.T + clipboard.low
            keys, groups = np.unique(source // 16, axis=0, return_inverse=True)
            for group, key in enumerate(keys):
                raw = clipboard.sections.get(tuple(map(int, key)))
                if raw is not None:
                    members = groups == group
                    yield int(key[1]), raw, source[members], destination[members]

    for sy, _raw, source, destination in samples():
        valid = np.all((source >= clipboard.low) & (source <= clipboard.high), axis=1)
        if view is not None:
            valid &= (
                (destination[:, 0] >= view[0])
                & (destination[:, 0] <= view[1])
                & (destination[:, 2] >= view[2])
                & (destination[:, 2] <= view[3])
            )
        if not np.any(valid):
            continue
        if clipboard.sphere or clipboard.hollow or clipboard.chunk_mask is not None:
            valid &= np.asarray(
                [
                    selected_cell(
                        *map(int, point),
                        clipboard.low,
                        clipboard.high,
                        clipboard.sphere,
                        clipboard.hollow,
                        clipboard.chunk_mask,
                    )
                    if keep
                    else False
                    for point, keep in zip(source, valid, strict=True)
                ]
            )
        positions = np.flatnonzero(valid)
        if not len(positions):
            continue
        dest_points = destination[positions]
        keys, groups = np.unique(dest_points // 16, axis=0, return_inverse=True)
        if required is not None and not any((int(key[0]), int(key[2])) in required for key in keys):
            continue
        section = paste.section(int(source[0, 0]) // 16, sy, int(source[0, 2]) // 16)
        for group, coordinate in enumerate(keys):
            key = tuple(map(int, coordinate))
            if required is not None and (key[0], key[2]) not in required:
                continue
            members = groups == group
            local_dest = dest_points[members] % 16
            dest_indices = local_dest[:, 0] * 256 + local_dest[:, 2] * 16 + local_dest[:, 1]
            dest = sections.setdefault(key, Section(9, key[1], []))
            for layer_index, layer in enumerate(section.layers):
                if len(dest.layers) <= layer_index:
                    if used + 8192 > limit:
                        if view is None:
                            raise _PreviewBudgetExceeded("变换后的预览超过预算")
                        return finish(truncated=True)
                    used += 8192
                    dest.layers.append(Layer([paste.air], np.zeros(4096, dtype=np.uint16)))
                    palette_ids[key, layer_index] = {}
                dest_layer = dest.layers[layer_index]
                ids = palette_ids[key, layer_index]
                source_local = source[positions[members]] % 16
                source_indices = np.asarray(layer.indices)[
                    source_local[:, 0] * 256 + source_local[:, 2] * 16 + source_local[:, 1]
                ]
                lookup = np.zeros(len(layer.palette), dtype=np.uint16)
                for index in np.unique(source_indices):
                    tree = layer.palette[int(index)]
                    identity = id(tree)
                    # Retain the source object alongside its cached transform: ids cannot be reused.
                    cached = transformed.get(identity)
                    if cached is None:
                        cached = tree, transform_block(tree, paste.transform, allow_unknown=True)
                        transformed[identity] = cached
                    tree = cached[1]
                    if identity not in ids:
                        out = BytesIO()
                        tree.write(out, byteorder="little")
                        used += len(out.getvalue())
                        if used > limit:
                            if view is None:
                                raise _PreviewBudgetExceeded("变换后的预览超过预算")
                            return finish(truncated=True)
                        ids[identity] = len(dest_layer.palette)
                        dest_layer.palette.append(tree)
                    lookup[index] = ids[identity]
                dest_layer.indices[dest_indices] = lookup[source_indices]
    return finish()


def preview_data(
    clipboard: Clipboard | None,
    rotation=(0, 0, 0),
    mirror=(False, False, False),
    skip_unsupported=False,
    camera: tuple[float, float, float] | None = None,
    render_distance: int | None = None,
    camera_origin: tuple[float, float, float] = (0, 0, 0),
    cached: frozenset[tuple[int, int]] = frozenset(),
    axis_order="xyz",
    scale=1,
) -> bytes:
    """Read-only scene payload, optionally limited to visible camera chunks."""
    if clipboard is None:
        raise ValueError("请先复制方块选区")
    view = None
    transform = GridTransform(
        clipboard.low, clipboard.high, (0, -2048, 0), rotation, mirror, axis_order, scale
    )
    center = None
    if camera is not None and render_distance is not None:
        radius = max(0, int(render_distance))
        cx = int((camera[0] - camera_origin[0] + transform.bounds[0][0]) // 16)
        cz = int((camera[2] - camera_origin[2] + transform.bounds[0][2]) // 16)
        center = cx, cz
        view = (
            (cx - radius - 1) * 16,
            (cx + radius + 1) * 16 + 15,
            (cz - radius - 1) * 16,
            (cz + radius + 1) * 16 + 15,
        )
        if transform.identity:
            # Identity preview retains source coordinates in its payload.
            sx = int((camera[0] - camera_origin[0] + clipboard.low[0]) // 16)
            sz = int((camera[2] - camera_origin[2] + clipboard.low[2]) // 16)
            center = sx, sz
            visible = {
                key: raw
                for key, raw in clipboard.sections.items()
                if abs(key[0] - sx) <= radius + 1 and abs(key[2] - sz) <= radius + 1
            }
            clipboard = Clipboard(
                clipboard.low,
                clipboard.high,
                clipboard.sphere,
                clipboard.hollow,
                visible,
                [],
                chunk_mask=clipboard.chunk_mask,
            )
    if not transform.identity:
        try:
            required = None
            if center is not None:
                new_targets = {
                    (x, z)
                    for x in range(center[0] - radius, center[0] + radius + 1)
                    for z in range(center[1] - radius, center[1] + radius + 1)
                    if (x, z) not in cached
                }
                required = {
                    (x + dx, z + dz)
                    for x, z in new_targets
                    for dx, dz in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1))
                }
            clipboard = transformed_preview(
                clipboard, rotation, mirror, skip_unsupported, view, required, axis_order, scale
            )
        except _PreviewBudgetExceeded:
            clipboard = Clipboard(*transform.bounds, None, clipboard.hollow, {}, [])
    # A view-limited request can safely carry more sections than the legacy
    # clipboard preview cap; the camera radius still bounds the payload.
    limit = _VIEW_PREVIEW_LIMIT if camera is not None else _PREVIEW_LIMIT

    def outline():
        header = json.dumps(
            {
                "low": clipboard.low,
                "size": [b - a + 1 for a, b in zip(clipboard.low, clipboard.high, strict=True)],
                "chunks": [],
            },
            separators=(",", ":"),
        ).encode()
        return struct.pack("<I", len(header)) + header

    buffers, items = [], []
    offset = 0
    truncated = getattr(clipboard, "preview_truncated", False)
    grouped: dict[tuple[int, int], list] = {}
    for coordinate, raw in clipboard.sections.items():
        cx, sy, cz = coordinate
        grouped.setdefault((cx, cz), []).append((sy, raw))
    air = descriptor(new_block("air"))
    targets = {
        key
        for key in grouped
        if key not in cached
        and (
            center is None
            or (abs(key[0] - center[0]) <= radius and abs(key[1] - center[1]) <= radius)
        )
    }
    context = {
        (x + dx, z + dz)
        for x, z in targets
        for dx, dz in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1))
    }
    groups = [(key, sections) for key, sections in grouped.items() if key in context]
    if center is not None:
        groups.sort(key=lambda item: (item[0][0] - center[0]) ** 2 + (item[0][1] - center[1]) ** 2)
    for (cx, cz), sections in groups:
        meta = {"x": cx, "z": cz, "missing": False, "sections": []}
        layers_data = []
        layer_offset = 0
        for sy, raw in sections:
            section = decode(unpack(raw), sy)
            entry = {"y": sy, "layers": []}
            full = (
                clipboard.sphere is None
                and not clipboard.hollow
                and all(
                    a <= b and c <= d
                    for a, b, c, d in zip(
                        clipboard.low,
                        (cx * 16, sy * 16, cz * 16),
                        (cx * 16 + 15, sy * 16 + 15, cz * 16 + 15),
                        clipboard.high,
                        strict=True,
                    )
                )
                and (clipboard.chunk_mask is None or (cx, cz) in clipboard.chunk_mask)
            )
            mask = (
                None
                if full
                else [
                    selected_cell(
                        cx * 16 + i // 256,
                        sy * 16 + i % 16,
                        cz * 16 + i // 16 % 16,
                        clipboard.low,
                        clipboard.high,
                        clipboard.sphere,
                        clipboard.hollow,
                        clipboard.chunk_mask,
                    )
                    for i in range(4096)
                ]
            )
            for layer in section.layers:
                from .voxels import render_descriptor

                palette = [render_descriptor(tree) for tree in layer.palette]
                air_id = len(palette)
                palette.append(air)
                indices = (
                    layer.indices
                    if mask is None
                    else [value if mask[i] else air_id for i, value in enumerate(layer.indices)]
                )
                entry["layers"].append({"palette": palette, "offset": layer_offset})
                layers_data.append(struct.pack("<4096H", *indices))
                layer_offset += 8192

            meta["sections"].append(entry)
        header = json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode()
        size = 4 + len(header) + layer_offset
        # Reserve metadata per chunk, so a large index never erases prepared payloads.
        if offset + size + (len(items) + 1) * 64 + 1024 > limit:
            truncated = True
            break
        items.append({"offset": offset, "length": size, "render": (cx, cz) in targets})
        buffers.extend([struct.pack("<I", len(header)), header, *layers_data])
        offset += size
    header = json.dumps(
        {
            "low": clipboard.low,
            "size": [b - a + 1 for a, b in zip(clipboard.low, clipboard.high, strict=True)],
            "chunks": items,
            "truncated": truncated,
        },
        separators=(",", ":"),
    ).encode()
    if offset + len(header) + 4 > limit:
        return outline()
    return struct.pack("<I", len(header)) + header + b"".join(buffers)
