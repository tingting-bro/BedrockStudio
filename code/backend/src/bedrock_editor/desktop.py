"""Start the local service, then host its frontend in a native window."""

import argparse
import socket
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from .api import create_app
from .closing import CloseController
from .constants import (
    APP_CHANNEL,
    APP_NAME,
    APP_TITLE,
    DESKTOP_HEIGHT,
    DESKTOP_MIN_SIZE,
    DESKTOP_WIDTH,
    DEV_BACKEND_PORT,
    DEV_FRONTEND_PORT,
)
from .paths import code_root, resource_pack_root
from .worlds import discover_roots


def main() -> None:
    parser = argparse.ArgumentParser(description=f"{APP_NAME} {APP_CHANNEL}")
    parser.add_argument("--browser", action="store_true")
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--dev", action="store_true")
    parser.add_argument(
        "--smoke-test", action="store_true", help="隔离状态，检查原生窗口并自动退出"
    )
    args = parser.parse_args()
    if args.smoke_test:
        from .packaging_check import check_desktop

        check_desktop()
        return
    root = code_root()
    build = root / "frontend/dist"
    if not args.dev and not (build / "index.html").is_file():
        raise SystemExit("请先构建前端：cd code/frontend，然后执行 npm install 和 npm run build")
    app = create_app(build if build.exists() else None)
    listener = socket.socket()
    listener.bind(("127.0.0.1", args.port or (DEV_BACKEND_PORT if args.dev else 0)))
    port = listener.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", use_colors=False)
    )
    url = f"http://127.0.0.1:{DEV_FRONTEND_PORT}" if args.dev else f"http://127.0.0.1:{port}"
    print(f"{APP_NAME}: {url}", flush=True)
    if args.browser or args.dev:
        if not args.no_open:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        server.run(sockets=[listener])
        return
    import webview

    thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        if not thread.is_alive():
            raise SystemExit("本地服务启动失败")
        time.sleep(0.05)
    close_controller = CloseController(app.state.documents)
    window = webview.create_window(
        APP_TITLE,
        url,
        js_api=close_controller,
        width=DESKTOP_WIDTH,
        height=DESKTOP_HEIGHT,
        min_size=DESKTOP_MIN_SIZE,
        background_color="#15191c",
    )
    close_controller._window = window

    def choose() -> str | None:
        roots = discover_roots()
        result = window.create_file_dialog(
            webview.FileDialog.FOLDER, directory=str(roots[0]) if roots else ""
        )
        return result[0] if result else None

    def save_structure(raw: bytes, filename: str) -> None:
        result = window.create_file_dialog(
            webview.FileDialog.SAVE,
            save_filename=filename,
            file_types=(f"Minecraft structure (*.{filename.rsplit('.', 1)[-1]})",),
        )
        if result:
            # The path comes exclusively from the native save dialog.
            selected = result if isinstance(result, str) else result[0]
            Path(selected).write_bytes(raw)

    app.state.structure_saver = save_structure
    app.state.folder_picker = choose
    window.events.closing += close_controller._on_closing
    try:
        webview.start(icon=str(resource_pack_root() / "app-icon.ico"))
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        listener.close()
