"""UI-independent documents, typed node access and bounded undo snapshots."""

import json
import math
import re
import threading
from base64 import urlsafe_b64decode, urlsafe_b64encode
from collections.abc import Iterator
from typing import Any
from uuid import uuid4

import nbtlib

from . import storage
from .snapshots import Snapshot, unpack
from .worlds import normalize_world, world_info

PathParts = list[str | int]
ARRAY_TYPES = {7: nbtlib.Byte, 11: nbtlib.Int, 12: nbtlib.Long}
INTEGER_TYPES = {1, 2, 3, 4}
TAG_TYPES = {
    tag.tag_id: tag
    for tag in (
        nbtlib.Byte,
        nbtlib.Short,
        nbtlib.Int,
        nbtlib.Long,
        nbtlib.Float,
        nbtlib.Double,
        nbtlib.ByteArray,
        nbtlib.String,
        nbtlib.List,
        nbtlib.Compound,
        nbtlib.IntArray,
        nbtlib.LongArray,
    )
}


def valid_name(name: str) -> None:
    if len(name.encode("utf-8")) > 65535:
        raise ValueError("标签名称 UTF-8 长度不能超过 65535 字节")


def make_tag(tag_id: int, value: str | None = None, list_type: int | None = None) -> Any:
    """Construct a runtime-selected tag with its numeric or container protocol."""
    tag_class = TAG_TYPES.get(tag_id)
    if tag_class is None:
        raise ValueError("不支持的 NBT 类型")
    try:
        if tag_id in INTEGER_TYPES:
            return tag_class(int((value if value is not None else "0").strip()))
        if tag_id in (5, 6):
            number = float(value if value is not None else "0")
            if not math.isfinite(number):
                raise ValueError("只能输入有限数值")
            if tag_id == 5 and abs(number) > 3.4028234663852886e38:
                raise ValueError("数值超出了 Float 的 32 位范围")
            return tag_class(number)
        if tag_id == 8:
            text = value if value is not None else ""
            if len(text.encode("utf-8")) > 65535:
                raise ValueError("字符串 UTF-8 长度不能超过 65535 字节")
            return nbtlib.String(text)
        if tag_id in ARRAY_TYPES:
            text = (value or "").strip()
            if text.startswith("[") and text.endswith("]"):
                text = text[1:-1].strip()
            # Validate each integer before constructing NumPy arrays, which can wrap overflow.
            elements = [
                make_tag(ARRAY_TYPES[tag_id].tag_id, token)
                for token in re.split(r"[\s,，]+", text)
                if token
            ]
            return tag_class(elements)
        if value not in (None, ""):
            raise ValueError("容器的内容请通过新增子标签填写")
        if tag_id == 9:
            subtype = TAG_TYPES.get(list_type)
            if subtype is None:
                raise ValueError("请选择 List 的元素类型")
            return nbtlib.List[subtype]()
        return nbtlib.Compound()
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError(f"{tag_class.__name__} 的值无效：{exc}") from exc


def node_id(parts: PathParts) -> str:
    if not parts:
        return "root"
    return (
        urlsafe_b64encode(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode())
        .decode()
        .rstrip("=")
    )


def node_path(value: str) -> PathParts:
    if value == "root":
        return []
    try:
        parts = json.loads(urlsafe_b64decode(value + "=" * (-len(value) % 4)))
        if not isinstance(parts, list) or any(
            type(p) not in (str, int) or (type(p) is int and p < 0) for p in parts
        ):
            raise ValueError()
        return parts
    except Exception as exc:
        raise ValueError("无效的节点路径") from exc


def resolve(tree: nbtlib.File, parts: PathParts) -> Any:
    value = tree
    try:
        for part in parts:
            value = value[part]
        return value
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("节点已不存在，请刷新后重试") from exc


def typed_value(tree: nbtlib.File, parts: PathParts) -> Any:
    value = resolve(tree, parts)
    if parts:
        parent = resolve(tree, parts[:-1])
        if parent.tag_id in ARRAY_TYPES:
            return ARRAY_TYPES[parent.tag_id](int(value))
    return value


