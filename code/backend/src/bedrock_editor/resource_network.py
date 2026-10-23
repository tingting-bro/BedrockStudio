"""Resource downloads through mirrors, with opt-in official-origin fallback."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import zipfile
from http.client import HTTPException
from threading import Lock
from time import monotonic
from urllib.error import URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .resource_progress import report

# All defaults must serve both Git tag advertisements and pinned archives.
GITHUB_MIRRORS = ("https://ghproxy.imciel.com", "https://gh.catmak.name", "https://gh-proxy.org")
MOJANG_MIRRORS = ("https://bmclapi2.bangbang93.com", "https://bmclapi.bangbang93.com")
GITHUB_HOSTS = {"github.com", "codeload.github.com", "raw.githubusercontent.com"}
MOJANG_HOSTS = {
    "piston-meta.mojang.com",
    "piston-data.mojang.com",
    "launchermeta.mojang.com",
    "launcher.mojang.com",
    "resources.download.minecraft.net",
}
_failed: dict[str, float] = {}
# Separate metadata latency from archive throughput; keep observations in memory.
_performance: dict[tuple[str, bool], tuple[float, float]] = {}
SLOW_GRACE = 15
MIN_DOWNLOAD_RATE = 64 << 10
_lock = Lock()
log = logging.getLogger(__name__)


def allow_origin() -> bool:
    # Official endpoints are the recovery path after the configured mirrors.
    # Keep the environment switch as a compatibility override for deployments
    # that explicitly need to prohibit origin traffic.
    return os.environ.get("BEDROCK_EDITOR_ALLOW_ORIGIN_DOWNLOAD", "1") != "0"


def origin_host(host: str | None) -> bool:
    host = (host or "").lower().rstrip(".")
    return host in GITHUB_HOSTS | MOJANG_HOSTS or host.endswith(
        (".github.com", ".githubusercontent.com", ".mojang.com")
    )


def mirrors(name: str, defaults: tuple[str, ...]) -> tuple[str, ...]:
    value = os.environ.get(name)
    entries = (
        defaults
        if value is None
        else tuple(p.strip().rstrip("/") for p in value.split(",") if p.strip())
    )
    for entry in entries:
        parts = urlsplit(entry)
        if (
            parts.scheme != "https"
            or not parts.netloc
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
        ):
            raise ValueError(f"{name} 必须是逗号分隔的 HTTPS 镜像地址")
    return tuple(dict.fromkeys(entries))


def download_urls(url: str) -> tuple[str, ...]:
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError("原版资源地址必须使用 HTTPS")
    host = parts.hostname
    if host in GITHUB_HOSTS or host.endswith((".github.com", ".githubusercontent.com")):
        # Most accelerators accept GitHub archive URLs, but reject codeload URLs.
        source = url
        if host == "codeload.github.com":
            match = re.fullmatch(r"/([^/]+/[^/]+)/zip/([a-f0-9]{40})", parts.path)
            if match:
                source = f"https://github.com/{match[1]}/archive/{match[2]}.zip"
        urls = [
            f"{mirror}/{source}"
            for mirror in mirrors("BEDROCK_EDITOR_GITHUB_MIRRORS", GITHUB_MIRRORS)
        ]
    elif host in MOJANG_HOSTS or host.endswith(".mojang.com"):
        urls = [
            urlunsplit(
                (
                    "https",
                    urlsplit(mirror).netloc,
                    urlsplit(mirror).path + parts.path,
                    parts.query,
                    "",
                )
            )
            for mirror in mirrors("BEDROCK_EDITOR_MOJANG_MIRRORS", MOJANG_MIRRORS)
        ]
    else:
        return (url,)
    if allow_origin():
        urls.append(url)
    if not urls:
        raise ValueError("未配置可用资源镜像；可设置资源镜像地址后重试")
    return tuple(dict.fromkeys(urls))


class MirrorRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urlsplit(newurl)
        if parts.scheme != "https":
            raise URLError("资源镜像重定向必须使用 HTTPS")
        if not allow_origin() and origin_host(parts.hostname):
            raise URLError("资源镜像重定向到了已禁用的官方直连地址")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_resource(request, *, timeout):
    return build_opener(MirrorRedirect()).open(request, timeout=timeout)


def validate_payload(url: str, data: bytes) -> None:
    """Reject mirror error pages before accepting a channel as successful."""
    parts = urlsplit(url)
    if data.lstrip()[:32].lower().startswith((b"<!doctype html", b"<html")):
        raise ValueError("资源镜像返回网页，未返回资源文件")
    if parts.path.endswith("/info/refs"):
        if not data.startswith(b"001e# service=git-upload-pack\n") or b" refs/tags/v" not in data:
            raise ValueError("资源镜像返回无效的版本列表")
        offset = 0
        while offset < len(data):
            header = data[offset : offset + 4]
            if not re.fullmatch(rb"[0-9a-fA-F]{4}", header):
                raise ValueError("资源镜像返回无效的版本列表")
            size = int(header, 16)
            if (size and size < 4) or offset + max(4, size) > len(data):
                raise ValueError("资源镜像版本列表下载不完整")
            offset += max(4, size)
    elif parts.path.endswith(".json"):
        value = json.loads(data)
        if "version_manifest" in parts.path and (
            not isinstance(value, dict)
            or not isinstance(value.get("versions"), list)
            or not isinstance(value.get("latest"), dict)
            or not value["latest"].get("release")
        ):
            raise ValueError("资源镜像返回无效的版本清单")
    if parts.hostname == "codeload.github.com" or parts.path.endswith((".zip", ".jar")):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if not archive.infolist():
                raise ValueError("资源镜像返回空归档")
    digest = re.search(r"/(?:objects|packages)/([a-f0-9]{40})/", parts.path)
    if digest and hashlib.sha1(data).hexdigest() != digest[1]:
        raise ValueError("资源镜像文件 SHA-1 校验失败")


def read_resource(url: str, limit: int, *, opener=open_resource) -> bytes:
    urls = download_urls(url)
    bulk = limit > 8 << 20
    stage = "正在下载资源包…" if bulk else "正在查询资源版本…"
    with _lock:
        available = [
            candidate
            for candidate in urls
            if _failed.get(urlsplit(candidate).netloc, 0) <= monotonic()
        ]

        # Stable sort preserves configured priority for channels not yet observed.
        def cost(candidate):
            parts = urlsplit(candidate)
            direct = origin_host(parts.hostname)
            sample = _performance.get((parts.netloc, bulk))
            if sample is None:
                return direct, float("inf")
            latency, rate = sample
            return direct, latency + (limit / rate if bulk else 0)

        # Cooldown changes priority, never removes the last recovery path.
        # A fresh channel may also fail; retry previously failed mirrors last.
        cooling = [candidate for candidate in urls if candidate not in available]
        candidates = sorted(available, key=cost) + sorted(cooling, key=cost)
    failures = []
    retried = set()
    for candidate in candidates:
        host = urlsplit(candidate).netloc
        report(f"{stage}（{host}）")
        try:
            started = monotonic()
            request = Request(
                candidate,
                headers={"User-Agent": "Bedrock-World-Editor/1.0", "Accept-Encoding": "identity"},
            )
            with opener(request, timeout=10 if bulk else 8) as response:
                latency = monotonic() - started
                if response.headers.get("Content-Range"):
                    raise ValueError("资源镜像只返回部分文件")
                raw_size = response.headers.get("Content-Length", "")
                total = int(raw_size) if raw_size.isdecimal() else None
                if total is not None and total > limit:
                    raise ValueError("原版资源下载超过预算")
                data = bytearray()
                report(stage, 0, total)
                while chunk := response.read(min(64 << 10, limit + 1 - len(data))):
                    data.extend(chunk)
                    if len(data) > limit:
                        raise ValueError("原版资源下载超过预算")
                    elapsed = monotonic() - started
                    if (
                        bulk
                        and len(candidates) > 1
                        and elapsed >= SLOW_GRACE
                        and len(data) / elapsed < MIN_DOWNLOAD_RATE
                    ):
                        raise ValueError("资源镜像下载速度过低，正在切换渠道")
                    report(stage, len(data), total)
                if total is not None and len(data) != total:
                    raise ValueError("资源文件下载不完整")
            result = bytes(data)
            validate_payload(url, result)
            with _lock:
                _failed.pop(host, None)
                key = (host, bulk)
                rate = max(1, len(result)) / max(monotonic() - started, 0.001)
                previous = _performance.get(key)
                _performance[key] = (
                    (latency, rate)
                    if previous is None
                    else ((previous[0] + latency) / 2, (previous[1] + rate) / 2)
                )
            return result
        except (OSError, URLError, HTTPException, ValueError, zipfile.BadZipFile) as error:
            log.info("资源渠道 %s 失败：%s", host, error)
            failures.append((host, error))
            with _lock:
                _failed[host] = monotonic() + 60
            timed_out = isinstance(error, TimeoutError) or (
                isinstance(error, URLError) and isinstance(error.reason, TimeoutError)
            )
            if timed_out and candidate not in retried:
                # Finish trying other mirrors before one bounded timeout retry.
                # Never retry invalid payloads, checksums or HTTP rejection pages.
                retried.add(candidate)
                candidates.append(candidate)
    if len(failures) == 1 and len(urls) == 1:
        raise failures[0][1]
    detail = "；".join(f"{host}: {error}" for host, error in failures)
    raise ValueError(f"所有资源下载渠道均失败，请稍后重试或配置其他镜像：{detail}")
