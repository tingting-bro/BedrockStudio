"""Optional viewport markers from actual stored entity and structure positions."""

import struct
from base64 import b64decode
from collections.abc import Callable, Mapping
from io import BytesIO
from math import isfinite
from typing import Any

import nbtlib

from .chunks import ChunkEditor


def nbt_records(raw: bytes) -> list[nbtlib.File]:
    """Coordinate entities contain consecutive little-endian Compound roots."""
    stream = BytesIO(raw)
    trees = []
    while stream.tell() < len(raw):
        if len(trees) >= 2048:
            raise ValueError("标记记录数量过多")
        start = stream.tell()
        try:
            tree = nbtlib.File.parse(stream, byteorder="little")
            encoded = BytesIO()
            tree.write(encoded, byteorder="little")
        except Exception as exc:
            raise ValueError("标记 NBT 无法读取") from exc
        if encoded.getvalue() != raw[start : stream.tell()]:
            raise ValueError("标记 NBT 含不支持的扩展数据")
        trees.append(tree)
    return trees


def position(tree: nbtlib.File) -> tuple[float, float, float] | None:
    values = tree.get("Pos")
    if not isinstance(values, (nbtlib.List, nbtlib.IntArray)) or len(values) != 3:
        values = [tree.get(axis) for axis in ("x", "y", "z")]
    if not all(getattr(value, "tag_id", None) in (1, 2, 3, 4, 5, 6) for value in values):
        return None
    result = tuple(float(value) for value in values)
    return result if all(isfinite(value) and abs(value) <= 2**35 for value in result) else None


