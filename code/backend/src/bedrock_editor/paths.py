"""Locate source resources and the installed standalone distribution."""

import sys
from pathlib import Path


def compiled() -> bool:
    return "__compiled__" in globals() or getattr(sys, "frozen", False)


def code_root() -> Path:
    if compiled():
        return Path(sys.executable).resolve().parent / "code"
    return Path(__file__).resolve().parents[3]


def resource_pack_root() -> Path:
    root = code_root()
    return root / ("frontend/dist" if compiled() else "resource_packs")


def bundled_node() -> Path | None:
    if compiled():
        return Path(sys.executable).resolve().parent / "node.exe"
    return None
