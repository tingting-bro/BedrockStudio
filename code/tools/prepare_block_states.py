"""Extract one valid canonical state per block from CC0 pmmp BedrockData network NBT."""

from __future__ import annotations

import argparse
import json
from io import BytesIO
from pathlib import Path


def extract(raw: bytes) -> dict:
    stream = BytesIO(raw)

    def byte():
        value = stream.read(1)
        if not value:
            raise ValueError("Truncated network NBT")
        return value[0]

    def uint():
        result = 0
        for shift in range(0, 35, 7):
            value = byte()
            result |= (value & 127) << shift
            if value < 128:
                return result
        raise ValueError("Invalid varint")

    def string():
        size = uint()
        value = stream.read(size)
        if len(value) != size:
            raise ValueError("Truncated string")
        return value.decode("utf-8")

    def payload(tag):
        if tag == 1:
            value = byte()
            return value if value < 128 else value - 256
        if tag == 3:
            value = uint()
            return (value >> 1) ^ -(value & 1)
        if tag == 8:
            return string()
        if tag == 10:
            result = {}
            while (child := byte()) != 0:
                name = string()
                result[name] = {"type": child, "value": payload(child)}
            return result
        raise ValueError(f"Unexpected NBT tag {tag}")

    result = {}
    while stream.tell() < len(raw):
        if byte() != 10:
            raise ValueError("Expected compound root")
        string()
        tree = payload(10)
        name = tree["name"]["value"].removeprefix("minecraft:")
        result.setdefault(
            name, {"states": tree["states"]["value"], "version": tree["version"]["value"]}
        )
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.write_text(
        json.dumps(extract(args.source.read_bytes()), ensure_ascii=False, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
    )
