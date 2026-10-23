"""Offline release checks using disposable packs, structures and a world database."""

import json
import os
import shutil
import subprocess
import sys
from base64 import b64encode
from pathlib import Path
from urllib.request import Request, urlopen

from .paths import bundled_node, code_root


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(f"功能自检失败：{message}")


def worker_identity(_):
    return os.getpid(), sys.stdout is not None, sys.stderr is not None


def synthetic_world(state: Path) -> Path:
    """Create only tiny, deterministic resources; release checks never download packs."""
    import nbtlib
    from PIL import Image

    from .bedrock_resources import ENTITY_ASSET_VERSION
    from .players import encode_player
    from .storage import encode

    def write(path: Path, value) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    root = state / "render-resources"
    java = root / "synthetic"
    write(java / "source.json", {})
    write(java / "pack.mcmeta", {"pack": {"pack_format": 46, "description": "build check"}})
    assets = java / "assets/minecraft"
    write(assets / "blockstates/stone.json", {"variants": {"": {"model": "block/stone"}}})
    write(
        assets / "models/block/stone.json",
        {
            "textures": {"all": "block/stone"},
            "elements": [
                {
                    "from": [0, 0, 0],
                    "to": [16, 16, 16],
                    "faces": {
                        side: {"texture": "#all", "cullface": side}
                        for side in ("east", "west", "up", "down", "north", "south")
                    },
                }
            ],
        },
    )
    texture = assets / "textures/block/stone.png"
    texture.parent.mkdir(parents=True)
    Image.new("RGBA", (16, 16), (125, 125, 125, 255)).save(texture)
    bedrock = root / "bedrock/1.21.120"
    write(bedrock / "source.json", {"release": "1.21.120", "entity_assets": ENTITY_ASSET_VERSION})
    write(bedrock / "blocks.json", {})
    write(bedrock / "textures/terrain_texture.json", {"texture_data": {}})
    write(
        bedrock / "entity/pig.json",
        {
            "minecraft:client_entity": {
                "description": {
                    "identifier": "minecraft:pig",
                    "geometry": {"default": "geometry.pig"},
                    "textures": {"default": "textures/entity/pig"},
                    "render_controllers": ["controller.render.pig"],
                }
            }
        },
    )
    write(
        bedrock / "models/entity/pig.json",
        {
            "minecraft:geometry": [
                {
                    "description": {"identifier": "geometry.pig"},
                    "bones": [
                        {
                            "name": "body",
                            "cubes": [{"origin": [-4, 0, -4], "size": [8, 8, 8], "uv": [0, 0]}],
                        }
                    ],
                }
            ]
        },
    )
    write(
        bedrock / "render_controllers/pig.json",
        {
            "render_controllers": {
                "controller.render.pig": {
                    "geometry": "Geometry.default",
                    "textures": ["Texture.default"],
                },
            }
        },
    )
    write(
        bedrock / "behavior_pack/entities/pig.json",
        {
            "minecraft:entity": {
                "description": {"identifier": "minecraft:pig"},
                "components": {"minecraft:collision_box": {"width": 0.9, "height": 0.9}},
            }
        },
    )
    entity_texture = bedrock / "textures/entity/pig.png"
    entity_texture.parent.mkdir(parents=True)
    Image.new("RGBA", (64, 32), (230, 150, 150, 255)).save(entity_texture)
    world = state / "synthetic-world"
    world.mkdir()
    (world / "level.dat").write_bytes(
        encode(
            10,
            nbtlib.File(
                {
                    "LevelName": nbtlib.String("发布自检"),
                    "lastOpenedWithVersion": nbtlib.List[nbtlib.Int]([1, 21, 120]),
                }
            ),
        )
    )
    player = encode_player(nbtlib.File({"UniqueID": nbtlib.Long(9223372036854775806)}))
    node = bundled_node() or shutil.which("node")
    require(node is not None, "缺少 Node.js")
    subprocess.run(
        [
            str(node),
            "-e",
            """
const {createRequire} = require('node:module');
const {LevelDB} = createRequire(process.argv[1])('@8crafter/leveldb-zlib');
(async () => {
  const db = new LevelDB(process.argv[2], {createIfMissing: true});
  await db.open();
  try {
    await db.batch([{type:'put', key:Buffer.from('~local_player'),
      value:Buffer.from(process.argv[3], 'base64')}], {sync:true});
  } finally { await db.close(); }
})().catch(e => {console.error(e); process.exitCode=1;});
""",
            str(code_root() / "frontend/package.json"),
            str(world / "db"),
            b64encode(player).decode(),
        ],
        check=True,
        timeout=20,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return world


def check_converters() -> None:
    import amulet_nbt

    from . import resources
    from .structure_formats import Structure, export_clipboard, parse, to_clipboard
    from .voxels import default_states, known_blocks, new_block

    # Exercise Cython's runtime imports and modified UTF-8 (including NUL/non-BMP).
    text = amulet_nbt.StringTag("发布\0\U0001f30d")
    require(amulet_nbt.from_snbt(text.to_snbt()) == text, "NBT 编解码")
    from amulet.level.loader import Formats, Interfaces, Translators
    from PyMCTranslate.py3.api.version.code_functions import code_functions

    require(bool(code_functions), "动态方块转换函数")
    require(bool(Formats.keys() and Interfaces.keys() and Translators.keys()), "动态格式加载器")
    require(bool(default_states()) and "stone" in known_blocks(), "方块状态与目录索引")
    original = Structure((1, 1, 1), {(0, 0, 0): new_block("stone")})
    clipboard = to_clipboard(original)
    for format in ("mcstructure", "schem", "schematic"):
        result = parse(export_clipboard(clipboard, format), format)
        require(
            result.size == original.size
            and str(result.blocks[(0, 0, 0)]["name"]) == "minecraft:stone",
            f"{format} 结构往返",
        )
    try:
        require(list(resources.parallel_map(abs, [-3, -5], workers=2)) == [3, 5], "后台计算")
        workers = list(resources.parallel_map(worker_identity, [0, 1], workers=2))
        require(
            all(pid != os.getpid() and stdout and stderr for pid, stdout, stderr in workers),
            "后台进程与无控制台标准流",
        )
        require(not resources._disabled, "后台子进程不可用，发生串行回退")
    finally:
        resources.shutdown()
    # The browser-mode folder picker uses Tk even when the native window uses WebView2.
    import tkinter

    require(bool(tkinter.Tcl().eval("info patchlevel")), "浏览器模式文件夹选择器运行库")


def check_api(url: str, token: str, world: Path) -> None:
    """Use the real authenticated HTTP routes, including lazy database/model imports."""

    def request(path: str, body=None):
        with urlopen(
            Request(
                url + "/api" + path,
                data=json.dumps(body).encode() if body is not None else None,
                headers={"X-Editor-Token": token, "Content-Type": "application/json"},
            ),
            timeout=30,
        ) as response:
            return json.load(response)

    doc = request("/documents/open", {"path": str(world)})
    prefix = "/documents/" + doc["id"]
    result = request(prefix + "/render-resources")
    atlas = result["amulet"]["url"].removeprefix("/api")
    models = request(atlas + "/models", {"queries": [{"block": {"name": "minecraft:stone"}}]})
    require(bool(models["models"][0]["parts"]), "真实 3D 模型 API")
    entities = request(atlas + "/entity-models")
    pig = entities["entities"]["minecraft:pig"]
    require(pig["geometry"] in entities["geometries"], "实体几何 API")
    require(pig["texture"].startswith("data:image/png;base64,"), "实体贴图 API")
    require(pig["collision_box"] == [0.9, 0.9], "实体行为包 API")
    with urlopen(
        Request(url + "/api" + atlas + "/atlas.png", headers={"X-Editor-Token": token}),
        timeout=10,
    ) as response:
        require(response.read().startswith(b"\x89PNG"), "3D 图集 API")
    # Access the actual subprocess bridge and retain a lossless 64-bit payload.
    from .players import DatabaseStore, decode_player, encode_player

    store = DatabaseStore(world)
    try:
        require(store.items[0]["name"] == "~local_player", "玩家数据库索引")
        raw = store.request("get", key=b"~local_player".hex())
        from base64 import b64decode

        require(
            int(decode_player(b64decode(raw))["UniqueID"]) == 9223372036854775806,
            "玩家数据库读取与 64 位整数",
        )
        tree = decode_player(b64decode(raw))
        tree["UniqueID"] = type(tree["UniqueID"])(9223372036854775805)
        expected = b64encode(encode_player(tree)).decode()
        store.request("write", items=[{"key": b"~local_player".hex(), "value": expected}])
    finally:
        store.close()
    reopened = DatabaseStore(world)
    try:
        require(reopened.request("get", key=b"~local_player".hex()) == expected, "数据库同步保存")
    finally:
        reopened.close()
    print("功能自检通过：3D 初始化/图集/模型、结构转换、数据库、后台进程", flush=True)
