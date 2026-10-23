"""Compile Bedrock Studio and produce a Windows installer inside build/."""

from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from importlib.metadata import version as package_version
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).resolve().parent


@dataclass(frozen=True)
class BuildInfo:
    name: str
    title: str
    description: str
    version: str
    channel: str
    executable_name: str
    publisher: str
    app_id: str
    install_directory: str
    state_directory: str
    installer_name: str

    @property
    def release_name(self) -> str:
        return f"{self.name} {self.channel} {self.version}"


def load_build_info(root: Path) -> BuildInfo:
    """Read one metadata snapshot and validate it before touching build outputs."""
    path = root / "code/backend/src/bedrock_editor/app_constants.json"
    config = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or not isinstance(config.get("packaging"), dict):
        raise ValueError("app_constants.json 缺少 packaging 打包配置")
    packaging = config["packaging"]

    def text(data: dict, key: str) -> str:
        value = data.get(key)
        if not isinstance(value, str) or not value.strip() or any(ord(c) < 32 for c in value):
            raise ValueError(f"app_constants.json 的 {key} 必须是非空单行文本")
        return value

    def filename(value: str, key: str) -> str:
        reserved = re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", value.split(".")[0], re.I)
        if (
            not value.strip()
            or re.search(r'[<>:"/\\|?*\x00-\x1f]', value)
            or value != value.strip()
            or value.endswith(".")
            or value in {".", ".."}
            or reserved
            or len(value) > 240
        ):
            raise ValueError(f"app_constants.json 的 {key} 不是有效的 Windows 文件名")
        return value

    name = f"{text(config, 'brand')} {text(config, 'edition')}"
    version = text(config, "version")
    if not re.fullmatch(r"\d+(?:\.\d+){2,3}", version) or any(
        int(part) > 65535 for part in version.split(".")
    ):
        raise ValueError("app_constants.json 的 version 必须是三段或四段 0～65535 的数字版本")
    channel = text(config, "channel")
    executable_name = filename(text(packaging, "executable_name"), "executable_name")
    try:
        app_id = str(UUID(text(packaging, "app_id"))).upper()
    except ValueError:
        raise ValueError("app_constants.json 的 app_id 必须是有效 UUID") from None
    template = text(packaging, "installer_name")
    try:
        installer_name = template.format(
            executable_name=executable_name, version=version, channel=channel
        )
    except (KeyError, ValueError, IndexError, AttributeError):
        raise ValueError("installer_name 仅支持 executable_name、version、channel 占位符") from None
    filename(installer_name, "installer_name")
    return BuildInfo(
        name=name,
        title=f"{name} · {text(config, 'caption')}",
        description=text(config, "description"),
        version=version,
        channel=channel,
        executable_name=executable_name,
        publisher=text(packaging, "publisher"),
        app_id=app_id,
        install_directory=filename(text(packaging, "install_directory"), "install_directory"),
        state_directory=filename(text(packaging, "state_directory"), "state_directory"),
        installer_name=installer_name,
    )


def run(
    command: list[str | Path], cwd: Path, *, capture: bool = False, timeout: int | None = None
) -> str:
    print("> " + subprocess.list2cmdline([str(part) for part in command]), flush=True)
    try:
        result = subprocess.run(
            [str(part) for part in command],
            cwd=cwd,
            check=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.STDOUT if capture else None,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            timeout=timeout,
        )
    except subprocess.CalledProcessError as exc:
        if capture and exc.stdout:
            print(exc.stdout, end="", flush=True)
        raise
    return result.stdout or ""


def find_iscc(explicit: str | None) -> Path | None:
    if explicit:
        candidate = Path(explicit).expanduser().resolve()
        return candidate if candidate.is_file() else None
    found = shutil.which("ISCC.exe")
    if found:
        return Path(found)
    for variable in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        base = os.environ.get(variable)
        if not base:
            continue
        for folder in ("Inno Setup 6", "Programs/Inno Setup 6"):
            candidate = Path(base) / folder / "ISCC.exe"
            if candidate.is_file():
                return candidate
    return None


def prerequisites(iscc: str | None) -> tuple[Path, Path, Path]:
    problems = []
    if sys.platform != "win32" or platform.machine().lower() not in ("amd64", "x86_64"):
        problems.append("当前打包脚本仅支持 Windows x64")
    if sys.version_info < (3, 12) or sys.maxsize <= 2**32:
        problems.append("需要 64 位系统 Python 3.12+")
    for module in ("bedrock_editor", "nuitka", "ordered_set", "zstandard"):
        if importlib.util.find_spec(module) is None:
            problems.append(f'缺少 {module}：请执行 python -m pip install -e "./code[build]"')
    if importlib.util.find_spec("nuitka") and package_version("Nuitka") != "4.3.1":
        problems.append(
            '需要 Nuitka 4.3.1（修复 pywebview win32 收集）：python -m pip install -e "./code[build]"'
        )
    node = shutil.which("node.exe")
    npm = shutil.which("npm.cmd")
    compiler = find_iscc(iscc)
    if not node or not npm:
        problems.append("请安装 Node.js 20.19+（包含 npm），并加入 PATH")
    else:
        version, arch = json.loads(
            run(
                [node, "-p", "JSON.stringify([process.versions.node, process.arch])"],
                ROOT,
                capture=True,
            )
        )
        if tuple(map(int, version.split("."))) < (20, 19, 0) or arch != "x64":
            problems.append("需要 x64 Node.js 20.19+")
    if compiler is None:
        problems.append("请安装 Inno Setup 6，或用 --iscc 指定 ISCC.exe")
    if problems:
        raise RuntimeError("\n".join(problems))
    return Path(node), Path(npm), compiler


def clean_build(root: Path, *, keep_compilation: bool = False) -> Path:
    """Clean release outputs, optionally retaining compiler caches; never follow redirects."""
    root = root.resolve()
    output = root / "build"
    if output.is_symlink() or output.is_junction() or output.resolve() != output:
        raise RuntimeError(f"拒绝清理链接或重定向的 build 目录：{output}")
    if output.exists():
        if not output.is_dir():
            raise RuntimeError(f"build 必须是目录：{output}")
        if keep_compilation:
            for relative in ("native", "native/start.build", ".cache"):
                path = output / relative
                if path.is_symlink() or path.is_junction() or path.resolve() != path:
                    raise RuntimeError(f"拒绝清理链接或重定向的构建目录：{path}")

            def remove(path):
                if path.is_symlink():
                    path.unlink()
                elif path.is_junction():
                    path.rmdir()
                elif path.is_dir():
                    if not path.resolve().is_relative_to(output):
                        raise RuntimeError(f"拒绝清理构建目录以外的路径：{path}")
                    shutil.rmtree(path)
                else:
                    path.unlink()

            for path in output.iterdir():
                if path.name == ".cache":
                    continue
                if path.name == "native" and path.is_dir():
                    for child in path.iterdir():
                        if child.name != "start.build":
                            remove(child)
                else:
                    remove(path)
        else:
            shutil.rmtree(output)
    output.mkdir(exist_ok=True)
    return output


def stage_node(node: Path, npm: Path, frontend: Path, target: Path) -> None:
    """Collect the database addon's runtime packages, without browser/build dependencies."""
    target.mkdir(parents=True, exist_ok=True)
    (target / "package.json").write_text('{"private":true}', encoding="utf-8")
    listing = run(
        [
            node,
            "-e",
            """
const fs = require('node:fs'), path = require('node:path');
require('@8crafter/leveldb-zlib');
require('bindings'); // Include its fallback lookup and file-uri-to-path dependency.
const roots = new Set();
for (const file of Object.keys(require.cache)) {
  let dir = path.dirname(file);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('No package root: ' + file);
    dir = parent;
  }
  roots.add(dir);
}
console.log(JSON.stringify([...roots]));
""",
        ],
        frontend,
        capture=True,
    )
    source_modules = (frontend / "node_modules").resolve()
    for name in json.loads(listing):
        package = Path(name)
        relative = package.resolve().relative_to(source_modules)
        shutil.copytree(
            package,
            target / "node_modules" / relative,
            ignore=shutil.ignore_patterns(
                "node_modules",
                "test",
                "tests",
                "docs",
                "example*",
                ".github",
                "*.ts",
                "*.map",
                "*.pdb",
                "linux-*",
                "darwin-*",
                "win32-*-ia32",
            ),
        )
    shutil.copy2(node, target.parents[1] / "node.exe")
    # Loading the addon checks architecture, ABI and dependent DLLs without opening a DB.
    run(
        [target.parents[1] / "node.exe", "-e", "require('@8crafter/leveldb-zlib')"],
        target,
    )


def stage_public(target: Path) -> None:
    """Ship UI assets and immutable indexes; downloaded vanilla packs stay in the cache."""
    source = ROOT / "code/resource_packs"
    for name in (
        "app-icon.ico",
        "app-icon.png",
        "favicon.svg",
        "fonts",
        "minecraft/icons",
        "minecraft/scene",
        "minecraft/LICENSE.md",
    ):
        origin = source / name
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if origin.is_dir():
            shutil.copytree(origin, destination)
        else:
            shutil.copy2(origin, destination)
    # The legacy entity index can reference vanilla PNGs outside scene/. Include
    # exactly those files so the offline catalog also works without source packs.
    catalog = target / "minecraft/scene/entity-models.json"
    if catalog.is_file():
        data = json.loads(catalog.read_text(encoding="utf-8"))
        for entity in data.get("entities", {}).values():
            for key in ("texture", "baby_texture"):
                url = entity.get(key)
                if not isinstance(url, str) or not url.startswith("/minecraft/"):
                    continue
                relative = Path(url.lstrip("/"))
                origin = (source / relative).resolve()
                if not origin.is_relative_to(source.resolve()) or not origin.is_file():
                    raise RuntimeError(f"实体索引引用了无效资源：{url}")
                destination = target / relative
                if not destination.is_file():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(origin, destination)


def windows_file_version(path: Path) -> tuple[int, int, int, int]:
    """Read fixed PE version metadata without executing the DLL."""
    api = ctypes.windll.version
    size = api.GetFileVersionInfoSizeW(str(path), None)
    if not size:
        raise RuntimeError(f"无法读取运行库版本：{path}")
    buffer = ctypes.create_string_buffer(size)
    pointer = ctypes.c_void_p()
    length = ctypes.c_uint()
    if not api.GetFileVersionInfoW(str(path), 0, size, buffer) or not api.VerQueryValueW(
        buffer, "\\", ctypes.byref(pointer), ctypes.byref(length)
    ):
        raise RuntimeError(f"无法读取运行库版本：{path}")
    fields = ctypes.cast(pointer, ctypes.POINTER(ctypes.c_uint32))
    return fields[2] >> 16, fields[2] & 65535, fields[3] >> 16, fields[3] & 65535


def stage_windows_runtime(payload: Path) -> None:
    """Replace obsolete DLLs collected from other packages with the newest runtime."""
    for name in ("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll"):
        destination = payload / name
        candidates = [
            folder / name
            for folder in (
                payload,
                Path(sys.base_prefix),
                Path(os.environ["SystemRoot"]) / "System32",
            )
            if (folder / name).is_file()
        ]
        if not candidates:
            raise RuntimeError(f"缺少 {name}，请安装 Microsoft Visual C++ 2015–2022 x64 运行库")
        source = max(candidates, key=windows_file_version)
        if source != destination:
            shutil.copy2(source, destination)


def nuitka_command(output: Path, jobs: int, info: BuildInfo) -> list[str | Path]:
    return [
        sys.executable,
        "-m",
        "nuitka",
        "--standalone",
        "--assume-yes-for-downloads",
        "--include-module=webview.platforms.win32",
        "--enable-plugin=tk-inter",
        "--noinclude-data-files=webview/lib/*.jar",
        "--windows-console-mode=attach",
        "--include-package=bedrock_editor",
        "--include-package=uvicorn",
        "--include-package=amulet",
        # Cython extensions import sibling modules invisibly to static analysis.
        "--include-package=amulet_nbt",
        "--include-package=mutf8",
        "--include-package=minecraft_model_reader",
        "--include-package=PyMCTranslate",
        "--include-package-data=bedrock_editor",
        f"--include-data-files={ROOT / 'code/backend/src/bedrock_editor/app_constants.json'}=bedrock_editor/app_constants.json",
        "--include-package-data=webview",
        "--include-package-data=amulet",
        "--include-package-data=PyMCTranslate",
        "--include-package-data=minecraft_model_reader",
        f"--company-name={info.publisher}",
        f"--product-name={info.name}",
        f"--file-description={info.title} · {info.description} ({info.channel})",
        f"--file-version={info.version}",
        f"--product-version={info.version}",
        f"--windows-icon-from-ico={ROOT / 'code/resource_packs/app-icon.ico'}",
        f"--output-dir={output / 'native'}",
        f"--output-filename={info.executable_name}.exe",
        f"--report={output / 'compilation-report.xml'}",
        f"--jobs={jobs}",
        ROOT / "start.py",
    ]


def installer_script(payload: Path, output: Path, info: BuildInfo) -> str:
    def quote(value: str | Path) -> str:
        return str(value).replace("{", "{{").replace('"', '""')

    app_id = "{{" + info.app_id + "}"

    return rf"""; Generated by build.py. All output stays in build/.
[Setup]
AppId={app_id}
AppName={quote(info.name)}
AppVersion={info.version}
AppVerName={quote(info.release_name)}
AppPublisher={quote(info.publisher)}
VersionInfoCompany={quote(info.publisher)}
VersionInfoDescription={quote(info.title)} · {quote(info.description)} ({quote(info.channel)})
VersionInfoVersion={info.version}
VersionInfoProductName={quote(info.name)}
VersionInfoProductVersion={info.version}
VersionInfoProductTextVersion={quote(info.release_name)}
DefaultDirName={{localappdata}}\Programs\{quote(info.install_directory)}
DefaultGroupName={quote(info.name)}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={quote(output)}
OutputBaseFilename={quote(info.installer_name)}
SetupIconFile={quote(ROOT / "code/resource_packs/app-icon.ico")}
UninstallDisplayIcon={{app}}\{quote(info.executable_name)}.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[InstallDelete]
; Remove obsolete bundled files on upgrades; runtime data/, settings.json and temp.json are untouched.
Type: filesandordirs; Name: "{{app}}\code\frontend\node_modules"
Type: filesandordirs; Name: "{{app}}\code\frontend\dist\minecraft\vanilla"
Type: filesandordirs; Name: "{{app}}\code\frontend\dist\minecraft\amulet"
Type: files; Name: "{{app}}\code\frontend\dist\minecraft\manifest.json"

[Files]
Source: "{quote(payload)}\*"; DestDir: "{{app}}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{{localappdata}}\{quote(info.state_directory)}"

[Icons]
Name: "{{group}}\{quote(info.name)}"; Filename: "{{app}}\{quote(info.executable_name)}.exe"; WorkingDir: "{{localappdata}}\{quote(info.state_directory)}"
Name: "{{autodesktop}}\{quote(info.name)}"; Filename: "{{app}}\{quote(info.executable_name)}.exe"; WorkingDir: "{{localappdata}}\{quote(info.state_directory)}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Code]
function InitializeSetup(): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}}', 'pv', Version);
  if not Result then
    Result := RegQueryStringValue(HKLM32, 'Software\Microsoft\EdgeUpdate\Clients\{{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}}', 'pv', Version);
  if Result then Result := (Version <> '') and (Version <> '0.0.0.0');
  if not Result then
    MsgBox('Please install Microsoft Edge WebView2 Runtime, then run this installer again.' + #13#10 + 'https://go.microsoft.com/fwlink/p/?LinkId=2124703', mbError, MB_OK);
end;
"""


def build(node: Path, npm: Path, iscc: Path, jobs: int, *, clean: bool = False) -> Path:
    info = load_build_info(ROOT)
    output = clean_build(ROOT, keep_compilation=not clean)
    frontend = ROOT / "code/frontend"
    if not (frontend / "node_modules/.package-lock.json").is_file():
        run([npm, "ci"], frontend)
    cache = output / ".cache"
    cache.mkdir(exist_ok=True)

    def build_frontend():
        run(
            [
                npm,
                "exec",
                "--",
                "tsc",
                "--noEmit",
                "--incremental",
                "--tsBuildInfoFile",
                cache / "frontend.tsbuildinfo",
            ],
            frontend,
        )
        run(
            [
                npm,
                "exec",
                "--",
                "vite",
                "build",
                "--mode",
                "installer",
                "--emptyOutDir",
                "--outDir",
                output / "frontend-dist",
            ],
            frontend,
        )
        stage_public(output / "frontend-dist")

    # These produce separate output trees. Both must succeed before staging a release.
    with ThreadPoolExecutor(max_workers=1) as executor:
        frontend_build = executor.submit(build_frontend)
        run(nuitka_command(output, jobs, info), ROOT)
        frontend_build.result()
    payload = output / "native/start.dist"
    executable = payload / f"{info.executable_name}.exe"
    if not executable.is_file():
        raise RuntimeError(f"Nuitka 未生成预期程序：{executable}")
    target = payload / "code/frontend"
    stage_node(node, npm, frontend, target)
    stage_windows_runtime(payload)
    shutil.move(str(output / "frontend-dist"), target / "dist")
    # --help exits before creating any window, server or database.
    run([executable, "--help"], output)
    print(run([executable, "--smoke-test"], output, capture=True, timeout=90), end="", flush=True)
    script = output / "installer.iss"
    script.write_text(installer_script(payload, output, info), encoding="utf-8-sig")
    run([iscc, "/Qp", script], output)
    installer = output / f"{info.installer_name}.exe"
    if not installer.is_file():
        raise RuntimeError("Inno Setup 未生成预期安装包")
    return installer


def main() -> int:
    parser = argparse.ArgumentParser(description="Nuitka 原生编译并生成 Windows x64 安装包")
    parser.add_argument("--iscc", help="Inno Setup 6 的 ISCC.exe 路径")
    parser.add_argument("--check", action="store_true", help="仅检查打包依赖，不清理或构建")
    parser.add_argument("--jobs", type=int, default=min(8, os.cpu_count() or 1))
    parser.add_argument("--clean", action="store_true", help="删除编译缓存后全新构建")
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs 必须大于 0")
    try:
        node, npm, iscc = prerequisites(args.iscc)
        if args.check:
            print("打包依赖检查通过。")
        else:
            print(f"安装包已生成：{build(node, npm, iscc, args.jobs, clean=args.clean)}")
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"打包失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
