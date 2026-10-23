"""Validated application preferences, stored outside Minecraft worlds."""

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .constants import (
    DEFAULT_FLIGHT_SPEED,
    DEFAULT_RENDER_DISTANCE,
    MAX_FLIGHT_SPEED,
    MAX_RENDER_DISTANCE,
    MIN_FLIGHT_SPEED,
    MIN_RENDER_DISTANCE,
)

DEFAULT_SHORTCUTS = {
    "save": "Ctrl+KeyS",
    "undo": "Ctrl+KeyZ",
    "redo": "Ctrl+Shift+KeyZ",
    "delete": "Delete",
    "toggleView": "Tab",
    "focus": "Home",
    "tools": "KeyN",
    "copy": "Ctrl+KeyC",
    "move": "Ctrl+KeyX",
    "paste": "Ctrl+KeyV",
    "deselect": "Ctrl+KeyD",
}


class Preferences(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    world_layout: Literal["grid", "list"] = "grid"
    show_covers: bool = True
    default_view: Literal["2d", "3d", "map"] = "2d"
    default_render_distance: int = Field(
        default=DEFAULT_RENDER_DISTANCE, ge=MIN_RENDER_DISTANCE, le=MAX_RENDER_DISTANCE
    )
    default_flight_speed: float = Field(
        default=DEFAULT_FLIGHT_SPEED,
        ge=MIN_FLIGHT_SPEED,
        le=MAX_FLIGHT_SPEED,
        allow_inf_nan=False,
    )
    reduced_motion: bool = False
    shortcuts: dict[str, str] = Field(default_factory=lambda: DEFAULT_SHORTCUTS.copy())

    @model_validator(mode="after")
    def validate_shortcuts(self) -> "Preferences":
        if set(self.shortcuts) - DEFAULT_SHORTCUTS.keys():
            raise ValueError("未知快捷键操作")
        effective = DEFAULT_SHORTCUTS | self.shortcuts
        for binding in effective.values():
            if not re.fullmatch(
                r"(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?"
                r"(?:Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-2]|Delete|Home|End|PageUp|PageDown|Tab)",
                binding,
            ):
                raise ValueError("快捷键格式无效")
            key = binding.split("+")[-1]
            if (
                re.fullmatch(r"(?:Shift\+)?Key[WASDQERFG]", binding)
                or key in {"F5", "F11", "F12"}
                or binding
                in {
                    "Alt+F4",
                    "Ctrl+KeyW",
                    "Ctrl+KeyQ",
                    "Ctrl+KeyR",
                    "Ctrl+KeyL",
                    "Ctrl+KeyT",
                    "Ctrl+KeyN",
                    "Ctrl+KeyO",
                    "Ctrl+KeyP",
                    "KeyW",
                    "KeyA",
                    "KeyS",
                    "KeyD",
                    "KeyQ",
                    "KeyE",
                    "KeyR",
                    "KeyF",
                    "KeyG",
                }
            ):
                raise ValueError("该按键已用于窗口、飞行或变换操作")
        if len(set(effective.values())) != len(effective):
            raise ValueError("快捷键重复，请为每个操作设置不同按键")
        self.shortcuts = effective
        return self
