"""Use Amulet-Core's format wrappers and version translators in memory.

No Amulet GUI, world database, disk cache or temporary structure file is opened.
Core is a separately installed licensed dependency, not vendored source.
The private chunk entry points are deliberately pinned to Core 1.9.43:
public commit_chunk catches conversion errors instead of propagating them.
"""

import gzip
import logging
from copy import deepcopy
from functools import lru_cache
from io import BytesIO
from threading import RLock, get_ident

import nbtlib

_LOCK = RLock()
BEDROCK_VERSION = (1, 21, 60)
JAVA_VERSION = (1, 20, 4)


class _TranslationErrors(logging.Handler):
    """Core's translators log missing mappings and return unchanged blocks."""

    def __init__(self):
        super().__init__(logging.WARNING)
        self.owner = get_ident()
        self.messages = []

    def emit(self, record):
        if record.thread == self.owner:
            self.messages.append(record.getMessage())


def _java_entities(tree, format):
    root = tree.get("Schematic", tree)
    if format == "schematic":
        return root.get("TileEntities", [])
    return root.get("Blocks", root).get("BlockEntities", [])


def _point(entity):
    pos = entity.get("Pos")
    return tuple(int(v) for v in pos) if pos is not None else tuple(int(entity[k]) for k in "xyz")


def _has_items(entity):
    # PyMCTranslate 1.2.46 ItemTranslator.to/from_universal are unimplemented.
    # Core otherwise copies these stacks unchanged between incompatible schemas.
    return any(entity.get(key) for key in ("Items", "Item", "RecordItem", "Book", "book"))


def _metadata(tree, format):
    root = tree.get("Schematic", tree)
    if format == "schem":
        root = root.get("Metadata", {})
    return root.get("BedrockEditor", {})


def _keep_native_entities(native, java, format):
    """Java has no TickDelay/Bedrock extensions. Preserve them as metadata.

    Only restore a snapshot when its Java entity still matches exactly, so
    commands edited by another editor always take precedence over old metadata.
    """
    positions = native["structure"]["palette"]["default"]["block_position_data"]
    origin = tuple(map(int, native["structure_world_origin"]))
    originals = {}
    for entry in positions.values():
        entity = entry.get("block_entity_data")
        if entity is not None:
            originals[tuple(v - origin[i] for i, v in enumerate(_point(entity)))] = entity
    entries = []
    for entity in _java_entities(java, format):
        original = originals.get(_point(entity))
        if original is not None:
            entries.append(
                nbtlib.Compound(
                    {
                        "Java": deepcopy(entity),
                        "Bedrock": deepcopy(original),
                    }
                )
            )
    if entries:
        root = java.get("Schematic", java)
        if format == "schem":
            root = root.setdefault("Metadata", nbtlib.Compound())
        root["BedrockEditor"] = nbtlib.Compound(
            {
                "Version": nbtlib.Int(1),
                "BlockEntities": nbtlib.List[nbtlib.Compound](entries),
            }
        )


def _restore_native_entities(java, native, format):
    extension = _metadata(java, format)
    if int(extension.get("Version", 0)) != 1:
        return
    current = {_point(entity): entity for entity in _java_entities(java, format)}
    origin = tuple(map(int, native["structure_world_origin"]))
    size = tuple(map(int, native["size"]))
    positions = native["structure"]["palette"]["default"]["block_position_data"]
    for entry in extension.get("BlockEntities", []):
        if not isinstance(entry.get("Java"), nbtlib.Compound) or not isinstance(
            entry.get("Bedrock"), nbtlib.Compound
        ):
            continue
        point = _point(entry["Java"])
        if current.get(point) != entry["Java"] or not all(
            0 <= point[i] < size[i] for i in range(3)
        ):
            continue
        entity = deepcopy(entry["Bedrock"])
        for i, axis in enumerate("xyz"):
            entity[axis] = nbtlib.Int(point[i] + origin[i])
        index = (point[0] * size[1] + point[1]) * size[2] + point[2]
        positions[str(index)] = nbtlib.Compound({"block_entity_data": entity})


@lru_cache(maxsize=1)
def _runtime():
    from amulet.level.formats.mcstructure import MCStructureFormatWrapper
    from amulet.level.formats.schematic import SchematicFormatWrapper
    from amulet.level.formats.sponge_schem import SpongeSchemFormatWrapper

    return {
        "mcstructure": MCStructureFormatWrapper,
        "schematic": SchematicFormatWrapper,
        "schem": SpongeSchemFormatWrapper,
    }


