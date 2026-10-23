"""One world session: level.dat and lazily opened database NBT documents."""

import struct
from collections import OrderedDict
from collections.abc import Callable
from copy import copy
from dataclasses import dataclass
from typing import Any, Literal

import nbtlib

from . import storage
from .chunk_markers import markers
from .chunks import ChunkEditor, chunk_key
from .data import (
    DATA_CATEGORIES,
    RECORD_CATEGORIES,
    DataCategory,
    RecordCategory,
    map_png,
    new_record_tree,
)
from .editor import Document, node_id
from .named_markers import NAMED_LAYERS, named_objects
from .object_deletion import prepare_objects
from .objects import ObjectDocument, object_record, source_path
from .players import DatabaseDocument, DatabaseStore, decode_player, encode_player
from .snapshots import Snapshot, pack, unpack

LEVEL_RECORD = "level.dat"
HISTORY_BYTES = 64 * 1024 * 1024


@dataclass
class ScopeChange:
    before: dict[str, Snapshot]
    after: dict[str, Snapshot]


def current_size(doc: Document) -> int:
    """Lazy database records retain packed bytes; opened editors retain raw data."""
    if isinstance(doc, DatabaseDocument) and doc._lazy_tree:
        return len(doc.history[doc.index])
    return len(doc.current)


