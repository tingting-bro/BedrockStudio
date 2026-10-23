"""Lossless in-memory snapshots for large whole-record operations."""

from dataclasses import dataclass
from zlib import compress, decompress


@dataclass(frozen=True)
class PackedSnapshot:
    payload: bytes

    def __len__(self) -> int:
        return len(self.payload)


type Snapshot = bytes | PackedSnapshot


def pack(raw: bytes) -> Snapshot:
    payload = compress(raw, level=1)
    return PackedSnapshot(payload) if len(payload) < len(raw) else raw


def unpack(snapshot: Snapshot) -> bytes:
    return decompress(snapshot.payload) if isinstance(snapshot, PackedSnapshot) else snapshot