def _write(tree, format):
    stream = BytesIO()
    tree.write(stream, byteorder="little" if format == "mcstructure" else "big")
    return stream.getvalue()


def _prepare(tree, format):
    """Normalize optional producer fields without replacing original payloads."""
    tree = deepcopy(tree)
    if format == "mcstructure":
        tree.setdefault("format_version", nbtlib.Int(1))
        origin = tree.setdefault("structure_world_origin", nbtlib.List[nbtlib.Int]([0, 0, 0]))
        size = tuple(int(value) for value in tree["size"])
        positions = tree["structure"]["palette"]["default"].get("block_position_data", {})
        for key, entry in positions.items():
            if "block_entity_data" not in entry:
                continue
            index = int(key)
            point = (index // (size[1] * size[2]), index // size[2] % size[1], index % size[2])
            for i, axis in enumerate("xyz"):
                entry["block_entity_data"][axis] = nbtlib.Int(point[i] + int(origin[i]))
    elif format == "schem":
        root = tree.get("Schematic", tree)
        # Sponge v1 has the v2 block layout, but no DataVersion field.
        if int(root.get("Version", 2)) == 1:
            root["Version"] = nbtlib.Int(2)
            root.setdefault("DataVersion", nbtlib.Int(1519))  # Java 1.13 blockstates
            if "BlockEntities" not in root and "TileEntities" in root:
                root["BlockEntities"] = root["TileEntities"]
        if int(root.get("Version", 2)) == 2:
            root.setdefault("BlockEntities", nbtlib.List[nbtlib.Compound]())
            root.setdefault("Entities", nbtlib.List[nbtlib.Compound]())
    return tree


def convert(tree: nbtlib.File, source: str, target: str, *, as_tree=False) -> bytes | nbtlib.File:
    """Translate using the same wrappers as Amulet-App; propagate every failure."""
    with _LOCK:
        wrappers = _runtime()
        reader = wrappers[source](f"memory.{source}")
        writer = None
        errors = _TranslationErrors()
        logger = logging.getLogger("PyMCTranslate")
        logger.addHandler(errors)
        try:
            prepared = _prepare(tree, source)
            reader.open_from(BytesIO(_write(prepared, source)))
            output = BytesIO()
            if source == target:
                # Native structures retain raw palette and entity tags. Avoid
                # universal translation that would rewrite unknown NBT fields.
                reader.save_to(output)
                return output.getvalue()
            writer = wrappers[target](f"memory.{target}")
            platform = "bedrock" if target == "mcstructure" else "java"
            version = BEDROCK_VERSION if platform == "bedrock" else JAVA_VERSION
            writer.translation_manager = reader.translation_manager
            writer.create_and_open(platform, version, reader.bounds("main"), True)
            for cx, cz in reader.all_chunk_coords("main"):
                raw_chunk = reader._get_raw_chunk_data(cx, cz, "main")
                if any(_has_items(entity) for entity in raw_chunk.block_entities):
                    raise ValueError(
                        "Amulet 尚未实现物品栈跨版本转换；请使用 mcstructure 保留容器物品"
                    )
                if raw_chunk.entities:
                    raise ValueError(
                        "Amulet-Core 1.9 的跨版本独立实体转换未启用；请使用 mcstructure 保留实体"
                    )
                chunk = reader._load_chunk(cx, cz, "main")
                writer._commit_chunk(chunk, "main")
                saved = writer._get_raw_chunk_data(cx, cz, "main")
                before = {_point(entity) for entity in raw_chunk.block_entities}
                after = {_point(entity) for entity in saved.block_entities}
                if not before.issubset(after):
                    raise ValueError("Amulet 无法保留部分方块实体，转换已取消；请使用 mcstructure")
                if errors.messages:
                    raise ValueError(f"方块或 NBT 缺少版本转换规则：{errors.messages[0]}")
            writer.save_to(output)
            raw = output.getvalue()
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            result = nbtlib.File.parse(
                BytesIO(raw), byteorder="little" if target == "mcstructure" else "big"
            )
            if target == "mcstructure":
                _restore_native_entities(prepared, result, source)
            else:
                _keep_native_entities(prepared, result, target)
            if as_tree:
                return result
            raw = _write(result, target)
            if target != "mcstructure":
                raw = gzip.compress(raw, mtime=0)
            return raw
        except Exception as exc:
            raise ValueError(f"Amulet 结构转换失败（{source} → {target}）：{exc}") from exc
        finally:
            logger.removeHandler(errors)
            reader.close()
            if writer is not None:
                writer.close()
