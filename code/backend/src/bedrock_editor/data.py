"""Supported data collections and lossless Bedrock map image previews."""

import re
import struct
import zlib
from typing import Literal

import nbtlib

DataCategory = Literal["maps", "tickingareas", "structures", "portals", "scoreboard", "other"]
DATA_CATEGORIES = ("maps", "tickingareas", "structures", "portals", "scoreboard", "other")
RecordCategory = Literal["players", "maps", "tickingareas", "structures", "portals"]
RECORD_CATEGORIES = ("players", "maps", "tickingareas", "structures", "portals")


def record_sort_key(item: dict[str, str]) -> tuple[int, str, str]:
    """Sort shortest names first, then alphabetically without case sensitivity."""
    name = item["name"]
    return len(name), name.casefold(), name


def new_record_tree(category: RecordCategory, name: str) -> nbtlib.File:
    """Validate a supported logical key before constructing its initial NBT."""
    if category not in RECORD_CATEGORIES:
        raise ValueError("记录分类无效")
    if (
        not name
        or len(name.encode("utf-8")) > 512
        or any(ord(c) < 32 or ord(c) == 127 for c in name)
    ):
        raise ValueError("记录名称不能为空、包含控制字符或超过 512 个 UTF-8 字节")
    valid = False
    if category == "players":
        valid = name in ("~local_player", "~local_player.Editor") or (
            name.startswith("player_") and len(name) > len("player_")
        )
    elif category == "maps":
        valid = re.fullmatch(r"map_-?(0|[1-9]\d*)", name, flags=re.ASCII) is not None
        if valid:
            identifier = int(name[4:])
            if not -(2**63) <= identifier < 2**63 or name == "map_-0":
                raise ValueError("地图 ID 必须是 64 位有符号整数，不能含前导零")
    elif category == "tickingareas":
        valid = name.startswith("tickingarea_") and len(name) > len("tickingarea_")
    elif category == "structures":
        valid = name.startswith("structuretemplate_") and len(name) > len("structuretemplate_")
    else:
        valid = name == "portals"
    if not valid:
        raise ValueError("记录名称不符合所选分类的键格式")
    tree = nbtlib.File()
    if category == "maps":
        tree.update(
            {
                "mapId": nbtlib.Long(identifier),
                "width": nbtlib.Short(128),
                "height": nbtlib.Short(128),
                "colors": nbtlib.ByteArray([0] * (128 * 128 * 4)),
            }
        )
    return tree


def map_png(tree: nbtlib.File) -> bytes:
    """Bedrock colors stores one RGBA byte quadruplet per pixel, in row order."""
    colors = tree.get("colors")
    if not isinstance(colors, nbtlib.ByteArray):
        raise ValueError("地图没有可预览的 colors 字节数组")
    dimensions = []
    for name in ("width", "height"):
        value = tree.get(name, nbtlib.Int(128))
        if not isinstance(value, (nbtlib.Byte, nbtlib.Short, nbtlib.Int, nbtlib.Long)):
            raise ValueError("地图尺寸必须是整数")
        dimensions.append(int(value))
    width, height = dimensions
    if not (0 < width <= 1024 and 0 < height <= 1024):
        raise ValueError("地图预览尺寸无效（最大 1024 × 1024）")
    pixels = colors.tobytes()
    if len(pixels) != width * height * 4:
        raise ValueError("地图颜色数量与尺寸不一致，不能生成预览")

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload))
        )

    stride = width * 4
    rows = b"".join(
        b"\0" + pixels[start : start + stride] for start in range(0, len(pixels), stride)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )
