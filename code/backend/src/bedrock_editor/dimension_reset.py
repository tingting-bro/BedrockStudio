"""Preflight a dimension reset without changing database or document state."""

from __future__ import annotations

import re
from base64 import b64decode, b64encode
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import nbtlib

from .snapshots import Snapshot, pack

if TYPE_CHECKING:
    from .players import DatabaseStore


def record_dimension(name: str, tree: nbtlib.File) -> int | None:
    from .named_markers import integer

    if name.startswith("player_") or name in ("~local_player", "~local_player.Editor"):
        return integer(tree, "DimensionId", 0)
    for container in (tree, tree.get("data")):
        if isinstance(container, nbtlib.Compound):
            for field in ("DimensionId", "Dimension", "dimension", "DimId"):
                if field in container:
                    return integer(container, field)
    return None


def village_dimension(name: str) -> int | None:
    match = re.match(r"VILLAGE_(Overworld|Nether|TheEnd|[-+]?\d+|dm-?\d+)_", name, re.I)
    if not match:
        return None
    token = match[1].lower()
    standard = {"overworld": 0, "nether": 1, "theend": 2}
    return standard[token] if token in standard else int(token.removeprefix("dm"))


@dataclass
class DimensionReset:
    dimension: int
    signature: str
    before: dict[str, Snapshot]
    after: dict[str, bytes | None]

    @property
    def retained_bytes(self) -> int:
        return sum(map(len, self.before.values())) + sum(
            len(raw) for raw in self.after.values() if raw is not None
        )

    @property
    def summary(self) -> dict[str, int]:
        return {"dimension": self.dimension, "records": len(self.before)}

    @classmethod
    def prepare(cls, store: DatabaseStore, dimension: int, budget: int) -> DimensionReset:
        # Imported locally to keep the database/chunk module dependency one-way.
        from .named_markers import integer
        from .players import decode_player, encode_player

        manifest = store.request("reset-sources", dimension=dimension)
        prepared = cls(dimension, manifest["signature"], {}, {})
        sources = manifest["items"]
        actors: set[str] = set()
        linked_dimensions: dict[str, set[int]] = {}
        links: dict[str, tuple[int, bytes]] = {}
        retained = 0
        link_bytes = 0

        def read(item: dict[str, Any]) -> bytes:
            value = store.request("get", key=item["key"])
            return b64decode(value, validate=True)

        def stage(key: str, raw: bytes, replacement: bytes | None = None) -> None:
            nonlocal retained
            prepared.before[key] = pack(raw)
            prepared.after[key] = replacement
            retained += len(prepared.before[key]) + (len(replacement) if replacement else 0)
            if retained > budget:
                raise ValueError("维度重置快照超过共享 64 MB 预算，已取消整次操作")

        # Links identify even actors whose payload cannot be parsed.
        for item in sources:
            if item["kind"] != "link":
                continue
            raw = read(item)
            link_bytes += len(raw)
            if link_bytes > 64 * 1024 * 1024:
                raise ValueError("实体索引读取超过 64 MB，已取消维度重置")
            if len(raw) % 8:
                raise ValueError("实体索引损坏，无法完整重置维度，已取消操作")
            links[item["key"]] = item["dimension"], raw
            for i in range(0, len(raw), 8):
                linked_dimensions.setdefault(raw[i : i + 8].hex(), set()).add(item["dimension"])
            if item["dimension"] == dimension:
                actors.update(raw[i : i + 8].hex() for i in range(0, len(raw), 8))

        for item in sources:
            kind, key = item["kind"], item["key"]
            if kind == "link":
                continue
            raw = read(item)
            if kind == "coordinate":
                stage(key, raw)
                continue
            name = item.get("name", "")
            if name == "scoreboard":
                continue  # The scoreboard is a shared world record, never dimension-owned.
            if kind == "named" and village_dimension(name) is not None:
                if village_dimension(name) == dimension:
                    stage(key, raw)
                continue
            try:
                tree = decode_player(raw)
            except ValueError as exc:
                if kind == "actor" and key[22:] in actors:
                    stage(key, raw)
                    continue
                if kind == "actor" and key[22:] in linked_dimensions:
                    continue  # A malformed actor indexed only in other dimensions is preserved.
                # An unassigned malformed record cannot safely be attributed to a dimension.
                raise ValueError(f"记录 {name or key} 无法判断维度，已取消重置：{exc}") from exc
            owner = record_dimension(name, tree)
            if kind == "actor":
                suffix = key[22:]
                if owner == dimension or (owner is None and suffix in actors):
                    actors.add(suffix)
                    stage(key, raw)
                else:
                    actors.discard(suffix)
                continue
            if owner == dimension and name != "portals":
                stage(key, raw)
                continue
            changed = False
            if name == "portals":
                data = tree.get("data", tree)
                if isinstance(data, nbtlib.Compound) and "PortalRecords" in data:
                    entries = data["PortalRecords"]
                    if not isinstance(entries, nbtlib.List) or (
                        entries and entries.subtype != nbtlib.Compound
                    ):
                        raise ValueError("传送门记录损坏，已取消维度重置")
                    remaining = [entry for entry in entries if integer(entry, "DimId") != dimension]
                    changed = len(entries) != len(remaining)
                    if changed:
                        data["PortalRecords"] = nbtlib.List[nbtlib.Compound](remaining)
            if name.startswith("player_") or name in ("~local_player", "~local_player.Editor"):
                if integer(tree, "SpawnDimension", 0) == dimension and "SpawnX" in tree:
                    for field in ("SpawnX", "SpawnY", "SpawnZ", "SpawnDimension"):
                        tree.pop(field, None)
                    changed = True
            if changed:
                stage(key, raw, encode_player(tree))

        for key, (owner, raw) in links.items():
            if owner == dimension:
                stage(key, raw)
            else:
                remaining = b"".join(
                    raw[i : i + 8]
                    for i in range(0, len(raw), 8)
                    if raw[i : i + 8].hex() not in actors
                )
                if remaining != raw:
                    stage(key, raw, remaining or None)
        # Detect a change during the preflight, before publishing any staged state.
        prepared.check(store)
        return prepared

    def check(self, store: DatabaseStore) -> None:
        if store.request("reset-sources", dimension=self.dimension)["signature"] != self.signature:
            raise ValueError("维度数据已被其他程序修改，已取消操作，请重新打开存档")

    def writes(self) -> list[dict[str, Any]]:
        return [
            {"key": key, "value": None if raw is None else b64encode(raw).decode()}
            for key, raw in self.after.items()
        ]
