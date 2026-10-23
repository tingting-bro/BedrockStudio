"""Lossless native Bedrock adapter around Amulet-Core's mcstructure wrapper.

Native reads validate both layers directly without redundant serialization.
Writes use raw Core chunks, bypassing cross-edition universal translation.
"""

from copy import deepcopy
from struct import pack

import nbtlib
import numpy as np


def load_layers(root, size):
    """Return typed palettes and arrays; validate both layers before conversion."""
    if int(root.get("format_version", 1)) != 1:
        raise ValueError("mcstructure 格式版本不支持")
    body = root.get("structure", root)
    palettes = body.get("palette", {})
    palette = palettes.get("default", palettes)
    blocks = palette.get("block_palette")
    if not isinstance(blocks, nbtlib.List) or not 0 < len(blocks) <= 65_536:
        raise ValueError("mcstructure 调色板无效")
    if any(
        not isinstance(block, nbtlib.Compound)
        or not isinstance(block.get("name"), nbtlib.String)
        or not isinstance(block.get("states", nbtlib.Compound()), nbtlib.Compound)
        for block in blocks
    ):
        raise ValueError("mcstructure 方块名称或状态无效")
    indices = body.get("block_indices")
    if not isinstance(indices, nbtlib.List) or not 1 <= len(indices) <= 2:
        raise ValueError("mcstructure 方块索引层数无效")
    total = size[0] * size[1] * size[2]
    if any(len(layer) != total for layer in indices):
        raise ValueError("mcstructure 方块索引长度无效")
    # Bedrock XYZ storage: Z varies fastest.
    layers = np.asarray(indices, dtype=np.int32).reshape((len(indices), *size))
    if np.any(layers < -1) or np.any(layers >= len(blocks)):
        raise ValueError("mcstructure 方块索引越界")
    # The validated native arrays already have the required XYZ layout. A Core
    # read/write/read roundtrip materializes millions of Int tags and rewrites
    # the same palette without adding conversion information.
    if len(layers) == 1:
        layers = np.concatenate((layers, np.full((1, *size), -1, dtype=np.int32)))
    return blocks, layers, palette.get("block_position_data", {}), body.get("entities", [])


class _DenseIntList(nbtlib.List[nbtlib.Int]):
    """Standard TAG_List<Int> with a contiguous writer, avoiding millions of tags."""

    def __init__(self, values):
        super().__init__()
        self.values = np.asarray(values, dtype=np.int32).reshape(-1)

    def __len__(self):
        return len(self.values)

    def __iter__(self):
        return (nbtlib.Int(value) for value in self.values)

    def __getitem__(self, index):
        value = self.values[index]
        return type(self)(value) if isinstance(index, slice) else nbtlib.Int(value)

    def write(self, fileobj, byteorder="big"):
        fileobj.write(bytes([nbtlib.Int.tag_id]))
        fileobj.write(pack("<i" if byteorder == "little" else ">i", len(self)))
        fileobj.write(
            self.values.astype("<i4" if byteorder == "little" else ">i4", copy=False).tobytes()
        )


def dump_tree(size, palette, layers, position_data, entities):
    """Construct standard native NBT directly, preserving palettes and entity types."""
    tree = nbtlib.File(
        {
            "format_version": nbtlib.Int(1),
            "size": nbtlib.List[nbtlib.Int](size),
            "structure": nbtlib.Compound(
                {
                    "block_indices": nbtlib.List[nbtlib.List[nbtlib.Int]](
                        [_DenseIntList(layer) for layer in layers]
                    ),
                    "entities": nbtlib.List[nbtlib.Compound](
                        [deepcopy(nbtlib.Compound(entity)) for entity in entities]
                    ),
                    "palette": nbtlib.Compound(
                        {
                            "default": nbtlib.Compound(
                                {
                                    "block_palette": nbtlib.List[nbtlib.Compound](
                                        [deepcopy(nbtlib.Compound(block)) for block in palette]
                                    ),
                                    "block_position_data": position_data,
                                }
                            )
                        }
                    ),
                }
            ),
            "structure_world_origin": nbtlib.List[nbtlib.Int]([0, 0, 0]),
        }
    )

    return tree
