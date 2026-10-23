"""Discover current-user Bedrock installations without fixed account IDs."""

import os
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

from . import storage


def discover_roots() -> list[Path]:
    override = os.environ.get("BEDROCK_WORLD_ROOTS")
    if override is not None:
        return [Path(p).expanduser().resolve() for p in override.split(os.pathsep) if p]
    roaming = Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming"))
    local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
    roots: list[Path] = []
    for edition in ("Minecraft Bedrock", "Minecraft Bedrock Preview"):
        base = roaming / edition
        roots.extend(base.glob("Users/*/games/com.mojang/minecraftWorlds"))
        roots.append(base / "games/com.mojang/minecraftWorlds")
    packages = local / "Packages"
    for pattern in ("Microsoft.MinecraftUWP_*", "Microsoft.MinecraftWindowsBeta_*"):
        for package in packages.glob(pattern):
            roots.append(package / "LocalState/games/com.mojang/minecraftWorlds")
    return list(dict.fromkeys(path.resolve() for path in roots if path.is_dir()))


def normalize_world(path: str | Path) -> Path:
    folder = Path(path).expanduser().resolve()
    if folder.name.lower() == "level.dat" and folder.is_file():
        folder = folder.parent
    if not folder.is_dir() or not (folder / "level.dat").is_file():
        raise ValueError("请选择包含 level.dat 的基岩版世界文件夹")
    return folder


def world_info(folder: Path) -> dict[str, Any]:
    path = folder / "level.dat"
    name_file = folder / "levelname.txt"
    name = (
        name_file.read_text(encoding="utf-8-sig", errors="replace").strip()
        if name_file.exists()
        else folder.name
    )
    stat = path.stat()
    info = {
        "id": sha256(str(folder).encode()).hexdigest()[:20],
        "path": str(folder),
        "name": name,
        "folder_name": folder.name,
        "mode": "未知模式",
        "version": "未知版本",
        "seed": None,
        "last_played": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(),
        "level_dat_size": stat.st_size,
        "tag_count": 0,
        "icon_url": None,
        "error": None,
    }
    try:
        _, _, tree = storage.read(path)
        info["name"] = str(tree.get("LevelName", name)) or name
        modes = {0: "生存模式", 1: "创造模式", 2: "冒险模式", 3: "旁观模式", 5: "旁观模式"}
        info["mode"] = modes.get(int(tree.get("GameType", -1)), "未知模式")
        version = tree.get("lastOpenedWithVersion")
        if version is not None:
            info["version"] = ".".join(str(int(v)) for v in list(version)[:3])
        if "RandomSeed" in tree:
            info["seed"] = str(int(tree["RandomSeed"]))
        played = int(tree.get("LastPlayed", stat.st_mtime))
        if played > 0:
            try:
                info["last_played"] = datetime.fromtimestamp(played, UTC).isoformat()
            except (ValueError, OverflowError, OSError):
                pass  # Invalid metadata should not prevent opening a valid NBT file.
        info["tag_count"] = len(tree)
    except (ValueError, OSError, OverflowError) as exc:
        info["error"] = str(exc)
    for filename in ("world_icon.jpeg", "world_icon.jpg", "world_icon.png"):
        if (folder / filename).is_file():
            info["icon_url"] = f"/api/worlds/{info['id']}/icon"
            break
    return info
