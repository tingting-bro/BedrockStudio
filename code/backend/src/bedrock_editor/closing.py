"""Keep native window closing cancellable until the user finishes the close flow."""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

from .constants import APP_CLOSE_PROMPT

if TYPE_CHECKING:
    from webview import Window

    from .editor import Document
    from .workspace import Workspace


class CloseController:
    """Expose save/discard approval to JavaScript while keeping window state private."""

    def __init__(self, documents: dict[str, Workspace] | dict[str, Document]) -> None:
        self._documents = documents
        self._window: Window | None = None
        self._lock = threading.Lock()
        self._pending = False
        self._approved = False

    def _on_closing(self) -> bool:
        with self._lock:
            if self._approved:
                return True
            if not self._pending:
                self._pending = True
                threading.Thread(target=self._request_confirmation, daemon=True).start()
        # This callback runs on the native UI thread. Never wait for JavaScript here.
        return False

    def _request_confirmation(self) -> None:
        window = self._window
        if window is None:
            self.cancel_close()
            return
        try:
            shown = window.evaluate_js(
                "typeof window.bedrockDesktop?.requestClose === 'function' "
                "? (window.bedrockDesktop.requestClose(), true) : false"
            )
        except Exception:
            shown = False
        if not shown:
            self._fallback_confirmation()

    def _dirty_documents(self) -> list[Workspace | Document]:
        dirty = []
        for doc in list(self._documents.values()):
            with doc.lock:
                if doc.dirty:
                    dirty.append(doc)
        return dirty

    def cancel_close(self) -> dict[str, bool]:
        with self._lock:
            self._pending = False
        return {"cancelled": True}

    def confirm_close(self, discard: bool = False) -> dict[str, bool | str]:
        window = self._window
        if window is None:
            return {"closed": False, "error": "窗口尚未就绪"}
        if not discard and self._dirty_documents():
            return {"closed": False, "error": "当前修改尚未保存"}
        with self._lock:
            self._approved = True
        try:
            window.destroy()
        except Exception as exc:
            with self._lock:
                self._approved = False
                self._pending = False
            return {"closed": False, "error": str(exc)}
        return {"closed": True}

    def _fallback_confirmation(self) -> None:
        """Allow a safe close even while the frontend is loading or unavailable."""
        window = self._window
        if window is None:
            self.cancel_close()
            return
        try:
            dirty = self._dirty_documents()
            if dirty:
                if window.create_confirmation_dialog("保存修改", "保存当前修改并关闭？"):
                    try:
                        for doc in dirty:
                            with doc.lock:
                                doc.save(doc.revision)
                    except Exception as exc:
                        window.create_confirmation_dialog("保存失败", str(exc))
                        self.cancel_close()
                        return
                    self.confirm_close()
                elif window.create_confirmation_dialog("放弃修改", "不保存当前修改并关闭？"):
                    self.confirm_close(discard=True)
                else:
                    self.cancel_close()
            elif window.create_confirmation_dialog("关闭程序", APP_CLOSE_PROMPT):
                self.confirm_close()
            else:
                self.cancel_close()
        except Exception:
            # UI failure must never be interpreted as permission to discard changes.
            self.cancel_close()
