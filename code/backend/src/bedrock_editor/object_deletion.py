"""Prepare map object deletions against original source indexes, without mutation."""

from __future__ import annotations

import struct
from copy import copy
from typing import TYPE_CHECKING

from .chunks import chunk_key
from .editor import resolve
from .objects import ObjectDocument, object_record, source_path
from .players import DatabaseDocument

if TYPE_CHECKING:
    from .editor import Document
    from .workspace import Workspace

SPAWN_FIELDS = ("SpawnX", "SpawnY", "SpawnZ", "SpawnDimension")


def prepare_objects(
    workspace: Workspace, references: list[str]
) -> tuple[dict[str, Document], dict[str, bytes], set[str]]:
    documents: dict[str, Document] = {}
    paths: dict[str, set[tuple[str | int, ...]]] = {}
    spawn_records: set[str] = set()
    named: set[str] = set()
    actors: list[ObjectDocument] = []
    digests: dict[str, set[bytes]] = {}
    retained = 0

    def source(key: str, kind: str, *, whole: bool = False) -> tuple[str, Document]:
        nonlocal retained
        if key in workspace.chunks().actor_records:
            raise ValueError("请先保存或还原粘贴的实体，再删除共享索引中的对象")
        if kind != "named" and workspace.chunks().blocks_cleared(key):
            raise ValueError("对象所属方块已暂存清空，请先保存或还原")
        alias = key if kind == "named" else object_record(key)
        if alias not in documents:
            existing = workspace._records.get(alias)
            if existing is not None:
                doc = copy(existing)
                if isinstance(doc, DatabaseDocument) and doc.deleted:
                    raise ValueError("选中的对象已删除，请刷新列表")
            elif kind == "named":
                doc = DatabaseDocument(
                    workspace.chunks().store,
                    key,
                    workspace._records["level.dat"],
                    for_deletion=whole,
                )
            else:
                doc = ObjectDocument(
                    workspace.chunks().store, key, kind, workspace._records["level.dat"]
                )
            coordinate = chunk_key(bytes.fromhex(key))
            if kind != "named" and coordinate is not None:
                if coordinate[0] in workspace.chunks().pending:
                    raise ValueError("对象所属区块已暂存删除，请先还原")
                if coordinate[0][1:] not in workspace.chunks().index(coordinate[0][0]):
                    raise ValueError("对象所属区块已删除，请刷新列表")
            documents[alias] = doc
            retained += len(doc.history[doc.index]) + len(doc.saved_state)
            if retained + workspace.chunk_bytes > 64 * 1024 * 1024:
                raise ValueError("对象删除超过共享 64 MB 预算，已取消整个操作")
        return alias, documents[alias]

    for reference in dict.fromkeys(references):
        if reference == "spawn":
            documents["level.dat"] = copy(workspace._records["level.dat"])
            paths.setdefault("level.dat", set()).add(())
            continue
        target = workspace._object_targets.get(reference)
        if target is None:
            raise ValueError("对象未在当前地图中读取，请刷新图层后重试")
        key, kind, index = target
        if kind == "named":
            path = tuple(index)
            respawn = reference.endswith(":player_spawns")
            alias, doc = source(key, kind, whole=not path and not respawn)
            named.add(key)
            if respawn:
                spawn_records.add(alias)
            else:
                paths.setdefault(alias, set()).add(path)
        else:
            alias, doc = source(key, kind)
            path = source_path(kind, index)
            if kind in ("entities", "blocks"):
                path = path[:-1]
            paths.setdefault(alias, set()).add(tuple(path))
            if kind == "actor":
                actors.append(doc)

    # Independent actors may also have legacy coordinate copies and references
    # in several dimensions. Merge those removals into the same source plan.
    for actor in actors:
        suffix = bytes.fromhex(actor.key)[len(b"actorprefix") :]
        for link in actor.store.request("actor-links", suffix=suffix.hex()):
            alias, _ = source(link, "digest")
            digests.setdefault(alias, set()).add(suffix)
        if actor.actor_id is None or actor._actor_chunk is None:
            continue
        dimension = int(actor.tree.get("DimensionId", actor.tree.get("Dimension", 0)))
        x, z = actor._actor_chunk
        if (dimension, x, z) in workspace.chunks().pending:
            continue
        prefix = struct.pack("<ii", x, z)
        prefixes = (
            [prefix, prefix + bytes(4)]
            if dimension == 0
            else [prefix + struct.pack("<i", dimension)]
        )
        for prefix in prefixes:
            key = (prefix + b"\x32").hex()
            if (
                object_record(key) not in workspace._records
                and actor.store.request("get", key=key, optional=True) is None
            ):
                continue
            alias, doc = source(key, "entities")
            for index, entry in enumerate(doc.tree["objects"]):
                identity = entry["nbt"].get("UniqueID")
                if (
                    getattr(identity, "tag_id", None) in (1, 2, 3, 4)
                    and int(identity) == actor.actor_id
                ):
                    paths.setdefault(alias, set()).add(("objects", index))

    after = {}
    for alias, doc in documents.items():
        removals = paths.get(alias, set())
        if () in removals and alias != "level.dat":
            after[alias] = b""
            continue
        if isinstance(doc, DatabaseDocument):
            doc.ensure_editable()
        _, tree = doc.decode(doc.current)
        if alias == "level.dat":
            tree.clear()
        elif alias in digests:
            raw = doc.current
            after[alias] = b"".join(
                raw[i : i + 8]
                for i in range(0, len(raw), 8)
                if raw[i : i + 8] not in digests[alias]
            )
            continue
        else:
            # Validate all original paths, then delete descending indexes.
            for path in removals:
                resolve(tree, list(path))
            for path in sorted(
                removals, key=lambda p: tuple((isinstance(v, int), v) for v in p), reverse=True
            ):
                del resolve(tree, list(path[:-1]))[path[-1]]
            if alias in spawn_records:
                for field in SPAWN_FIELDS:
                    tree.pop(field, None)
        after[alias] = doc.encode(tree)
    return documents, after, named
