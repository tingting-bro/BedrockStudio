"""Positions from supported named Bedrock NBT records, without guessed coordinates."""

import re
from collections.abc import Mapping
from typing import Any

import nbtlib

from .chunk_markers import position

NAMED_LAYERS = ("players", "player_spawns", "portals", "maps", "villages", "tickingareas")


def integer(tree: Mapping[str, Any], name: str, default: int | None = None) -> int | None:
    value = tree.get(name)
    if value is None:
        return default
    return int(value) if getattr(value, "tag_id", None) in (1, 2, 3, 4) else None


def xyz(tree: Mapping[str, Any], names: tuple[str, str, str]) -> tuple[float, float, float] | None:
    values: list[float] = []
    for name in names:
        value = integer(tree, name)
        if value is None or value == -(2**31):
            return None
        values.append(float(value))
    return values[0], values[1], values[2]


def named_objects(name: str, tree: nbtlib.File, layers: list[str]) -> list[dict[str, Any]]:
    result = []

    def add(
        kind: str,
        label: str,
        dimension: int | None,
        pos: tuple[float, float | None, float] | None,
        *,
        path: list[str | int] | None = None,
        area: dict[str, float] | None = None,
        deletable: bool = True,
    ) -> None:
        if (
            kind not in layers
            or pos is None
            or dimension is None
            or not -(2**31) <= dimension < 2**31
            or any(abs(value) > 2**35 for value in pos if value is not None)
        ):
            return
        result.append(
            {
                "kind": kind,
                "label": label[:160],
                "dimension": dimension,
                "x": pos[0],
                "y": pos[1],
                "z": pos[2],
                "object_path": path or [],
                "object_deletable": deletable,
                "object_type": kind,
                "area": area,
            }
        )

    if name.startswith("player_") or name in ("~local_player", "~local_player.Editor"):
        label = str(tree.get("PlayerName", "")) or str(tree.get("CustomName", "")) or name
        add("players", label, integer(tree, "DimensionId", 0), position(tree))
        add(
            "player_spawns",
            f"{label} · 重生点",
            integer(tree, "SpawnDimension", 0),
            xyz(tree, ("SpawnX", "SpawnY", "SpawnZ")),
            deletable=False,
        )
    elif name == "portals":
        data = tree.get("data", tree)
        if not isinstance(data, nbtlib.Compound):
            return result
        entries = data.get("PortalRecords")
        if isinstance(entries, nbtlib.List) and entries.subtype == nbtlib.Compound:
            for index, portal in enumerate(entries[:2000]):
                add(
                    "portals",
                    f"下界传送门 #{index + 1}",
                    integer(portal, "DimId"),
                    xyz(portal, ("TpX", "TpY", "TpZ")),
                    path=(["data"] if data is not tree else []) + ["PortalRecords", index],
                )
            if len(entries) > 2000 and result:
                result[0]["source_truncated"] = True
    elif name.startswith("map_"):
        x, z = integer(tree, "xCenter"), integer(tree, "zCenter")
        if x is not None and z is not None:
            scale = integer(tree, "scale", 0)
            span = 128 * 2 ** max(0, min(4, scale if scale is not None else 0))
            add(
                "maps",
                f"物品地图 {name}",
                integer(tree, "dimension"),
                (x, None, z),
                area={
                    "min_x": x - span // 2,
                    "max_x": x + span // 2 - 1,
                    "min_z": z - span // 2,
                    "max_z": z + span // 2 - 1,
                },
            )
    elif name.startswith("tickingarea_"):
        coords = [integer(tree, field) for field in ("MinX", "MinZ", "MaxX", "MaxZ")]
        if all(value is not None for value in coords):
            x0, z0, x1, z1 = coords
            if x0 <= x1 and z0 <= z1:
                # TickingArea bounds are inclusive chunk coordinates.
                area = {
                    "min_x": x0 * 16,
                    "min_z": z0 * 16,
                    "max_x": x1 * 16 + 15,
                    "max_z": z1 * 16 + 15,
                }
                add(
                    "tickingareas",
                    str(tree.get("Name", name)) or name,
                    integer(tree, "Dimension"),
                    (
                        (area["min_x"] + area["max_x"]) / 2,
                        None,
                        (area["min_z"] + area["max_z"]) / 2,
                    ),
                    area=area,
                )
    elif name.startswith("VILLAGE_") and name.endswith("_INFO"):
        match = re.match(r"VILLAGE_(Overworld|Nether|TheEnd|[-+]?\d+|dm-?\d+)_", name, re.I)
        if match:
            token = match[1].lower()
            dimension = {"overworld": 0, "nether": 1, "theend": 2}.get(token)
            if dimension is None:
                dimension = int(token.removeprefix("dm"))
            data = tree.get("data", tree)
            if isinstance(data, nbtlib.Compound):
                low, high = xyz(data, ("X0", "Y0", "Z0")), xyz(data, ("X1", "Y1", "Z1"))
                if (
                    low is not None
                    and high is not None
                    and all(a <= b for a, b in zip(low, high, strict=True))
                ):
                    add(
                        "villages",
                        f"村庄 {name}",
                        dimension,
                        tuple((a + b) / 2 for a, b in zip(low, high, strict=True)),
                        area={"min_x": low[0], "max_x": high[0], "min_z": low[2], "max_z": high[2]},
                    )
    return result