def markers(
    chunks: ChunkEditor,
    dimension: int,
    bounds: tuple[int, int, int, int],
    layers: list[str],
    *,
    staged: Mapping[str, Any] | None = None,
    register: Callable[[str, str, int], str] | None = None,
    points: list[dict[str, int]] | None = None,
    limit: int = 2000,
) -> dict[str, Any]:
    if not layers:
        return {"items": [], "truncated": False, "unreadable": 0}
    min_x, max_x, min_z, max_z = bounds
    region = (
        chunks.region(dimension, min_x, max_x, min_z, max_z, limit=1024)
        if points is None
        else {"items": points, "truncated": False}
    )
    points = [
        p
        for p in region["items"]
        if (dimension, p["x"], p["z"]) not in chunks.pending
        and (dimension, p["x"], p["z"]) not in chunks.created
    ]
    result: dict[str, dict[str, Any]] = {}
    truncated, unreadable, read_bytes = region["truncated"], 0, 0
    seen = set()

    def add(
        identifier: str,
        kind: str,
        label: str,
        x: float,
        y: float,
        z: float,
        area: dict[str, int] | None = None,
        source: tuple[str, str, int] | None = None,
        object_type: str | None = None,
        icon_type: str | None = None,
        render: dict[str, Any] | None = None,
    ) -> None:
        nonlocal truncated
        if not (min_x * 16 <= x < (max_x + 1) * 16 and min_z * 16 <= z < (max_z + 1) * 16):
            return
        if len(result) >= limit:
            truncated = True
            return
        result[identifier] = {
            "id": identifier,
            "kind": kind,
            "label": label[:160],
            "x": x,
            "y": y,
            "z": z,
            "area": area,
            "object_type": object_type or kind,
            "icon_type": icon_type,
            "render": render,
            "source_name": identifier,
            "object_ref": register(*source)
            if register is not None and source is not None
            else None,
        }

    for offset in range(0, len(points), 64):
        response = chunks.store.request(
            "chunk-markers", dimension=dimension, chunks=points[offset : offset + 64], layers=layers
        )
        truncated |= response["truncated"]
        for item in response["items"]:
            if chunks.blocks_cleared(item["key"]):
                continue
            if item["key"] in seen:
                continue
            seen.add(item["key"])
            edited = staged.get(item["key"]) if staged is not None else None
            if edited is not None and edited.deleted:
                continue
            raw = edited.current if edited is not None else b64decode(item["value"], validate=True)
            read_bytes += len(raw)
            if read_bytes > 64 * 1024 * 1024:
                truncated = True
                break
            try:
                if item["kind"] == "structures":
                    # Hardcoded spawning areas: uint32 count, six int32 bounds and uint8 type.
                    if len(raw) < 4:
                        raise ValueError("结构区域数据不完整")
                    count = struct.unpack_from("<I", raw)[0]
                    if count > 2000 or len(raw) != 4 + count * 25:
                        raise ValueError("不支持的结构区域格式")
                    for index in range(count):
                        x0, y0, z0, x1, y1, z1, kind = struct.unpack_from(
                            "<iiiiiiB", raw, 4 + index * 25
                        )
                        if x0 > x1 or y0 > y1 or z0 > z1:
                            raise ValueError("结构区域范围无效")
                        area = {"min_x": x0, "max_x": x1, "min_z": z0, "max_z": z1}
                        add(
                            f"{item['key']}:{index}",
                            "structures",
                            f"结构生成区域 #{kind}",
                            (x0 + x1) / 2,
                            y0,
                            (z0 + z1) / 2,
                            area,
                            (item["key"], "structures", index),
                        )
                else:
                    for index, tree in enumerate(nbt_records(raw)):
                        pos = position(tree)
                        if pos is None:
                            continue
                        stored_dimension = tree.get("DimensionId", tree.get("Dimension"))
                        if stored_dimension is not None and int(stored_dimension) != dimension:
                            continue
                        fallback = "未知方块实体" if item["kind"] == "blocks" else "未知实体"
                        label = str(tree.get("identifier", tree.get("id", fallback)))
                        custom = tree.get("CustomName")
                        if isinstance(custom, nbtlib.String) and custom:
                            label = f"{custom} · {label}"
                        unique_id = tree.get("UniqueID")
                        identifier = (
                            str(int(unique_id))
                            if getattr(unique_id, "tag_id", None) in (1, 2, 3, 4)
                            else f"{item['key']}:{index}"
                        )
                        mode = (
                            "actor"
                            if bytes.fromhex(item["key"]).startswith(b"actorprefix")
                            else item["kind"]
                        )
                        add(
                            f"{item['kind']}:{identifier}",
                            item["kind"],
                            label,
                            *pos,
                            source=(item["key"], mode, index),
                            object_type=str(tree.get("identifier", tree.get("id", "unknown"))),
                            icon_type=(
                                str(tree["Item"]["Name"])
                                if isinstance(tree.get("Item"), nbtlib.Compound)
                                and isinstance(tree["Item"].get("Name"), nbtlib.String)
                                else None
                            ),
                            render=entity_render(tree) if item["kind"] == "entities" else None,
                        )
            except (ValueError, TypeError, OverflowError):
                unreadable += 1
        if read_bytes > 64 * 1024 * 1024 or len(result) >= limit:
            break
    return {"items": list(result.values()), "truncated": truncated, "unreadable": unreadable}


def entity_render(tree: nbtlib.File) -> dict[str, Any]:
    """Small, validated display metadata; source NBT remains untouched."""
    rotation = tree.get("Rotation")
    angles = [0.0, 0.0]
    if isinstance(rotation, nbtlib.List) and len(rotation) == 2:
        for index, value in enumerate(rotation):
            if getattr(value, "tag_id", None) in (1, 2, 3, 4, 5, 6):
                angle = float(value)
                if isfinite(angle):
                    angles[index] = angle % 360
    scale = tree.get("Scale", 1)
    if getattr(scale, "tag_id", None) not in (1, 2, 3, 4, 5, 6):
        scale = 1
    scale = float(scale)
    if not isfinite(scale) or not 0.01 <= scale <= 100:
        scale = 1.0
    baby = tree.get("IsBaby")
    result = {
        "rotation": angles,
        "scale": scale,
        "baby": isinstance(baby, nbtlib.Byte) and bool(baby),
    }
    if isinstance(tree.get("Sheared"), nbtlib.Byte):
        result["sheared"] = bool(tree["Sheared"])
    return result
