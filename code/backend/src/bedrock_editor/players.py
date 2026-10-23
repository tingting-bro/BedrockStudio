"""Bedrock database NBT records and a private, lock-owning LevelDB subprocess."""

from __future__ import annotations

import json
import shutil
import subprocess
from base64 import b64decode, b64encode
from io import BytesIO
from pathlib import Path
from typing import Any

import nbtlib

from . import storage
from .chunks import ChunkEditor
from .data import DATA_CATEGORIES, record_sort_key
from .editor import Document
from .paths import bundled_node, code_root
from .snapshots import pack, unpack


def decode_player(raw: bytes) -> nbtlib.File:
    if not raw or len(raw) > storage.MAX_FILE_SIZE:
        raise ValueError("数据库 NBT 大小无效（最多支持 16 MB）")
    stream = BytesIO(raw)
    try:
        tree = nbtlib.File.parse(stream, byteorder="little")
    except Exception as exc:
        raise ValueError(f"数据库 NBT 无法解析：{exc}") from exc
    if stream.tell() != len(raw):
        raise ValueError("数据库 NBT 后存在额外字节，未打开该记录")
    if encode_player(tree) != raw:
        raise ValueError("数据库 NBT 含无法无损读取的扩展数据，不支持标签编辑；可删除整条记录")
    return tree


def encode_player(tree: nbtlib.File) -> bytes:
    stream = BytesIO()
    tree.write(stream, byteorder="little")
    return stream.getvalue()


