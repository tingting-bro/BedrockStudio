"""Lossless entity clipboard and preflighted modern actor/digp insertions."""

import math
import secrets
import struct
from base64 import b64decode

import nbtlib

from . import storage
from .chunk_markers import nbt_records, position
from .chunks import chunk_key
from .players import encode_player
from .snapshots import pack, unpack
from .voxels import actor_bytes, selected_cell


def capture(chunks, dimension, low, high, sphere, hollow, add, chunk_mask=None):
    coords = chunks.store.request("marker-coordinates")
    points = {
        (p["x"], p["z"])
        for p in coords
        if p["dimension"] == dimension
        and p["kind"] == "entities"
        and low[0] // 16 <= p["x"] <= high[0] // 16
        and low[2] // 16 <= p["z"] <= high[2] // 16
    }
    seen = set()
    identities = set()
    captured = []
    for x, z in sorted(points):
        if chunk_mask is not None and (x, z) not in chunk_mask:
            continue
        response = chunks.store.request(
            "chunk-markers", dimension=dimension, chunks=[{"x": x, "z": z}], layers=["entities"]
        )
        if response["truncated"]:
            raise ValueError("源实体读取不完整，整批复制已取消")
        for item in sorted(
            response["items"],
            key=lambda item: not bytes.fromhex(item["key"]).startswith(b"actorprefix"),
        ):
            coordinate = chunk_key(bytes.fromhex(item["key"]))
            if coordinate is not None and coordinate[0] in chunks.pending:
                continue
            if chunks.blocks_cleared(item["key"]):
                continue
            if item["key"] in seen:
                continue
            seen.add(item["key"])
            raw = b64decode(item["value"], validate=True)
            if len(raw) > storage.MAX_FILE_SIZE:
                raise ValueError("源实体记录超过 16 MB")
            for tree in nbt_records(raw):
                identity = tree.get("UniqueID")
                if isinstance(identity, nbtlib.Long) and int(identity) in identities:
                    continue
                if isinstance(identity, nbtlib.Long):
                    identities.add(int(identity))
                pos = position(tree)
                if pos is None:
                    raise ValueError("源实体坐标无法读取，整批复制已取消")
                stored = tree.get("DimensionId", tree.get("Dimension", dimension))
                if int(stored) != dimension or not selected_cell(
                    *(math.floor(v) for v in pos), low, high, sphere, hollow, chunk_mask
                ):
                    continue
                add(encode_player(tree), captured)
    # Include unsaved pasted actors too; their source bytes remain immutable.
    for key, (_, packed) in chunks.actor_records.items():
        if not bytes.fromhex(key).startswith(b"actorprefix") or packed is None:
            continue
        tree = nbt_records(unpack(packed))[0]
        pos = position(tree)
        if (
            int(tree.get("DimensionId", dimension)) == dimension
            and pos is not None
            and selected_cell(*(math.floor(v) for v in pos), low, high, sphere, hollow, chunk_mask)
        ):
            add(encode_player(tree), captured)
    return captured


def read(chunks, key):
    if key in chunks.actor_records:
        packed = chunks.actor_records[key][1]
        return None if packed is None else unpack(packed)
    value = chunks.store.request("get", key=key, optional=True)
    return None if value is None else b64decode(value, validate=True)


