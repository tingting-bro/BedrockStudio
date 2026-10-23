"""Application constants shared with the frontend; edit app_constants.json."""

import json
from pathlib import Path

_CONFIG = json.loads(Path(__file__).with_name("app_constants.json").read_text(encoding="utf-8"))

APP_NAME = f"{_CONFIG['brand']} {_CONFIG['edition']}"
APP_VERSION = _CONFIG["version"]
APP_CHANNEL = _CONFIG["channel"]
APP_TITLE = f"{APP_NAME} · {_CONFIG['caption']}"
APP_CLOSE_PROMPT = f"确定关闭 {APP_NAME}？"
DEFAULT_RENDER_DISTANCE = _CONFIG["render_distance"]["default"]
MIN_RENDER_DISTANCE = _CONFIG["render_distance"]["min"]
MAX_RENDER_DISTANCE = _CONFIG["render_distance"]["max"]
DEFAULT_FLIGHT_SPEED = _CONFIG["flight_speed"]["default"]
MIN_FLIGHT_SPEED = _CONFIG["flight_speed"]["min"]
MAX_FLIGHT_SPEED = _CONFIG["flight_speed"]["max"]
DESKTOP_WIDTH = _CONFIG["desktop"]["width"]
DESKTOP_HEIGHT = _CONFIG["desktop"]["height"]
DESKTOP_MIN_SIZE = (_CONFIG["desktop"]["min_width"], _CONFIG["desktop"]["min_height"])
DEV_FRONTEND_PORT = _CONFIG["development"]["frontend_port"]
DEV_BACKEND_PORT = _CONFIG["development"]["backend_port"]
DEV_ORIGINS = (f"http://127.0.0.1:{DEV_FRONTEND_PORT}", f"http://localhost:{DEV_FRONTEND_PORT}")