class DatabaseStore:
    """Keep the native database lock until the world closes; never create/repair it."""

    def __init__(self, folder: Path) -> None:
        self.path = folder / "db"
        if not (self.path / "CURRENT").is_file():
            raise ValueError("世界没有可读取的 db 数据库")
        node = bundled_node() or shutil.which("node")
        if node is None:
            raise ValueError("数据库编辑需要 Node.js 20.19+，请安装后重新打开世界")
        frontend = code_root() / "frontend/package.json"
        self._process = subprocess.Popen(
            [node, str(Path(__file__).with_name("leveldb_bridge.cjs")), str(frontend)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            self.request("open", path=str(self.path))
            self.names: dict[str, str] = {}
            self.kinds: dict[str, str] = {}
            self._collections: dict[str, list[dict[str, str]]] = {}
            self._new_items: dict[str, dict[str, str]] = {}
        except Exception:
            self.close()
            raise

    @property
    def items(self) -> list[dict[str, str]]:
        return self.records("players")

    @property
    def data_items(self) -> list[dict[str, str]]:
        return self.records()

    def records(self, category: str | None = None) -> list[dict[str, str]]:
        """Index only the requested collection; retain keys, never NBT payloads."""
        if category is None:
            if any(kind not in self._collections for kind in DATA_CATEGORIES):
                self._cache_entries(self.request("data"), DATA_CATEGORIES)
            return sorted(
                [item for kind in DATA_CATEGORIES for item in self._collections[kind]],
                key=record_sort_key,
            )
        if category not in self._collections:
            entries = (
                self.request("players")
                if category == "players"
                else self.request("data", category=category)
            )
            self._cache_entries(entries, (category,))
        return self._collections[category]

    def _cache_entries(self, entries: list[dict[str, str]], categories: tuple[str, ...]) -> None:
        combined = {item["id"]: item for item in entries}
        for items in self._collections.values():
            for item in items:
                combined.setdefault(item["id"], item)  # Retain saved deletions for later undo.
        combined.update(self._new_items)
        for category in categories:
            items = [
                item for item in combined.values() if item.get("category", "players") == category
            ]
            for item in items:
                self.names[item["id"]] = item["name"]
                self.kinds[item["id"]] = category
            if category == "players":
                items.sort(
                    key=lambda item: (
                        not item["name"].startswith("~local_player"),
                        item["name"] != "~local_player",
                        item["name"].casefold(),
                    )
                )
            else:
                items.sort(key=record_sort_key)
            self._collections[category] = items

    def ensure_key(self, key: str) -> bool:
        """Resolve a single supported key without scanning any collection."""
        if key in self.names:
            return True
        if not isinstance(key, str) or not key or len(key) > 4096:
            return False
        try:
            if bytes.fromhex(key).hex() != key:
                return False
        except ValueError:
            return False
        entry = self.request("lookup", key=key)
        if entry is None:
            return False
        self.names[key] = entry["name"]
        self.kinds[key] = entry["category"]
        return True

    def request(self, command: str, **arguments: Any) -> Any:
        process = self._process
        if process.poll() is not None or process.stdin is None or process.stdout is None:
            raise ValueError("世界数据库连接已关闭；请检查 Node.js 和前端依赖后重新打开世界")
        try:
            process.stdin.write(json.dumps({"command": command, **arguments}) + "\n")
            process.stdin.flush()
            line = process.stdout.readline()
        except OSError as exc:
            raise ValueError("世界数据库连接失败，请重新打开世界") from exc
        if not line:
            raise ValueError("世界数据库驱动不可用，请在 code/frontend 执行 npm.cmd ci")
        response = json.loads(line)
        if "error" in response:
            raise ValueError(f"世界数据库操作失败（请先退出游戏）：{response['error']}")
        return response["result"]

    def read(self, key: str) -> bytes:
        raw = self.read_optional(key)
        if raw is None:
            raise ValueError("数据库记录已不存在")
        return raw

    def read_optional(self, key: str) -> bytes | None:
        if not self.ensure_key(key):
            raise ValueError("不是此世界的数据库记录")
        value = self.request("get", key=key, optional=True)
        return None if value is None else b64decode(value, validate=True)

    def register_new(self, name: str, category: str) -> str:
        key = name.encode("utf-8").hex()
        self.names[key] = name
        self.kinds[key] = category
        item = {"id": key, "name": name}
        if category != "players":
            item["category"] = category
        self._new_items[key] = item
        if category in self._collections:
            self._cache_entries(self._collections[category], (category,))
        return key

    def invalidate_indices(self) -> None:
        """Drop key caches after an entire dimension has been reset successfully."""
        self.names.clear()
        self.kinds.clear()
        self._collections.clear()
        self._new_items.clear()

    def save(self, documents: list[DatabaseDocument], chunks: ChunkEditor | None = None) -> None:
        if documents and chunks is not None and chunks.reset is not None:
            raise ValueError("维度重置不能与新的数据库对象修改同时保存，请先还原重置")
        for doc in documents:
            if not doc.deleted:
                doc.decode(doc.current)
            raw = doc.read_raw()
            actual_hash = storage.fingerprint(raw) if raw is not None else None
            if actual_hash != doc.original_hash:
                raise ValueError("数据库记录已被其他程序修改，请重新打开世界")
        # Recheck immediately before the atomic, synchronous database batch.
        for doc in documents:
            raw = doc.read_raw()
            actual_hash = storage.fingerprint(raw) if raw is not None else None
            if actual_hash != doc.original_hash:
                raise ValueError("保存前数据库记录发生变化，已取消保存")
        checks = chunks.checks() if chunks is not None and chunks.dirty else []
        reset = chunks.reset if chunks is not None else None
        if reset is not None:
            reset.check(self)
        chunk_items = chunks.writes() if chunks is not None else []
        chunk_keys = {item["key"] for item in chunk_items}
        if any(doc.key in chunk_keys for doc in documents):
            raise ValueError("同一数据库记录同时存在地图和 NBT 修改，请先还原其中一项再保存")
        actor_checks = chunks.actor_checks() if chunks is not None else []
        self.request(
            "write",
            items=[
                {"key": doc.key, "value": None if doc.deleted else b64encode(doc.current).decode()}
                for doc in documents
            ]
            + chunk_items,
            **({"chunk_checks": checks} if checks else {}),
            **(
                {"reset_check": {"dimension": reset.dimension, "signature": reset.signature}}
                if reset is not None
                else {}
            ),
            **(
                {
                    "object_checks": [
                        {"key": doc.key, "hash": doc.original_hash}
                        for doc in documents
                        if doc.map_object
                    ]
                    + actor_checks
                }
                if actor_checks or any(doc.map_object for doc in documents)
                else {}
            ),
        )
        for doc in documents:
            doc.original_hash = None if doc.deleted else storage.fingerprint(doc.current)
            doc.saved_state = doc.history[doc.index]
        if chunks is not None:
            chunks.saved()

    def close(self) -> None:
        process = self._process
        try:
            if process.poll() is None:
                self.request("close")
        finally:
            if process.stdin:
                process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()


class DatabaseDocument(Document):
    """Shared player/data editor, including opaque whole-record deletion history."""

    map_object = False

    def read_raw(self) -> bytes | None:
        return self.store.read_optional(self.key)

    def __init__(
        self,
        store: DatabaseStore,
        key: str,
        level: Document,
        *,
        for_deletion: bool = False,
        new_tree: nbtlib.File | None = None,
        new_name: str | None = None,
    ) -> None:
        self.store = store
        self.key = key
        self.folder = level.folder
        self._world_source = level
        self.path = store.path
        raw = store.read(key) if new_tree is None else encode_player(new_tree)
        if not raw or len(raw) > storage.MAX_FILE_SIZE:
            raise ValueError("数据库记录大小无效（最多支持 16 MB）")
        self.version = 0
        self._decode_error: str | None = None
        self._lazy_tree = for_deletion
        if for_deletion:
            # Keep one compressed raw snapshot, never thousands of parsed trees.
            self.tree = nbtlib.File()
        else:
            self.tree = decode_player(raw)
        self.original_hash = storage.fingerprint(raw) if new_tree is None else None
        self.saved_state = (pack(raw) if for_deletion else raw) if new_tree is None else b""
        self.history = [self.saved_state]
        self.labels = ["打开数据库记录"]
        self.index = 0
        self.revision = 0
        self.id = level.id
        self.lock = level.lock
        self.root_label = store.names[key] if new_name is None else new_name
        self.max_snapshot_size = storage.MAX_FILE_SIZE
        if new_tree is not None:
            self.apply_snapshot(raw, "新增记录")

    def decode(self, raw: bytes) -> tuple[int, nbtlib.File]:
        if not raw:
            return 0, nbtlib.File(root_name=self.tree.root_name)
        if self._lazy_tree:
            return 0, nbtlib.File()
        return 0, decode_player(raw)

    def ensure_editable(self) -> None:
        if self._lazy_tree:
            try:
                self.tree = decode_player(self.current)
            except ValueError as exc:
                self._decode_error = str(exc)
            else:
                self._lazy_tree = False
        if self._decode_error is not None:
            raise ValueError(
                "此数据库记录含不支持或损坏的 NBT，不能编辑标签；"
                f"可删除整条记录并撤销恢复原始数据。详情：{self._decode_error}"
            )

    @property
    def deleted(self) -> bool:
        return not self.history[self.index]

    @property
    def dirty(self) -> bool:
        snapshot = self.history[self.index]
        if snapshot == self.saved_state:
            return False
        return unpack(snapshot) != unpack(self.saved_state)

    def summary(self) -> dict[str, Any]:
        result = super().summary()
        result["can_undo"] = any(
            raw and unpack(raw) != self.current for raw in self.history[: self.index]
        )
        result["can_redo"] = any(
            raw and unpack(raw) != self.current for raw in self.history[self.index + 1 :]
        )
        return result

    def travel(self, step: int, revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        target = self.index + step
        # Collection deletion belongs to scope history, never tag undo/redo.
        while 0 <= target < len(self.history):
            raw = self.history[target]
            if raw and unpack(raw) != self.current:
                return super().travel(target - self.index, revision)
            target += step
        return self.summary()

    def encode(self, tree: nbtlib.File) -> bytes:
        return encode_player(tree)

    def save(self, revision: int) -> dict[str, Any]:
        self.check_revision(revision)
        if self.dirty:
            self.store.save([self])
        return {**self.summary(), "backup_path": None}
