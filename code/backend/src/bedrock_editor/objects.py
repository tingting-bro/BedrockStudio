"""Session-authorized map object records, preserving sibling roots and binary layouts."""

from __future__ import annotations

import struct
from base64 import b64decode
from math import floor
from typing import TYPE_CHECKING

import nbtlib

from . import storage
from .chunk_markers import nbt_records, position
from .chunks import chunk_key
from .players import DatabaseDocument, decode_player, encode_player

if TYPE_CHECKING:
    from .editor import Document
    from .players import DatabaseStore

AREA_FIELDS = ("MinX", "MinY", "MinZ", "MaxX", "MaxY", "MaxZ", "Type")


class ObjectDocument(DatabaseDocument):
    """One source record is shared by every map object stored in that record."""

    map_object = True

    def __init__(self, store: DatabaseStore, key: str, kind: str, level: Document) -> None:
        self.store = store
        self.key = key
        self.kind = kind
        self.folder = level.folder
        self._world_source = level
        self.path = store.path
        raw = self.read_raw()
        if raw is None or not raw or len(raw) > storage.MAX_FILE_SIZE:
            raise ValueError("对象记录不存在或大小无效")
        self.version = 0
        self._decode_error = None
        self._lazy_tree = False
        self.tree = self.decode(raw)[1]
        if kind == "actor":
            unique_id = self.tree.get("UniqueID")
            self.actor_id = (
                int(unique_id) if getattr(unique_id, "tag_id", None) in (1, 2, 3, 4) else None
            )
            self._identity = {
                name: encode_player(nbtlib.File({name: self.tree[name]}))
                if name in self.tree
                else None
                for name in ("UniqueID", "DimensionId", "Dimension")
            }
            pos = position(self.tree)
            self._actor_chunk = (
                (floor(pos[0] / 16), floor(pos[2] / 16)) if pos is not None else None
            )
        self.original_hash = storage.fingerprint(raw)
        self.saved_state = raw
        self.history = [raw]
        self.labels = ["打开地图对象"]
        self.index = self.revision = 0
        self.id = level.id
        self.lock = level.lock
        self.root_label = {
            "actor": "实体 NBT",
            "entities": "区块实体 NBT",
            "blocks": "方块实体 NBT",
            "structures": "结构区域",
            "digest": "实体索引",
        }[kind]
        self.max_snapshot_size = storage.MAX_FILE_SIZE

    def read_raw(self) -> bytes | None:
        value = self.store.request("get", key=self.key, optional=True)
        return None if value is None else b64decode(value, validate=True)

    def decode(self, raw: bytes) -> tuple[int, nbtlib.File]:
        if not raw:
            if self.kind in ("blocks", "entities"):
                return 0, nbtlib.File({"objects": nbtlib.List[nbtlib.Compound]()})
            return 0, nbtlib.File()
        if self.kind == "actor":
            return 0, decode_player(raw)
        if self.kind == "digest":
            if len(raw) % 8:
                raise ValueError("实体索引格式无效")
            return 0, nbtlib.File(
                {"references": nbtlib.ByteArray([b if b < 128 else b - 256 for b in raw])}
            )
        if self.kind == "structures":
            if len(raw) < 4:
                raise ValueError("结构区域格式无效")
            count = struct.unpack_from("<I", raw)[0]
            if count > 2000 or len(raw) != 4 + count * 25:
                raise ValueError("不支持的结构区域格式")
            areas = []
            for i in range(count):
                values = struct.unpack_from("<iiiiiiB", raw, 4 + 25 * i)
                areas.append(
                    nbtlib.Compound(
                        {
                            name: nbtlib.Int(value)
                            for name, value in zip(AREA_FIELDS, values, strict=True)
                        }
                    )
                )
            return 0, nbtlib.File({"areas": nbtlib.List[nbtlib.Compound](areas)})
        trees = nbt_records(raw)
        return 0, nbtlib.File(
            {
                "objects": nbtlib.List[nbtlib.Compound](
                    [
                        nbtlib.Compound(
                            {
                                "nbt": nbtlib.Compound(tree),
                                "root_name": nbtlib.String(tree.root_name),
                            }
                        )
                        for tree in trees
                    ]
                )
            }
        )

    def encode(self, tree: nbtlib.File) -> bytes:
        if self.kind == "actor":
            for name in ("UniqueID", "DimensionId", "Dimension"):
                encoded = encode_player(nbtlib.File({name: tree[name]})) if name in tree else None
                if encoded != self._identity[name]:
                    raise ValueError("实体标识和维度不能直接修改，以免破坏区块索引")
            after = position(tree)
            if (
                self._actor_chunk is not None
                and after is not None
                and self._actor_chunk != (floor(after[0] / 16), floor(after[2] / 16))
            ):
                raise ValueError("暂不支持跨区块移动实体；可修改当前区块内的位置和其他 NBT")
            return encode_player(tree)
        if self.kind == "digest":
            refs = tree.get("references")
            if not isinstance(refs, nbtlib.ByteArray) or len(refs) % 8:
                raise ValueError("实体索引格式无效")
            return bytes(int(value) & 255 for value in refs)
        name = "areas" if self.kind == "structures" else "objects"
        entries = tree.get(name)
        if (
            set(tree) != {name}
            or not isinstance(entries, nbtlib.List)
            or entries.subtype != nbtlib.Compound
        ):
            raise ValueError("对象容器字段和类型不能改变；请展开后编辑对象")
        if self.kind == "structures":
            if len(entries) > 2000:
                raise ValueError("结构区域数量超过上限")
            raw = struct.pack("<I", len(entries))
            for area in entries:
                if set(area) != set(AREA_FIELDS) or any(
                    not isinstance(area[field], nbtlib.Int) for field in AREA_FIELDS
                ):
                    raise ValueError("结构区域须保留全部 Int 边界及类型字段")
                values = [int(area[field]) for field in AREA_FIELDS]
                if any(values[i] > values[i + 3] for i in range(3)) or not 0 <= values[6] <= 255:
                    raise ValueError("结构边界或类型无效")
                raw += struct.pack("<iiiiiiB", *values)
            return raw
        result = []
        coordinate = chunk_key(bytes.fromhex(self.key))[0]
        for entry in entries:
            if (
                set(entry) != {"nbt", "root_name"}
                or not isinstance(entry["nbt"], nbtlib.Compound)
                or not isinstance(entry["root_name"], nbtlib.String)
            ):
                raise ValueError("对象须保留 nbt 与 root_name 字段；请在 nbt 内编辑")
            pos = position(entry["nbt"])
            if pos is not None and (floor(pos[0] / 16), floor(pos[2] / 16)) != coordinate[1:]:
                raise ValueError("暂不支持跨区块移动对象；NBT 坐标须留在当前区块内")
            result.append(
                encode_player(nbtlib.File(entry["nbt"], root_name=str(entry["root_name"])))
            )
        return b"".join(result)


def object_record(key: str) -> str:
    return f"object:{key}"


def source_path(kind: str, index: int) -> list[str | int]:
    if kind == "actor":
        return []
    return ["areas", index] if kind == "structures" else ["objects", index, "nbt"]