def serialize_node(tree: nbtlib.File, parts: PathParts) -> dict[str, Any]:
    tag = typed_value(tree, parts)
    tag_type = tag.tag_id
    container = tag_type in (7, 9, 10, 11, 12)
    count = len(tag) if container else 0
    if container:
        scalar = None
        subtype = tag.subtype.__name__ if tag_type == 9 else None
        summary = f"{count} 项" + (f" · {subtype}" if subtype else "")
    else:
        subtype = None
        if tag_type == 8:
            scalar = str(tag)
        elif tag_type in INTEGER_TYPES:
            scalar = str(int(tag))
        else:
            scalar = repr(float(tag))
        summary = scalar.replace("\n", " ↵ ")[:160]
    type_name = TAG_TYPES[tag_type].__name__
    parent = resolve(tree, parts[:-1]) if parts else None
    if tag_type == 10 or (tag_type == 9 and tag.subtype.tag_id == 0):
        allowed_child_types = list(TAG_TYPES)
    elif tag_type == 9:
        allowed_child_types = [tag.subtype.tag_id]
    elif tag_type in ARRAY_TYPES:
        allowed_child_types = [ARRAY_TYPES[tag_type].tag_id]
    else:
        allowed_child_types = []
    return {
        "id": node_id(parts),
        "name": str(parts[-1]) if parts else "level.dat",
        "path": parts,
        "path_label": " / ".join(str(p) for p in parts) or "/",
        "type": type_name,
        "tag_id": tag_type,
        "container": container,
        "child_count": count,
        "list_type": subtype,
        "value": scalar,
        "summary": summary,
        "editable": bool(parts) and (not container or tag_type in ARRAY_TYPES),
        "renameable": parent is not None and parent.tag_id == 10,
        "deletable": bool(parts),
        "allowed_child_types": allowed_child_types,
    }


