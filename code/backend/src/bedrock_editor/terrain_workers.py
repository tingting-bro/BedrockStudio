"""Bounded, lazy CPU workers for immutable terrain previews (never database access)."""

from __future__ import annotations

from base64 import b64encode
from typing import Any

from . import resources


def available_memory() -> int:
    return resources.memory_headroom()


def worker_count() -> int:
    return max(
        1, min(61, (resources.os.cpu_count() or 1) * 9 // 10, available_memory() // (512 << 20))
    )


def preview_limit() -> int:
    # A full preview plus Python keys/dicts/base64 costs approximately 4 KiB.
    return max(4096, min(1048576, available_memory() // 8 // 4096))


def decode_batch(jobs: list[tuple[dict[str, bytes], int, str]]) -> list[dict[str, Any]]:
    from .chunks import chunk_key, terrain_kind, terrain_tile

    result = []
    for records, ceiling, layer in jobs:
        kind = terrain_kind(records)
        try:
            if kind == "unreadable":
                raise ValueError("姝ゅ尯鍧楁病鏈夊彲瀹屾暣瑙ｆ瀽鐨勭幇浠ｅ瓙鍖哄潡鍦板舰")
            # Classification uses all stored sections; the ceiling only clips pixels.
            visible = any(
                parsed is not None and parsed[1] == 0x2F and parsed[2] * 16 <= ceiling
                for key in records
                if (parsed := chunk_key(bytes.fromhex(key))) is not None
            )
            pixels = terrain_tile(records, ceiling, layer) if visible else bytes(1024)
            result.append({"kind": kind, "rgba": b64encode(pixels).decode()})
        except ValueError as exc:
            result.append({"kind": "unreadable", "error": str(exc)})
    return result


class TerrainDecoder:
    def __init__(self) -> None:
        self.pool = None
        self.workers = worker_count()
        self.disabled = False

    def decode(self, jobs: list[tuple[dict[str, bytes], int, str]]) -> list[dict[str, Any]]:
        if self.disabled or self.workers == 1 or len(jobs) < 16:
            return decode_batch(jobs)

        # Bound IPC groups by bytes, not total request size. Large requests
        # continue using multiple cores instead of falling back to serial.
        def groups():
            group, size = [], 0
            for job in jobs:
                cost = sum(map(len, job[0].values()))
                if group and (len(group) >= 8 or size + cost > 2 << 20):
                    yield group
                    group, size = [], 0
                group.append(job)
                size += cost
            if group:
                yield group

        result = [
            tile
            for group in resources.parallel_map(decode_batch, groups(), workers=self.workers)
            for tile in group
        ]
        self.pool = resources._pool
        self.disabled = resources._disabled
        return result

    def close(self) -> None:
        # Pool belongs to the application, shared by documents and structures.
        self.pool = None
