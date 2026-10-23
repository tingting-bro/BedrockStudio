"""Exercise the installed desktop stack in an isolated, automatically closed window."""

import os
import socket
import tempfile
import threading
import time
from pathlib import Path
from urllib.request import urlopen

import uvicorn
import webview

from .api import create_app
from .constants import APP_NAME
from .packaging_features import check_api, check_converters, synthetic_world
from .paths import code_root


def check_desktop() -> None:
    """Load WinForms/pythonnet/WebView2 and the real React page, without opening a world."""
    with tempfile.TemporaryDirectory(prefix="bedrock-build-check-") as state:
        previous_state = os.environ.get("BEDROCK_EDITOR_STATE_DIR")
        previous_worker_log = os.environ.get("BEDROCK_EDITOR_WORKER_LOG")
        os.environ["BEDROCK_EDITOR_STATE_DIR"] = state
        worker_log = Path(state) / "worker-errors.log"
        os.environ["BEDROCK_EDITOR_WORKER_LOG"] = str(worker_log)
        try:
            _check(Path(state))
        except BaseException:
            if worker_log.is_file():
                print(worker_log.read_text(encoding="utf-8"), flush=True)
            raise
        finally:
            if previous_worker_log is None:
                os.environ.pop("BEDROCK_EDITOR_WORKER_LOG", None)
            else:
                os.environ["BEDROCK_EDITOR_WORKER_LOG"] = previous_worker_log
            if previous_state is None:
                os.environ.pop("BEDROCK_EDITOR_STATE_DIR", None)
            else:
                os.environ["BEDROCK_EDITOR_STATE_DIR"] = previous_state


def _check(state: Path) -> None:
    # Importing this backend catches missing win32/clr before starting the service.
    from webview.platforms import winforms

    if winforms.renderer != "edgechromium":
        raise RuntimeError(f"需要 WebView2，实际渲染器为 {winforms.renderer}")
    check_converters()
    world = synthetic_world(state)
    frontend = code_root() / "frontend/dist"
    app = create_app(frontend)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", use_colors=False))
    failures: list[str] = []
    passed = threading.Event()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        url = f"http://127.0.0.1:{listener.getsockname()[1]}"
        thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
        thread.start()
        try:
            for _ in range(200):
                if server.started:
                    break
                if not thread.is_alive():
                    raise RuntimeError("打包自检服务启动失败")
                time.sleep(0.05)
            if not server.started:
                raise RuntimeError("打包自检服务启动超时")
            check_api(url, app.state.token, world)
            for asset in ("/", "/fonts/PressStart2P-Regular.ttf", "/minecraft/scene/atlas.json"):
                with urlopen(url + asset, timeout=10) as response:
                    if response.status != 200 or not response.read():
                        raise RuntimeError(f"缺少前端资源：{asset}")
            window = webview.create_window(f"{APP_NAME} build check", url, hidden=True)

            def verify() -> None:
                try:
                    for _ in range(100):
                        if window.evaluate_js(
                            "Boolean(document.querySelector('#root')?.children.length)"
                        ):
                            passed.set()
                            return
                        time.sleep(0.1)
                    failures.append("React 页面未渲染")
                except Exception as exc:
                    failures.append(str(exc))
                finally:
                    window.destroy()

            window.events.loaded += verify
            watchdog = threading.Timer(45, window.destroy)
            watchdog.daemon = True
            watchdog.start()
            try:
                webview.start(gui="edgechromium", private_mode=True, storage_path=str(state))
            finally:
                watchdog.cancel()
            if failures or not passed.is_set():
                raise RuntimeError("桌面自检失败：" + "; ".join(failures or ["页面加载超时"]))
            print("桌面自检通过：WinForms / pythonnet / WebView2 / React / 静态资源", flush=True)
        finally:
            server.should_exit = True
            thread.join(timeout=10)