class Document:
    """Own one world's NBT tree, save state and bounded edit history."""

    def __init__(self, folder: str) -> None:
        self.folder = normalize_world(folder)
        self.path = self.folder / "level.dat"
        raw, self.version, self.tree = storage.read(self.path)
        self.original_hash = storage.fingerprint(raw)
        self.saved_state = storage.encode(self.version, self.tree)
        self.history: list[Snapshot] = [self.saved_state]
        self.labels = ["打开存档"]
        self.index = 0
        self.revision = 0
        self.id = uuid4().hex
        self.lock = threading.RLock()
        self.root_label = "level.dat"
        self.max_snapshot_size = storage.MAX_FILE_SIZE

    def decode(self, raw: bytes) -> tuple[int, nbtlib.File]:
        return storage.decode(raw)

    def encode(self, tree: nbtlib.File) -> bytes:
        return storage.encode(self.version, tree)

    def node(self, parts: PathParts) -> dict[str, Any]:
        result = serialize_node(self.tree, parts)
        if not parts:
            result["name"] = self.root_label
        return result

    @property
    def dirty(self) -> bool:
        return self.current != unpack(self.saved_state)

    @property
    def current(self) -> bytes:
        return unpack(self.history[self.index])

    def world_metadata(self) -> dict[str, Any]:
        """Reuse world card metadata until its source files change."""
        source = getattr(self, "_world_source", None)
        if source is not None:
            return source.world_metadata()
        signature = []
        for name in (
            "level.dat",
            "levelname.txt",
            "world_icon.jpeg",
            "world_icon.jpg",
            "world_icon.png",
        ):
            try:
                stat = (self.folder / name).stat()
                signature.append((name, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size))
            except FileNotFoundError:
                signature.append((name, None, None, None))
        if getattr(self, "_world_signature", None) != signature:
            metadata = world_info(self.folder)
            self._world_signature = signature
            self._world_metadata = metadata
        return self._world_metadata.copy()

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "world": self.world_metadata(),
            "root": self.node([]),
            "revision": self.revision,
            "dirty": self.dirty,
            "can_undo": self.index > 0,
            "can_redo": self.index < len(self.history) - 1,
            "header_version": self.version,
            "changes": self.labels[1 : self.index + 1],
        }

    def check_revision(self, revision: int) -> None:
        if revision != self.revision:
            raise ValueError("编辑状态已更新，请重试")

    def children(self, identifier: str, offset: int, limit: int) -> dict[str, Any]:
        parts = node_path(identifier)
        tag = typed_value(self.tree, parts)
        if tag.tag_id not in (7, 9, 10, 11, 12):
            return {"items": [], "total": 0}
        keys = (
            list(tag.keys())[offset : offset + limit]
            if tag.tag_id == 10
            else range(offset, min(len(tag), offset + limit))
        )
        return {
            "items": [serialize_node(self.tree, parts + [key]) for key in keys],
            "total": len(tag),
        }

    def search(self, query: str, max_nodes: int = 25000, max_results: int = 500) -> dict[str, Any]:
        found = []
        stack = [iter([([], self.tree)])]
        visited = 0
        needle = query.casefold()
        while stack and visited < max_nodes and len(found) < max_results:
            try:
                parts, tag = next(stack[-1])
            except StopIteration:
                stack.pop()
                continue
            visited += 1
            node = self.node(parts)
            searchable = " ".join(
                (node["name"], node["value"] or node["summary"], node["path_label"])
            )
            if needle in searchable.casefold():
                found.append(node)
            if tag.tag_id == 10:
                stack.append(self._compound_nodes(parts, tag))
            elif tag.tag_id in (7, 9, 11, 12):
                # Bind the current container/path; nested generators must not capture the loop variables.
                stack.append(self._sequence_nodes(parts, tag))
        return {"items": found, "truncated": bool(stack), "visited": visited}

    @staticmethod
    def _compound_nodes(
        parts: PathParts, tag: nbtlib.Compound
    ) -> Iterator[tuple[PathParts, nbtlib.Base]]:
        for key, value in tag.items():
            yield parts + [key], value

    @staticmethod
    def _sequence_nodes(
        parts: PathParts, tag: nbtlib.List | nbtlib.ByteArray | nbtlib.IntArray | nbtlib.LongArray
    ) -> Iterator[tuple[PathParts, nbtlib.Base]]:
        for i, value in enumerate(tag):
            yield (
                parts + [i],
                ARRAY_TYPES[tag.tag_id](int(value)) if tag.tag_id in ARRAY_TYPES else value,
            )

    def edit(
        self, identifier: str, name: str | None, value: str | None, revision: int
    ) -> dict[str, Any]:
        self.check_revision(revision)
        parts = node_path(identifier)
        if not parts:
            raise ValueError("根节点不能直接修改")
        _, working = self.decode(self.current)
        tag = typed_value(working, parts)
        parent = resolve(working, parts[:-1])
        key = parts[-1]
        new_parts = parts[:]
        if value is not None:
            if tag.tag_id in (9, 10):
                raise ValueError("容器节点请展开后编辑子节点")
            converted = make_tag(tag.tag_id, value)
            if parent.tag_id in ARRAY_TYPES:
                # Parsed NumPy arrays can reference immutable input bytes.
                replacement = parent.copy()
                replacement[key] = int(converted)
                resolve(working, parts[:-2])[parts[-2]] = replacement
            else:
                parent[key] = converted
        if name is not None and name != str(key):
            if parent.tag_id != 10:
                raise ValueError("列表或数组中的元素不能重命名")
            valid_name(name)
            if name in parent:
                raise ValueError("标签名称已存在")
            items = [(name if k == key else k, v) for k, v in parent.items()]
            parent.clear()
            parent.update(items)
            new_parts[-1] = name
        return self.commit(working, f"修改 {' / '.join(map(str, parts))}", new_parts)

    def add(
        self,
        identifier: str,
        tag_id: int,
        name: str | None,
        value: str | None,
        list_type: int | None,
        revision: int,
    ) -> dict[str, Any]:
        self.check_revision(revision)
        parts = node_path(identifier)
        _, working = self.decode(self.current)
        parent = resolve(working, parts)
        if parent.tag_id not in (7, 9, 10, 11, 12):
            raise ValueError("只能在 Compound、List 或数组中新增子标签")
        if parent.tag_id == 10:
            if name is None:
                raise ValueError("请输入标签名称")
            valid_name(name)
            if name in parent:
                raise ValueError("标签名称已存在")
            key = name
        else:
            if name is not None:
                raise ValueError("列表或数组中的元素没有名称")
            key = len(parent)
            expected = (
                parent.subtype.tag_id if parent.tag_id == 9 else ARRAY_TYPES[parent.tag_id].tag_id
            )
            if expected not in (0, tag_id):
                raise ValueError("新增元素必须与列表或数组的元素类型一致")
        tag = make_tag(tag_id, value, list_type)
        if parent.tag_id == 10:
            parent[key] = tag
        elif parent.tag_id == 9:
            if parent.subtype.tag_id == 0:
                # Empty lists may use TAG_End; infer a real subtype for their first element.
                resolve(working, parts[:-1])[parts[-1]] = nbtlib.List[TAG_TYPES[tag_id]]([tag])
            else:
                parent.append(tag)
        else:
            resolve(working, parts[:-1])[parts[-1]] = type(parent)([*map(int, parent), int(tag)])
        return self.commit(working, f"新增 {' / '.join(map(str, parts + [key]))}", parts + [key])

    def delete(self, identifier: str, revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        parts = node_path(identifier)
        if not parts:
            raise ValueError("根节点不能删除")
        _, working = self.decode(self.current)
        resolve(working, parts)  # Ensure the target exists before mutating.
        parent = resolve(working, parts[:-1])
        position = list(parent.keys()).index(parts[-1]) if parent.tag_id == 10 else parts[-1]
        if parent.tag_id in ARRAY_TYPES:
            elements = [int(v) for i, v in enumerate(parent) if i != parts[-1]]
            resolve(working, parts[:-2])[parts[-2]] = type(parent)(elements)
        else:
            del parent[parts[-1]]
        parent = resolve(working, parts[:-1])
        selected = parts[:-1]
        if len(parent):
            position = min(position, len(parent) - 1)
            key = list(parent.keys())[position] if parent.tag_id == 10 else position
            selected = selected + [key]
        return self.commit(working, f"删除 {' / '.join(map(str, parts))}", selected)

    def clear(self, revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        _, working = self.decode(self.current)
        working.clear()
        return self.commit(working, f"清空 {self.root_label}", [])

    def value(self, identifier: str) -> dict[str, str | None]:
        tag = typed_value(self.tree, node_path(identifier))
        return {
            "value": ", ".join(str(int(v)) for v in tag)
            if tag.tag_id in ARRAY_TYPES
            else serialize_node(self.tree, node_path(identifier))["value"]
        }

    def commit(self, working: nbtlib.File, label: str, selected: PathParts) -> dict[str, Any]:
        raw = self.encode(working)
        return self.commit_snapshot(raw, label, selected)

    def commit_snapshot(self, raw: bytes, label: str, selected: PathParts) -> dict[str, Any]:
        self.apply_snapshot(raw, label)
        return {**self.summary(), "selected": self.node(selected)}

    def apply_snapshot(self, snapshot: Snapshot, label: str) -> None:
        raw = unpack(snapshot)
        if raw != self.current:
            if len(raw) > self.max_snapshot_size:
                raise ValueError("当前世界的 NBT 快照超过内存上限，请关闭世界后减少打开的记录")
            _, validated = self.decode(raw)
            self.history = self.history[: self.index + 1] + [snapshot]
            self.labels = self.labels[: self.index + 1] + [label]
            self.index += 1
            while len(self.history) > 51 or sum(map(len, self.history)) > 64 * 1024 * 1024:
                if len(self.history) <= 1:
                    break
                self.history.pop(0)
                self.labels.pop(0)
                self.index -= 1
            self.tree = validated
            self.revision += 1

    def travel(self, step: int, revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        new_index = self.index + step
        if 0 <= new_index < len(self.history):
            self.index = new_index
            _, self.tree = self.decode(self.current)
            self.revision += 1
        return self.summary()

    def save(self, revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        if self.current == self.saved_state:
            return {**self.summary(), "backup_path": None}
        backup = storage.save(self.path, self.current, self.original_hash)
        self.original_hash = storage.fingerprint(self.current)
        self.saved_state = self.current
        return {**self.summary(), "backup_path": str(backup)}
