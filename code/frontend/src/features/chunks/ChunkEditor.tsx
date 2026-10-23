import { LoadingActivity } from "@/components/LoadingIndicator";
import { APP_CLOSE_PROMPT, MAP_QUALITY } from "@/lib/constants";
import {
  getPreferences,
  matchesShortcut,
  shortcutHint,
} from "@/lib/preferences";
import { Settings2 } from "lucide-react";
import WorldLoading from "@/components/WorldLoading";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Crosshair,
  Grid2X2,
  Layers,
  Map,
  Minus,
  Plus,
  RotateCcw,
  Undo2,
  Redo2,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { api, type DocumentState } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Brand } from "@/components/Brand";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import MinecraftIcon from "@/components/MinecraftIcon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { finishDesktopClose } from "@/lib/desktop";
import ChunkMap, { type ChunkSummary } from "./ChunkMap";
import ViewAngle from "./ViewAngle";
import ChunkToolbar, { type FillOperation } from "./ChunkToolbar";
import ObjectEditor, { type ObjectEditorHandle } from "./ObjectEditor";
import { markerLayers, type Overlays } from "./marker-view";
import {
  fitCamera,
  MAX_SCALE,
  MIN_SCALE,
  dimensionLabel,
  type Camera,
  type Point,
  type SelectionShape,
  type ChunkKind,
  selectionShapes,
  type SelectionCommand,
} from "./map-view";

const ceilings = [319, 95, 255];
import type { SceneEditorHandle } from "./ChunkScene3D";
import type { SceneFill, SceneTool, StructureFormat } from "./SceneToolbar";

const ChunkScene3D = lazy(() => import("./ChunkScene3D"));

