"""Bedrock level.dat framing and recoverable single-file persistence."""

import os
import shutil
import struct
import tempfile
from datetime import datetime
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import nbtlib

MAX_FILE_SIZE = 16 * 1024 * 1024


def decode(raw: bytes) -> tuple[int, nbtlib.File]:
    if len(raw) < 12 or len(raw) > MAX_FILE_SIZE:
        raise ValueError("level.dat 文件大小无效（最多支持 16 MB）")
    version, length = struct.unpack("<II", raw[:8])
    if not 0 < version < 1000 or length != len(raw) - 8:
        raise ValueError("不是有效的基岩版 level.dat：文件头或数据长度不一致")
    stream = BytesIO(raw[8:])
    try:
        tree = nbtlib.File.parse(stream, byteorder="little")
    except Exception as exc:
        raise ValueError(f"NBT 数据无法解析：{exc}") from exc
    if stream.tell() != length:
        raise ValueError("NBT 数据后存在额外字节，为避免丢失数据，未打开该文件")
    return version, tree


def read(path: Path) -> tuple[bytes, int, nbtlib.File]:
    if path.stat().st_size > MAX_FILE_SIZE:
        raise ValueError("level.dat 超过 demo 支持的 16 MB 上限")
    raw = path.read_bytes()
    version, tree = decode(raw)
    return raw, version, tree


def encode(version: int, tree: nbtlib.File) -> bytes:
    stream = BytesIO()
    tree.write(stream, byteorder="little")
    payload = stream.getvalue()
    return struct.pack("<II", version, len(payload)) + payload


def fingerprint(raw: bytes) -> str:
    return sha256(raw).hexdigest()


def save(path: Path, raw: bytes, original_fingerprint: str) -> Path:
    decode(raw)
    if fingerprint(path.read_bytes()) != original_fingerprint:
        raise ValueError("存档已被游戏或其他程序修改，请重新打开后再编辑")
    backup = path.with_name(f"level.dat.bak.{datetime.now():%Y%m%d-%H%M%S}-{uuid4().hex[:6]}")
    handle, temporary = tempfile.mkstemp(prefix=".level-dat-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        decode(Path(temporary).read_bytes())
        shutil.copy2(path, backup)
        # Check again immediately before committing; the game must be closed while editing.
        if fingerprint(path.read_bytes()) != original_fingerprint:
            raise ValueError("保存期间原文件发生变化，已取消写入，请重新打开存档")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return backup