def prepare(chunks, paste, dimension, budget=64 * 1024**2):
    """Return packed originals/replacements, without modifying active state."""
    result = dict(chunks.actor_records)
    if not paste.clipboard.actors:
        return result
    originals = []
    for raw in paste.clipboard.actors:
        records = nbt_records(unpack(raw))
        if len(records) != 1:
            raise ValueError("实体剪贴板记录无效")
        identity = records[0].get("UniqueID")
        originals.append(
            int(identity) if getattr(identity, "tag_id", None) in (1, 2, 3, 4) else None
        )
    identities = {}
    allocated = set()
    source_ids = set(originals)
    assignments = []
    for original in originals:
        for _ in range(64):
            identity = -secrets.randbelow(2**62 - 1) - 1
            key = (b"actorprefix" + struct.pack("<q", identity)).hex()
            if identity not in source_ids and key not in allocated and read(chunks, key) is None:
                allocated.add(key)
                break
        else:
            raise ValueError("无法分配不冲突的实体身份")
        if original is not None:
            identities[original] = identity
        assignments.append(identity)

    reference_names = {
        "entityID",
        "entityId",
        "LeasherID",
        "OwnerID",
        "OwnerNew",
        "TargetID",
        "LoveCause",
        "LastHurtBy",
        "TradePlayer",
    }

    def remap(tree):
        for name, value in list(tree.items()):
            if isinstance(value, nbtlib.Compound):
                remap(value)
            elif isinstance(value, nbtlib.List) and value.subtype is nbtlib.Compound:
                for child in value:
                    remap(child)
            elif (
                name in reference_names
                and isinstance(value, nbtlib.Long)
                and int(value) in identities
            ):
                tree[name] = nbtlib.Long(identities[int(value)])

    retained = actor_bytes(result)
    for packed, identity in zip(paste.clipboard.actors, assignments, strict=True):
        tree = nbt_records(unpack(packed))[0]
        tree["UniqueID"] = nbtlib.Long(identity)
        # Remap references only, never re-map the newly allocated own identity.
        for name, value in list(tree.items()):
            if name != "UniqueID":
                if isinstance(value, nbtlib.Compound):
                    remap(value)
                elif isinstance(value, nbtlib.List) and value.subtype is nbtlib.Compound:
                    for child in value:
                        remap(child)
                elif (
                    name in reference_names
                    and isinstance(value, nbtlib.Long)
                    and int(value) in identities
                ):
                    tree[name] = nbtlib.Long(identities[int(value)])
        pos = position(tree)
        if pos is None:
            raise ValueError("实体坐标无效")
        # Entity positions are continuous; cell rotations are centred at half a block.
        moved = paste.transform.continuous(pos)
        if not -2048 <= moved[1] < 2048 or any(
            not -(2**35) <= v < 2**35 for v in (moved[0], moved[2])
        ):
            raise ValueError("粘贴实体超出坐标范围")
        if (
            "Pos" not in tree
            or not isinstance(tree["Pos"], nbtlib.List)
            or tree["Pos"].subtype not in (nbtlib.Float, nbtlib.Double)
        ):
            raise ValueError("实体位置类型无法无损变换")
        tree["Pos"] = type(tree["Pos"])(moved)
        # Hanging entities and leashes store block anchors separately from Pos.
        for names in (("TileX", "TileY", "TileZ"), ("xTile", "yTile", "zTile")):
            if not any(name in tree for name in names):
                continue
            if not all(isinstance(tree.get(name), nbtlib.Int) for name in names):
                continue
            anchor = paste.transform.point(tuple(int(tree[name]) for name in names))
            for name, value in zip(names, anchor, strict=True):
                tree[name] = nbtlib.Int(value)
        for name in ("BlockPos", "LeashHome"):
            anchor = tree.get(name)
            if anchor is None:
                continue
            if not isinstance(anchor, (nbtlib.IntArray, nbtlib.List)) or len(anchor) != 3:
                continue
            if isinstance(anchor, nbtlib.List) and anchor.subtype is not nbtlib.Int:
                continue
            tree[name] = type(anchor)(paste.transform.point(tuple(int(v) for v in anchor)))
        # Restrict directional field semantics to hanging entities, preserving mod data.
        hanging = "TileX" in tree or str(tree.get("identifier", "")) == "minecraft:painting"
        for name in ("Direction",) if hanging else ():
            facing = tree.get(name)
            if facing is None:
                continue
            if getattr(facing, "tag_id", None) not in (1, 2, 3) or not 0 <= int(facing) <= 3:
                continue
            directions = ((0, 0, 1), (-1, 0, 0), (0, 0, -1), (1, 0, 0))
            direction = paste.transform.vector(directions[int(facing)])
            if direction in directions:
                tree[name] = type(facing)(directions.index(direction))
        for name in ("DimensionId", "Dimension"):
            if name in tree:
                tree[name] = type(tree[name])(dimension)
        if "DimensionId" not in tree and "Dimension" not in tree:
            tree["DimensionId"] = nbtlib.Int(dimension)
        for name in ("Motion",):
            values = tree.get(name)
            if (
                isinstance(values, nbtlib.List)
                and len(values) == 3
                and values.subtype in (nbtlib.Float, nbtlib.Double)
            ):
                tree[name] = type(values)(paste.transform.vector(tuple(float(v) for v in values)))
        angles = tree.get("Rotation")
        if (
            isinstance(angles, nbtlib.List)
            and len(angles) == 2
            and angles.subtype in (nbtlib.Float, nbtlib.Double)
        ):
            yaw, pitch = (math.radians(float(v)) for v in angles)
            vx, vy, vz = paste.transform.vector(
                (
                    -math.sin(yaw) * math.cos(pitch),
                    -math.sin(pitch),
                    math.cos(yaw) * math.cos(pitch),
                )
            )
            tree["Rotation"] = type(angles)(
                (
                    math.degrees(math.atan2(-vx, vz)),
                    math.degrees(math.atan2(-vy, math.hypot(vx, vz))),
                )
            )
        raw = encode_player(tree)
        if len(raw) > storage.MAX_FILE_SIZE:
            raise ValueError("粘贴实体超过单记录 16 MB")
        suffix = struct.pack("<q", int(tree["UniqueID"]))
        key = (b"actorprefix" + suffix).hex()
        packed = pack(raw)
        result[key] = (None, packed)
        retained += len(packed)
        cx, cz = math.floor(moved[0] / 16), math.floor(moved[2] / 16)
        prefix = struct.pack("<ii", cx, cz) + (struct.pack("<i", dimension) if dimension else b"")
        link = (b"digp" + prefix).hex()
        if link in result:
            original, packed = result[link]
            current = unpack(packed) if packed is not None else b""
        else:
            current = read(chunks, link)
            original = pack(current) if current is not None else None
            current = current or b""
        if len(current) % 8 or len(current) + 8 > storage.MAX_FILE_SIZE:
            raise ValueError("目标实体索引无效或超过 16 MB")
        previous_size = sum(len(raw) for raw in result.get(link, ()) if raw is not None)
        result[link] = original, pack(current + suffix)
        retained += sum(len(raw) for raw in result[link] if raw is not None) - previous_size
        if retained > budget:
            raise ValueError("粘贴实体超过共享 64 MB 预算，整批已取消")
    return result


def staged_markers(chunks, dimension, bounds, register):
    from .chunk_markers import entity_render

    result = []
    for key, (_, packed) in chunks.actor_records.items():
        if not bytes.fromhex(key).startswith(b"actorprefix") or packed is None:
            continue
        tree = nbt_records(unpack(packed))[0]
        pos = position(tree)
        if pos is None or int(tree.get("DimensionId", tree.get("Dimension", 0))) != dimension:
            continue
        if (
            not bounds[0] * 16 <= pos[0] < (bounds[1] + 1) * 16
            or not bounds[2] * 16 <= pos[2] < (bounds[3] + 1) * 16
        ):
            continue
        name = str(tree.get("identifier", tree.get("id", "unknown")))
        result.append(
            {
                "id": f"entities:{int(tree['UniqueID'])}",
                "kind": "entities",
                "label": str(tree.get("CustomName", name)),
                "object_type": name,
                "source_name": key,
                "object_ref": register(key, "actor", 0),
                "x": pos[0],
                "y": pos[1],
                "z": pos[2],
                "render": entity_render(tree),
                "icon_type": str(tree["Item"].get("Name", ""))
                if isinstance(tree.get("Item"), nbtlib.Compound)
                else None,
            }
        )
    return result