export default function ChunkEditor({
  initial,
  onBack,
  windowCloseRequested,
  onCancelWindowClose,
  onSettings,
}: {
  initial: DocumentState;
  onBack: (doc: DocumentState | null) => void;
  windowCloseRequested: boolean;
  onCancelWindowClose: () => void;
  onSettings?: () => void;
}) {
  const [doc, setDoc] = useState(initial);
  const [dimension, setDimension] = useState<number | null>(0);
  const [summary, setSummary] = useState<ChunkSummary | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, z: 0, scale: 1 });
  const [layer, setLayer] = useState<"surface" | "height">("surface");
  const [ceiling, setCeiling] = useState(319);
  const [grid, setGrid] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [hover, setHover] = useState<Point | null>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [closing, setClosing] = useState<"mode" | "window" | null>(null);
  const [locating, setLocating] = useState(false);
  const [location, setLocation] = useState({ x: "0", z: "0" });
  const [locationError, setLocationError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [ceilingDraft, setCeilingDraft] = useState("319");
  const [dimensions, setDimensions] = useState([0, 1, 2]);
  const [scaleDraft, setScaleDraft] = useState<string | null>(null);
  const [shape, setShape] = useState<SelectionShape>("rectangle");
  const [selectionCommand, setSelectionCommand] =
    useState<SelectionCommand | null>(null);
  const [blur, setBlur] = useState(true);
  const [overlays, setOverlays] = useState<Overlays>({
    entities: false,
    blocks: false,
    structures: false,
    spawn: false,
  });
  const [creating, setCreating] = useState(false);
  const [createHeight, setCreateHeight] = useState({ min: "-64", max: "319" });
  const [createError, setCreateError] = useState("");
  const [object, setObject] = useState<{
    reference: string;
    label: string;
  } | null>(null);
  const [objectDraft, setObjectDraft] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState("");
  const [kinds, setKinds] = useState<ChunkKind[]>([
    "terrain",
    "air",
    "unreadable",
    "missing",
  ]);
  const [displayKinds, setDisplayKinds] = useState<ChunkKind[]>([
    "terrain",
    "air",
  ]);
  const [fillOperation, setFillOperation] = useState<FillOperation>("chunks");
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [quality, setQuality] = useState(MAP_QUALITY.default);
  const [qualityDraft, setQualityDraft] = useState<string | null>(null);
  const [view, setView] = useState<"2d" | "3d" | "map">(
    getPreferences().default_view,
  );
  const [sceneStatus, setSceneStatus] = useState("");
  const [sceneBusy, setSceneBusy] = useState(false);
  const [sceneToolReset, setSceneToolReset] = useState(0);
  const [sceneTool, setSceneTool] = useState<SceneTool>("browse");
  const [sceneShape, setSceneShape] = useState<SelectionShape>("rectangle");
  const [sceneBlock, setSceneBlock] = useState("minecraft:stone");
  const [sceneFill, setSceneFill] = useState<SceneFill | null>(null);
  const [sceneDraft, setSceneDraft] = useState(false);
  const [chunkTools, setChunkTools] = useState(true);
  const [mapYaw, setMapYaw] = useState(180);
  const sceneEditor = useRef<SceneEditorHandle>(null);
  const objectEditor = useRef<ObjectEditorHandle>(null);
  const objectChanged = useCallback(
    (next: DocumentState) =>
      setDoc((previous) => ({
        ...previous,
        revision: next.revision,
        world_dirty: next.world_dirty,
        chunk_pending: next.chunk_pending,
        object_pending: next.object_pending,
      })),
    [],
  );
  const objectDraftChanged = useCallback(
    (dirty: boolean) => setObjectDraft(dirty),
    [],
  );
  const fittedDimension = useRef<number | null>(null);
  const cameraChanges = useRef(0);
  const updateCamera = useCallback((next: Camera) => {
    cameraChanges.current++;
    setCamera(next);
  }, []);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const chunkPending =
    doc.chunk_pending ??
    (summary ? summary.pending.length + (summary.created?.length ?? 0) : 0);
  const pending =
    chunkPending + (doc.object_pending ?? summary?.object_pending ?? 0);
  const unsaved = doc.world_dirty || objectDraft || sceneDraft || sceneBusy;
  const blocked =
    busy ||
    sceneBusy ||
    deleting ||
    resetting ||
    creating ||
    !!closing ||
    !!object;
  const indexReady =
    !loading &&
    summary?.dimension === dimension &&
    summary?.revision === doc.revision;
  const dataBlocked = blocked || !indexReady;
  // Keep a canvas mounted while the index loads, so navigation works immediately.
  const mapSummary: ChunkSummary = summary ?? {
    dimension: dimension ?? 0,
    revision: doc.revision,
    world_dirty: doc.world_dirty,
    total: 0,
    bounds: null,
    focus: null,
    pending: [],
    spawn: null,
  };
  const reportError = useCallback((message: string) => setError(message), []);
  const updateSize = useCallback(
    (next: { width: number; height: number }) => setSize(next),
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    api<{ items: number[] }>(
      `/documents/${doc.id}/chunks/dimensions?revision=${doc.revision}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((next) => {
        if (!controller.signal.aborted) setDimensions(next.items);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [doc.id, doc.revision, attempt]);
  useEffect(() => {
    if (windowCloseRequested) setClosing("window");
  }, [windowCloseRequested]);
  useEffect(() => {
    document.documentElement.dataset.unsaved = String(unsaved);
    function beforeUnload(event: BeforeUnloadEvent) {
      if (unsaved && !window.bedrockDesktop?.allowClose) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      delete document.documentElement.dataset.unsaved;
    };
  }, [unsaved]);
  useEffect(() => {
    if (dimension === null) return;
    const controller = new AbortController();
    const cameraVersion = cameraChanges.current;
    setLoading(true);
    setError("");
    setSelected(new Set());
    setSummary((previous) =>
      previous?.dimension === dimension ? previous : null,
    );
    api<ChunkSummary>(
      `/documents/${doc.id}/chunks?dimension=${dimension}&revision=${doc.revision}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        setSummary(next);
        if (
          fittedDimension.current !== dimension &&
          cameraChanges.current === cameraVersion
        ) {
          // Only the initial overworld view follows the actual world spawn.
          setCamera(
            dimension === 0
              ? { x: next.spawn?.x ?? 0, z: next.spawn?.z ?? 0, scale: 1 }
              : fitCamera(
                  next.bounds,
                  sizeRef.current.width,
                  sizeRef.current.height,
                  next.focus ?? undefined,
                ),
          );
        }
        // An initial manual pan also counts as initialized; later refreshes must not fit it.
        fittedDimension.current = dimension;
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // Summary is refreshed by revision/explicit retry; camera changes do not reload the index.
  }, [doc.id, doc.revision, dimension, attempt]);
  function chooseDimension(next: number) {
    if (blocked) return;
    if (next === dimension) return;
    setLoading(true);
    setSummary(null);
    setDimension(next);
    setCeiling(ceilings[next] ?? 319);
    setCeilingDraft(String(ceilings[next] ?? 319));
    setScaleDraft(null);
    setSelected(new Set());
    setHover(null);
  }
  function fit() {
    if (summary)
      updateCamera(
        fitCamera(
          summary.bounds,
          size.width,
          size.height,
          summary.focus ?? undefined,
        ),
      );
  }
  async function recover() {
    const next = await api<DocumentState>(`/documents/${doc.id}`).catch(
      () => null,
    );
    if (next) setDoc(next);
    setAttempt((value) => value + 1);
  }
  async function save() {
    if (busy || (!doc.world_dirty && !sceneDraft)) return;
    setBusy(true);
    try {
      const flushed = await sceneEditor.current?.flush();
      setDoc(
        await api<DocumentState>(`/documents/${doc.id}/save`, "POST", {
          revision: flushed?.revision ?? doc.revision,
          record: "level.dat",
        }),
      );
      setSelected(new Set());
      setAttempt((value) => value + 1);
    } catch (e) {
      toast.error((e as Error).message);
      await recover();
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (dimension === null || busy || !pending) return;
    setBusy(true);
    try {
      const next = await api<ChunkSummary>(
        `/documents/${doc.id}/chunks/restore`,
        "POST",
        { dimension, revision: doc.revision },
      );
      setSummary(next);
      setDoc({
        ...doc,
        revision: next.revision,
        world_dirty: next.world_dirty,
        chunk_pending: next.chunk_pending ?? next.pending.length,
        object_pending: next.object_pending,
      });
      setSelected(new Set());
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (dimension === null || busy || !selected.size) return;
    setBusy(true);
    try {
      const chunks = [...selected].map((key) => {
        const [x, z] = key.split(",").map(Number);
        return { x, z };
      });
      const next = await api<ChunkSummary>(
        `/documents/${doc.id}/chunks/${fillOperation === "blocks" ? "clear-blocks" : "delete"}`,
        "POST",
        { dimension, revision: doc.revision, chunks, skip_ineligible: true },
      );
      setSummary(next);
      setDoc({
        ...doc,
        revision: next.revision,
        world_dirty: next.world_dirty,
        chunk_pending:
          next.chunk_pending ??
          next.pending.length + (next.created?.length ?? 0),
      });
      setSelected(new Set());
      setDeleting(false);
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function resetDimension() {
    if (dimension === null || busy) return;
    setBusy(true);
    try {
      const next = await api<ChunkSummary>(
        `/documents/${doc.id}/chunks/reset`,
        "POST",
        { dimension, revision: doc.revision },
      );
      setSummary(next);
      setDoc({
        ...doc,
        revision: next.revision,
        world_dirty: next.world_dirty,
        chunk_pending: next.chunk_pending ?? 1,
        object_pending: next.object_pending,
      });
      setSelected(new Set());
      setResetting(false);
    } catch (e) {
      setResetError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function chooseTool(mode: "existing" | "browse") {
    setSceneToolReset((value) => value + 1);
    if (mode === "browse") {
      setSelected(new Set());
      sceneEditor.current?.clearSelection();
    }
    setSelecting(mode !== "browse");
    setSceneTool(mode === "browse" ? "browse" : "select");
    setSelectionCommand(null);
  }
  function selectionAction(kind: SelectionCommand["kind"]) {
    setSelectionCommand((previous) => ({
      kind,
      serial: (previous?.serial ?? 0) + 1,
    }));
  }
  async function create() {
    if (dimension === null || busy || !selected.size) return;
    if (
      ![createHeight.min, createHeight.max].every((text) =>
        /^-?\d+$/.test(text),
      )
    ) {
      setCreateError("请输入整数高度");
      return;
    }
    setBusy(true);
    try {
      const chunks = [...selected].map((key) => {
        const [x, z] = key.split(",").map(Number);
        return { x, z };
      });
      const next = await api<ChunkSummary>(
        `/documents/${doc.id}/chunks/create`,
        "POST",
        {
          dimension,
          revision: doc.revision,
          chunks,
          min_y: Number(createHeight.min),
          max_y: Number(createHeight.max),
          skip_ineligible: true,
        },
      );
      setSummary(next);
      setDoc({
        ...doc,
        revision: next.revision,
        world_dirty: next.world_dirty,
        chunk_pending:
          next.chunk_pending ??
          next.pending.length + (next.created?.length ?? 0),
      });
      setSelected(new Set());
      setCreating(false);
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function cancelClose() {
    if (closing === "window") onCancelWindowClose();
    setClosing(null);
  }
  async function exitWorld() {
    setBusy(true);
    try {
      await api(`/documents/${doc.id}`, "DELETE");
      onBack(null);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function finishClose(saveChanges: boolean) {
    if (busy || sceneBusy || !closing) return;
    setBusy(true);
    try {
      let current = doc;
      if (saveChanges && sceneEditor.current) {
        const flushed = await sceneEditor.current.flush();
        if (flushed)
          current = {
            ...current,
            revision: flushed.revision,
            world_dirty: flushed.world_dirty,
            chunk_pending: flushed.chunk_pending,
          };
      }
      if (saveChanges && objectEditor.current) {
        const flushed = await objectEditor.current.flush();
        if (flushed)
          current = {
            ...current,
            revision: flushed.revision,
            world_dirty: flushed.world_dirty,
            object_pending: flushed.object_pending,
          };
      }
      if (saveChanges && current.world_dirty)
        current = await api<DocumentState>(
          `/documents/${doc.id}/save`,
          "POST",
          { revision: current.revision, record: "level.dat" },
        );
      setDoc(current);
      if (closing === "window")
        await finishDesktopClose(!saveChanges && current.world_dirty);
      else {
        await api(`/documents/${doc.id}`, "DELETE");
        onBack(null);
      }
    } catch (e) {
      toast.error((e as Error).message);
      await recover();
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        dataBlocked
      )
        return;
      if (matchesShortcut(event, "save")) {
        event.preventDefault();
        void save();
      }
      if (
        matchesShortcut(event, "delete") &&
        (chunkTools || view === "map") &&
        selected.size &&
        !selectionLoading &&
        !summary?.reset
      ) {
        event.preventDefault();
        setFillOperation("chunks");
        setDeleteError("");
        setDeleting(true);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  async function travelChunks(step: number) {
    if (dataBlocked || !summary) return;
    setBusy(true);
    try {
      const next = await api<ChunkSummary>(
        `/documents/${doc.id}/chunks/voxels/travel`,
        "POST",
        {
          dimension: summary.dimension,
          revision: summary.revision,
          step,
        },
      );
      setSummary(next);
      setDoc((previous) => ({
        ...previous,
        revision: next.revision,
        world_dirty: next.world_dirty,
        chunk_pending: next.chunk_pending,
        object_pending: next.object_pending,
      }));
    } catch (error) {
      reportError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="chunk-page">
      {!summary && loading && !error && (
        <WorldLoading stage="正在读取世界区块索引…" />
      )}
      <header className="editor-header">
        <div className="editor-brand">
          <Button
            variant="ghost"
            aria-label="退出存档"
            disabled={blocked}
            onClick={() => (unsaved ? setClosing("mode") : void exitWorld())}
          >
            <ArrowLeft data-icon="inline-start" />
            退出存档
          </Button>
          <Brand compact />
        </div>
        <div className="editor-world-name">
          <span>{doc.world.name}</span>
          <Badge variant="secondary">世界</Badge>
          <Button
            variant="ghost"
            onClick={onSettings}
            disabled={blocked}
            aria-label="应用设置"
          >
            <Settings2 />
          </Button>
        </div>
      </header>
      <div className="editor-toolbar chunk-editor-toolbar">
        <div className="toolbar-label">
          <Map />
          <span>区块编辑</span>
          <span className="chunk-stats">
            {summary
              ? `${summary.total} 个区块${summary.bounds ? ` · ${summary.bounds.max_x - summary.bounds.min_x + 1} × ${summary.bounds.max_z - summary.bounds.min_z + 1}` : ""}`
              : ""}
          </span>
          {doc.world_dirty ? (
            <span className="modified-indicator" title="尚未保存" />
          ) : null}
        </div>
        <div className="chunk-header-actions">
          <div className="scene-view-switch" aria-label="编辑视图">
            <Button
              size="sm"
              variant={view === "2d" ? "default" : "secondary"}
              disabled={blocked || sceneDraft}
              onClick={() => {
                setView("2d");
                setLayersOpen(false);
              }}
            >
              2D
            </Button>
            <Button
              size="sm"
              variant={view === "3d" ? "default" : "secondary"}
              disabled={blocked || sceneDraft}
              onClick={() => {
                setView("3d");
                setLayersOpen(false);
              }}
            >
              3D
            </Button>
            <Button
              size="sm"
              variant={view === "map" ? "default" : "secondary"}
              disabled={blocked || sceneDraft}
              onClick={() => {
                setView("map");
                setLayersOpen(false);
              }}
            >
              地图俯视
            </Button>
          </div>
          <label className="chunk-dimension-select">
            维度
            <select
              aria-label="选择维度"
              value={dimension ?? ""}
              disabled={blocked}
              onChange={(event) => chooseDimension(Number(event.target.value))}
            >
              {dimensions.map((value) => (
                <option key={value} value={value}>
                  {dimensionLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <div className="chunk-layer-anchor">
            <Button
              variant="secondary"
              disabled={dimension === null || blocked}
              aria-expanded={layersOpen}
              onClick={() => setLayersOpen(!layersOpen)}
            >
              <Layers />
              视图
            </Button>
            {layersOpen && (
              <div className="chunk-layer-menu">
                <label>
                  最高 Y
                  <Input
                    inputMode="numeric"
                    value={ceilingDraft}
                    disabled={blocked}
                    onBlur={() => setCeilingDraft(String(ceiling))}
                    onChange={(e) => {
                      const text = e.target.value;
                      setCeilingDraft(text);
                      const value = Number(text);
                      if (
                        /^-?\d+$/.test(text) &&
                        Number.isInteger(value) &&
                        value >= -2048 &&
                        value <= 2047
                      )
                        setCeiling(value);
                    }}
                  />
                </label>
                {view === "map" && (
                  <>
                    <label>
                      地图图层
                      <select
                        value={layer}
                        disabled={blocked}
                        onChange={(e) =>
                          setLayer(e.target.value as "surface" | "height")
                        }
                      >
                        <option value="surface">地表颜色</option>
                        <option value="height">高度图</option>
                      </select>
                    </label>
                    <label className="chunk-grid-option">
                      <input
                        type="checkbox"
                        checked={grid}
                        disabled={blocked}
                        onChange={(e) => setGrid(e.target.checked)}
                      />
                      <Grid2X2 size={16} />
                      区块网格
                    </label>
                    <label className="chunk-grid-option">
                      <input
                        type="checkbox"
                        checked={blur}
                        disabled={blocked}
                        onChange={(e) => setBlur(e.target.checked)}
                      />
                      分级缩略图
                    </label>
                    <label>
                      总体画面质量
                      <Input
                        aria-label="总体画面质量"
                        type="number"
                        min={MAP_QUALITY.min}
                        max={MAP_QUALITY.max}
                        step="any"
                        value={qualityDraft ?? String(quality)}
                        disabled={blocked || !blur}
                        onChange={(event) => {
                          setQualityDraft(event.target.value);
                          const value = Number(event.target.value);
                          if (
                            Number.isFinite(value) &&
                            value >= MAP_QUALITY.min &&
                            value <= MAP_QUALITY.max
                          )
                            setQuality(value);
                        }}
                        onBlur={() => setQualityDraft(null)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <p className="chunk-view-note">
                      简化和合并阈值乘以此值，值越大越早简化。
                      近处逐区块分级，极远处按 2×2、3×3 等聚合；关闭后始终使用
                      16×16 像素。
                    </p>
                  </>
                )}
                <label className="chunk-grid-option">
                  <input
                    type="checkbox"
                    checked={displayKinds.includes("terrain")}
                    disabled={blocked}
                    onChange={(event) =>
                      setDisplayKinds(
                        event.target.checked ? ["terrain", "air"] : [],
                      )
                    }
                  />
                  <span
                    aria-hidden="true"
                    className="chunk-kind-swatch chunk-kind-loaded"
                  />
                  已加载区块
                </label>
                <div className="chunk-view-divider">地图信息</div>
                {markerLayers.map(([key, label]) => (
                  <label className="chunk-grid-option" key={key}>
                    <input
                      type="checkbox"
                      checked={overlays[key] ?? false}
                      disabled={blocked}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setOverlays((previous) => ({
                          ...previous,
                          [key]: checked,
                        }));
                      }}
                    />
                    <MinecraftIcon name={key} />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <Separator orientation="vertical" className="toolbar-separator" />
          <Button
            variant="ghost"
            size="icon"
            aria-label="还原区块修改"
            title="还原区块修改"
            disabled={!pending || dataBlocked}
            onClick={() => void restore()}
          >
            <RotateCcw />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            aria-label="撤销"
            title="撤销"
            disabled={dataBlocked || !summary?.voxel_can_undo}
            onClick={() => void travelChunks(-1)}
          >
            <Undo2 />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            aria-label="重做"
            title="重做"
            disabled={dataBlocked || !summary?.voxel_can_redo}
            onClick={() => void travelChunks(1)}
          >
            <Redo2 />
          </Button>
          <Button
            size="sm"
            disabled={(!doc.world_dirty && !sceneDraft) || dataBlocked}
            onClick={() => void save()}
          >
            <Save data-icon="inline-start" />
            {busy ? "处理中…" : "保存存档"}
          </Button>
        </div>
      </div>
      <main
        className={`chunk-workspace${view !== "map" ? " chunk-workspace-3d" : ""}`}
      >
        <div className="chunk-edit-layout">
          {(chunkTools || view === "map") && (
            <ChunkToolbar
              selecting={selecting}
              shape={shape}
              kinds={kinds}
              blocked={blocked}
              dataBlocked={dataBlocked || !!summary?.reset}
              selectedCount={selectionLoading ? 0 : selected.size}
              onBrowse={() => chooseTool("browse")}
              onSelect={() => chooseTool("existing")}
              onShape={(next) => {
                setSelected(new Set());
                sceneEditor.current?.clearSelection();
                setShape(next);
                chooseTool("existing");
              }}
              onKinds={(next) => {
                setKinds(next);
                sceneEditor.current?.clearSelection();
                setSelected(new Set());
                setSelectionCommand(null);
              }}
              onSelection={selectionAction}
              onFill={(next) => {
                setFillOperation(next);
                setDeleteError("");
                setDeleting(true);
              }}
              onCreate={() => {
                setCreateError("");
                setCreateHeight({
                  min: dimension === 0 ? "-64" : "0",
                  max:
                    dimension === 1 ? "127" : dimension === 2 ? "255" : "319",
                });
                setCreating(true);
              }}
              onReset={() => {
                setResetError("");
                setResetting(true);
              }}
            />
          )}
          <div className="chunk-map-stage">
            <div className="scene-session" hidden={view === "map"}>
              <Suspense
                fallback={
                  <div className="chunk-map-empty">
                    <LoadingActivity />
                    {view !== "map" && (
                      <WorldLoading stage="正在载入世界编辑器…" />
                    )}
                  </div>
                }
              >
                <ChunkScene3D
                  ref={sceneEditor}
                  active={view !== "map"}
                  ceiling={ceiling}
                  onCeiling={(value) => {
                    setCeiling(value);
                    setCeilingDraft(String(value));
                  }}
                  view={view}
                  onView={(next) => {
                    if (next === "map" && (blocked || sceneDraft)) return;
                    setView(next);
                    setLayersOpen(false);
                  }}
                  selectedChunks={selected}
                  chunkSelecting={chunkTools && selecting}
                  chunkShape={shape}
                  chunkKinds={kinds}
                  displayKinds={displayKinds}
                  selectionCommand={view === "map" ? null : selectionCommand}
                  onChunkSelection={setSelected}
                  onSelectionBusy={setSelectionLoading}
                  onSize={updateSize}
                  grid={grid}
                  onGrid={setGrid}
                  overlays={overlays}
                  id={doc.id}
                  tool={sceneTool}
                  onTool={(next) => {
                    setChunkTools(false);
                    setSelecting(false);
                    setSelectionCommand(null);
                    if (next === "browse") setSelected(new Set());
                    setSceneTool(next);
                  }}
                  onShape={setSceneShape}
                  voxelShape={sceneShape}
                  fillCommand={sceneFill}
                  fillBlock={sceneBlock}
                  onObject={(reference, label) => {
                    if (!dataBlocked) setObject({ reference, label });
                  }}
                  onDraft={setSceneDraft}
                  summary={mapSummary}
                  camera={camera}
                  ready={indexReady}
                  indexError={!indexReady ? error : undefined}
                  disabled={blocked}
                  onChanged={(next) => {
                    setSummary(next);
                    setDoc((previous) => ({
                      ...previous,
                      revision: next.revision,
                      world_dirty: next.world_dirty,
                      chunk_pending: next.chunk_pending,
                      object_pending: next.object_pending,
                    }));
                  }}
                  onError={reportError}
                  onCamera={updateCamera}
                  onHover={setHover}
                  onStatus={setSceneStatus}
                  onBusy={setSceneBusy}
                  onBack={() => {
                    setChunkTools((previous) => !previous);
                    setSelecting(true);
                    setSceneTool("select");
                  }}
                />
              </Suspense>
            </div>
            {view === "map" && (
              <>
                <div className="scene-topbar" aria-label="地图视角控制">
                  <label>
                    视角
                    <select
                      value="map"
                      disabled={blocked || sceneDraft}
                      onChange={(event) => {
                        const mode = event.target.value;
                        if (mode === "map") return;
                        sceneEditor.current?.setCameraMode(
                          mode as "orbit" | "fly" | "top",
                        );
                        setView(mode === "top" ? "2d" : "3d");
                        setLayersOpen(false);
                      }}
                    >
                      <option value="orbit">环绕</option>
                      <option value="fly">自由飞行</option>
                      <option value="top">
                        俯视 · {shortcutHint("toggleView")}
                      </option>
                      <option value="map">地图俯视</option>
                    </select>
                  </label>
                  <ViewAngle
                    label="偏航"
                    value={mapYaw}
                    disabled={blocked}
                    onCommit={(value) =>
                      setMapYaw(((((value + 180) % 360) + 360) % 360) - 180)
                    }
                  />
                </div>
                <ChunkMap
                  id={doc.id}
                  summary={mapSummary}
                  ready={indexReady}
                  camera={camera}
                  yaw={mapYaw}
                  onCamera={updateCamera}
                  layer={layer}
                  ceiling={ceiling}
                  grid={grid}
                  selecting={selecting && !dataBlocked}
                  selected={selected}
                  onSelected={setSelected}
                  onHover={setHover}
                  onSize={updateSize}
                  onError={reportError}
                  disabled={blocked}
                  shape={shape}
                  kinds={kinds}
                  displayKinds={displayKinds}
                  onSelectionBusy={setSelectionLoading}
                  selectionCommand={selectionCommand}
                  blur={blur}
                  quality={quality}
                  overlays={overlays}
                  onObject={(reference, label) => {
                    if (!dataBlocked) setObject({ reference, label });
                  }}
                  onDeleteObjects={async (references) => {
                    if (dataBlocked) throw new Error("请等待当前操作完成");
                    setBusy(true);
                    try {
                      const next = await api<DocumentState>(
                        `/documents/${doc.id}/chunks/objects/delete-selection`,
                        "POST",
                        { revision: doc.revision, objects: references },
                      );
                      objectChanged(next);
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                {summary && !loading && !summary.total && (
                  <div className="chunk-map-empty">此维度没有已生成的区块</div>
                )}
                {selecting && (
                  <div className="chunk-map-hint">
                    {selectionShapes.find(([key]) => key === shape)?.[1]} · Ctrl
                    增减 · 右键平移
                  </div>
                )}
              </>
            )}
            {!summary && (
              <div className="chunk-map-empty">
                {loading ? (
                  "正在读取区块索引…"
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => setAttempt(attempt + 1)}
                  >
                    重新读取
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
        {error && (
          <p className="chunk-error" role="alert">
            {error}
          </p>
        )}
        <div
          className={`chunk-map-controls${view !== "map" ? " scene-hide-map-controls" : ""}`}
        >
          <div className="chunk-dimension-controls">
            <div>
              <Button
                variant="secondary"
                size="icon"
                aria-label="适应地图"
                disabled={dataBlocked}
                onClick={fit}
              >
                <Map />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label="定位区块"
                disabled={blocked}
                onClick={() => {
                  setLocation({
                    x: String(Math.floor(camera.x / 16)),
                    z: String(Math.floor(camera.z / 16)),
                  });
                  setLocationError("");
                  setLocating(true);
                }}
              >
                <Crosshair />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label="缩小地图"
                disabled={blocked}
                onClick={() =>
                  updateCamera({
                    ...camera,
                    scale: Math.max(MIN_SCALE, camera.scale / 1.4),
                  })
                }
              >
                <Minus />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label="放大地图"
                disabled={blocked}
                onClick={() =>
                  updateCamera({
                    ...camera,
                    scale: Math.min(MAX_SCALE, camera.scale * 1.4),
                  })
                }
              >
                <Plus />
              </Button>
              <label className="chunk-scale-input">
                <Input
                  aria-label="地图缩放倍数"
                  inputMode="decimal"
                  value={
                    scaleDraft ?? String(Number(camera.scale.toPrecision(6)))
                  }
                  disabled={blocked}
                  onChange={(event) => setScaleDraft(event.target.value)}
                  onBlur={() => {
                    const value = Number(scaleDraft);
                    if (
                      scaleDraft !== null &&
                      Number.isFinite(value) &&
                      value >= MIN_SCALE &&
                      value <= MAX_SCALE
                    )
                      updateCamera({ ...camera, scale: value });
                    setScaleDraft(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                倍
              </label>
            </div>
          </div>
          <div className="chunk-position">
            {hover
              ? `区块 ${hover.x}, ${hover.z} · 方块 ${hover.x * 16}, ${hover.z * 16} · `
              : ""}
          </div>
        </div>
      </main>
      <footer className="chunk-footer">
        <span>
          {selected.size ? `已选 ${selected.size} 个区块` : ""}
          {summary?.reset
            ? `待重置 ${dimensionLabel(summary.reset.dimension)} · ${summary.reset.records} 条数据`
            : pending
              ? `${selected.size ? " · " : ""}待删除 ${summary?.pending.length ?? 0} · 待新增 ${summary?.created?.length ?? 0}${summary?.cleared?.length ? ` · 地形修改 ${summary.cleared.length}` : ""}`
              : ""}
          {doc.object_pending ? ` · 对象记录修改 ${doc.object_pending}` : ""}
          {view !== "map" ? ` · ${sceneStatus}` : ""}
        </span>
      </footer>
      {object && (
        <ObjectEditor
          ref={objectEditor}
          id={doc.id}
          revision={doc.revision}
          reference={object.reference}
          label={object.label}
          onChanged={objectChanged}
          onDraftChange={objectDraftChanged}
          onClose={() => {
            setObject(null);
            setObjectDraft(false);
          }}
        />
      )}
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!busy) setCreating(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增空区块</DialogTitle>
            <DialogDescription>
              在选区中的未生成位置新增全空气区块，跳过已有区块。保存前可还原。自定义维度请按实际高度设置。
            </DialogDescription>
          </DialogHeader>
          <div className="chunk-location">
            <label>
              最低 Y
              <Input
                value={createHeight.min}
                disabled={
                  busy ||
                  (dimension !== null && dimension >= 0 && dimension <= 2)
                }
                onChange={(e) =>
                  setCreateHeight({ ...createHeight, min: e.target.value })
                }
              />
            </label>
            <label>
              最高 Y
              <Input
                value={createHeight.max}
                disabled={
                  busy ||
                  (dimension !== null && dimension >= 0 && dimension <= 2)
                }
                onChange={(e) =>
                  setCreateHeight({ ...createHeight, max: e.target.value })
                }
              />
            </label>
          </div>
          <p className="chunk-view-note">
            最低 Y 须为 16 的倍数，最高 Y 须为 16 的倍数减 1。
          </p>
          {createError && (
            <p className="field-error" role="alert">
              {createError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              取消
            </Button>
            <Button disabled={busy} onClick={() => void create()}>
              暂存新增
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={resetting}
        onOpenChange={(open) => {
          if (!busy) setResetting(open);
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              重置{dimension === null ? "" : dimensionLabel(dimension)}？
            </DialogTitle>
            <DialogDescription>
              删除当前维度全部区块、独立实体及其索引、位于此维度的玩家记录、村庄关联数据、常加载区域、物品地图和其他具有明确维度归属的
              NBT。
              共享传送门记录只删除此维度条目，其他维度玩家的此维度重生点也会清除。
              保留其他维度、level.dat（含世界出生点）、计分板及无法判断维度的共享数据。
              请先保存或还原已有数据库和地图修改。重置先暂存，保存前可还原；保存后无法在此恢复。
            </DialogDescription>
          </DialogHeader>
          {resetError && (
            <p className="field-error" role="alert">
              {resetError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setResetting(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void resetDimension()}
            >
              暂存重置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleting}
        onOpenChange={(open) => {
          if (!busy) {
            setDeleting(open);
            setDeleteError("");
          }
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {fillOperation === "blocks"
                ? "删除所选区块内的方块？"
                : "删除所选区块？"}
            </DialogTitle>
            <DialogDescription>
              {fillOperation === "blocks"
                ? "清空所选区块全部高度的方块、方块实体及待执行事件，保留区块、生物、掉落物、玩家和生物群系。无法完整解析的地形会取消整批操作。"
                : `删除${dimension === null ? "" : dimensionLabel(dimension)}选中区块的地形、方块实体和区块数据，保留玩家、独立实体及命名 NBT。`}
              未生成位置跳过。保存前可还原；保存后无法在此恢复。
            </DialogDescription>
          </DialogHeader>
          {deleteError && <p className="field-error">{deleteError}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              暂存删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!closing}
        onOpenChange={(open) => {
          if (!open && !busy) cancelClose();
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {closing === "mode" ? "退出存档？" : "关闭程序？"}
            </DialogTitle>
            <DialogDescription>
              {unsaved ? "当前有未保存的修改。" : APP_CLOSE_PROMPT}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={cancelClose}>
              取消
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void finishClose(false)}
            >
              {unsaved ? "不保存" : "关闭"}
            </Button>
            {unsaved && (
              <Button disabled={busy} onClick={() => void finishClose(true)}>
                {closing === "mode" ? "保存并退出" : "保存并关闭"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={locating} onOpenChange={setLocating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>定位区块</DialogTitle>
            <DialogDescription>输入区块坐标 X、Z。</DialogDescription>
          </DialogHeader>
          <div className="chunk-location">
            <label>
              X
              <Input
                value={location.x}
                onChange={(e) =>
                  setLocation({ ...location, x: e.target.value })
                }
              />
            </label>
            <label>
              Z
              <Input
                value={location.z}
                onChange={(e) =>
                  setLocation({ ...location, z: e.target.value })
                }
              />
            </label>
          </div>
          {locationError && <p className="field-error">{locationError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLocating(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                const values = [location.x, location.z];
                if (
                  values.some(
                    (value) =>
                      !/^-?\d+$/.test(value) ||
                      !Number.isSafeInteger(Number(value)) ||
                      Number(value) < -2147483648 ||
                      Number(value) > 2147483647,
                  )
                ) {
                  setLocationError("请输入 32 位有符号整数区块坐标");
                  return;
                }
                updateCamera({
                  x: Number(location.x) * 16 + 8,
                  z: Number(location.z) * 16 + 8,
                  scale: 3,
                });
                setLocating(false);
              }}
            >
              定位
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
