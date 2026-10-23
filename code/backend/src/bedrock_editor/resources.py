"""Shared, lazy CPU capacity and bounded immutable jobs. Never opens a world."""

from __future__ import annotations

import atexit
import ctypes
import logging
import multiprocessing
import os
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from itertools import chain
from threading import RLock, Semaphore


def memory_status():
    if os.name == "nt":

        class Status(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
                (name, ctypes.c_ulonglong)
                for name in (
                    "total",
                    "available",
                    "page",
                    "free_page",
                    "virtual",
                    "free_virtual",
                    "extra",
                )
            ]

        status = Status()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return status.total, status.available
    try:
        page = os.sysconf("SC_PAGE_SIZE")
        return page * os.sysconf("SC_PHYS_PAGES"), page * os.sysconf("SC_AVPHYS_PAGES")
    except (AttributeError, OSError, ValueError):
        return 1 << 30, 512 << 20


def memory_headroom():
    total, available = memory_status()
    # Keep 10% of physical memory available to the OS and other applications.
    return max(0, available - total // 10)


def worker_count():
    cpus = os.cpu_count() or 1
    return max(1, min(61, cpus * 9 // 10, memory_headroom() // (512 << 20)))


_lock = RLock()
_pool = None
_slots = None
_disabled = False


def structure_workers(sections):
    # A cold Windows interpreter is expensive. Native NumPy section encoding
    # already handles ordinary structures quickly on one core.
    threshold = 128 if _pool is not None and not _disabled else 4096
    return min(worker_count(), max(1, sections // 32)) if sections >= threshold else 1


def shutdown():
    global _pool, _slots
    with _lock:
        pool, _pool = _pool, None
        _slots = None
    if pool is not None:
        pool.shutdown(wait=True, cancel_futures=True)


def parallel_map(function, items, *, workers=None):
    """Ordered results, bounded queue across callers, serial fallback on pool failure.

    Inputs must be immutable and replayable. Only infrastructure errors retry;
    validation errors propagate before callers can commit any world mutation.
    """
    global _pool, _slots, _disabled
    from concurrent.futures.process import BrokenProcessPool

    iterator = iter(items)
    count = worker_count() if workers is None else workers
    if count <= 1 or _disabled:
        yield from map(function, iterator)
        return
    pending = deque()
    try:
        with _lock:
            if _pool is None:
                _pool = ProcessPoolExecutor(
                    max_workers=count, mp_context=multiprocessing.get_context("spawn")
                )
                _slots = Semaphore(count * 2)
            pool, slots = _pool, _slots
    except (OSError, RuntimeError):
        logging.getLogger(__name__).warning("后台计算进程创建失败，改用串行计算", exc_info=True)
        _disabled = True
        yield from map(function, iterator)
        return
    try:
        exhausted = False
        while pending or not exhausted:
            while not exhausted and len(pending) < count:
                try:
                    item = next(iterator)
                except StopIteration:
                    exhausted = True
                    break
                # Do not block while holding results: another caller may own slots.
                if pending and not slots.acquire(blocking=False):
                    iterator = chain((item,), iterator)
                    break
                if not pending:
                    slots.acquire()
                try:
                    future = pool.submit(function, item)
                except (OSError, RuntimeError) as exc:
                    slots.release()
                    pending.append((item, None))
                    raise BrokenProcessPool(str(exc)) from exc
                except BaseException:
                    slots.release()
                    raise
                future.add_done_callback(lambda _, slots=slots: slots.release())
                pending.append((item, future))
            if pending:
                item, future = pending[0]
                result = future.result()
                pending.popleft()
                yield result
    except BrokenProcessPool:
        logging.getLogger(__name__).warning("后台计算进程退出，改用串行计算", exc_info=True)
        _disabled = True
        for value, future in pending:
            if future is not None:
                future.cancel()
            yield function(value)
        yield from map(function, iterator)
    finally:
        for _, future in pending:
            if future is not None:
                future.cancel()


atexit.register(shutdown)
