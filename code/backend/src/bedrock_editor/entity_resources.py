"""Build entity geometry and textures from the selected Bedrock resource generation."""

import ast
import base64
import io
import json
import math
import operator
import re
from copy import deepcopy
from pathlib import PurePosixPath

from PIL import Image

from .bedrock_resources import read_pack_json as read_json


def prepare_entities(pack):
    """Keep the generated index and converted textures in memory, independent of installation."""
    textures = {}
    retained = 0

    def texture_url(texture, opaque=False):
        nonlocal retained
        if not isinstance(texture, str):
            return None
        relative = PurePosixPath(texture)
        if relative.is_absolute() or ".." in relative.parts or "\\" in texture or ":" in texture:
            raise ValueError("实体贴图路径无效")
        key = texture, opaque
        if key in textures:
            return textures[key]
        for suffix in (".png", ".tga"):
            path = pack / f"{texture}{suffix}"
            if path.is_file():
                break
        else:
            return None
        with Image.open(path) as image:
            if max(image.size) > 2048:
                raise ValueError("实体贴图超过尺寸预算")
            output = io.BytesIO()
            image.convert("RGB" if opaque else "RGBA").save(output, format="PNG")
            url = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")
            retained += len(url)
            if retained > 32 << 20:
                raise ValueError("实体贴图超过内存预算")
            textures[key] = url, image.size
        return textures[key]

    result = build_catalog(pack, texture_url)
    if len(json.dumps(result)) > 64 << 20:
        raise ValueError("实体模型索引超过内存预算")
    return result


