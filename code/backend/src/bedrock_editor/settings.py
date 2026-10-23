"""Persist user preferences in the runtime directory, outside application constants."""

import json
import os
import tempfile
from pathlib import Path
from threading import RLock

from .preferences import Preferences


class SettingsStore:
    def __init__(self) -> None:
        base = os.environ.get("BEDROCK_EDITOR_STATE_DIR")
        directory = (Path(base) if base is not None else Path.cwd()).resolve()
        self.path = directory / "settings.json"
        self.legacy_path = directory / "temp.json"
        self.lock = RLock()

    def _read(self) -> Preferences:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError):
            raise ValueError("用户设置 settings.json 损坏，请检查文件内容") from None
        return Preferences.model_validate(data)

    def _initial(self) -> Preferences:
        try:
            data = json.loads(self.legacy_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return Preferences()
        except (ValueError, UnicodeError):
            raise ValueError("旧版设置 temp.json 损坏，无法迁移用户设置") from None
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ValueError("旧版设置 temp.json 格式无效，无法迁移用户设置")
        return Preferences.model_validate(data.get("preferences", {}))

    def _write(self, preferences: Preferences) -> None:
        content = json.dumps(preferences.model_dump(), ensure_ascii=False, indent=2) + "\n"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        pending = None
        try:
            # Commit only a complete file; failures retain the previous settings.
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix="settings-",
                suffix=".tmp",
                delete=False,
            ) as stream:
                pending = Path(stream.name)
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(pending, self.path)
        finally:
            if pending is not None:
                pending.unlink(missing_ok=True)

    def load(self) -> Preferences:
        with self.lock:
            try:
                return self._read()
            except FileNotFoundError:
                preferences = self._initial()
                self._write(preferences)
                return preferences

    def save(self, preferences: Preferences) -> Preferences:
        # Validate the entire update before touching either file.
        preferences = Preferences.model_validate(preferences.model_dump())
        with self.lock:
            try:
                previous = self._read()
            except FileNotFoundError:
                previous = None
            if previous != preferences:
                self._write(preferences)
            return preferences
