"""Small persistent recent-world list, separate from Minecraft save data."""

import json
import os
from pathlib import Path
from threading import RLock
from typing import Any

from .worlds import normalize_world


class RecentWorlds:
    def __init__(self) -> None:
        base = os.environ.get("BEDROCK_EDITOR_STATE_DIR")
        self.path = (Path(base) if base is not None else Path.cwd()).resolve() / "temp.json"
        self.lock = RLock()

    def _state(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"version": 1}
        except (ValueError, UnicodeError):
            raise ValueError("临时状态 temp.json 损坏，成功打开存档后将重新记录") from None
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ValueError("临时状态 temp.json 格式无效")
        return data

    @staticmethod
    def _paths(data: dict[str, Any]) -> list[str]:
        paths = data.get("recent_worlds", data.get("paths", []))
        if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
            raise ValueError("最近存档记录格式无效")
        return paths[:20]

    def paths(self) -> list[str]:
        with self.lock:
            return self._paths(self._state())

    def remember(self, folder: Path) -> None:
        with self.lock:
            try:
                data = self._state()
                previous = self._paths(data)
            except ValueError:
                data = {"version": 1}
                previous = []
            selected = os.path.normcase(str(folder.resolve()))
            paths = [str(folder.resolve())]
            for path in previous:
                if os.path.normcase(str(Path(path).resolve())) != selected:
                    paths.append(path)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            before = data.copy()
            data.pop("paths", None)
            data["recent_worlds"] = paths[:20]
            content = json.dumps(data, ensure_ascii=False)
            if data == before and self.path.is_file():
                return
            # Runtime state is disposable: one file, no sibling .tmp/cache files.
            self.path.write_text(content, encoding="utf-8")

    def available(self) -> list[Path]:
        result = []
        for path in self.paths():
            try:
                folder = normalize_world(path)
            except (ValueError, OSError):
                continue
            if folder not in result:
                result.append(folder)
        return result
