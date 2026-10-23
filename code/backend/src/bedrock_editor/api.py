"""Local API; storage and editing do not depend on FastAPI."""

import logging
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import ExitStack, asynccontextmanager, contextmanager
from pathlib import Path
from threading import RLock
from typing import Annotated, Any, Literal

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .constants import APP_NAME, APP_VERSION, DEV_ORIGINS
from .data import DataCategory, RecordCategory
from .editor import node_path
from .paths import resource_pack_root
from .preferences import Preferences
from .recent import RecentWorlds
from .settings import SettingsStore
from .workspace import LEVEL_RECORD, Workspace
from .worlds import discover_roots, normalize_world, world_info


class PreviewCacheRequest(BaseModel):
    cached: list[tuple[int, int]] = Field(default_factory=list, max_length=8192)


class OpenRequest(BaseModel):
    path: str


class RenderBlock(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    states: dict[str, str | Annotated[int, Field(strict=True)]] = Field(
        default_factory=dict, max_length=64
    )
    version: int | None = None
    stateTypes: dict[str, int] = Field(default_factory=dict, max_length=64)


class RenderModelQuery(BaseModel):
    block: RenderBlock
    neighbors: list[RenderBlock | None] = Field(default_factory=list, max_length=6)


class RenderModelsRequest(BaseModel):
    queries: list[RenderModelQuery] = Field(max_length=256)


class EditRequest(BaseModel):
    node_id: str
    name: str | None = None
    value: str | None = None
    revision: int
    record: str = LEVEL_RECORD


class RevisionRequest(BaseModel):
    revision: int
    record: str = LEVEL_RECORD


class AddRequest(BaseModel):
    parent_id: str
    tag_id: int
    name: str | None = None
    value: str | None = None
    list_type: int | None = None
    revision: int
    record: str = LEVEL_RECORD


class DeleteRequest(RevisionRequest):
    node_id: str


class SelectionRequest(BaseModel):
    revision: int
    records: list[str] = Field(min_length=1, max_length=10000)


class SelectionAddRequest(SelectionRequest):
    tag_id: int
    name: str | None = None
    value: str | None = None
    list_type: int | None = None


class SelectionDeleteRequest(BaseModel):
    revision: int
    records: list[str] = Field(min_length=1, max_length=1000000)


class ScopeDeleteRequest(BaseModel):
    revision: int
    target: Literal["player", "players", "world", "level", "record", "data"] | DataCategory
    player: str | None = None
    records: list[str] | None = Field(default=None, min_length=1, max_length=10000)
    record: str | None = None


class ScopeRevisionRequest(BaseModel):
    revision: int


class CreateRecordRequest(BaseModel):
    revision: int
    category: RecordCategory
    name: str


class ChunkCoordinate(BaseModel):
    x: Annotated[int, Field(strict=True, ge=-(2**31), lt=2**31)]
    z: Annotated[int, Field(strict=True, ge=-(2**31), lt=2**31)]


class ChunkRequest(BaseModel):
    dimension: Annotated[int, Field(strict=True, ge=-(2**31), lt=2**31)]
    revision: int


class ChunkSelectionRequest(ChunkRequest):
    chunks: list[ChunkCoordinate] = Field(min_length=1)
    skip_ineligible: bool = False


class ChunkAreaRequest(ChunkRequest):
    min_x: Annotated[int, Field(strict=True, ge=-(2**31), lt=2**31)]
    max_x: Annotated[int, Field(strict=True, ge=-(2**31), lt=2**31)]
    min_z: Annotated[int, Field(strict=True, ge=-(2**31), lt=2**31)]
    max_z: Annotated[int, Field(strict=True, ge=-(2**31), lt=2**31)]
    kinds: list[Literal["terrain", "air", "unreadable", "missing"]] = Field(max_length=4)
    shape: Literal["rectangle", "circle"] = "rectangle"
    cursor: Annotated[int, Field(strict=True, ge=0)] = 0
    page_size: Annotated[int, Field(strict=True, ge=1, le=4096)] = 512


class ChunkTileRequest(ChunkSelectionRequest):
    chunks: list[ChunkCoordinate] = Field(min_length=1, max_length=64)
    ceiling: Annotated[int, Field(ge=-2048, le=2047)] = 319
    layer: Literal["surface", "height"] = "surface"
    resolution: Literal[1, 2, 4, 8, 16] = 16
    span: Annotated[int, Field(strict=True, ge=1, le=2**32)] = 1


class ChunkCreateRequest(ChunkSelectionRequest):
    min_y: Annotated[int, Field(strict=True, ge=-2048, le=2032)] = -64
    max_y: Annotated[int, Field(strict=True, ge=-2033, le=2047)] = 319


class VoxelPoint(BaseModel):
    x: Annotated[int, Field(strict=True, ge=-(2**35), lt=2**35)]
    y: Annotated[int, Field(strict=True, ge=-2048, le=2047)]
    z: Annotated[int, Field(strict=True, ge=-(2**35), lt=2**35)]


class VoxelSphere(VoxelPoint):
    radius: Annotated[int, Field(strict=True, ge=0, le=262144)]


class VoxelEditRequest(ChunkRequest):
    model_config = {"extra": "forbid"}

    low: VoxelPoint
    high: VoxelPoint
    block: str = Field(max_length=128)
    match: str | None = Field(default=None, max_length=128)
    sphere: VoxelSphere | None = None
    hollow: bool = False
    states: str | None = Field(default=None, max_length=65536)
    chunk_mask: list[ChunkCoordinate] | None = Field(default=None, min_length=1)


class VoxelCopyRequest(ChunkRequest):
    model_config = {"extra": "forbid"}
    low: VoxelPoint
    high: VoxelPoint
    sphere: VoxelSphere | None = None
    hollow: bool = False
    include_block_entities: bool = True
    include_entities: bool = True
    chunk_mask: list[ChunkCoordinate] | None = Field(default=None, min_length=1)


class VoxelPasteRequest(ChunkRequest):
    model_config = {"extra": "forbid"}
    origin: VoxelPoint
    rotation: tuple[
        Literal[0, 90, 180, 270], Literal[0, 90, 180, 270], Literal[0, 90, 180, 270]
    ] = (0, 0, 0)
    mirror: tuple[bool, bool, bool] = (False, False, False)
    axis_order: Literal["xyz", "xzy", "yxz", "yzx", "zxy", "zyx"] = "xyz"
    scale: Annotated[float, Field(gt=0, allow_inf_nan=False)] = 1
    replace_existing: bool = True
    paste_air: bool = True
    skip_unsupported: bool = False
    move_revision: Annotated[int, Field(strict=True, ge=0)] | None = None


class StructureExportRequest(ChunkRequest):
    model_config = {"extra": "forbid"}
    low: VoxelPoint
    high: VoxelPoint
    format: Literal["mcstructure", "schematic", "schem"]
    sphere: VoxelSphere | None = None
    hollow: bool = False
    include_block_entities: bool = True
    include_entities: bool = True
    chunk_mask: list[ChunkCoordinate] | None = Field(default=None, min_length=1)


class VoxelTravelRequest(ChunkRequest):
    step: Literal[-1, 1]


class ChunkMarkerRequest(ChunkRequest):
    min_x: Annotated[int, Field(strict=True, ge=-(2**31), lt=2**31)]
    max_x: Annotated[int, Field(strict=True, ge=-(2**31), lt=2**31)]
    min_z: Annotated[int, Field(strict=True, ge=-(2**31), lt=2**31)]
    max_z: Annotated[int, Field(strict=True, ge=-(2**31), lt=2**31)]
    layers: list[
        Literal[
            "entities",
            "blocks",
            "structures",
            "players",
            "player_spawns",
            "portals",
            "maps",
            "villages",
            "tickingareas",
        ]
    ] = Field(max_length=9)
    cursor: Annotated[int, Field(strict=True, ge=0, lt=2**31)] = 0
    page_size: Annotated[int, Field(strict=True, ge=1, le=32)] = 32


class MapObjectRequest(BaseModel):
    revision: int
    object: str = Field(min_length=1, max_length=4096)


class MapObjectsDeleteRequest(BaseModel):
    revision: int
    objects: list[Annotated[str, Field(min_length=1, max_length=4096)]] = Field(
        min_length=1, max_length=100000
    )


def create_app(frontend: Path | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            try:
                with ExitStack() as cleanup:
                    for workspace in list(application.state.documents.values()):
                        cleanup.callback(workspace.close)
            finally:
                application.state.documents.clear()
                from .resources import shutdown

                shutdown()

    app = FastAPI(
        title=APP_NAME, version=APP_VERSION, docs_url=None, redoc_url=None, lifespan=lifespan
    )
    app.state.token = secrets.token_urlsafe(32)
    app.state.documents = {}
    app.state.worlds = {}
    app.state.folder_picker = None
    app.state.structure_saver = None
    app.state.render_resources = {}
    app.state.render_documents = {}
    app.state.render_progress = {}
    render_lock = RLock()

    def release_unused_render_resources() -> None:
        active = set(app.state.render_documents.values())
        for session in list(app.state.render_resources):
            if session not in active:
                del app.state.render_resources[session]

    recent = RecentWorlds()
    settings = SettingsStore()
    app.state.recent_warning = None
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(DEV_ORIGINS),
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type", "X-Editor-Token"],
    )

    @app.middleware("http")
    async def local_access(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if (
            request.url.path.startswith("/api/")
            and request.method != "OPTIONS"
            and request.url.path != "/api/bootstrap"
            and not request.url.path.endswith("/icon")
        ):
            if not secrets.compare_digest(
                request.headers.get("X-Editor-Token", ""), app.state.token
            ):
                return JSONResponse({"detail": "本地编辑会话无效，请刷新页面"}, status_code=403)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if origin and origin not in (
                str(request.base_url).rstrip("/"),
                *DEV_ORIGINS,
            ):
                return JSONResponse({"detail": "请求来源不允许"}, status_code=403)
        return await call_next(request)

    @app.exception_handler(ValueError)
    async def invalid_request(_request: Request, error: ValueError) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=400)

    @app.exception_handler(OSError)
    async def file_error(_request: Request, error: OSError) -> JSONResponse:
        return JSONResponse({"detail": f"文件操作失败：{error}"}, status_code=400)

    @contextmanager
    def document(identifier: str) -> Iterator[Workspace]:
        doc = app.state.documents.get(identifier)
        if doc is None:
            raise HTTPException(404, "文档已关闭，请重新打开")
        with doc.lock:
            if app.state.documents.get(identifier) is not doc:
                raise HTTPException(404, "文档已关闭，请重新打开")
            yield doc

    def register(folder: Path) -> dict[str, Any]:
        info = world_info(folder)
        app.state.worlds[info["id"]] = folder
        return info

    @app.get("/api/bootstrap")
    def bootstrap() -> dict[str, Any]:
        from .resources import memory_headroom, worker_count

        return {
            "token": app.state.token,
            "desktop": app.state.folder_picker is not None,
            "resources": {
                "cpu_workers": worker_count(),
                "display_mb": max(32, memory_headroom() * 45 // 100 // (1 << 20)),
            },
        }

    @app.get("/api/preferences")
    def preferences() -> Preferences:
        return settings.load()

    @app.post("/api/preferences")
    def save_preferences(body: Preferences) -> Preferences:
        return settings.save(body)

    @app.get("/api/worlds")
    def worlds() -> dict[str, Any]:
        roots = discover_roots()
        items, warnings, seen = [], [], set()
        info_by_folder = {}
        for root in roots:
            try:
                for folder in root.iterdir():
                    if (
                        folder.is_dir()
                        and (folder / "level.dat").is_file()
                        and folder.resolve() not in seen
                    ):
                        seen.add(folder.resolve())
                        try:
                            info = register(folder)
                            info_by_folder[folder.resolve()] = info
                            items.append(info)
                        except OSError as exc:
                            warnings.append(f"{folder.name}：{exc}")
            except OSError as exc:
                warnings.append(f"{root}：{exc}")
        items.sort(key=lambda w: w["last_played"], reverse=True)
        recent_items = []
        try:
            for folder in recent.available():
                try:
                    info = info_by_folder.get(folder.resolve())
                    recent_items.append(info if info is not None else register(folder))
                except OSError as exc:
                    warnings.append(f"{folder.name}：{exc}")
        except (ValueError, OSError) as exc:
            warnings.append(f"最近存档：{exc}")
        if app.state.recent_warning:
            warnings.append(app.state.recent_warning)
        return {
            "items": items,
            "recent": recent_items,
            "roots": [str(p) for p in roots],
            "warnings": warnings,
        }

    @app.get("/api/worlds/{identifier}/icon")
    def icon(identifier: str) -> FileResponse:
        folder = app.state.worlds.get(identifier)
        if folder:
            for filename in ("world_icon.jpeg", "world_icon.jpg", "world_icon.png"):
                image = folder / filename
                if image.is_file():
                    return FileResponse(image)
        raise HTTPException(404, "存档没有封面")

    @app.post("/api/worlds/inspect")
    def inspect_world(body: OpenRequest) -> dict[str, Any]:
        return register(normalize_world(body.path))

    @app.post("/api/worlds/pick")
    def pick_world() -> dict[str, Any]:
        if app.state.folder_picker:
            selected = app.state.folder_picker()
        else:
            import tkinter as tk
            from tkinter import filedialog

            picker = tk.Tk()
            picker.withdraw()
            picker.attributes("-topmost", True)
            try:
                roots = discover_roots()
                selected = filedialog.askdirectory(
                    title="选择包含 level.dat 的世界文件夹",
                    initialdir=str(roots[0]) if roots else str(Path.home()),
                )
            finally:
                picker.destroy()
        return {"world": register(normalize_world(selected)) if selected else None}

    @app.post("/api/documents/open")
    def open_document(body: OpenRequest) -> dict[str, Any]:
        if len(app.state.documents) >= 8:
            raise ValueError("打开的文档过多，请先关闭已有文档")
        doc = Workspace(body.path)
        register(doc.folder)
        app.state.documents[doc.id] = doc
        try:
            recent.remember(doc.folder)
            app.state.recent_warning = None
        except OSError as exc:
            app.state.recent_warning = f"无法记录最近存档：{exc}"
        return doc.summary()

    @app.get("/api/documents/{identifier}")
    def document_summary(identifier: str, record: str = LEVEL_RECORD) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.summary(record)

    @app.get("/api/documents/{identifier}/chunks")
    def chunks(
        identifier: str, dimension: Annotated[int, Query(ge=-(2**31), lt=2**31)], revision: int
    ) -> dict[str, Any]:
        with document(identifier) as doc:
            doc.check_revision(revision)
            return doc.chunk_summary(dimension)

    @app.get("/api/documents/{identifier}/chunks/dimensions")
    def chunk_dimensions(identifier: str, revision: int) -> dict[str, Any]:
        with document(identifier) as doc:
            doc.check_revision(revision)
            return {"items": doc.chunks().dimensions()}

    @app.get("/api/documents/{identifier}/chunks/region")
    def chunk_region(
        identifier: str,
        dimension: Annotated[int, Query(ge=-(2**31), lt=2**31)],
        revision: int,
        min_x: int,
        max_x: int,
        min_z: int,
        max_z: int,
        step: Annotated[int, Query(ge=1, le=2**32)] = 1,
        overview: bool = False,
        selection: bool = False,
        empty: bool = False,
    ) -> dict[str, Any]:
        if not (-(2**31) <= min_x <= max_x < 2**31 and -(2**31) <= min_z <= max_z < 2**31):
            raise ValueError("地图坐标范围无效")
        with document(identifier) as doc:
            doc.check_revision(revision)
            if selection or empty:
                step = 1
            elif overview:
                while ((max_x - min_x) // step + 2) * ((max_z - min_z) // step + 2) > 4096:
                    step *= 2
            else:
                step = 1
            return doc.chunks().region(
                dimension,
                min_x,
                max_x,
                min_z,
                max_z,
                step=step,
                limit=4096 if overview else 1024,
                selection=selection,
                empty=empty,
            )

    @app.post("/api/documents/{identifier}/chunks/tiles")
    def chunk_tiles(identifier: str, body: ChunkTileRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            doc.check_revision(body.revision)
            return {
                "items": doc.chunks().tiles(
                    body.dimension,
                    [(c.x, c.z) for c in body.chunks],
                    body.ceiling,
                    body.layer,
                    body.resolution,
                    body.span,
                )
            }

    @app.get("/api/documents/{identifier}/chunks/terrain-page")
    def terrain_page(
        identifier: str,
        dimension: Annotated[int, Query(ge=-(2**31), lt=2**31)],
        revision: int,
        min_x: int,
        max_x: int,
        min_z: int,
        max_z: int,
        cursor: Annotated[int, Query(ge=0)] = 0,
        page_size: Annotated[int, Query(ge=1, le=512)] = 512,
        span: Annotated[int, Query(ge=1, le=2**32)] = 1,
    ) -> dict[str, Any]:
        with document(identifier) as doc:
            doc.check_revision(revision)
            return doc.chunks().terrain_page(
                dimension, (min_x, max_x, min_z, max_z), cursor, page_size, span
            )

    @app.post("/api/documents/{identifier}/chunks/delete")
    def delete_chunks(identifier: str, body: ChunkSelectionRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.delete_chunks(
                body.dimension,
                [(c.x, c.z) for c in body.chunks],
                body.revision,
                skip_ineligible=body.skip_ineligible,
            )

    @app.get("/api/documents/{identifier}/render-progress")
    def render_progress(identifier: str) -> dict[str, Any]:
        with document(identifier):
            with render_lock:
                return app.state.render_progress.get(
                    identifier, {"stage": "正在准备材质资源…", "loaded": 0, "total": None}
                ).copy()

    @app.get("/api/documents/{identifier}/render-resources")
    def render_resources(identifier: str) -> dict[str, Any]:
        from .bedrock_resources import world_version
        from .resource_progress import reporter
        from .scene_resources import prepare_resources

        with document(identifier) as doc:
            revision = doc.revision
            version = world_version(doc.record().tree)

        def publish(progress):
            with render_lock:
                if identifier in app.state.documents:
                    app.state.render_progress[identifier] = progress

        publish({"stage": "正在等待资源准备…", "loaded": 0, "total": None})
        token = reporter.set(publish)
        try:
            resources = prepare_resources(version)
        except Exception as exc:
            logging.getLogger(__name__).exception("3D 资源初始化失败")
            raise HTTPException(503, f"3D 资源准备失败：{exc}") from exc
        finally:
            reporter.reset(token)
        session = resources.version
        with document(identifier) as doc:
            doc.check_revision(revision)
            with render_lock:
                app.state.render_resources[session] = resources
                app.state.render_documents[identifier] = session
                release_unused_render_resources()
        return {
            "size": resources.size[0],
            "columns": 1,
            "textures": {},
            "blocks": {},
            "source": {
                "bedrock": resources.bedrock_version,
                "mode": "classic",
                "complexModels": "java-adapter",
            },
            "amulet": {"url": f"/api/render/{session}", "token": app.state.token},
        }

    @app.get("/api/render/{session}/atlas.png")
    def render_atlas(session: str) -> Response:
        resources = app.state.render_resources.get(session)
        if resources is None:
            raise HTTPException(404, "3D 资源会话已失效")
        return Response(resources.image, media_type="image/png")

    @app.get("/api/render/{session}/entity-models")
    def render_entities(session: str) -> dict[str, Any]:
        resources = app.state.render_resources.get(session)
        if resources is None:
            raise HTTPException(404, "3D 资源会话已失效")
        return resources.entities()

    @app.post("/api/render/{session}/models")
    def render_models(session: str, body: RenderModelsRequest) -> dict[str, Any]:
        resources = app.state.render_resources.get(session)
        if resources is None:
            raise HTTPException(404, "3D 资源会话已失效")
        import json

        models = []
        size = 0
        for query in body.queries:
            model = resources.model(query.model_dump(exclude_none=True))
            size += len(json.dumps(model))
            if size > 8 << 20:
                raise ValueError("Amulet 模型响应超过 8 MB 预算")
            models.append(model)
        return {"models": models}

    @app.get("/api/documents/{identifier}/chunks/voxels")
    def voxel_scene(
        identifier: str,
        dimension: Annotated[int, Query(ge=-(2**31), lt=2**31)],
        revision: int,
        x: Annotated[int, Query(ge=-(2**31), lt=2**31)],
        z: Annotated[int, Query(ge=-(2**31), lt=2**31)],
    ) -> Response:
        from .voxels import scene_data

        with document(identifier) as doc:
            doc.check_revision(revision)
            return Response(
                scene_data(doc.chunks(), (dimension, x, z)), media_type="application/octet-stream"
            )

    @app.get("/api/documents/{identifier}/chunks/block-catalog")
    def voxel_catalog(identifier: str, revision: int) -> dict[str, Any]:
        from .voxels import PLACEABLE

        with document(identifier) as doc:
            doc.check_revision(revision)
            return {"items": [f"minecraft:{name}" for name in PLACEABLE]}

    @app.get("/api/documents/{identifier}/chunks/voxels/block")
    def voxel_block(
        identifier: str,
        dimension: int,
        revision: int,
        x: Annotated[int, Query(ge=-(2**35), lt=2**35)],
        y: Annotated[int, Query(ge=-2048, le=2047)],
        z: Annotated[int, Query(ge=-(2**35), lt=2**35)],
    ) -> dict[str, Any]:
        from .chunk_markers import nbt_records, position
        from .chunks import chunk_key
        from .voxels import block_at, effective

        with document(identifier) as doc:
            doc.check_revision(revision)
            records = effective(doc.chunks(), (dimension, x // 16, z // 16))
            tree = block_at(records, (x, y, z))
            entities = doc.object_markers(
                dimension, (x // 16, x // 16, z // 16, z // 16), ["blocks"]
            )
            entity = next(
                (
                    item
                    for item in entities["items"]
                    if item.get("x") == x and item.get("y") == y and item.get("z") == z
                ),
                None,
            )
            entity_pending = False
            if not entity:
                for key, raw in records.items():
                    parsed = chunk_key(bytes.fromhex(key))
                    if parsed and parsed[1] == 0x31 and raw:
                        entity_pending |= any(
                            position(item) == (x, y, z) for item in nbt_records(raw)
                        )
            return {
                "entity_pending": entity_pending,
                "name": str(tree["name"]),
                "states": tree.get("states", {}).snbt() if "states" in tree else "{}",
                "entity": entity.get("object_ref") if entity else None,
            }

    @app.post("/api/documents/{identifier}/chunks/voxels/edit")
    def voxel_edit(identifier: str, body: VoxelEditRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.edit_voxels(
                body.dimension,
                (body.low.x, body.low.y, body.low.z),
                (body.high.x, body.high.y, body.high.z),
                body.block,
                body.match,
                body.revision,
                sphere=(body.sphere.x, body.sphere.y, body.sphere.z, body.sphere.radius)
                if body.sphere
                else None,
                states=body.states,
                hollow=body.hollow,
                chunk_mask=[(p.x, p.z) for p in body.chunk_mask]
                if body.chunk_mask is not None
                else None,
            )

    @app.get("/api/documents/{identifier}/chunks/voxels/clipboard")
    def voxel_clipboard(identifier: str) -> dict[str, Any]:
        with document(identifier) as doc:
            return {"available": doc.chunks().clipboard is not None}

    @app.get("/api/documents/{identifier}/chunks/voxels/clipboard/preview")
    @app.post("/api/documents/{identifier}/chunks/voxels/clipboard/preview")
    def voxel_preview(
        identifier: str,
        revision: int,
        rx: Annotated[int, Query(ge=0, le=270, multiple_of=90)] = 0,
        ry: Annotated[int, Query(ge=0, le=270, multiple_of=90)] = 0,
        rz: Annotated[int, Query(ge=0, le=270, multiple_of=90)] = 0,
        mx: bool = False,
        my: bool = False,
        mz: bool = False,
        axis_order: Literal["xyz", "xzy", "yxz", "yzx", "zxy", "zyx"] = "xyz",
        scale: Annotated[float, Query(gt=0, allow_inf_nan=False)] = 1,
        skip_unsupported: bool = False,
        camera_x: float | None = None,
        camera_y: float | None = None,
        camera_z: float | None = None,
        origin_x: float = 0,
        origin_y: float = 0,
        origin_z: float = 0,
        render_distance: Annotated[int, Query(ge=0, le=512)] = 12,
        cache: PreviewCacheRequest | None = None,
    ) -> Response:
        from .voxel_clipboard import preview_data

        try:
            cached_chunks = frozenset(cache.cached if cache is not None else ())
            if any(
                len(point) != 2 or any(not -(2**35) <= v < 2**35 for v in point)
                for point in cached_chunks
            ):
                raise ValueError("预览缓存坐标无效")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="预览缓存坐标无效") from exc
        with document(identifier) as doc:
            doc.check_revision(revision)
            return Response(
                preview_data(
                    doc.chunks().clipboard,
                    (rx, ry, rz),
                    (mx, my, mz),
                    skip_unsupported,
                    (camera_x, camera_y or 0, camera_z)
                    if camera_x is not None and camera_z is not None
                    else None,
                    render_distance if camera_x is not None and camera_z is not None else None,
                    (origin_x, origin_y, origin_z),
                    cached_chunks,
                    axis_order,
                    scale,
                ),
                media_type="application/octet-stream",
            )

    @app.post("/api/documents/{identifier}/chunks/voxels/copy")
    def voxel_copy(identifier: str, body: VoxelCopyRequest) -> dict[str, Any]:
        from .voxel_clipboard import copy_selection
        from .workspace import HISTORY_BYTES

        with document(identifier) as doc:
            doc.check_revision(body.revision)
            if any(d.dirty for d in doc.object_documents().values()):
                raise ValueError("请先保存或还原对象 NBT 修改")
            protected = {
                id(raw): raw
                for d in doc._records.values()
                for raw in (d.history[d.index], d.saved_state)
            }
            return copy_selection(
                doc.chunks(),
                body.dimension,
                (body.low.x, body.low.y, body.low.z),
                (body.high.x, body.high.y, body.high.z),
                (body.sphere.x, body.sphere.y, body.sphere.z, body.sphere.radius)
                if body.sphere
                else None,
                body.hollow,
                HISTORY_BYTES - sum(map(len, protected.values())),
                include_block_entities=body.include_block_entities,
                include_entities=body.include_entities,
                source_revision=doc.revision,
                chunk_mask=[(p.x, p.z) for p in body.chunk_mask]
                if body.chunk_mask is not None
                else None,
            )

    @app.post("/api/documents/{identifier}/chunks/structures/export")
    def structure_export(identifier: str, body: StructureExportRequest) -> Response:
        from .structure_formats import export_clipboard
        from .voxel_clipboard import copy_selection

        with document(identifier) as doc:
            doc.check_revision(body.revision)
            if any(d.dirty for d in doc.object_documents().values()):
                raise ValueError("请先保存或还原对象 NBT 修改")
            previous = doc.chunks().clipboard
            try:
                copy_selection(
                    doc.chunks(),
                    body.dimension,
                    (body.low.x, body.low.y, body.low.z),
                    (body.high.x, body.high.y, body.high.z),
                    (body.sphere.x, body.sphere.y, body.sphere.z, body.sphere.radius)
                    if body.sphere
                    else None,
                    body.hollow,
                    64 * 1024**2,
                    include_block_entities=body.include_block_entities,
                    include_entities=body.include_entities,
                    allow_large=True,
                    chunk_mask=[(p.x, p.z) for p in body.chunk_mask]
                    if body.chunk_mask is not None
                    else None,
                )
                raw = export_clipboard(doc.chunks().clipboard, body.format)
                if app.state.structure_saver is not None:
                    app.state.structure_saver(raw, f"structure.{body.format}")
                    return Response(status_code=204)
                media = {
                    "mcstructure": "application/octet-stream",
                    "schematic": "application/gzip",
                    "schem": "application/gzip",
                }[body.format]
                return Response(
                    raw,
                    media_type=media,
                    headers={
                        "Content-Disposition": f'attachment; filename="structure.{body.format}"'
                    },
                )
            finally:
                # Export must preserve the previous clipboard even on failure.
                doc.chunks().clipboard = previous

    @app.post("/api/documents/{identifier}/chunks/structures/import")
    async def structure_import(
        identifier: str,
        file: UploadFile = File(...),  # noqa: B008
        format: Literal["mcstructure", "schematic", "schem"] = Form(...),  # noqa: B008
        revision: int = Form(...),  # noqa: B008
    ) -> dict[str, Any]:
        from .structure_formats import parse, to_clipboard

        # UploadFile is already backed by Starlette's spooled temporary file.
        # Read it without a protocol-sized cap; structure parsing validates the
        # NBT stream and converts it section by section.
        raw = await file.read()
        with document(identifier) as doc:
            doc.check_revision(revision)
            if any(d.dirty for d in doc.object_documents().values()):
                raise ValueError("请先保存或还原对象 NBT 修改")
            chunks = doc.chunks()
            previous_size = chunks.clipboard.budget_size if chunks.clipboard else 0
            remaining = 64 * 1024**2 - chunks.retained_bytes + previous_size
            imported = to_clipboard(parse(raw, format), remaining)
            chunks.clipboard = imported
            return {
                "available": True,
                "size": [v + 1 for v in (imported.high[0], imported.high[1], imported.high[2])],
                "bytes": imported.size,
                "block_entities": len(imported.block_entities),
                "entities": len(imported.actors),
            }

    @app.post("/api/documents/{identifier}/chunks/voxels/paste")
    def voxel_paste(identifier: str, body: VoxelPasteRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.edit_voxels(
                body.dimension,
                (0, 0, 0),
                (0, 0, 0),
                "air",
                None,
                body.revision,
                paste=(body.origin.x, body.origin.y, body.origin.z),
                rotation=body.rotation,
                mirror=body.mirror,
                axis_order=body.axis_order,
                scale=body.scale,
                replace_existing=body.replace_existing,
                paste_air=body.paste_air,
                skip_unsupported=body.skip_unsupported,
                move_revision=body.move_revision,
            )

    @app.post("/api/documents/{identifier}/chunks/voxels/travel")
    def voxel_travel(identifier: str, body: VoxelTravelRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.edit_voxels(
                body.dimension, (0, 0, 0), (0, 0, 0), "air", None, body.revision, body.step
            )

    @app.post("/api/documents/{identifier}/chunks/select")
    def select_chunks(identifier: str, body: ChunkAreaRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            doc.check_revision(body.revision)
            return doc.chunks().selection(
                body.dimension,
                (body.min_x, body.max_x, body.min_z, body.max_z),
                set(body.kinds),
                body.shape,
                body.cursor,
                body.page_size,
            )

    @app.post("/api/documents/{identifier}/chunks/clear-blocks")
    def clear_chunk_blocks(identifier: str, body: ChunkSelectionRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.clear_chunk_blocks(
                body.dimension, [(c.x, c.z) for c in body.chunks], body.revision
            )

    @app.post("/api/documents/{identifier}/chunks/restore")
    def restore_chunks(identifier: str, body: ChunkRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.restore_chunks(body.dimension, body.revision)

    @app.post("/api/documents/{identifier}/chunks/reset")
    def reset_dimension(identifier: str, body: ChunkRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.reset_dimension(body.dimension, body.revision)

    @app.post("/api/documents/{identifier}/chunks/create")
    def create_chunks(identifier: str, body: ChunkCreateRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.create_chunks(
                body.dimension,
                [(c.x, c.z) for c in body.chunks],
                body.min_y,
                body.max_y,
                body.revision,
                skip_ineligible=body.skip_ineligible,
            )

    @app.post("/api/documents/{identifier}/chunks/markers")
    def chunk_markers(identifier: str, body: ChunkMarkerRequest) -> dict[str, Any]:
        if body.min_x > body.max_x or body.min_z > body.max_z:
            raise ValueError("地图坐标范围无效")
        with document(identifier) as doc:
            doc.check_revision(body.revision)
            return doc.object_markers(
                body.dimension,
                (body.min_x, body.max_x, body.min_z, body.max_z),
                body.layers,
                cursor=body.cursor,
                page_size=body.page_size,
            )

    @app.post("/api/documents/{identifier}/chunks/objects/open")
    def open_map_object(identifier: str, body: MapObjectRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.open_object(body.object, body.revision)

    @app.post("/api/documents/{identifier}/chunks/objects/delete")
    def delete_map_object(identifier: str, body: MapObjectRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.delete_object(body.object, body.revision)

    @app.post("/api/documents/{identifier}/chunks/objects/delete-selection")
    def delete_map_objects(identifier: str, body: MapObjectsDeleteRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.delete_objects(body.objects, body.revision)

    @app.post("/api/documents/{identifier}/record-selection/delete")
    def delete_selected_records(identifier: str, body: SelectionDeleteRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.delete_records(body.records, body.revision)

    @app.get("/api/documents/{identifier}/record-selection/ids")
    def select_record_ids(
        identifier: str,
        revision: int,
        scope: Literal["players", "data"] | DataCategory,
        q: Annotated[str, Query(max_length=200)] = "",
    ) -> dict[str, Any]:
        with document(identifier) as doc:
            doc.check_revision(revision)
            if scope == "players":
                entries = doc.players()
            else:
                entries = doc.data_records("other" if scope == "data" else scope)
            needle = q.strip().casefold()
            return {
                "ids": [
                    item["id"]
                    for item in entries
                    if needle in item["name"].casefold() or needle in item["id"].casefold()
                ]
            }

    @app.get("/api/documents/{identifier}/players")
    def player_list(
        identifier: str,
        q: Annotated[str, Query(max_length=200)] = "",
        offset: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int | None, Query(ge=1, le=1000)] = None,
    ) -> dict[str, Any]:
        with document(identifier) as doc:
            if limit is None:
                return {"items": doc.players()}
            return doc.player_page(q, offset, limit)

    @app.get("/api/documents/{identifier}/record-capabilities")
    def record_capabilities(
        identifier: str, revision: int, record: str | None = None
    ) -> dict[str, Any]:
        with document(identifier) as doc:
            doc.check_revision(revision)
            return doc.creation_capabilities(record)

    @app.post("/api/documents/{identifier}/record-selection/capabilities")
    def selection_capabilities(identifier: str, body: SelectionRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.selection_capabilities(body.records, body.revision)

    @app.post("/api/documents/{identifier}/record-selection/add")
    def selection_add(identifier: str, body: SelectionAddRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.add_to_records(
                body.records, body.revision, body.tag_id, body.name, body.value, body.list_type
            )

    @app.post("/api/documents/{identifier}/records")
    def create_record(identifier: str, body: CreateRecordRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.create_record(body.category, body.name, body.revision)

    @app.get("/api/documents/{identifier}/world-search")
    def world_search(
        identifier: str,
        q: Annotated[str, Query(min_length=1, max_length=200)],
        scope: Literal["world", "data"] = "world",
    ) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.search_world(q, scope)

    @app.get("/api/documents/{identifier}/data/{category}")
    def data_list(
        identifier: str,
        category: DataCategory | Literal["all"],
        q: Annotated[str, Query(max_length=200)] = "",
        offset: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int, Query(ge=1, le=200)] = 200,
    ) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.data_page(None if category == "all" else category, q, offset, limit)

    @app.get("/api/documents/{identifier}/map-preview")
    def map_preview(identifier: str, record: str, revision: int) -> Response:
        with document(identifier) as doc:
            doc.check_revision(revision)
            return Response(
                doc.map_preview(record),
                media_type="image/png",
                headers={"Cache-Control": "no-store"},
            )

    @app.get("/api/documents/{identifier}/nodes/{node}/children")
    def children(
        identifier: str,
        node: str,
        offset: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int, Query(ge=1, le=1000)] = 300,
        record: str = LEVEL_RECORD,
    ) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.record(record).children(node, offset, limit)

    @app.get("/api/documents/{identifier}/nodes/{node}")
    def get_node(identifier: str, node: str, record: str = LEVEL_RECORD) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.record(record).node(node_path(node))

    @app.get("/api/documents/{identifier}/nodes/{node}/value")
    def node_value(identifier: str, node: str, record: str = LEVEL_RECORD) -> dict[str, str | None]:
        with document(identifier) as doc:
            return doc.record(record).value(node)

    @app.get("/api/documents/{identifier}/search")
    def search(
        identifier: str,
        q: Annotated[str, Query(min_length=1, max_length=200)],
        record: str = LEVEL_RECORD,
    ) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.record(record).search(q)

    @app.post("/api/documents/{identifier}/commands")
    def command(identifier: str, body: EditRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.execute(
                "edit",
                body.record,
                body.revision,
                identifier=body.node_id,
                name=body.name,
                value=body.value,
            )

    @app.post("/api/documents/{identifier}/add")
    def add_node(identifier: str, body: AddRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.execute(
                "add",
                body.record,
                body.revision,
                identifier=body.parent_id,
                tag_id=body.tag_id,
                name=body.name,
                value=body.value,
                list_type=body.list_type,
            )

    @app.post("/api/documents/{identifier}/delete")
    def delete_node(identifier: str, body: DeleteRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.execute("delete", body.record, body.revision, identifier=body.node_id)

    @app.post("/api/documents/{identifier}/undo")
    def undo(identifier: str, body: RevisionRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.execute("travel", body.record, body.revision, step=-1)

    @app.post("/api/documents/{identifier}/delete-scope")
    def delete_scope(identifier: str, body: ScopeDeleteRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            key = body.record if body.target == "record" else body.player
            return doc.delete_scope(body.target, body.revision, key, body.records)

    @app.post("/api/documents/{identifier}/scope-undo")
    def scope_undo(identifier: str, body: ScopeRevisionRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.travel_scope(-1, body.revision)

    @app.post("/api/documents/{identifier}/scope-redo")
    def scope_redo(identifier: str, body: ScopeRevisionRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.travel_scope(1, body.revision)

    @app.post("/api/documents/{identifier}/clear")
    def clear_record(identifier: str, body: RevisionRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.execute("clear", body.record, body.revision)

    @app.post("/api/documents/{identifier}/redo")
    def redo(identifier: str, body: RevisionRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.execute("travel", body.record, body.revision, step=1)

    @app.post("/api/documents/{identifier}/save")
    def save_document(identifier: str, body: RevisionRequest) -> dict[str, Any]:
        with document(identifier) as doc:
            return doc.save(body.revision, body.record)

    @app.delete("/api/documents/{identifier}")
    def close_document(identifier: str) -> dict[str, bool]:
        with document(identifier) as doc:
            doc.close()
            del app.state.documents[identifier]
            with render_lock:
                app.state.render_documents.pop(identifier, None)
                app.state.render_progress.pop(identifier, None)
                release_unused_render_resources()
        return {"closed": True}

    if frontend and frontend.is_dir():
        app.mount("/assets", StaticFiles(directory=frontend / "assets"), name="assets")
        # Vite copies publicDir resources outside /assets. Serve the same paths
        # in the desktop host, including offline textures and fonts.
        for directory in ("minecraft", "fonts"):
            static_directory = frontend / directory
            if not static_directory.is_dir():
                static_directory = resource_pack_root() / directory
            if static_directory.is_dir():
                app.mount(
                    f"/{directory}",
                    StaticFiles(directory=static_directory),
                    name=directory,
                )

        @app.get("/", response_class=HTMLResponse)
        def index() -> str:
            return (frontend / "index.html").read_text(encoding="utf-8")

        @app.get("/favicon.svg")
        def favicon() -> FileResponse:
            for path in (frontend / "favicon.svg", resource_pack_root() / "favicon.svg"):
                if path.is_file():
                    return FileResponse(path)
            raise HTTPException(status_code=404, detail="页面图标不存在")

    return app