class Workspace:
    def __init__(self, folder: str) -> None:
        level = Document(folder)
        self.id = level.id
        self.folder = level.folder
        self.lock = level.lock
        self.revision = 0
        self._records: dict[str, Document] = {LEVEL_RECORD: level}
        self._database: DatabaseStore | None = None
        self._chunks: ChunkEditor | None = None
        self._closed = False
        self._scope_history: list[ScopeChange] = []
        self._scope_index = 0
        self._object_targets: OrderedDict[str, tuple[str, str, int | list[str | int]]] = (
            OrderedDict()
        )
        self._map_named_records: set[str] = set()
        self._marker_coordinates: list[dict[str, Any]] | None = None
        self._village_keys: list[dict[str, str]] | None = None
        self._named_marker_cache: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
        self._marker_cache_revision = -1
        self._marker_query_key: tuple[Any, ...] | None = None
        self._marker_query_sources: list[dict[str, Any]] = []

    def object_documents(self) -> dict[str, ObjectDocument]:
        return {doc.key: doc for doc in self._records.values() if isinstance(doc, ObjectDocument)}

    @property
    def object_pending(self) -> int:
        return sum(
            doc.dirty for doc in self.object_documents().values() if doc.kind != "digest"
        ) + sum(self._records[key].dirty for key in self._map_named_records if key in self._records)

    def object_markers(
        self,
        dimension: int,
        bounds: tuple[int, int, int, int],
        layers: list[str],
        cursor: int | None = None,
        page_size: int = 32,
    ) -> dict[str, Any]:
        def register(key: str, kind: str, index: int) -> str:
            reference = f"{key}:{index}"
            self._object_targets[reference] = (key, kind, index)
            self._object_targets.move_to_end(reference)
            while len(self._object_targets) > 100000:
                self._object_targets.popitem(last=False)
            return reference

        if self._chunks is not None and self._chunks.reset is not None:
            return {"items": [], "truncated": False, "unreadable": 0, "next_cursor": None}
        if cursor is not None or any(layer in NAMED_LAYERS for layer in layers):
            return self._marker_page(dimension, bounds, layers, cursor or 0, register, page_size)
        result = markers(
            self.chunks(),
            dimension,
            bounds,
            layers,
            staged=self.object_documents(),
            register=register,
        )
        if "entities" in layers:
            from .clipboard_actors import staged_markers

            result["items"].extend(staged_markers(self.chunks(), dimension, bounds, register))
        return result

    def _marker_sources(
        self, dimension: int, bounds: tuple[int, int, int, int], layers: list[str]
    ) -> list[dict[str, Any]]:
        query = (dimension, bounds, tuple(sorted(layers)), self.revision)
        if query == self._marker_query_key:
            return self._marker_query_sources
        store = self.chunks().store
        sources: list[dict[str, Any]] = []
        chunk_layers = [layer for layer in layers if layer not in NAMED_LAYERS]
        if chunk_layers:
            if self._marker_coordinates is None:
                self._marker_coordinates = store.request("marker-coordinates")
            coords = {
                (p["x"], p["z"])
                for p in self._marker_coordinates
                if p["dimension"] == dimension
                and p["kind"] in chunk_layers
                and bounds[0] <= p["x"] <= bounds[1]
                and bounds[2] <= p["z"] <= bounds[3]
            }
            sources.extend({"x": x, "z": z} for x, z in sorted(coords))
        categories = set(layers) & set(NAMED_LAYERS)
        if "player_spawns" in categories:
            categories.add("players")
            categories.remove("player_spawns")
        for category in sorted(categories):
            if category == "villages":
                if self._village_keys is None:
                    self._village_keys = store.request("map-villages")
                entries = self._village_keys
            else:
                entries = store.records(category)
            sources.extend(entries)
        self._marker_query_sources, self._marker_query_key = sources, query
        return sources

    def _marker_page(
        self,
        dimension: int,
        bounds: tuple[int, int, int, int],
        layers: list[str],
        cursor: int,
        register: Callable[[str, str, int], str],
        page_size: int = 32,
    ) -> dict[str, Any]:
        if not layers:
            return {"items": [], "truncated": False, "unreadable": 0, "next_cursor": None}
        chunks = self.chunks()
        store = chunks.store
        sources = self._marker_sources(dimension, bounds, layers)
        chunk_layers = [layer for layer in layers if layer not in NAMED_LAYERS]
        if not 1 <= page_size <= 32:
            raise ValueError("对象分页大小无效")
        page = sources[cursor : cursor + page_size]
        result = markers(
            chunks,
            dimension,
            bounds,
            chunk_layers,
            staged=self.object_documents(),
            register=register,
            points=[entry for entry in page if "x" in entry],
            limit=65536,
        )
        # A dense batch can hit the driver's per-read budget before its final coordinates.
        # Retry smaller reads rather than skipping those coordinates with the next page.
        points = [entry for entry in page if "x" in entry]
        if result["truncated"] and len(points) > 1:
            combined = {}
            result = {"items": [], "truncated": False, "unreadable": 0}
            for point in points:
                single = markers(
                    chunks,
                    dimension,
                    bounds,
                    chunk_layers,
                    staged=self.object_documents(),
                    register=register,
                    points=[point],
                    limit=65536,
                )
                combined.update({item["id"]: item for item in single["items"]})
                result["truncated"] |= single["truncated"]
                result["unreadable"] += single["unreadable"]
            result["items"] = list(combined.values())
        if self._marker_cache_revision != self.revision:
            self._named_marker_cache.clear()
            self._marker_cache_revision = self.revision
        for entry in page:
            if "id" not in entry:
                continue
            key = entry["id"]
            doc = self._records.get(key)
            if isinstance(doc, DatabaseDocument) and doc.deleted:
                continue
            try:
                if key not in self._named_marker_cache:
                    raw = doc.current if doc is not None else store.read(key)
                    self._named_marker_cache[key] = named_objects(
                        entry["name"], decode_player(raw), list(NAMED_LAYERS)
                    )
                    while len(self._named_marker_cache) > 4096:
                        self._named_marker_cache.popitem(last=False)
                for item in self._named_marker_cache[key]:
                    result["truncated"] |= bool(item.get("source_truncated"))
                    if item["kind"] not in layers or item["dimension"] != dimension:
                        continue
                    x, z = item["x"], item["z"]
                    if not (
                        bounds[0] * 16 <= x < (bounds[1] + 1) * 16
                        and bounds[2] * 16 <= z < (bounds[3] + 1) * 16
                    ):
                        continue
                    reference = f"named:{key}:{node_id(item['object_path'])}:{item['kind']}"
                    self._object_targets[reference] = (key, "named", item["object_path"])
                    self._object_targets.move_to_end(reference)
                    while len(self._object_targets) > 100000:
                        self._object_targets.popitem(last=False)
                    result["items"].append(
                        {
                            **item,
                            "id": reference,
                            "object_ref": reference,
                            "source_name": entry["name"],
                        }
                    )
            except (ValueError, OSError, TypeError):
                result["unreadable"] += 1
        result["next_cursor"] = cursor + len(page) if cursor + len(page) < len(sources) else None
        if cursor == 0 and "entities" in layers:
            from .clipboard_actors import staged_markers

            result["items"].extend(staged_markers(chunks, dimension, bounds, register))
        return result

    def open_object(self, reference: str, revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        self._check_dimension_reset()
        if reference == "spawn":
            result = self.summary()
            result["object_path"] = []
            result["object_ref"] = reference
            return result
        if reference not in self._object_targets:
            raise ValueError("对象未在当前地图中读取，请刷新图层后重试")
        key, kind, index = self._object_targets[reference]
        if key in self.chunks().actor_records:
            raise ValueError("请先保存粘贴的实体，再编辑其 NBT")
        if kind == "named":
            doc = self.record(key)
            doc.node(index)
            self._map_named_records.add(key)
            doc.map_object = True
            result = self.summary(key)
            result.update(
                object_path=index,
                object_ref=reference,
                object_mapped=False,
                object_deletable=not reference.endswith(":player_spawns"),
            )
            return result
        record = object_record(key)
        if record not in self._records:
            candidate = ObjectDocument(self.chunks().store, key, kind, self._records[LEVEL_RECORD])
            if (
                sum(current_size(doc) for doc in self._records.values()) + len(candidate.current)
                > HISTORY_BYTES - self.chunk_bytes
            ):
                raise ValueError("当前世界打开的 NBT 记录已达到 64 MB 上限")
            self._records[record] = candidate
            self._trim_history()
        result = self.summary(record)
        path = source_path(kind, index)
        self.record(record).node(path)  # Validate that this object still exists.
        result.update(object_path=path, object_ref=reference, object_mapped=kind == "structures")
        return result

    def delete_object(self, reference: str, revision: int) -> dict[str, Any]:
        self.open_object(reference, revision)
        if reference == "spawn":
            raise ValueError("出生点请编辑 level.dat 中的 SpawnX/SpawnY/SpawnZ 标签")
        key, kind, index = self._object_targets[reference]
        if kind == "named":
            if reference.endswith(":player_spawns"):
                raise ValueError("玩家重生点请编辑 SpawnX/SpawnY/SpawnZ 标签，不能删除整条玩家记录")
            if index:
                self.execute("delete", key, revision, identifier=node_id(index))
            else:
                target = self.record(key)
                target.apply_snapshot(b"", "删除地图中的命名 NBT 对象")
                self.revision += 1
                self._trim_history()
            return self.summary()
        record = object_record(key)
        target = self.record(record)
        if kind != "actor":
            path = source_path(kind, index)
            if kind != "structures":
                path = path[:-1]
            self.execute("delete", record, revision, identifier=node_id(path))
            return self.summary()
        suffix = bytes.fromhex(key)[len(b"actorprefix") :]
        links = target.store.request("actor-links", suffix=suffix.hex())
        if any(link in self.chunks().actor_records for link in links):
            raise ValueError("请先保存或还原粘贴的实体，再删除共享索引中的对象")
        prepared: dict[str, tuple[ObjectDocument, bytes]] = {record: (target, b"")}
        # Remove a migration-era coordinate copy of the same actor, preserving its siblings.
        if target.actor_id is not None and target._actor_chunk is not None:
            dimension = int(target.tree.get("DimensionId", target.tree.get("Dimension", 0)))
            x, z = target._actor_chunk
            if (dimension, x, z) not in self.chunks().pending:
                prefix = struct.pack("<ii", x, z)
                prefixes = (
                    [prefix, prefix + bytes(4)]
                    if dimension == 0
                    else [prefix + struct.pack("<i", dimension)]
                )
                for prefix in prefixes:
                    source = (prefix + b"\x32").hex()
                    alias = object_record(source)
                    existing = self._records.get(alias)
                    if existing is None and not target.store.request(
                        "get", key=source, optional=True
                    ):
                        continue
                    doc = existing or ObjectDocument(
                        target.store, source, "entities", self._records[LEVEL_RECORD]
                    )
                    _, working = doc.decode(doc.current)
                    roots = working["objects"]
                    keep = []
                    for entry in roots:
                        identity = entry["nbt"].get("UniqueID")
                        if (
                            getattr(identity, "tag_id", None) not in (1, 2, 3, 4)
                            or int(identity) != target.actor_id
                        ):
                            keep.append(entry)
                    if len(keep) != len(roots):
                        working["objects"] = nbtlib.List[nbtlib.Compound](keep)
                        prepared[alias] = doc, doc.encode(working)
        for link in links:
            alias = object_record(link)
            doc = self._records.get(alias)
            if doc is None:
                doc = ObjectDocument(target.store, link, "digest", self._records[LEVEL_RECORD])
            raw = doc.current
            updated = b"".join(
                raw[i : i + 8] for i in range(0, len(raw), 8) if raw[i : i + 8] != suffix
            )
            prepared[alias] = doc, updated
        # Validate every replacement and shared retained states before touching any history.
        snapshots = {
            id(raw): raw for doc in self._records.values() for raw in (doc.current, doc.saved_state)
        }
        for doc, raw in prepared.values():
            doc.decode(raw)
            snapshots[id(doc.saved_state)] = doc.saved_state
            snapshots[id(raw)] = raw
        if sum(map(len, snapshots.values())) > HISTORY_BYTES - self.chunk_bytes:
            raise ValueError("对象删除超过共享 64 MB 预算，已取消操作")
        for alias, (doc, raw) in prepared.items():
            doc.apply_snapshot(raw, "删除地图实体及索引引用")
            self._records[alias] = doc
        self.revision += 1
        self._trim_history()
        return self.summary()

    def delete_objects(self, references: list[str], revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        self._check_dimension_reset()
        if not references:
            raise ValueError("请选择要删除的对象")
        documents, after, named = prepare_objects(self, references)
        self._stage_deletion(documents, after, "批量删除地图对象", scope_history=False)
        self._map_named_records.update(named)
        for key in named:
            self._records[key].map_object = True
        return self.summary()

    def delete_records(self, keys: list[str], revision: int) -> dict[str, Any]:
        """Delete explicit mixed search/list targets; level.dat retains its file."""
        self.check_revision(revision)
        self._check_dimension_reset()
        if not keys:
            raise ValueError("请选择要删除的记录")
        documents: dict[str, Document] = {}
        after = {}
        retained = self.chunk_bytes + sum(current_size(doc) for doc in self._records.values())
        for key in dict.fromkeys(keys):
            if key == LEVEL_RECORD:
                doc = copy(self._records[key])
                _, tree = doc.decode(doc.current)
                tree.clear()
                after[key] = doc.encode(tree)
            else:
                store = self._store()
                if key.startswith("object:") or store is None or not store.ensure_key(key):
                    raise ValueError("不是此世界的可删除记录")
                existing = self._records.get(key)
                doc = (
                    copy(existing)
                    if existing is not None
                    else DatabaseDocument(
                        store, key, self._records[LEVEL_RECORD], for_deletion=True
                    )
                )
                if doc.deleted:
                    raise ValueError("选中的记录已删除，请刷新列表")
                # Include every bulk target in the driver's fingerprint checks.
                doc.map_object = True
                after[key] = b""
                if existing is None:
                    retained += current_size(doc)
                if retained > HISTORY_BYTES:
                    raise ValueError("删除目标压缩后超过共享 64 MB 预算，已取消整个操作")
            documents[key] = doc
        self._stage_deletion(documents, after, "批量删除所选记录")
        return self.summary()

    def _stage_deletion(
        self,
        documents: dict[str, Document],
        after: dict[str, bytes],
        label: str,
        *,
        scope_history: bool = True,
    ) -> None:
        before = {
            key: pack(snapshot)
            if isinstance(snapshot := doc.history[doc.index], bytes)
            else snapshot
            for key, doc in documents.items()
        }
        protected = {
            id(raw): raw
            for doc in self._records.values()
            for raw in (doc.history[doc.index], doc.saved_state)
        }
        for key, doc in documents.items():
            protected[id(doc.saved_state)] = doc.saved_state
            protected[id(before[key])] = before[key]
            protected[id(after[key])] = after[key]
            if len(after[key]) > storage.MAX_FILE_SIZE:
                raise ValueError("删除后的记录超过 16 MB 上限")
            doc.decode(after[key])
        if sum(map(len, protected.values())) + self.chunk_bytes > HISTORY_BYTES:
            raise ValueError("批量删除超过共享 64 MB 预算，已取消整个操作")
        if not any(doc.current != after[key] for key, doc in documents.items()):
            return
        # All fallible reads, decoding and budget checks precede the commit.
        for key, doc in documents.items():
            doc.max_snapshot_size = storage.MAX_FILE_SIZE
            doc.apply_snapshot(after[key], label)
        self._records.update(documents)
        if LEVEL_RECORD in documents:
            # Keep one level source for metadata and release the replaced document.
            for doc in self._records.values():
                if isinstance(doc, DatabaseDocument):
                    doc._world_source = self._records[LEVEL_RECORD]
        self.revision += 1
        if scope_history:
            self._remember_scope(before, after)
        else:
            self._trim_history()

    @property
    def dirty(self) -> bool:
        return any(doc.dirty for doc in self._records.values()) or bool(
            self._chunks is not None and self._chunks.dirty
        )

    @property
    def chunk_bytes(self) -> int:
        return self._chunks.retained_bytes if self._chunks is not None else 0

    def chunks(self) -> ChunkEditor:
        if self._chunks is None:
            store = self._store()
            if store is None:
                raise ValueError("世界没有可读取的 db 数据库")
            self._chunks = ChunkEditor(store)
        return self._chunks

    def chunk_summary(self, dimension: int) -> dict[str, Any]:
        level = self._records[LEVEL_RECORD]
        tree = level.tree
        spawn = None
        if all(
            getattr(tree.get(name), "tag_id", None) in (1, 2, 3, 4)
            and -(2**31) <= int(tree[name]) < 2**31
            for name in ("SpawnX", "SpawnZ")
        ):
            spawn = {"x": int(tree["SpawnX"]), "z": int(tree["SpawnZ"])}
            if getattr(tree.get("SpawnY"), "tag_id", None) in (1, 2, 3, 4):
                spawn["y"] = int(tree["SpawnY"])
        return {
            **self.chunks().summary(dimension),
            "revision": self.revision,
            "world_dirty": self.dirty,
            "chunk_pending": self._chunks.pending_count if self._chunks is not None else 0,
            "spawn": spawn,
            "object_pending": self.object_pending,
            "voxel_can_undo": self.chunks().voxel_index > 0,
            "voxel_can_redo": self.chunks().voxel_index < len(self.chunks().voxel_history),
        }

    def edit_voxels(
        self,
        dimension: int,
        low: tuple[int, int, int],
        high: tuple[int, int, int],
        name: str,
        match: str | None,
        revision: int,
        step: int = 0,
        sphere: tuple[int, int, int, int] | None = None,
        states: str | None = None,
        hollow: bool = False,
        paste: tuple[int, int, int] | None = None,
        rotation: tuple[int, int, int] = (0, 0, 0),
        mirror: tuple[bool, bool, bool] = (False, False, False),
        skip_unsupported: bool = False,
        move_revision: int | None = None,
        chunk_mask=None,
        axis_order="xyz",
        replace_existing=True,
        paste_air=True,
        scale=1,
    ) -> dict[str, Any]:
        self.check_revision(revision)
        # History can cover earlier selections: protect every open dirty DB object.
        if any(doc.dirty for doc in self.object_documents().values()):
            raise ValueError("请先保存或还原对象 NBT 修改")
        protected = {
            id(raw): raw
            for doc in self._records.values()
            for raw in (doc.history[doc.index], doc.saved_state)
        }
        budget = HISTORY_BYTES - sum(map(len, protected.values()))
        if move_revision is not None:
            self.check_revision(move_revision)
            if not replace_existing or not paste_air:
                raise ValueError("移动选区需要启用替换原方块和粘贴空气")
            if paste is None:
                raise ValueError("移动选区必须指定目标位置")
        clipboard = None
        if paste is not None:
            from .voxel_clipboard import Paste

            if self.chunks().clipboard is None:
                raise ValueError("请先复制方块选区")
            if move_revision is not None and (
                self.chunks().clipboard.source_dimension != dimension
                or self.chunks().clipboard.source_revision != move_revision
            ):
                raise ValueError("移动来源或版本已改变，请在当前维度重新剪切选区")
            clipboard = Paste(
                self.chunks().clipboard,
                paste,
                rotation,
                mirror,
                skip_unsupported,
                axis_order,
                replace_existing,
                paste_air,
                scale,
            )
            low, high = clipboard.bounds
            sphere, hollow = None, False
        if step:
            history = self.chunks().voxel_history
            index = self.chunks().voxel_index
            change = (
                history[index - 1 if step == -1 else index]
                if (step in (-1, 1) and 0 <= index + step <= len(history))
                else None
            )
            self.chunks().travel_voxels(step, budget)
            changed = True
        elif move_revision is not None:
            changed = self.chunks().move_voxels(dimension, clipboard, budget)
        else:
            changed = self.chunks().edit_voxels(
                dimension,
                low,
                high,
                name,
                match,
                budget,
                sphere,
                states,
                hollow,
                clipboard,
                chunk_mask,
            )
        if changed:
            self.revision += 1
            self._trim_history()
        result = self.chunk_summary(dimension)
        if not step:
            change = self.chunks().voxel_history[-1] if changed else None
        from .voxels import Change

        if change is None or isinstance(change, Change):
            result["voxel_changes"] = {
                "base_revision": revision,
                "chunks": [
                    {"x": c[1], "z": c[2]}
                    for c in (change.after if change else ())
                    if c[0] == dimension and change.before[c] != change.after[c]
                ],
            }
        return result

    def delete_chunks(
        self,
        dimension: int,
        coords: list[tuple[int, int]],
        revision: int,
        *,
        skip_ineligible: bool = False,
    ) -> dict[str, Any]:
        self.check_revision(revision)
        if skip_ineligible:
            known = self.chunks().index(dimension)
            coords = [
                p for p in coords if p in known and (dimension, *p) not in self.chunks().pending
            ]
            if not coords:
                raise ValueError("选区没有可删除的已有区块")
        targets = {(dimension, x, z) for x, z in coords}
        if any(
            doc.dirty
            and (parsed := chunk_key(bytes.fromhex(doc.key))) is not None
            and parsed[0] in targets
            for doc in self.object_documents().values()
        ):
            raise ValueError("选区中有未保存的对象 NBT 修改，请先保存或还原对象修改")
        protected = {
            id(raw): raw
            for doc in self._records.values()
            for raw in (doc.history[doc.index], doc.saved_state)
        }
        chunks = self.chunks()
        budget = HISTORY_BYTES - sum(map(len, protected.values()))
        chunks.map_operation(
            [(dimension, x, z) for x, z in coords],
            budget,
            lambda: chunks.stage(dimension, coords, budget),
        )
        self.revision += 1
        self._trim_history()
        return self.chunk_summary(dimension)

    def clear_chunk_blocks(
        self, dimension: int, coords: list[tuple[int, int]], revision: int
    ) -> dict[str, Any]:
        self.check_revision(revision)
        targets = {(dimension, x, z) for x, z in coords}
        if any(
            doc.dirty
            and (parsed := chunk_key(bytes.fromhex(doc.key))) is not None
            and parsed[0] in targets
            for doc in self.object_documents().values()
        ):
            raise ValueError("选区中有未保存的对象 NBT 修改，请先保存或还原")
        protected = {
            id(raw): raw
            for doc in self._records.values()
            for raw in (doc.history[doc.index], doc.saved_state)
        }
        chunks = self.chunks()
        budget = HISTORY_BYTES - sum(map(len, protected.values()))
        if chunks.map_operation(
            [(dimension, x, z) for x, z in coords],
            budget,
            lambda: chunks.clear_blocks(dimension, coords, budget),
        ):
            self.revision += 1
            self._trim_history()
        return self.chunk_summary(dimension)

    def reset_dimension(self, dimension: int, revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        if any(isinstance(doc, DatabaseDocument) and doc.dirty for doc in self._records.values()):
            raise ValueError("请先保存或还原已有数据库修改，再重置维度")
        protected = {
            id(raw): raw
            for doc in self._records.values()
            for raw in (doc.history[doc.index], doc.saved_state)
        }
        chunks = self.chunks()
        budget = HISTORY_BYTES - sum(map(len, protected.values()))
        chunks.map_operation([], budget, lambda: chunks.reset_dimension(dimension, budget))
        self.revision += 1
        self._trim_history()
        return self.chunk_summary(dimension)

    def _check_dimension_reset(self) -> None:
        if self._chunks is not None and self._chunks.reset is not None:
            raise ValueError("请先保存或还原维度重置，再编辑数据库对象")

    def restore_chunks(self, dimension: int, revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        chunks = self.chunks()
        chunks.index(dimension)  # Complete any fallible index read before changing staged state.
        if chunks.dirty:
            chunks.restore()
            self.revision += 1
        objects = [doc for doc in self.object_documents().values() if doc.dirty]
        objects.extend(
            self._records[key]
            for key in self._map_named_records
            if key in self._records and self._records[key].dirty
        )
        for doc in objects:
            doc.history = [doc.saved_state]
            doc.index = 0
            doc.labels = ["还原地图对象"]
            doc.tree = doc.decode(doc.current)[1]
        if objects:
            self.revision += 1
        return self.chunk_summary(dimension)

    def create_chunks(
        self,
        dimension: int,
        coords: list[tuple[int, int]],
        min_y: int,
        max_y: int,
        revision: int,
        *,
        skip_ineligible: bool = False,
    ) -> dict[str, Any]:
        self.check_revision(revision)
        if skip_ineligible:
            known = self.chunks().index(dimension)
            coords = [
                p for p in coords if p not in known and (dimension, *p) not in self.chunks().pending
            ]
            if not coords:
                raise ValueError("选区没有可新增的未生成位置")
        protected = {
            id(raw): raw
            for doc in self._records.values()
            for raw in (doc.history[doc.index], doc.saved_state)
        }
        chunks = self.chunks()
        budget = HISTORY_BYTES - sum(map(len, protected.values()))
        chunks.map_operation(
            [(dimension, x, z) for x, z in coords],
            budget,
            lambda: chunks.create(dimension, coords, min_y, max_y, budget),
        )
        self.revision += 1
        self._trim_history()
        return self.chunk_summary(dimension)

    def _store(self) -> DatabaseStore | None:
        if self._closed:
            raise ValueError("世界已关闭，请重新打开")
        if not (self.folder / "db").exists():
            return None
        if self._database is None:
            self._database = DatabaseStore(self.folder)
        return self._database

    def players(self) -> list[dict[str, str]]:
        store = self._store()
        if store is None:
            return []
        return [
            item
            for item in store.items
            if not isinstance(doc := self._records.get(item["id"]), DatabaseDocument)
            or not doc.deleted
        ]

    def data_records(self, category: DataCategory | None = None) -> list[dict[str, str]]:
        if category is not None and category not in DATA_CATEGORIES:
            raise ValueError("data 分类无效")
        store = self._store()
        if store is None:
            return []
        return [
            item
            for item in store.records(category)
            if (category is None or item["category"] == category)
            and not (
                isinstance(doc := self._records.get(item["id"]), DatabaseDocument) and doc.deleted
            )
        ]

    def record_kind(self, key: str) -> str:
        if key == LEVEL_RECORD:
            return "level"
        if key.startswith("object:"):
            return "other"
        assert self._database is not None
        return self._database.kinds[key]

    def creation_capabilities(self, record: str | None = None) -> dict[str, Any]:
        tag_types = []
        if record is not None:
            try:
                tag_types = self.record(record).node([])["allowed_child_types"]
            except ValueError:
                pass  # Unsupported NBT remains deletable, but cannot receive tags.
            return {"categories": [], "tag_types": tag_types}
        store = self._store()
        available = []
        free = (
            HISTORY_BYTES
            - self.chunk_bytes
            - sum(current_size(doc) for doc in self._records.values())
        )
        if store is not None:
            examples = {
                "players": "player_new",
                "maps": "map_0",
                "tickingareas": "tickingarea_new",
                "structures": "structuretemplate_new",
                "portals": "portals",
            }
            for category in RECORD_CATEGORIES:
                if category == "portals" and store.ensure_key(b"portals".hex()):
                    continue
                raw = encode_player(new_record_tree(category, examples[category]))
                if len(raw) <= free:
                    available.append(category)
        return {"categories": available, "tag_types": tag_types}

    def create_record(self, category: RecordCategory, name: str, revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        self._check_dimension_reset()
        tree = new_record_tree(category, name)
        store = self._store()
        if store is None:
            raise ValueError("世界没有可读取的 db 数据库，不能新增记录")
        key = name.encode("utf-8").hex()
        if key in store.names or store.request("get", key=key, optional=True) is not None:
            raise ValueError("记录名称已存在（含当前会话已删除的记录），请使用其他名称或撤销删除")
        candidate = DatabaseDocument(
            store, key, self._records[LEVEL_RECORD], new_tree=tree, new_name=name
        )
        if (
            sum(current_size(doc) for doc in self._records.values()) + len(candidate.current)
            > HISTORY_BYTES - self.chunk_bytes
        ):
            raise ValueError("新增记录超过 64 MB 内存上限")
        store.register_new(name, category)
        self._records[key] = candidate
        self.revision += 1
        self._scope_history = self._scope_history[: self._scope_index]
        self._scope_history.append(ScopeChange({key: b""}, {key: candidate.current}))
        self._scope_index += 1
        if len(self._scope_history) > 50:
            self._scope_history.pop(0)
            self._scope_index -= 1
        self._trim_history()
        return self.summary(key)

    def data_page(
        self, category: DataCategory | None, query: str, offset: int, limit: int
    ) -> dict[str, Any]:
        needle = query.strip().casefold()
        records = [
            item
            for item in self.data_records(category)
            if needle in item["name"].casefold() or needle in item["id"].casefold()
        ]
        return {"items": records[offset : offset + limit], "total": len(records)}

    def map_preview(self, key: str) -> bytes:
        store = self._store()
        if store is None or not store.ensure_key(key) or store.kinds.get(key) != "maps":
            raise ValueError("不是此世界的地图记录")
        doc = self._records.get(key)
        if doc is None:
            doc = DatabaseDocument(store, key, self._records[LEVEL_RECORD])
        elif isinstance(doc, DatabaseDocument) and doc._lazy_tree:
            doc = copy(doc)  # Preview must not materialize a retained lazy record.
        assert isinstance(doc, DatabaseDocument)
        if doc.deleted:
            raise ValueError("地图记录已删除")
        doc.ensure_editable()
        return map_png(doc.tree)

    def record(self, key: str = LEVEL_RECORD) -> Document:
        if key != LEVEL_RECORD:
            self._check_dimension_reset()
        if self._closed:
            raise ValueError("世界已关闭，请重新打开")
        if key not in self._records:
            if key.startswith("object:"):
                raise ValueError("对象尚未通过当前地图打开")
            store = self._store()
            if store is None:
                raise ValueError("世界没有玩家记录")
            candidate = DatabaseDocument(store, key, self._records[LEVEL_RECORD])
            if (
                sum(current_size(doc) for doc in self._records.values()) + len(candidate.current)
                > HISTORY_BYTES - self.chunk_bytes
            ):
                raise ValueError("当前世界打开的 NBT 记录已达到 64 MB 上限")
            self._records[key] = candidate
            self._trim_history()
        doc = self._records[key]
        if isinstance(doc, ObjectDocument):
            if doc.kind == "digest":
                raise ValueError("实体索引仅供内部维护")
            coordinate = chunk_key(bytes.fromhex(doc.key))
            if coordinate is not None and (
                coordinate[0] in self.chunks().pending
                or coordinate[0][1:] not in self.chunks().index(coordinate[0][0])
            ):
                raise ValueError("对象所属区块已删除或暂存删除，请先还原")
            if self.chunks().blocks_cleared(doc.key):
                raise ValueError("对象所属方块已暂存清空，请先保存或还原")
        if isinstance(doc, DatabaseDocument) and doc.deleted:
            raise ValueError("数据库记录已删除，可返回所属列表撤销")
        if isinstance(doc, DatabaseDocument):
            if doc._lazy_tree:
                size = sum(current_size(value) for value in self._records.values())
                if size - current_size(doc) + len(doc.current) > HISTORY_BYTES - self.chunk_bytes:
                    raise ValueError("当前世界打开的 NBT 记录已达到 64 MB 上限")
            doc.ensure_editable()
        return doc

    def delete_scope(
        self,
        target: Literal["player", "players", "world", "level", "record", "data"] | DataCategory,
        revision: int,
        record_id: str | None = None,
        records: list[str] | None = None,
    ) -> dict[str, Any]:
        self.check_revision(revision)
        if records is not None and target not in ("player", "record"):
            raise ValueError("多选删除必须指定玩家或 data 记录")
        if target == "level":
            return self.execute("clear", LEVEL_RECORD, revision)
        self._check_dimension_reset()
        if target not in ("player", "players", "world", "record", "data", *DATA_CATEGORIES):
            raise ValueError("删除范围无效")
        if target in ("player", "record"):
            requested = records if records is not None else [record_id]
            if not requested or len(requested) > 10000 or len(set(requested)) != len(requested):
                raise ValueError("请选择 1 至 10000 条不重复记录")
            store = self._store()
            entries = [
                {"id": key}
                for key in requested
                if store is not None
                and store.ensure_key(key)
                and (store.kinds[key] == "players") == (target == "player")
                and not (
                    isinstance(doc := self._records.get(key), DatabaseDocument) and doc.deleted
                )
            ]
        elif target == "data":
            entries = self.data_records("other")
        elif target in DATA_CATEGORIES:
            entries = self.data_records(target)
        else:
            entries = self.players()
        available = {item["id"] for item in entries}
        if target in ("player", "record"):
            keys = records if records is not None else [record_id]
            if not keys or len(keys) > 10000 or len(set(keys)) != len(keys):
                raise ValueError("请选择 1 至 10000 条不重复记录")
            if any(key not in available for key in keys):
                raise ValueError(
                    "不是此世界的可删除玩家记录"
                    if target == "player"
                    else "不是此世界的可删除 data 记录"
                )
        else:
            keys = sorted(available)
        # Read every target before mutation; preserve unsupported NBT as opaque bytes.
        candidates: dict[str, Document] = {}
        retained_size = sum(current_size(doc) for doc in self._records.values())
        before: dict[str, Snapshot] = {}
        for key in keys:
            doc = self._records.get(key)
            if doc is None:
                assert self._database is not None
                doc = DatabaseDocument(
                    self._database, key, self._records[LEVEL_RECORD], for_deletion=True
                )
            snapshot = doc.history[doc.index]
            if isinstance(snapshot, bytes):
                snapshot = pack(snapshot)
            before[key] = snapshot
            retained_size += len(snapshot)
            if retained_size > HISTORY_BYTES - self.chunk_bytes:
                raise ValueError("删除目标压缩后仍超过 64 MB 内存上限，已取消整个操作")
            candidates[key] = doc
        after = {key: b"" for key in candidates}
        if target == "world":
            level = self._records[LEVEL_RECORD]
            _, empty = level.decode(level.current)
            empty.clear()
            before[LEVEL_RECORD] = level.current
            after[LEVEL_RECORD] = level.encode(empty)
        if not any(unpack(before[key]) != raw for key, raw in after.items()):
            return self.summary()
        self._records.update(candidates)
        label = "清空世界编辑内容" if target == "world" else "删除数据库记录"
        self._apply_scope(after, label)
        self._remember_scope(before, after)
        return self.summary()

    def _remember_scope(self, before: dict[str, Snapshot], after: dict[str, Snapshot]) -> None:
        self._scope_history = self._scope_history[: self._scope_index]
        self._scope_history.append(ScopeChange(before, after))
        self._scope_index += 1
        if len(self._scope_history) > 50:
            self._scope_history.pop(0)
            self._scope_index -= 1
        self._trim_history()

    def _selection_documents(self, keys: list[str]) -> dict[str, DatabaseDocument]:
        self._check_dimension_reset()
        if not keys or len(keys) > 10000 or len(set(keys)) != len(keys):
            raise ValueError("请选择 1 至 10000 条不重复记录")
        store = self._store()
        if store is None or any(not store.ensure_key(key) for key in keys):
            raise ValueError("不是此世界的数据库记录")
        kinds = {store.kinds[key] for key in keys}
        if "players" in kinds and len(kinds) != 1:
            raise ValueError("玩家与 data 记录不能混合执行多选操作")
        result = {}
        size = sum(current_size(doc) for doc in self._records.values())
        for key in keys:
            doc = self._records.get(key)
            if doc is None:
                doc = DatabaseDocument(store, key, self._records[LEVEL_RECORD])
                size += len(doc.current)
            assert isinstance(doc, DatabaseDocument)
            if doc.deleted:
                raise ValueError("选中的记录已删除")
            if doc._lazy_tree:
                size += len(doc.current) - current_size(doc)
                doc = copy(doc)
            doc.ensure_editable()
            if size > HISTORY_BYTES - self.chunk_bytes:
                raise ValueError("选中记录超过 64 MB 内存上限")
            result[key] = doc
        return result

    def selection_capabilities(self, keys: list[str], revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        try:
            documents = self._selection_documents(keys)
        except ValueError:
            return {"categories": [], "tag_types": []}
        allowed = set(range(1, 13))
        for doc in documents.values():
            allowed.intersection_update(doc.node([])["allowed_child_types"])
        return {"categories": [], "tag_types": sorted(allowed)}

    def add_to_records(
        self,
        keys: list[str],
        revision: int,
        tag_id: int,
        name: str | None,
        value: str | None,
        list_type: int | None,
    ) -> dict[str, Any]:
        self.check_revision(revision)
        documents = self._selection_documents(keys)
        before = {key: doc.current for key, doc in documents.items()}
        after = {}
        # Existing document state is shared only for reading; add() replaces the
        # copied tree/history before mutation. Nothing is attached until all pass.
        for key, doc in documents.items():
            candidate = copy(doc)
            candidate.revision = revision
            candidate.max_snapshot_size = storage.MAX_FILE_SIZE
            try:
                candidate.add("root", tag_id, name, value, list_type, revision)
            except ValueError as exc:
                raise ValueError(f"{doc.root_label}：{exc}") from exc
            after[key] = candidate.current
        size = sum(
            len(after[key]) if key in after else current_size(doc)
            for key, doc in self._records.items()
        )
        size += sum(len(raw) for key, raw in after.items() if key not in self._records)
        if size > HISTORY_BYTES - self.chunk_bytes:
            raise ValueError("新增标签超过 64 MB 内存上限，已取消整个操作")
        self._records.update(documents)
        self._apply_scope(after, "批量新增标签")
        self._remember_scope(before, after)
        return self.summary()

    def _apply_scope(self, snapshots: dict[str, Snapshot], label: str) -> None:
        size = sum(
            len(snapshots[key]) if key in snapshots else current_size(doc)
            for key, doc in self._records.items()
        )
        # Parsed editor trees also occupy raw bytes after restoration.
        size += sum(
            len(unpack(raw)) - len(raw)
            for key, raw in snapshots.items()
            if not isinstance(self._records[key], DatabaseDocument)
            or not self._records[key]._lazy_tree
        )
        if size > HISTORY_BYTES - self.chunk_bytes:
            raise ValueError("恢复目标超过 64 MB 内存上限，已取消整个操作")
        for key, raw in snapshots.items():
            self._records[key].decode(unpack(raw))
        for key, raw in snapshots.items():
            doc = self._records[key]
            doc.max_snapshot_size = storage.MAX_FILE_SIZE
            doc.apply_snapshot(raw, label)
        self.revision += 1

    def travel_scope(self, step: int, revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        self._check_dimension_reset()
        index = self._scope_index - 1 if step == -1 else self._scope_index
        if 0 <= index < len(self._scope_history):
            change = self._scope_history[index]
            expected = change.after if step == -1 else change.before
            if any(self._records[key].current != unpack(raw) for key, raw in expected.items()):
                raise ValueError("关联记录在范围操作后又有修改，请先撤销这些修改")
            snapshots = change.before if step == -1 else change.after
            self._apply_scope(snapshots, "撤销范围操作" if step == -1 else "重做范围操作")
            self._scope_index += step
            self._trim_history()
        return self.summary()

    def player_page(self, query: str, offset: int, limit: int) -> dict[str, Any]:
        needle = query.strip().casefold()
        players = [
            item
            for item in self.players()
            if needle in item["name"].casefold() or needle in item["id"].casefold()
        ]
        return {"items": players[offset : offset + limit], "total": len(players)}

    def search_world(self, query: str, scope: Literal["world", "data"] = "world") -> dict[str, Any]:
        """Search edited state first; temporary reads never fill the undo cache."""
        items: list[dict[str, Any]] = []
        errors: list[str] = []
        visited = size = 0
        truncated = False
        records = [{"id": LEVEL_RECORD, "name": LEVEL_RECORD}] if scope == "world" else []
        try:
            if scope == "world":
                records.extend(self.players())
            records.extend(self.data_records("other" if scope == "data" else None))
        except (ValueError, OSError) as exc:
            errors.append(f"数据库：{exc}")
        for index, item in enumerate(records):
            if visited >= 25000 or len(items) >= 500 or size >= HISTORY_BYTES or index >= 1000:
                truncated = True
                break
            try:
                doc = self._records.get(item["id"])
                if doc is None:
                    assert self._database is not None
                    doc = DatabaseDocument(self._database, item["id"], self._records[LEVEL_RECORD])
                if isinstance(doc, DatabaseDocument):
                    if doc._lazy_tree:
                        doc = copy(doc)
                    doc.ensure_editable()
                size += len(doc.current)
                if size > HISTORY_BYTES:
                    truncated = True
                    break
                result = doc.search(query, 25000 - visited, 500 - len(items))
                visited += result["visited"]
                truncated = truncated or result["truncated"]
                items.extend(
                    {"record": item["id"], "record_name": item["name"], "node": node}
                    for node in result["items"]
                )
            except (ValueError, OSError) as exc:
                errors.append(f"{item['name']}：{exc}")
                if len(errors) >= 20:
                    truncated = True
                    break
        return {"items": items, "truncated": truncated, "errors": errors}

    def _trim_history(self) -> None:
        documents = list(self._records.values())

        def usage() -> int:
            snapshots = {
                id(raw): raw for doc in documents for raw in (*doc.history, doc.saved_state)
            }
            for change in self._scope_history:
                for raw in (*change.before.values(), *change.after.values()):
                    snapshots[id(raw)] = raw
            return sum(map(len, snapshots.values())) + self.chunk_bytes

        total = usage()
        while total > HISTORY_BYTES:
            candidates = [doc for doc in documents if len(doc.history) > 1]
            if not candidates:
                if self._scope_history:
                    if self._scope_index > 0:
                        self._scope_history.pop(0)
                        self._scope_index -= 1
                    else:
                        self._scope_history.pop()
                    total = usage()
                    continue
                break
            doc = max(candidates, key=lambda value: len(value.history))
            if doc.index > 0:
                doc.history.pop(0)
                doc.labels.pop(0)
                doc.index -= 1
            else:
                doc.history.pop()
                doc.labels.pop()
            total = usage()

    def title(self, key: str) -> str:
        if key == LEVEL_RECORD:
            return key
        if key.startswith("object:"):
            return self._records[key].root_label
        assert self._database is not None
        return self._database.names[key]

    def summary(self, record: str = LEVEL_RECORD) -> dict[str, Any]:
        doc = self.record(record)
        result = doc.summary()
        result["root"]["name"] = self.title(record)
        return {
            **result,
            "record": record,
            "record_kind": self.record_kind(record),
            "revision": self.revision,
            "world_dirty": self.dirty,
            "object_pending": self.object_pending,
            "chunk_pending": self._chunks.pending_count if self._chunks is not None else 0,
            "scope_can_undo": self._scope_index > 0,
            "scope_can_redo": self._scope_index < len(self._scope_history),
            "records": [
                {"id": key, "name": self.title(key), "dirty": value.dirty}
                for key, value in self._records.items()
                if not isinstance(value, ObjectDocument)
                if not isinstance(value, DatabaseDocument) or not value.deleted
            ],
        }

    def check_revision(self, revision: int) -> None:
        if revision != self.revision:
            raise ValueError("编辑状态已更新，请重试")

    def execute(
        self,
        operation: Literal["edit", "add", "delete", "travel", "clear"],
        record: str,
        revision: int,
        **arguments: Any,
    ) -> dict[str, Any]:
        self.check_revision(revision)
        doc = self.record(record)
        doc.revision = self.revision
        other_size = sum(
            current_size(value) for value in self._records.values() if value is not doc
        )
        doc.max_snapshot_size = min(
            storage.MAX_FILE_SIZE, HISTORY_BYTES - self.chunk_bytes - other_size
        )
        result = getattr(doc, operation)(revision=revision, **arguments)
        self.revision = doc.revision
        self._trim_history()
        if isinstance(doc, ObjectDocument) and doc.deleted:
            return self.summary()
        summary = self.summary(record)
        if "selected" in result:
            summary["selected"] = result["selected"]
            if not summary["selected"]["path"]:
                summary["selected"]["name"] = self.title(record)
        return summary

    def save(self, revision: int, record: str = LEVEL_RECORD) -> dict[str, Any]:
        self.check_revision(revision)
        self.record(record)  # Reject invalid targets before any writes.
        level = self._records[LEVEL_RECORD]
        # Preflight all conflicts before saving either storage target.
        if level.dirty and storage.fingerprint(level.path.read_bytes()) != level.original_hash:
            raise ValueError("存档已被游戏或其他程序修改，请重新打开后再编辑")
        database_records = [
            doc for doc in self._records.values() if isinstance(doc, DatabaseDocument) and doc.dirty
        ]
        backups = []
        if database_records or (self._chunks is not None and self._chunks.dirty):
            assert self._database is not None
            dimension_reset = self._chunks is not None and self._chunks.reset is not None
            actors_changed = self._chunks is not None and bool(self._chunks.actor_records)
            cleared_keys = (
                {key for records in self._chunks.replacements.values() for key in records}
                if self._chunks is not None
                else set()
            )
            if self._chunks is None:
                self._database.save(database_records)
            else:
                self._database.save(database_records, self._chunks)
            if actors_changed:
                self._marker_coordinates = None
                self._marker_query_key = None
                self._database.invalidate_indices()
            for key, cached in list(self._records.items()):
                if isinstance(cached, ObjectDocument) and cached.key in cleared_keys:
                    del self._records[key]
            if dimension_reset:
                self._records = {LEVEL_RECORD: level}
                self._scope_history.clear()
                self._scope_index = 0
                self._map_named_records.clear()
                self._object_targets.clear()
                self._marker_coordinates = None
                self._village_keys = None
                self._named_marker_cache.clear()
                self._marker_query_key = None
                self._database.invalidate_indices()
            # Clean editors of coordinate records removed by chunk cleanup cannot be reopened.
            for key, doc in list(self._records.items()):
                if isinstance(doc, ObjectDocument) and doc.kind not in ("actor", "digest"):
                    parsed = chunk_key(bytes.fromhex(doc.key))
                    if parsed is not None and parsed[0][1:] not in self.chunks().index(
                        parsed[0][0]
                    ):
                        del self._records[key]
        if level.dirty:
            result = level.save(level.revision)
            backups.append(result["backup_path"])
        return {**self.summary(record), "backup_path": backups[-1] if backups else None}

    def close(self) -> None:
        with self.lock:
            try:
                if self._chunks is not None:
                    self._chunks.close()
                if self._database is not None:
                    self._database.close()
            finally:
                self._database = None
                self._closed = True
