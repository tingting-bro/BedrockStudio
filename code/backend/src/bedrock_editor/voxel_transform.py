"""Integer grid isometries and typed persistent block orientation changes."""

from copy import deepcopy
from fractions import Fraction
from itertools import product
from math import ceil, isfinite


class GridTransform:
    def __init__(
        self,
        low,
        high,
        origin,
        rotation=(0, 0, 0),
        mirror=(False, False, False),
        axis_order="xyz",
        scale=1,
    ):
        if len(rotation) != 3 or any(type(v) is not int or v % 90 for v in rotation):
            raise ValueError("旋转角度必须是 90° 的整数倍")
        if len(mirror) != 3 or any(type(v) is not bool for v in mirror):
            raise ValueError("镜像参数无效")
        if axis_order not in ("xyz", "xzy", "yxz", "yzx", "zxy", "zyx"):
            raise ValueError("坐标轴顺序无效")
        if (
            isinstance(scale, bool)
            or not isinstance(scale, (int, float))
            or not isfinite(scale)
            or scale <= 0
        ):
            raise ValueError("缩放比例必须是大于 0 的有限数值")
        self.scale = Fraction(str(scale))
        self.numerator, self.denominator = self.scale.numerator, self.scale.denominator
        self.low, self.origin = low, origin

        def rotate(v):
            x, y, z = (n * (-1 if m else 1) for n, m in zip(v, mirror, strict=True))
            for _ in range(rotation[0] // 90 % 4):
                y, z = -z, y
            for _ in range(rotation[1] // 90 % 4):
                x, z = z, -x
            for _ in range(rotation[2] // 90 % 4):
                x, y = -y, x
            return tuple((x, y, z)["xyz".index(axis)] for axis in axis_order)

        self.columns = tuple(rotate(v) for v in ((1, 0, 0), (0, 1, 0), (0, 0, 1)))
        self.orientation_identity = self.columns == ((1, 0, 0), (0, 1, 0), (0, 0, 1))
        self.identity = self.orientation_identity and self.scale == 1
        corners = [
            self.vector(v) for v in product(*[(0, b - a) for a, b in zip(low, high, strict=True)])
        ]
        self.minimum = tuple(min(v[i] for v in corners) for i in range(3))
        self.original_size = tuple(
            max(v[i] for v in corners) - self.minimum[i] + 1 for i in range(3)
        )
        self.size = tuple(max(1, ceil(n * self.scale)) for n in self.original_size)
        self.bounds = origin, tuple(a + b - 1 for a, b in zip(origin, self.size, strict=True))
        x, y, z = self.columns
        self.determinant = (
            x[0] * (y[1] * z[2] - y[2] * z[1])
            - y[0] * (x[1] * z[2] - x[2] * z[1])
            + z[0] * (x[1] * y[2] - x[2] * y[1])
        )

    def vector(self, v):
        return tuple(sum(v[j] * self.columns[j][i] for j in range(3)) for i in range(3))

    def point(self, p):
        v = self.vector(tuple(a - b for a, b in zip(p, self.low, strict=True)))
        return tuple(
            ceil((a - b) * self.scale) + c
            for a, b, c in zip(v, self.minimum, self.origin, strict=True)
        )

    def continuous(self, p):
        v = self.vector(tuple(a - b - 0.5 for a, b in zip(p, self.low, strict=True)))
        return tuple(
            (a - b + 0.5) * float(self.scale) + c
            for a, b, c in zip(v, self.minimum, self.origin, strict=True)
        )

    def cells(self, p):
        """All output cells sampling a source cell; shrink can discard it entirely."""
        v = self.vector(tuple(a - b for a, b in zip(p, self.low, strict=True)))
        return product(
            *(
                range(c + ceil((a - b) * self.scale), c + min(size, ceil((a - b + 1) * self.scale)))
                for a, b, c, size in zip(v, self.minimum, self.origin, self.size, strict=True)
            )
        )

    def inverse(self, p):
        v = tuple(
            (a - b) * self.denominator // self.numerator + c
            for a, b, c in zip(p, self.origin, self.minimum, strict=True)
        )
        return tuple(
            sum(v[i] * column[i] for i in range(3)) + self.low[j]
            for j, column in enumerate(self.columns)
        )


FACES = {
    "down": (0, -1, 0),
    "up": (0, 1, 0),
    "north": (0, 0, -1),
    "south": (0, 0, 1),
    "west": (-1, 0, 0),
    "east": (1, 0, 0),
}
SIX = tuple(FACES)
CARDINAL = ("south", "west", "north", "east")
STAIRS = ("east", "west", "south", "north")


def transform_block(tree, transform, allow_unknown=False):
    if allow_unknown:
        try:
            return transform_block(tree, transform)
        except ValueError:
            # Bedrock cannot express every orientation. Force paste retains the
            # entire original typed state rather than dropping the source block.
            return tree
    if transform.orientation_identity:
        return tree
    from .voxels import known_blocks

    if (
        not str(tree["name"]).startswith("minecraft:")
        or str(tree["name"]).removeprefix("minecraft:") not in known_blocks()
    ):
        raise ValueError("未知方块不能可靠旋转或镜像，整批已取消")
    result = deepcopy(tree)
    states = result.get("states", {})
    name = str(tree["name"])
    up = transform.columns[1]
    horizontal = up[1] != 0

    def reject():
        raise ValueError(f"{name} 的方向状态无法无损完成此旋转/镜像，整批已取消")

    def face(value, horizontal_only=False):
        if value not in FACES:
            reject()
        direction = next(k for k, v in FACES.items() if v == transform.vector(FACES[value]))
        if horizontal_only and direction in ("up", "down"):
            reject()
        return direction

    def put(key, value):
        states[key] = type(states[key])(value)

    # These shapes have no representable sideways state. Cubes and pillar axes
    # remain available for all three rotation axes.
    upright = any(
        k in states
        for k in (
            "upper_block_bit",
            "head_piece_bit",
            "rail_direction",
            "ground_sign_direction",
            "vine_direction_bits",
            "wall_post_bit",
            "attachment",
            "lever_direction",
        )
    )
    if upright and (not horizontal or up[1] < 0):
        reject()
    if not horizontal and any(
        k in states for k in ("upside_down_bit", "top_slot_bit", "minecraft:vertical_half")
    ):
        reject()
    for key in list(states):
        value = states[key]
        if key in ("pillar_axis", "portal_axis") and str(value) in ("x", "y", "z"):
            axis = transform.columns[("x", "y", "z").index(str(value))]
            put(key, ("x", "y", "z")[next(i for i, n in enumerate(axis) if n)])
        elif key in (
            "minecraft:cardinal_direction",
            "minecraft:facing_direction",
            "minecraft:block_face",
            "torch_facing_direction",
        ):
            if str(value) != "unknown":
                put(key, face(str(value), key == "minecraft:cardinal_direction"))
        elif key == "facing_direction":
            if not 0 <= int(value) < 6:
                reject()
            mapped = face(SIX[int(value)])
            if (
                mapped in ("up", "down")
                and any(t in name for t in ("chest", "furnace", "ladder", "barrel", "shulker"))
                and not horizontal
            ):
                # Barrels/shulkers have six directions, unlike horizontal containers.
                if not any(t in name for t in ("barrel", "shulker")):
                    reject()
            put(key, SIX.index(mapped))
        elif key in ("direction", "weirdo_direction", "coral_direction"):
            directions = STAIRS if key == "weirdo_direction" else CARDINAL
            if not 0 <= int(value) < 4:
                reject()
            put(key, directions.index(face(directions[int(value)], True)))
        elif key in ("upside_down_bit", "top_slot_bit") and up[1] < 0:
            put(key, 1 - int(value))
        elif key == "minecraft:vertical_half" and up[1] < 0:
            put(key, "top" if str(value) == "bottom" else "bottom")
        elif key == "door_hinge_bit" and transform.determinant * up[1] < 0:
            put(key, 1 - int(value))
        elif key in ("ground_sign_direction", "rotation"):
            if not horizontal or up[1] < 0:
                reject()
            # 16-step heading: 0 south, 4 west, 8 north, 12 east.
            south = CARDINAL.index(face("south", True)) * 4
            put(key, (south + int(value) * transform.determinant) % 16)
        elif key.startswith("wall_connection_type_"):
            if not horizontal:
                reject()
        elif key in (
            "rail_direction",
            "lever_direction",
            "vine_direction_bits",
            "multi_face_direction_bits",
            "coral_fan_direction",
        ):
            # Unknown encodings must never silently retain the old orientation.
            reject()
        elif any(
            token in key for token in ("direction", "facing", "orientation", "rotation", "axis")
        ) and key not in ("pillar_axis", "portal_axis"):
            reject()
    wall = {key: value for key, value in states.items() if key.startswith("wall_connection_type_")}
    for key, value in wall.items():
        states["wall_connection_type_" + face(key.removeprefix("wall_connection_type_"), True)] = (
            value
        )
    return result
