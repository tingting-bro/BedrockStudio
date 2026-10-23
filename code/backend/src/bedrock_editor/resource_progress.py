"""Request-local resource preparation updates; no persistent task state."""

from contextvars import ContextVar

reporter = ContextVar("resource_reporter", default=None)


def report(stage: str, loaded: int = 0, total: int | None = None) -> None:
    callback = reporter.get()
    if callback is not None:
        callback({"stage": stage, "loaded": loaded, "total": total})