def static_number(value, baby=False, current=0):
    """Read constant setup channels only; never evaluate resource-pack code."""
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if not isinstance(value, str):
        return None
    value = value.strip()
    match = re.fullmatch(r"query\.is_baby\s*\?\s*(.*?)\s*:\s*(.*)", value)
    if match:
        value = match[1 if baby else 2]
    value = re.sub(r"\bthis\b", str(current), value)
    operations = {
        ast.Add: operator.add,
        ast.Sub: operator.sub,
        ast.Mult: operator.mul,
        ast.Div: operator.truediv,
        ast.USub: operator.neg,
        ast.UAdd: operator.pos,
    }

    def number(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            return node.value
        if isinstance(node, ast.UnaryOp) and type(node.op) in operations:
            return operations[type(node.op)](number(node.operand))
        if isinstance(node, ast.BinOp) and type(node.op) in operations:
            return operations[type(node.op)](number(node.left), number(node.right))
        raise ValueError("dynamic expression")

    try:
        result = float(number(ast.parse(value, mode="eval").body))
        return result if math.isfinite(result) and abs(result) <= 1_000_000 else None
    except (ValueError, SyntaxError, TypeError, ZeroDivisionError, OverflowError):
        return None


def setup_pose(model, animation, baby=False):
    """Bake static setup offsets, keeping unsupported animated channels untouched."""
    result = deepcopy(model)
    for bone in result["bones"]:
        channels = animation.get("bones", {}).get(bone["name"], {})
        for name in ("rotation", "position", "scale"):
            value = channels.get(name)
            if value is None:
                continue
            if not isinstance(value, list):
                value = [value] * 3
            if len(value) != 3:
                continue
            default = 1 if name == "scale" else 0
            current = bone.get(name, [default] * 3)
            updated = []
            for old, expression in zip(current, value, strict=True):
                component = static_number(expression, baby, old)
                updated.append(
                    old
                    if component is None
                    else (old * component if name == "scale" else old + component)
                )
            if updated != current:
                bone[name] = updated
    return result


def build_catalog(pack, texture_url) -> dict:
    geometries = {}
    for path in sorted((pack / "models").rglob("*.json")):
        data = read_json(path)
        for geometry in data.get("minecraft:geometry", []):
            geometries[geometry["description"]["identifier"]] = geometry
        for name, geometry in data.items():
            if isinstance(geometry, dict) and "bones" in geometry:
                geometries[name] = geometry
    # Legacy files encode inheritance in the geometry identifier itself.
    inherited = {key.split(":", 1)[0]: key for key in geometries if ":" in key}

    def resolve(name, visiting=()):
        key = inherited.get(name, name)
        if key not in geometries or key in visiting:
            return None
        child = deepcopy(geometries[key])
        if ":" not in key:
            return child
        parent = resolve(key.split(":", 1)[1], (*visiting, key))
        if parent is None:
            return None
        bones = {bone["name"]: bone for bone in parent["bones"]}
        for bone in child["bones"]:
            bones[bone["name"]] = {**bones.get(bone["name"], {}), **bone}
        return {**parent, **child, "bones": list(bones.values())}

    geometries = {
        name: model for name in set(geometries) | set(inherited) if (model := resolve(name))
    }
    entities = {}
    animations = {}
    for path in sorted((pack / "animations").glob("*.json")):
        animations.update(read_json(path).get("animations", {}))
    controllers = {}
    for path in sorted((pack / "render_controllers").rglob("*.json")):
        controllers.update(read_json(path).get("render_controllers", {}))
    behaviors = {}
    for path in sorted((pack / "behavior_pack/entities").rglob("*.json")):
        entity = read_json(path).get("minecraft:entity", {})
        behaviors[entity.get("description", {}).get("identifier")] = entity.get("components", {})

    def collision_box(components):
        collision = components.get("minecraft:collision_box", {})
        if all(
            type(collision.get(k)) in (int, float) and 0 < collision[k] <= 100
            for k in ("width", "height")
        ):
            return [collision["width"], collision["height"]]
        return None

    def controller_assets(description, baby=False):
        """Resolve resource aliases and constant array channels without executing Molang."""
        for reference in description.get("render_controllers", []):
            if isinstance(reference, dict):
                reference = next(iter(reference), "")
            controller = controllers.get(reference, {})

            def resolve(value, kind, visiting=(), controller=controller):
                if not isinstance(value, str) or value in visiting:
                    return None
                conditional = re.fullmatch(r"query\.is_baby\s*\?\s*(.*?)\s*:\s*(.*)", value)
                if conditional:
                    return resolve(conditional[1 if baby else 2], kind, (*visiting, value))
                alias = re.fullmatch(rf"{kind}\.([\w.]+)", value, re.IGNORECASE)
                if alias:
                    return description.get(
                        "geometry" if kind == "Geometry" else "textures", {}
                    ).get(alias[1])
                array = re.fullmatch(r"(array\.[\w.]+)\[(.*)\]", value, re.IGNORECASE)
                if array:
                    entries = next(
                        (
                            v
                            for k, v in controller.get("arrays", {})
                            .get("geometries" if kind == "Geometry" else "textures", {})
                            .items()
                            if k.lower() == array[1].lower()
                        ),
                        [],
                    )
                    index = static_number(array[2], baby)
                    index = int(index) if index is not None else 0
                    if entries:
                        return resolve(entries[index % len(entries)], kind, (*visiting, value))
                return None

            model = resolve(controller.get("geometry"), "Geometry")
            texture = next(
                (
                    result
                    for value in controller.get("textures", [])
                    if (result := resolve(value, "Texture"))
                ),
                None,
            )
            if model and texture:
                return model, texture
        return None, None

    # Canonical unversioned client definitions win over older compatibility files.
    paths = sorted((pack / "entity").glob("*.json"), key=lambda p: (-p.name.count("."), p.name))
    for path in paths:
        description = read_json(path).get("minecraft:client_entity", {}).get("description", {})
        identifier = description.get("identifier", "")
        if not identifier.startswith("minecraft:"):
            continue
        models = description.get("geometry", {})
        textures = description.get("textures", {})
        geometry, texture = controller_assets(description)
        geometry = geometry or models.get("default") or next(iter(models.values()), None)
        texture = texture or textures.get("default") or next(iter(textures.values()), None)
        if geometry not in geometries or not isinstance(texture, str):
            continue
        opaque = any("sheep" in material for material in description.get("materials", {}).values())
        texture_path = texture
        texture_asset = texture_url(texture, opaque)
        if texture_asset is None:
            continue
        texture, texture_size = texture_asset
        entry = {
            "geometry": geometry,
            "texture": texture,
            "texture_width": texture_size[0],
            "texture_height": texture_size[1],
            "source": path.name,
        }
        components = behaviors.get(identifier, {})
        if bounds := collision_box(components):
            entry["collision_box"] = bounds
        baby_model, controller_baby_texture = controller_assets(description, baby=True)
        baby = models.get("baby") or (baby_model if baby_model != geometry else None)
        if baby in geometries:
            entry["baby_geometry"] = baby
        baby_texture = (
            textures.get("baby")
            or textures.get("baby_default")
            or (controller_baby_texture if controller_baby_texture != texture_path else None)
        )
        baby_asset = texture_url(baby_texture, opaque)
        if baby_asset:
            entry["baby_texture"], baby_size = baby_asset
            entry["baby_texture_width"] = baby_size[0]
            entry["baby_texture_height"] = baby_size[1]
        sheared = models.get("sheared")
        if sheared in geometries:
            entry["sheared_geometry"] = sheared
        setup = (
            animations.get(description.get("animations", {}).get("setup"), {})
            if "setup" in description.get("scripts", {}).get("animate", [])
            else {}
        )
        if setup:
            for field in ("geometry", "baby_geometry", "sheared_geometry"):
                if field not in entry:
                    continue
                original = entry[field]
                model = setup_pose(geometries[original], setup, field == "baby_geometry")
                if model != geometries[original]:
                    posed = original + "@" + identifier.replace(":", ".") + "." + field
                    geometries[posed] = model
                    entry[field] = posed
        scale = description.get("scripts", {}).get("scale")
        for field, is_baby in (("scale", False), ("baby_scale", True)):
            value = static_number(scale, is_baby)
            if value is not None and 0 < value <= 100:
                entry[field] = value
        entities[identifier] = entry
    for identifier, components in behaviors.items():
        if isinstance(identifier, str) and identifier not in entities:
            if bounds := collision_box(components):
                entities[identifier] = {"geometry": "", "texture": "", "collision_box": bounds}
    used = {
        entry[key]
        for entry in entities.values()
        for key in ("geometry", "baby_geometry", "sheared_geometry")
        if entry.get(key) in geometries
    }
    return {"entities": entities, "geometries": {key: geometries[key] for key in sorted(used)}}
