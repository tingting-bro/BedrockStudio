import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type SetStateAction,
} from "react";
import * as THREE from "three";
import { Focus, Settings2, X, Trash2, Scissors } from "lucide-react";
import { api, apiBlob, apiUpload, apiImage } from "@/lib/api";
import WorldLoading, {
  type WorldLoadingProgress,
} from "@/components/WorldLoading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ChunkSummary } from "./ChunkMap";
import type {
  Camera,
  Point,
  SelectionShape,
  ChunkKind,
  SelectionCommand,
} from "./map-view";
import {
  chunkSelection,
  dimensionHeight,
  selectSceneChunks,
  SceneChunkSelection,
} from "./scene-chunks";
import { selectionBounds as chunkBounds } from "./map-view";
import { SceneCamera } from "./scene-camera";
import { SceneLoader } from "./scene-loader";
import { SceneGround } from "./scene-ground";
import { ScenePastePreview } from "./scene-paste-preview";
import { SceneGizmo } from "./scene-gizmo";
import { SceneMarkers } from "./scene-markers";
import { SceneEntities } from "./scene-entities";
import { markerStyle, type MapMarker, type Overlays } from "./marker-view";
import {
  axes,
  identityTransform,
  quarterTurn,
  snapPosition,
} from "./scene-transform";
import {
  initialCameraHeight,
  selectionBounds,
  sphereRadius,
  sphereCorners,
  stretchSelection,
  type Atlas,
  type VoxelPoint,
} from "./scene-data";
import type { SceneFill, SceneTool, StructureFormat } from "./SceneToolbar";
import SceneToolbar from "./SceneToolbar";
import SceneNudge from "./SceneNudge";
import ViewAngle from "./ViewAngle";
import { selectionSize } from "./scene-selection";
import { selectionMaterial } from "./scene-selection-material";
import { FLIGHT_SPEED, RENDER_DISTANCE } from "@/lib/constants";
import {
  getPreferences,
  matchesShortcut,
  shortcutHint,
} from "@/lib/preferences";
type Tool = SceneTool;
const emptyChunkSelection = new Set<string>();
interface Hit {
  name?: string;
  point: VoxelPoint;
  adjacent: VoxelPoint;
}
function SceneInteger({
  value,
  min,
  max,
  label,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      aria-label={label}
      type="number"
      min={min}
      max={max}
      value={draft ?? String(value)}
      onBlur={() => setDraft(null)}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const next = Number(text);
        if (
          /^-?\d+$/.test(text) &&
          Number.isInteger(next) &&
          next >= min &&
          next <= max
        )
          onChange(next);
      }}
    />
  );
}
function SceneScale({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      aria-label="等比例缩放"
      type="number"
      min="0"
      step="0.1"
      value={draft ?? String(value)}
      onBlur={() => setDraft(null)}
      onChange={(event) => {
        setDraft(event.target.value);
        const next = Number(event.target.value);
        if (Number.isFinite(next) && next > 0) onChange(next);
      }}
    />
  );
}
function SceneCoordinate({
  value,
  axis,
  disabled,
  onCommit,
}: {
  value: number;
  axis: "x" | "y" | "z";
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      aria-label={`当前坐标 ${axis.toUpperCase()}`}
      type="number"
      step="any"
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(null);
        }
      }}
      onBlur={() => {
        if (draft !== null && draft.trim() !== "") {
          const next = Number(draft);
          if (
            Number.isFinite(next) &&
            (axis === "y"
              ? next >= -2048 && next <= 2047
              : next >= -(2 ** 35) && next < 2 ** 35)
          )
            onCommit(next);
        }
        setDraft(null);
      }}
    />
  );
}
export interface SceneEditorHandle {
  setCameraMode: (mode: "orbit" | "fly" | "top") => void;
  clearSelection: () => void;
  flush: () => Promise<ChunkSummary | undefined>;
  exportStructure: (format: StructureFormat) => Promise<void>;
  importStructure: (file: File) => Promise<void>;
}
interface Props {
  active?: boolean;
  ceiling?: number;
  onCeiling?: (value: number) => void;
  indexError?: string;
  view?: "2d" | "3d" | "map";
  onView?: (view: "2d" | "3d" | "map") => void;
  selectedChunks?: Set<string>;
  chunkSelecting?: boolean;
  chunkShape?: SelectionShape;
  chunkKinds?: ChunkKind[];
  displayKinds?: ChunkKind[];
  selectionCommand?: SelectionCommand | null;
  onChunkSelection?: (selected: Set<string>) => void;
  onSelectionBusy?: (busy: boolean) => void;
  onSize?: (size: { width: number; height: number }) => void;
  grid?: boolean;
  onGrid?: (value: boolean) => void;
  overlays: Overlays;
  fillBlock?: string;
  ref?: Ref<SceneEditorHandle>;
  tool: SceneTool;
  onTool?: (tool: SceneTool) => void;
  onShape?: (shape: SelectionShape) => void;
  voxelShape: SelectionShape;
  fillCommand: SceneFill | null;
  onObject: (reference: string, label: string) => void;
  onDraft: (dirty: boolean) => void;
  id: string;
  summary: ChunkSummary;
  camera: Camera;
  ready: boolean;
  disabled: boolean;
  onChanged: (s: ChunkSummary) => void;
  onError: (s: string) => void;
  onCamera: (c: Camera) => void;
  onHover: (p: Point | null) => void;
  onStatus: (s: string) => void;
  onBack: () => void;
  onBusy: (b: boolean) => void;
}
export default function ChunkScene3D(props: Props) {
  const host = useRef<HTMLDivElement>(null),
    live = useRef(props);
  live.current = props;
  const [mode, setMode] = useState<"orbit" | "fly" | "top">("fly"),
    [radius, setRadius] = useState(getPreferences().default_render_distance),
    [cut, setCut] = useState(false),
    [ceiling, setCeiling] = useState(319),
    [brightness, setBrightness] = useState(0.8),
    [quality, setQuality] = useState("auto");
  const tool = props.tool;
  const [voxelCorners, setVoxelCorners] = useState<VoxelPoint[]>([]),
    [hit, setHit] = useState<Hit | null>(null),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<string | null>(null),
    [failure, setFailure] = useState("");
  const [blockNbt, setBlockNbt] = useState<{
    point: VoxelPoint;
    name: string;
    states: string;
    entity: string | null;
    entity_pending?: boolean;
  } | null>(null);
  const [voxelHollow, setHollow] = useState(false);
  const chunkArea = useMemo(
    () =>
      props.selectedChunks?.size
        ? chunkSelection(props.selectedChunks, props.summary.dimension)
        : null,
    [props.selectedChunks, props.summary.dimension],
  );
  const corners = chunkArea?.corners ?? voxelCorners;
  const hollow = chunkArea ? false : voxelHollow;
  const setCorners = (next: SetStateAction<VoxelPoint[]>) => {
    selectionRequest.current?.abort();
    if (props.selectedChunks?.size) props.onChunkSelection?.(new Set());
    setVoxelCorners((previous) =>
      typeof next === "function" ? next(chunkArea?.corners ?? previous) : next,
    );
  };
  const [clipboard, setClipboard] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteOrigin, setPasteOrigin] = useState<VoxelPoint>({
    x: 0,
    y: 64,
    z: 0,
  });
  const [nbtDirty, setNbtDirty] = useState(false);
  const [nbtError, setNbtError] = useState("");
  const [pasteReady, setPasteReady] = useState(false);
  const [pasteError, setPasteError] = useState("");
  const [skipUnsupported, setSkipUnsupported] = useState(false);
  const moveSource = useRef<{ revision: number; dimension: number } | null>(
    null,
  );
  const [pasteTransform, setPasteTransform] = useState(identityTransform);
  const [gizmoMode, setGizmoMode] = useState<"translate" | "rotate">(
    "translate",
  );
  const [snap, setSnap] = useState(1);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    hit: Hit | null;
    entity?: MapMarker | null;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const commands = useRef({
    copy: () => {},
    paste: () => {},
    move: () => {},
    commit: () => {},
  });
  const pastePreview = useRef<ScenePastePreview | null>(null);
  const nbtAction = useRef<(h: Hit) => void>(() => {});
  const sphere = !chunkArea && props.voxelShape === "circle";
  const bounds = (a: VoxelPoint, b: VoxelPoint) =>
    selectionBounds(a, b, sphere);
  const [position, setPosition] = useState<VoxelPoint>({
    x: props.camera.x,
    y: initialCameraHeight(props.summary.dimension, props.summary.spawn?.y),
    z: props.camera.z,
  });
  const positionRef = useRef(position);
  const [planeY, setPlaneY] = useState(64),
    [locating, setLocating] = useState(false),
    [location, setLocation] = useState({ x: "0", y: "80", z: "0" });
  const locate = useRef<(x: number, y: number, z: number) => void>(() => {});
  const controls = useRef<SceneCamera | null>(null),
    loader = useRef<SceneLoader | null>(null);
  const savedCamera = useRef<{
    dimension: number;
    position: THREE.Vector3;
    target: THREE.Vector3;
  } | null>(null);
  const [markerNotice, setMarkerNotice] = useState("");
  const [markerCluster, setMarkerCluster] = useState<MapMarker[] | null>(null);
  const [markerQuery, setMarkerQuery] = useState("");
  const [markerPage, setMarkerPage] = useState(0);
  const [selectedEntity, setSelectedEntity] = useState<MapMarker | null>(null);
  const [entityNotice, setEntityNotice] = useState("");
  const [copyBlockEntities, setCopyBlockEntities] = useState(true);
  const [copyEntities, setCopyEntities] = useState(true);
  const [speed, setSpeed] = useState(
    getPreferences().default_flight_speed / FLIGHT_SPEED.base,
  );
  const [viewOpen, setViewOpen] = useState(false);
  const [operationBlock, setOperationBlock] = useState(
    props.fillBlock ?? "minecraft:stone",
  );
  const [operationMatch, setOperationMatch] = useState("");
  const [selectionDistance, setSelectionDistance] = useState(10);
  const [rendererAttempt, setRendererAttempt] = useState(0);
  const [startup, setStartup] = useState<WorldLoadingProgress | null>({
    stage: "正在准备材质资源…",
  });
  const [replaceExisting, setReplaceExisting] = useState(true);
  const [pasteAir, setPasteAir] = useState(true);
  const [viewAngles, setViewAngles] = useState({ yaw: 180, pitch: 0 });
  const viewAnglesRef = useRef(viewAngles);
  const commitAngle = (axis: "yaw" | "pitch", value: number) => {
    const cam = controls.current;
    if (!cam) return;
    const next = { ...cam.angles(), [axis]: value };
    cam.setAngles(next.yaw, next.pitch);
    viewAnglesRef.current = cam.angles();
    setViewAngles(viewAnglesRef.current);
  };
  const compass = useRef<HTMLDivElement>(null);
  const focusSelection = useRef<() => void>(() => {});
  const perspectiveMode = useRef<"fly" | "orbit">("fly");
  const selectionRequest = useRef<AbortController | null>(null);
  const selectVisible = useRef<(operation: "add" | "invert") => void>(() => {});
  const selectChunks = useRef<
    (
      start: Point,
      end: Point,
      operation: "replace" | "add" | "invert",
      shape?: SelectionShape,
    ) => void
  >(() => {});
  selectChunks.current = async (start, end, operation, shape) => {
    const p = live.current;
    if (!p.ready || p.disabled || p.active === false) return;
    selectionRequest.current?.abort();
    const controller = new AbortController();
    selectionRequest.current = controller;
    p.onSelectionBusy?.(true);
    try {
      const next = await selectSceneChunks(
        p.id,
        p.summary.dimension,
        p.summary.revision,
        start,
        end,
        shape ?? p.chunkShape ?? "rectangle",
        p.chunkKinds ?? ["terrain", "air", "unreadable", "missing"],
        p.selectedChunks ?? new Set(),
        operation,
        controller.signal,
      );
      if (next && !controller.signal.aborted) {
        setVoxelCorners([]);
        p.onChunkSelection?.(next);
      }
    } catch (error) {
      if (!controller.signal.aborted) p.onError((error as Error).message);
    } finally {
      if (selectionRequest.current === controller) p.onSelectionBusy?.(false);
    }
  };
  const changeMode = (next: "fly" | "orbit" | "top") => {
    if (next !== "top") perspectiveMode.current = next;
    setMode(next);
    props.onView?.(next === "top" ? "2d" : "3d");
  };
  const entitySelection = useRef(selectedEntity);
  entitySelection.current = selectedEntity;
  const markerItems = (markerCluster ?? []).filter((marker) =>
    `${marker.label} ${marker.object_type ?? ""} ${marker.id}`
      .toLowerCase()
      .includes(markerQuery.toLowerCase()),
  );
  const settings = useRef({
    displayKinds: props.displayKinds,
    mode,
    radius,
    cut: props.ceiling !== undefined || cut,
    ceiling: props.ceiling ?? ceiling,
    brightness,
    quality,
    speed,
    tool,
    busy,
    corners,
    sphere,
    planeY,
    modal: locating || !!confirm || !!blockNbt || !!menu || !!markerCluster,
    pasteOpen,
    pasteOrigin,
    pasteTransform,
    skipUnsupported,
    gizmoMode,
    snap,
    selectionDistance,
  });
  settings.current = {
    displayKinds: props.displayKinds,
    mode,
    radius,
    cut: props.ceiling !== undefined || cut,
    ceiling: props.ceiling ?? ceiling,
    brightness,
    quality,
    speed,
    tool,
    busy,
    corners,
    sphere,
    planeY,
    modal: locating || !!confirm || !!blockNbt || !!menu || !!markerCluster,
    pasteOpen,
    pasteOrigin,
    pasteTransform,
    skipUnsupported,
    gizmoMode,
    snap,
    selectionDistance,
  };
  const editorActions: SceneEditorHandle = {
    setCameraMode: changeMode,
    clearSelection: () => setCorners([]),
    flush: async () => {
      if (!blockNbt || !nbtDirty) return undefined;
      try {
        const next = await api<ChunkSummary>(
          `/documents/${props.id}/chunks/voxels/edit`,
          "POST",
          {
            dimension: props.summary.dimension,
            revision: props.summary.revision,
            low: blockNbt.point,
            high: blockNbt.point,
            block: blockNbt.name,
            states: blockNbt.states,
          },
        );
        props.onChanged(next);
        setBlockNbt(null);
        setNbtDirty(false);
        props.onDraft(false);
        return next;
      } catch (error) {
        setNbtError((error as Error).message);
        throw error;
      }
    },
    exportStructure: async (format) => {
      if (corners.length !== 2 || busy || props.disabled || !props.ready) {
        props.onError("请先在 3D 视图中选择两个方块");
        return;
      }
      const { low, high } = bounds(corners[0], corners[1]);
      setBusy(true);
      props.onBusy(true);
      try {
        const blob = await apiBlob(
          `/documents/${props.id}/chunks/structures/export`,
          "POST",
          {
            dimension: props.summary.dimension,
            revision: props.summary.revision,
            low,
            high,
            format,
            hollow,
            sphere: sphere
              ? { ...corners[0], radius: sphereRadius(corners[0], corners[1]) }
              : null,
            include_block_entities: copyBlockEntities,
            include_entities: copyEntities,
            chunk_mask: chunkArea?.mask ?? null,
          },
        );
        if (!blob.size) return; // Native save dialog completed or was cancelled.
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `structure_${low.x}_${low.y}_${low.z}_${high.x}_${high.y}_${high.z}.${format}`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (error) {
        props.onError((error as Error).message);
      } finally {
        setBusy(false);
        props.onBusy(false);
      }
    },
    importStructure: async (file) => {
      if (busy || props.disabled || !props.ready) return;
      const extension = file.name.toLowerCase().split(".").pop();
      if (
        !extension ||
        !["mcstructure", "schematic", "schem"].includes(extension)
      ) {
        props.onError("请选择 mcstructure、schematic 或 schem 文件");
        return;
      }
      setBusy(true);
      props.onBusy(true);
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("format", extension);
        form.append("revision", String(props.summary.revision));
        await apiUpload(
          `/documents/${props.id}/chunks/structures/import`,
          form,
        );
        moveSource.current = null;
        setClipboard(true);
        setPasteOrigin(
          snapPosition(
            {
              x: Math.floor(positionRef.current.x),
              y: Math.floor(positionRef.current.y),
              z: Math.floor(positionRef.current.z),
            },
            snap,
          ),
        );
        setPasteTransform(identityTransform());
        setSkipUnsupported(false);
        setGizmoMode("translate");
        setPasteReady(false);
        setPasteError("");
        setPasteOpen(true);
        setPropertiesOpen(true);
      } catch (error) {
        props.onError((error as Error).message);
      } finally {
        setBusy(false);
        props.onBusy(false);
      }
    },
  };
  useImperativeHandle(props.ref, () => editorActions);
  const action = useRef<(h: Hit) => void>(() => {});
  async function edit(
    low: VoxelPoint,
    high: VoxelPoint,
    name: string,
    filter: string | null,
    states?: string,
  ) {
    if (busy || props.disabled || !props.ready) return;
    setBusy(true);
    props.onBusy(true);
    try {
      const next = await api<ChunkSummary>(
        `/documents/${props.id}/chunks/voxels/edit`,
        "POST",
        {
          dimension: props.summary.dimension,
          revision: props.summary.revision,
          low,
          high,
          block: name,
          match: filter,
          states,
          chunk_mask: states === undefined ? (chunkArea?.mask ?? null) : null,
          hollow: states === undefined && hollow,
          sphere:
            states === undefined && sphere && corners.length === 2
              ? { ...corners[0], radius: sphereRadius(corners[0], corners[1]) }
              : null,
        },
      );
      props.onChanged(next);
      setConfirm(null);
      if (states !== undefined) {
        setBlockNbt(null);
        setNbtDirty(false);
        props.onDraft(false);
      }
    } catch (error) {
      props.onError((error as Error).message);
      if (states !== undefined) setNbtError((error as Error).message);
    } finally {
      setBusy(false);
      props.onBusy(false);
    }
  }
  async function copySelection(includeEntities = copyEntities) {
    if (corners.length !== 2 || busy || props.disabled || !props.ready) return;
    const { low, high } = bounds(corners[0], corners[1]);
    setBusy(true);
    props.onBusy(true);
    try {
      await api(`/documents/${props.id}/chunks/voxels/copy`, "POST", {
        dimension: props.summary.dimension,
        revision: props.summary.revision,
        low,
        high,
        hollow,
        include_block_entities: copyBlockEntities,
        include_entities: includeEntities,
        chunk_mask: chunkArea?.mask ?? null,
        sphere: sphere
          ? { ...corners[0], radius: sphereRadius(corners[0], corners[1]) }
          : null,
      });
      moveSource.current = null;
      setClipboard(true);
      return true;
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setBusy(false);
      props.onBusy(false);
    }
  }
  async function pasteSelection() {
    if (
      busy ||
      props.disabled ||
      !props.ready ||
      !pasteOpen ||
      !pasteReady ||
      pastePreview.current?.isReadyFor(pasteTransform) === false
    )
      return;
    setBusy(true);
    props.onBusy(true);
    try {
      const next = await api<ChunkSummary>(
        `/documents/${props.id}/chunks/voxels/paste`,
        "POST",
        {
          dimension: props.summary.dimension,
          revision: props.summary.revision,
          origin: pasteOrigin,
          rotation: pasteTransform.rotation,
          mirror: pasteTransform.mirror,
          axis_order: pasteTransform.axisOrder ?? "xyz",
          scale: pasteTransform.scale ?? 1,
          replace_existing: replaceExisting,
          paste_air: pasteAir,
          skip_unsupported: skipUnsupported,
          move_revision: moveSource.current?.revision ?? null,
        },
      );
      props.onChanged(next);
      setPasteOpen(false);
      moveSource.current = null;
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setBusy(false);
      props.onBusy(false);
    }
  }
  function beginPaste(copied = false, moving = false) {
    if ((!clipboard && !copied) || busy || props.disabled || !props.ready)
      return;
    if (!moving) moveSource.current = null;
    if (moving) {
      setReplaceExisting(true);
      setPasteAir(true);
    }
    setPasteOrigin(
      snapPosition(
        corners.length === 2
          ? bounds(corners[0], corners[1]).low
          : (hit?.point ?? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
              z: Math.floor(position.z),
            }),
        snap,
      ),
    );
    setPasteTransform(identityTransform());
    setSkipUnsupported(false);
    setGizmoMode("translate");
    setPasteReady(false);
    setPasteError("");
    setPasteOpen(true);
    setPropertiesOpen(true);
    setMenu(null);
  }
  async function beginMove() {
    if (corners.length !== 2 || busy || props.disabled || !props.ready) return;
    // Moving terrain only clears blocks at the source; independent actors stay there.
    if (await copySelection(false)) {
      moveSource.current = {
        revision: props.summary.revision,
        dimension: props.summary.dimension,
      };
      beginPaste(true, true);
    }
  }
  commands.current = {
    copy: () => void copySelection(),
    paste: beginPaste,
    move: () => void beginMove(),
    commit: () => void pasteSelection(),
  };
  useEffect(() => {
    if (!menu) return;
    controls.current?.release();
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  useEffect(() => {
    setClipboard(false);
    setPasteOpen(false);
    const controller = new AbortController();
    void api<{ available: boolean }>(
      `/documents/${props.id}/chunks/voxels/clipboard`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((data) => setClipboard(data.available))
      .catch(() => {});
    return () => controller.abort();
  }, [props.id]);
  useEffect(() => {
    setPasteReady(false);
    setPasteError("");
    if (pasteOpen)
      void pastePreview.current?.load(
        props.id,
        props.summary.revision,
        pasteTransform,
        skipUnsupported,
        positionRef.current,
        radius,
        pasteOrigin,
      );
    else pastePreview.current?.clear();
  }, [
    pasteOpen,
    props.id,
    props.summary.revision,
    pasteTransform,
    skipUnsupported,
  ]);
  action.current = (h) => {
    if (props.disabled || !props.ready || busy || tool === "browse") return;
    if (sphere) setCorners(sphereCorners(h.point, 1));
    else if (props.voxelShape === "single") setCorners([h.point, h.point]);
    else
      setCorners((previous) =>
        previous.length === 1 ? [previous[0], h.point] : [h.point],
      );
  };
  nbtAction.current = async (h) => {
    if (props.disabled || !props.ready || busy) return;
    setBusy(true);
    props.onBusy(true);
    try {
      const data = await api<{
        name: string;
        states: string;
        entity: string | null;
        entity_pending?: boolean;
      }>(
        `/documents/${props.id}/chunks/voxels/block?dimension=${props.summary.dimension}&revision=${props.summary.revision}&x=${h.point.x}&y=${h.point.y}&z=${h.point.z}`,
      );
      setBlockNbt({ ...data, point: h.point });
      setNbtDirty(false);
      setNbtError("");
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setBusy(false);
      props.onBusy(false);
    }
  };
  const handledFill = useRef(props.fillCommand?.serial);
  useEffect(() => {
    if (props.fillCommand && props.fillCommand.serial !== handledFill.current) {
      handledFill.current = props.fillCommand.serial;
      if (corners.length !== 2) props.onError("请先在选取模式下选择方块范围");
      else setConfirm(props.fillCommand.block);
    }
  }, [props.fillCommand]);
  useEffect(() => {
    if (tool === "browse") setVoxelCorners([]);
  }, [tool]);
  useEffect(() => setVoxelCorners([]), [props.voxelShape]);
  useEffect(() => {
    if (props.selectedChunks?.size) setVoxelCorners([]);
  }, [props.selectedChunks]);
  useEffect(() => {
    if (props.view && props.view !== "map")
      setMode(props.view === "2d" ? "top" : perspectiveMode.current);
  }, [props.view]);
  useEffect(() => {
    selectionRequest.current?.abort();
    props.onSelectionBusy?.(false);
    return () => {
      selectionRequest.current?.abort();
      props.onSelectionBusy?.(false);
    };
  }, [
    props.id,
    props.summary.dimension,
    props.summary.revision,
    props.chunkShape,
    props.chunkKinds,
    props.chunkSelecting,
    props.active,
  ]);
  useEffect(() => {
    if (!props.selectionCommand) return;
    if (props.selectionCommand.kind === "clear") setCorners([]);
    else
      selectVisible.current(
        props.selectionCommand.kind === "invert" ? "invert" : "add",
      );
  }, [props.selectionCommand]);
  useEffect(() => {
    props.onBusy(busy);
    return () => props.onBusy(false);
  }, [busy, props.onBusy]);
  useEffect(() => {
    setVoxelCorners([]);
    setHit(null);
    setPasteOpen(false);
    moveSource.current = null;
  }, [props.summary.dimension]);
  useEffect(
    () => setSelectedEntity(null),
    [props.summary.dimension, props.summary.revision],
  );
  useEffect(
    () => setMarkerCluster(null),
    [props.summary.dimension, props.summary.revision, props.overlays],
  );
  useEffect(() => {
    loader.current?.setRevision(
      props.summary.revision,
      props.summary.voxel_changes,
    );
  }, [props.summary]);
  useEffect(() => {
    if (!host.current) return;
    const container = host.current,
      controller = new AbortController();
    let disposed = false,
      frame = 0;
    let renderer: THREE.WebGLRenderer | undefined,
      cam: SceneCamera | undefined,
      data: SceneLoader | undefined,
      texture: THREE.Texture | undefined,
      observer: ResizeObserver | undefined;
    const cleanup: (() => void)[] = [];
    setFailure("");
    setStartup({ stage: "正在准备材质资源…" });
    let preloading = true;
    let preloadView: { x: number; z: number; radius: number } | undefined;
    let progressKey = "";
    const init = async () => {
      try {
        const progressController = new AbortController();
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const stopProgress = () => {
          progressController.abort();
          clearTimeout(pollTimer);
        };
        cleanup.push(stopProgress);
        const pollProgress = async () => {
          try {
            const progress = await api<WorldLoadingProgress>(
              `/documents/${props.id}/render-progress`,
              "GET",
              undefined,
              progressController.signal,
            );
            if (!disposed && !progressController.signal.aborted)
              setStartup(progress);
          } catch {
            /* The resource request owns error reporting. */
          }
          if (!disposed && !progressController.signal.aborted)
            pollTimer = setTimeout(() => void pollProgress(), 500);
        };
        void pollProgress();
        const atlas = await api<Atlas>(
          `/documents/${props.id}/render-resources`,
          "GET",
          undefined,
          controller.signal,
        ).finally(stopProgress);
        if (disposed) return;
        setStartup({ stage: "正在加载材质图集…" });
        const image = await apiImage(
          `${atlas.amulet!.url.slice(4)}/atlas.png`,
          controller.signal,
        );
        const imageUrl = URL.createObjectURL(image);
        try {
          texture = await new THREE.TextureLoader().loadAsync(imageUrl);
        } finally {
          URL.revokeObjectURL(imageUrl);
        }
        if (disposed) {
          texture.dispose();
          return;
        }
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.colorSpace = atlas.amulet
          ? THREE.NoColorSpace
          : THREE.SRGBColorSpace;
        renderer = new THREE.WebGLRenderer({
          antialias: false,
          powerPreference: "default",
        });
        renderer.localClippingEnabled = true;
        renderer.setClearColor(0x91b9cf);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.domElement.tabIndex = 0;
        renderer.domElement.setAttribute("aria-label", "3D 方块编辑画布");
        container.append(renderer.domElement);
        const world = new THREE.Scene();
        world.background = new THREE.Color(0x91b9cf);
        const ambient = new THREE.AmbientLight(0xffffff, 1.5),
          sun = new THREE.DirectionalLight(0xffffff, 1.3);
        sun.position.set(80, 150, 40);
        world.add(ambient, sun);
        const spawn =
          props.summary.dimension === 0 ? live.current.summary.spawn : null;
        const initialX = savedCamera.current
          ? live.current.camera.x
          : (spawn?.x ?? live.current.camera.x);
        const initialZ = savedCamera.current
          ? live.current.camera.z
          : (spawn?.z ?? live.current.camera.z);
        let ox = Math.floor(initialX / 256) * 256,
          oz = Math.floor(initialZ / 256) * 256;
        cam = new SceneCamera(
          renderer.domElement,
          initialX - ox,
          initialZ - oz,
          setSpeed,
        );
        controls.current = cam;
        if (!savedCamera.current) {
          const y = initialCameraHeight(props.summary.dimension, spawn?.y);
          cam.camera.position.set(initialX - ox + 0.5, y, initialZ - oz + 0.5);
          cam.orbit.target.set(initialX - ox + 0.5, y, initialZ - oz - 31.5);
          cam.camera.lookAt(cam.orbit.target);
          cam.setMode("fly");
        }
        if (savedCamera.current?.dimension === props.summary.dimension) {
          cam.camera.position
            .copy(savedCamera.current.position)
            .sub(new THREE.Vector3(ox, 0, oz));
          cam.orbit.target
            .copy(savedCamera.current.target)
            .sub(new THREE.Vector3(ox, 0, oz));
          cam.orbit.update();
        }
        cleanup.push(() => {
          if (cam)
            savedCamera.current = {
              dimension: props.summary.dimension,
              position: cam.camera.position
                .clone()
                .add(new THREE.Vector3(ox, 0, oz)),
              target: cam
                .target()
                .clone()
                .add(new THREE.Vector3(ox, 0, oz)),
            };
        });
        data = new SceneLoader(
          props.id,
          live.current.summary.revision,
          props.summary.dimension,
          atlas,
          texture,
          (s) => live.current.onStatus(s),
          (s) => {
            live.current.onError(s);
            if (s.startsWith("区块网格线程失败")) setFailure(s);
          },
        );
        loader.current = data;
        setStartup({ stage: "正在预加载区块…", unit: "chunks" });
        data.setOrigin(ox, oz);
        const chunkHighlight = new SceneChunkSelection();
        world.add(chunkHighlight.root);
        cleanup.push(() => chunkHighlight.dispose());
        world.add(data.root);
        const entities = new SceneEntities(
          props.id,
          props.summary.dimension,
          setEntityNotice,
          atlas.amulet,
        );
        world.add(entities.root);
        cleanup.push(() => entities.dispose());
        const entityOutline = new THREE.Box3Helper(new THREE.Box3(), 0xffdc72);
        entityOutline.visible = false;
        world.add(entityOutline);
        cleanup.push(() => entityOutline.dispose());
        const markerCanvas = document.createElement("canvas");
        markerCanvas.className = "scene-marker-canvas";
        markerCanvas.setAttribute("aria-hidden", "true");
        container.append(markerCanvas);
        const markers = new SceneMarkers(
          markerCanvas,
          props.id,
          props.summary.dimension,
          setMarkerNotice,
        );
        cleanup.push(() => markers.dispose());
        const preview = new ScenePastePreview(
          atlas,
          texture,
          (ready, error) => {
            if (!disposed) {
              setPasteReady(ready);
              setPasteError(error ?? "");
            }
          },
        );
        pastePreview.current = preview;
        world.add(preview.root);
        cleanup.push(() => {
          preview.dispose();
          if (pastePreview.current === preview) pastePreview.current = null;
        });
        if (settings.current.pasteOpen)
          void preview.load(
            props.id,
            live.current.summary.revision,
            settings.current.pasteTransform,
            false,
            positionRef.current,
            settings.current.radius,
            settings.current.pasteOrigin,
          );
        const gizmo = new SceneGizmo(
          cam.camera,
          renderer.domElement,
          world,
          (origin, rotation) => {
            setPasteOrigin(origin);
            setPasteTransform((previous) =>
              previous.rotation.every((v, i) => v === rotation[i])
                ? previous
                : { ...previous, rotation },
            );
          },
          (active) => {
            if (!cam) return;
            cam.release();
            cam.blocked =
              active ||
              live.current.disabled ||
              settings.current.busy ||
              settings.current.modal;
            cam.orbit.enabled = cam.mode === "orbit" && !cam.blocked;
          },
        );
        cleanup.push(() => gizmo.dispose());
        locate.current = (x, y, z) => {
          if (!cam || !data) return;
          cam.moveTo(x - ox, y, z - oz);
          const next = { x, y, z };
          positionRef.current = next;
          setPosition(next);
        };
        focusSelection.current = () => {
          const points = settings.current.corners;
          if (!cam || !points.length) return;
          const b = selectionBounds(
            points[0],
            points[1] ?? points[0],
            settings.current.sphere,
          );
          const center = new THREE.Vector3(
            (b.low.x + b.high.x + 1) / 2 - ox,
            (b.low.y + b.high.y + 1) / 2,
            (b.low.z + b.high.z + 1) / 2 - oz,
          );
          const extent = Math.max(
            b.high.x - b.low.x + 1,
            b.high.y - b.low.y + 1,
            b.high.z - b.low.z + 1,
          );
          const distance = Math.max(
            8,
            extent / Math.tan(THREE.MathUtils.degToRad(cam.camera.fov / 2)),
          );
          const direction = cam.camera.getWorldDirection(new THREE.Vector3());
          cam.camera.position
            .copy(center)
            .addScaledVector(direction, -distance);
          if (cam.mode === "top") cam.fitTop(extent * 0.8);
          cam.orbit.target.copy(center);
          cam.camera.updateMatrixWorld();
        };
        const ground = new SceneGround();
        world.add(ground.mesh);
        cleanup.push(() => ground.dispose());
        const chunkGrid = new THREE.GridHelper(1024, 64, 0x9daeb4, 0x9daeb4);
        (chunkGrid.material as THREE.Material).transparent = true;
        (chunkGrid.material as THREE.Material).opacity = 0.3;
        (chunkGrid.material as THREE.Material).depthTest = false;
        chunkGrid.renderOrder = 5;
        world.add(chunkGrid);
        cleanup.push(() => {
          chunkGrid.geometry.dispose();
          (chunkGrid.material as THREE.Material).dispose();
        });
        const outlineMaterial = new THREE.LineBasicMaterial({
            color: 0xffffff,
            depthTest: false,
          }),
          selectMaterial = new THREE.LineBasicMaterial({
            color: 0xb6e99b,
            depthTest: false,
          });
        const cubeGeometry = new THREE.BoxGeometry(1.006, 1.006, 1.006),
          edgeGeometry = new THREE.EdgesGeometry(cubeGeometry);
        cubeGeometry.dispose();
        const outline = new THREE.LineSegments(edgeGeometry, outlineMaterial);
        outline.visible = false;
        outline.renderOrder = 10;
        world.add(outline);
        const boxOutline = new THREE.LineSegments(edgeGeometry, selectMaterial);
        boxOutline.visible = false;
        boxOutline.renderOrder = 11;
        world.add(boxOutline);
        const cornerDots = [0xa0d791, 0x9696d7].map((color) => {
          const dot = new THREE.Mesh(
            new THREE.BoxGeometry(0.32, 0.32, 0.32),
            new THREE.MeshBasicMaterial({ color, depthTest: false }),
          );
          dot.renderOrder = 14;
          dot.visible = false;
          world.add(dot);
          cleanup.push(() => {
            dot.geometry.dispose();
            dot.material.dispose();
          });
          return dot;
        });
        const surfaceMaterial = selectionMaterial();
        const surfaceBox = new THREE.BoxGeometry(1, 1, 1);
        const surfaceSphere = new THREE.SphereGeometry(1, 40, 24);
        const selectionSurface = new THREE.Mesh<THREE.BufferGeometry>(
          surfaceBox,
          surfaceMaterial,
        );
        selectionSurface.visible = false;
        world.add(selectionSurface);
        cleanup.push(() => {
          surfaceBox.dispose();
          surfaceSphere.dispose();
          surfaceMaterial.dispose();
        });
        const ray = new THREE.Raycaster(),
          pointer = new THREE.Vector2();
        let lastPointer: MouseEvent | null = null;
        let down: { x: number; y: number; button: number } | null = null,
          lastHit: Hit | null = null;
        let drag: {
          axis: "x" | "y" | "z";
          upper: boolean;
          plane: THREE.Plane;
          start: THREE.Vector3;
          value: number;
          corners: VoxelPoint[];
          sphere: boolean;
          pointerId: number;
          screenStart: { x: number; y: number };
          screenDirection: THREE.Vector2;
          unitsPerPixel: number;
        } | null = null;
        let creating: {
          pointerId: number;
          start: VoxelPoint;
          screen: { x: number; y: number };
          moved: boolean;
        } | null = null;
        let chunkDrag: {
          pointerId: number;
          start: Point;
          end: Point;
          operation: "replace" | "invert";
        } | null = null;
        const finishDrag = () => {
          const pointerId =
            drag?.pointerId ?? creating?.pointerId ?? chunkDrag?.pointerId;
          chunkDrag = null;
          creating = null;
          drag = null;
          down = null;
          if (
            pointerId !== undefined &&
            renderer?.domElement.hasPointerCapture(pointerId)
          )
            renderer.domElement.releasePointerCapture(pointerId);
          if (cam)
            cam.blocked =
              live.current.disabled ||
              settings.current.busy ||
              settings.current.modal;
        };
        const windowUp = (event: PointerEvent) => {
          if (
            drag?.pointerId === event.pointerId ||
            creating?.pointerId === event.pointerId ||
            chunkDrag?.pointerId === event.pointerId
          )
            finishDrag();
        };
        const visibility = () => {
          if (document.hidden) finishDrag();
        };
        window.addEventListener("pointerup", windowUp);
        window.addEventListener("blur", finishDrag);
        document.addEventListener("visibilitychange", visibility);
        cleanup.push(() => {
          window.removeEventListener("pointerup", windowUp);
          window.removeEventListener("blur", finishDrag);
          document.removeEventListener("visibilitychange", visibility);
          finishDrag();
        });
        const updateRay = (event: MouseEvent) => {
          lastPointer = event;
          const rect = renderer!.domElement.getBoundingClientRect();
          pointer.set(
            document.pointerLockElement === renderer!.domElement
              ? 0
              : ((event.clientX - rect.left) / rect.width) * 2 - 1,
            document.pointerLockElement === renderer!.domElement
              ? 0
              : (-(event.clientY - rect.top) / rect.height) * 2 + 1,
          );
          ray.setFromCamera(pointer, cam!.viewCamera);
        };
        const pickEntity = (event: MouseEvent) => {
          updateRay(event);
          const terrain = ray
            .intersectObjects(data!.root.children, true)
            .find(
              (hit) =>
                hit.object.userData.voxel &&
                hit.object.visible &&
                (!settings.current.cut ||
                  hit.point.y <= settings.current.ceiling + 1),
            );
          return entities.pick(ray, terrain?.distance);
        };
        const pick = (event: MouseEvent): Hit | null => {
          if (!renderer || !cam || !data) return null;
          const rect = renderer.domElement.getBoundingClientRect();
          pointer.set(
            document.pointerLockElement === renderer!.domElement
              ? 0
              : ((event.clientX - rect.left) / rect.width) * 2 - 1,
            document.pointerLockElement === renderer!.domElement
              ? 0
              : (-(event.clientY - rect.top) / rect.height) * 2 + 1,
          );
          ray.setFromCamera(pointer, cam.viewCamera);
          lastPointer = event;
          if (
            cam.looking &&
            settings.current.tool === "select" &&
            !settings.current.pasteOpen
          ) {
            const p = ray.ray.at(
              settings.current.selectionDistance,
              new THREE.Vector3(),
            );
            const point = {
              x: Math.floor(p.x + ox),
              y: Math.floor(p.y),
              z: Math.floor(p.z + oz),
            };
            return point.y >= -2048 && point.y <= 2047
              ? { point, adjacent: { ...point } }
              : null;
          }
          const intersection = ray
            .intersectObjects(data.root.children, true)
            .find(
              (i) =>
                i.object.userData.voxel &&
                i.object.visible &&
                i.face &&
                (!settings.current.cut ||
                  i.point.y <= settings.current.ceiling + 1),
            );
          if (!intersection?.face) {
            const s = settings.current;
            if (s.tool === "browse") return null;
            const position = ray.ray.intersectPlane(
              new THREE.Plane(new THREE.Vector3(0, 1, 0), -s.planeY),
              new THREE.Vector3(),
            );
            if (
              !position ||
              Math.hypot(
                position.x - cam.camera.position.x,
                position.z - cam.camera.position.z,
              ) >
                (s.radius + 1) * 32
            )
              return null;
            const adjacent = {
              x: Math.floor(position.x + ox),
              y: s.planeY,
              z: Math.floor(position.z + oz),
            };

            return {
              point: {
                ...adjacent,
                y: s.planeY,
              },
              adjacent,
            };
          }
          const normal = intersection.face.normal
              .clone()
              .transformDirection(intersection.object.matrixWorld),
            inside = intersection.point.clone().addScaledVector(normal, -0.002);
          // Partial block surfaces can lie inside a cell; placement follows the face's dominant axis.
          const point = {
            x: Math.floor(inside.x + ox),
            y: Math.floor(inside.y),
            z: Math.floor(inside.z + oz),
          };
          const abs = [
              Math.abs(normal.x),
              Math.abs(normal.y),
              Math.abs(normal.z),
            ],
            axis = abs.indexOf(Math.max(...abs));
          const adjacent = { ...point };
          if (axis === 0) adjacent.x += Math.sign(normal.x);
          if (axis === 1) adjacent.y += Math.sign(normal.y);
          if (axis === 2) adjacent.z += Math.sign(normal.z);
          return {
            point,
            adjacent,
            name: data.blockName(point.x, point.y, point.z),
          };
        };
        const listen = (type: string, fn: EventListener) => {
          renderer!.domElement.addEventListener(type, fn);
          cleanup.push(() =>
            renderer?.domElement.removeEventListener(type, fn),
          );
        };
        listen("contextmenu", (e) => e.preventDefault());
        listen("pointerdown", ((e: PointerEvent) => {
          down = { x: e.clientX, y: e.clientY, button: e.button };
          if (
            e.button === 0 &&
            live.current.chunkSelecting &&
            !live.current.disabled &&
            live.current.ready &&
            !settings.current.busy &&
            !settings.current.modal &&
            !settings.current.pasteOpen
          ) {
            const h = pick(e);
            if (h) {
              const point = {
                x: Math.floor(h.point.x / 16),
                z: Math.floor(h.point.z / 16),
              };
              chunkDrag = {
                pointerId: e.pointerId,
                start: point,
                end: point,
                operation: e.ctrlKey || e.metaKey ? "invert" : "replace",
              };
              cam!.blocked = true;
              renderer!.domElement.setPointerCapture(e.pointerId);
            }
            return;
          }
          if (
            settings.current.pasteOpen &&
            gizmo.controls.axis &&
            e.button === 0
          ) {
            down = null;
            return;
          }
          if (
            e.button === 0 &&
            document.pointerLockElement === renderer!.domElement &&
            settings.current.tool === "select" &&
            !settings.current.pasteOpen &&
            !settings.current.modal &&
            !settings.current.busy &&
            !live.current.disabled &&
            live.current.ready
          ) {
            down = null;
            const h = pick(e);
            if (h) action.current(h);
            return;
          }
          if (
            e.button === 0 &&
            settings.current.tool === "select" &&
            !settings.current.pasteOpen &&
            !live.current.disabled &&
            !settings.current.busy &&
            !settings.current.modal &&
            live.current.ready
          ) {
            updateRay(e);
            const existing =
              settings.current.corners.length === 2 &&
              selectionSurface.visible &&
              ray.intersectObject(selectionSurface).length > 0;
            if (!existing) {
              const h = pick(e);
              if (h) {
                creating = {
                  pointerId: e.pointerId,
                  start: h.point,
                  screen: { x: e.clientX, y: e.clientY },
                  moved: false,
                };
                renderer!.domElement.setPointerCapture(e.pointerId);
              }
              return;
            }
          }
          if (
            e.button !== 0 ||
            settings.current.corners.length !== 2 ||
            settings.current.tool === "browse" ||
            settings.current.pasteOpen ||
            live.current.disabled ||
            settings.current.busy ||
            settings.current.modal
          )
            return;
          updateRay(e);
          if (!selectionSurface.visible) return;
          const face = ray.intersectObject(selectionSurface)[0];
          if (!face?.face) return;
          const normal = face.face.normal;
          const axis: "x" | "y" | "z" =
            Math.abs(normal.y) > 0.7
              ? "y"
              : Math.abs(normal.x) > Math.abs(normal.z)
                ? "x"
                : "z";
          const upper = normal[axis] > 0;
          const vector = new THREE.Vector3();
          vector[axis] = 1;
          const view = cam!.camera.getWorldDirection(new THREE.Vector3());
          if (!settings.current.sphere)
            view.addScaledVector(vector, -view.dot(vector));
          if (view.lengthSq() < 0.001) return;
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
            view.normalize(),
            face.point,
          );
          const b = selectionBounds(
            settings.current.corners[0],
            settings.current.corners[1],
            settings.current.sphere,
          );
          const rect = renderer!.domElement.getBoundingClientRect();
          const center = new THREE.Vector3(
            settings.current.corners[0].x - ox + 0.5,
            settings.current.corners[0].y + 0.5,
            settings.current.corners[0].z - oz + 0.5,
          );
          const projected = center.clone().project(cam!.viewCamera);
          const direction = new THREE.Vector2(
            e.clientX - (rect.left + ((projected.x + 1) * rect.width) / 2),
            e.clientY - (rect.top + ((1 - projected.y) * rect.height) / 2),
          );
          if (direction.lengthSq() < 16) direction.set(1, 0);
          direction.normalize();
          drag = {
            axis,
            upper,
            plane,
            start: face.point.clone(),
            value: (upper ? b.high : b.low)[axis],
            corners: settings.current.corners.map((p) => ({ ...p })),
            sphere: settings.current.sphere,
            pointerId: e.pointerId,
            screenStart: { x: e.clientX, y: e.clientY },
            screenDirection: direction,
            unitsPerPixel: cam!.unitsPerPixel(
              Math.max(1, center.distanceTo(cam!.camera.position)),
              rect.height,
            ),
          };
          cam!.blocked = true;
          cam!.release();
          renderer!.domElement.setPointerCapture(e.pointerId);
        }) as EventListener);
        listen("pointermove", ((e: PointerEvent) => {
          if (chunkDrag) {
            if (!(e.buttons & 1)) {
              finishDrag();
              return;
            }
            const h = pick(e);
            if (h)
              chunkDrag.end = {
                x: Math.floor(h.point.x / 16),
                z: Math.floor(h.point.z / 16),
              };
            return;
          }
          const rect = renderer!.domElement.getBoundingClientRect();
          const group = markers.hit(
            e.clientX - rect.left,
            e.clientY - rect.top,
          );
          const entity =
            settings.current.tool === "browse" && !settings.current.pasteOpen
              ? pickEntity(e)
              : null;
          renderer!.domElement.title = group
            ? group.members.length > 1
              ? `${group.members.length} 个对象 · 双击选择`
              : `${group.members[0].label} · X ${group.members[0].x} · Y ${group.members[0].y ?? "—"} · Z ${group.members[0].z} · 双击查看`
            : entity
              ? `${entity.marker.label} · 双击编辑实体 NBT`
              : "";
          if (creating) {
            if (!(e.buttons & 1)) {
              finishDrag();
              return;
            }
            if (
              Math.hypot(
                e.clientX - creating.screen.x,
                e.clientY - creating.screen.y,
              ) > 4
            ) {
              const h = pick(e);
              if (h) {
                creating.moved = true;
                setCorners(
                  live.current.voxelShape === "single"
                    ? [h.point, h.point]
                    : [creating.start, h.point],
                );
                cam!.blocked = true;
              }
            }
            return;
          }
          if (drag) {
            if (!(e.buttons & 1)) {
              finishDrag();
              return;
            }
            if (drag.sphere) {
              const delta =
                ((e.clientX - drag.screenStart.x) * drag.screenDirection.x +
                  (e.clientY - drag.screenStart.y) * drag.screenDirection.y) *
                drag.unitsPerPixel;
              setCorners(
                sphereCorners(
                  drag.corners[0],
                  Math.min(
                    2047,
                    Math.max(
                      0,
                      Math.round(
                        sphereRadius(drag.corners[0], drag.corners[1]) + delta,
                      ),
                    ),
                  ),
                ),
              );
              return;
            }
            updateRay(e);
            const position = ray.ray.intersectPlane(
              drag.plane,
              new THREE.Vector3(),
            );
            if (position) {
              const value = Math.round(
                drag.value + position[drag.axis] - drag.start[drag.axis],
              );
              const limit =
                drag.axis === "y" ? [-2048, 2047] : [-(2 ** 35), 2 ** 35 - 1];
              setCorners(
                stretchSelection(
                  drag.corners,
                  drag.sphere,
                  drag.axis,
                  drag.upper,
                  Math.max(limit[0], Math.min(limit[1], value)),
                ),
              );
            }
            return;
          }
          lastHit = entity ? null : pick(e);
          setHit(lastHit);
          live.current.onHover(
            entity
              ? {
                  x: Math.floor(entity.marker.x / 16),
                  z: Math.floor(entity.marker.z / 16),
                }
              : lastHit
                ? {
                    x: Math.floor(lastHit.point.x / 16),
                    z: Math.floor(lastHit.point.z / 16),
                  }
                : null,
          );
        }) as EventListener);
        listen("pointerleave", () => {
          lastPointer = null;
          lastHit = null;
          setHit(null);
        });
        listen("pointerup", ((e: PointerEvent) => {
          if (chunkDrag?.pointerId === e.pointerId) {
            const selection = chunkDrag;
            const h = pick(e);
            if (h)
              selection.end = {
                x: Math.floor(h.point.x / 16),
                z: Math.floor(h.point.z / 16),
              };
            finishDrag();
            selectChunks.current(
              selection.start,
              selection.end,
              selection.operation,
            );
            return;
          }
          const start = down;
          down = null;
          if (
            start?.button === 2 &&
            e.shiftKey &&
            Math.hypot(e.clientX - start.x, e.clientY - start.y) <= 5 &&
            !live.current.disabled &&
            !settings.current.busy &&
            !settings.current.modal
          ) {
            const rect = container.getBoundingClientRect();
            const entity =
              settings.current.tool === "browse" ? pickEntity(e) : null;
            setMenu({
              hit: entity ? null : pick(e),
              entity: entity?.marker,
              x: Math.max(0, Math.min(e.clientX - rect.left, rect.width - 190)),
              y: Math.max(0, Math.min(e.clientY - rect.top, rect.height - 310)),
            });
            return;
          }
          if (creating) {
            const selection = creating;
            finishDrag();
            if (
              !selection.moved &&
              !live.current.disabled &&
              !settings.current.busy &&
              !settings.current.modal &&
              live.current.ready
            ) {
              const h = pick(e);
              if (h) action.current(h);
            }
            return;
          }
          if (drag) {
            finishDrag();
            return;
          }
          if (
            !start ||
            start.button !== 0 ||
            Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5 ||
            live.current.disabled ||
            settings.current.busy
          )
            return;
          if (
            settings.current.tool === "browse" &&
            !settings.current.pasteOpen
          ) {
            const entity = pickEntity(e);
            setSelectedEntity(entity?.marker ?? null);
            if (entity) {
              setHit(null);
              return;
            }
          }
          const h = pick(e);
          if (!h) return;
          if (settings.current.pasteOpen) {
            setPasteOrigin(snapPosition(h.adjacent, settings.current.snap));
            return;
          }
          if (
            settings.current.tool === "browse" ||
            settings.current.tool === "fill"
          )
            return;
          action.current(h);
        }) as EventListener);
        listen("pointercancel", finishDrag);
        listen("lostpointercapture", () => {
          if (drag) finishDrag();
        });
        listen("blur", finishDrag);
        listen("keydown", ((event: KeyboardEvent) => {
          if (
            settings.current.busy ||
            live.current.disabled ||
            settings.current.modal
          )
            return;
          if (matchesShortcut(event, "toggleView")) {
            event.preventDefault();
            const next =
              settings.current.mode === "top" ? perspectiveMode.current : "top";
            setMode(next);
            live.current.onView?.(next === "top" ? "2d" : "3d");
          }
          if (matchesShortcut(event, "focus")) {
            event.preventDefault();
            focusSelection.current();
          }
          if (
            !settings.current.pasteOpen &&
            settings.current.tool === "select" &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.shiftKey &&
            (event.code === "KeyR" || event.code === "KeyF")
          ) {
            event.preventDefault();
            setSelectionDistance((value) =>
              Math.max(
                1,
                Math.min(1024, value + (event.code === "KeyR" ? 1 : -1)),
              ),
            );
          }
          if (matchesShortcut(event, "move")) {
            event.preventDefault();
            commands.current.move();
          }
          if (matchesShortcut(event, "deselect")) {
            event.preventDefault();
            setCorners([]);
          }
          if (matchesShortcut(event, "tools")) {
            event.preventDefault();
            setPropertiesOpen((v) => !v);
          }
          if (matchesShortcut(event, "copy")) {
            event.preventDefault();
            commands.current.copy();
          }
          if (matchesShortcut(event, "paste")) {
            event.preventDefault();
            commands.current.paste();
          }
          if (settings.current.pasteOpen) {
            if (event.code === "Enter") {
              event.preventDefault();
              commands.current.commit();
            }
            if (
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !event.shiftKey
            ) {
              if (event.code === "KeyG") setGizmoMode("translate");
              if (event.code === "KeyR") setGizmoMode("rotate");
            }
            if (event.code === "Escape") {
              gizmo.controls.reset();
              setPasteOpen(false);
            }
          } else if (
            matchesShortcut(event, "delete") &&
            !live.current.chunkSelecting &&
            settings.current.corners.length === 2
          ) {
            event.preventDefault();
            setConfirm("minecraft:air");
          }
        }) as EventListener);
        listen("dblclick", ((event: MouseEvent) => {
          if (
            live.current.disabled ||
            settings.current.busy ||
            settings.current.modal ||
            settings.current.pasteOpen ||
            settings.current.tool !== "browse"
          )
            return;
          const rect = renderer!.domElement.getBoundingClientRect();
          const entity = pickEntity(event);
          if (entity) {
            setSelectedEntity(entity.marker);
            if (entity.marker.object_ref)
              live.current.onObject(
                entity.marker.object_ref,
                entity.marker.label,
              );
            return;
          }
          const group = markers.hit(
            event.clientX - rect.left,
            event.clientY - rect.top,
          );
          if (group) {
            if (group.members.length > 1) {
              setMarkerCluster(group.members);
              setMarkerQuery("");
              setMarkerPage(0);
            } else {
              const marker = group.members[0];
              if (marker.object_ref)
                live.current.onObject(marker.object_ref, marker.label);
            }
            return;
          }
          const h = pick(event);
          if (h) nbtAction.current(h);
        }) as EventListener);
        let last = performance.now(),
          accum = 0,
          count = 0,
          average = 16,
          pixelRatio = 1,
          lastQuality = "",
          lastCameraSend = 0,
          lastPositionSend = 0,
          lastCenter = { x: live.current.camera.x, z: live.current.camera.z };
        observer = new ResizeObserver(() => {
          if (!renderer || !cam) return;
          const w = Math.max(1, container.clientWidth),
            h = Math.max(1, container.clientHeight);
          renderer.setSize(w, h, false);
          cam.resize(w, h);
          live.current.onSize?.({ width: w, height: h });
        });
        observer.observe(container);
        selectVisible.current = (operation) => {
          if (!cam) return;
          const x = cam.camera.position.x + ox,
            z = cam.camera.position.z + oz;
          const halfX =
            cam.mode === "top"
              ? cam.topCamera.right
              : settings.current.radius * 16;
          const halfZ =
            cam.mode === "top"
              ? cam.topCamera.top
              : settings.current.radius * 16;
          selectChunks.current(
            {
              x: Math.floor((x - halfX) / 16),
              z: Math.floor((z - halfZ) / 16),
            },
            {
              x: Math.floor((x + halfX) / 16),
              z: Math.floor((z + halfZ) / 16),
            },
            operation,
            "rectangle",
          );
        };
        let lost = false;
        const contextLost = (e: Event) => {
          e.preventDefault();
          lost = true;
          setFailure("显卡上下文已丢失，当前修改已保留。请重新加载场景。");
          cam?.release();
        };
        listen("webglcontextlost", contextLost);
        const animate = (now: number) => {
          if (disposed || lost || !renderer || !cam || !data) return;
          const s = settings.current,
            p = live.current,
            dt = Math.min((now - last) / 1000, 0.1);
          last = now;
          if (p.active === false || document.hidden) {
            cam.release();
            frame = requestAnimationFrame(animate);
            return;
          }
          if (
            (drag || creating || chunkDrag) &&
            (p.disabled || s.busy || s.modal || cam.mode !== s.mode)
          )
            finishDrag();
          cam.blocked =
            preloading ||
            p.disabled ||
            s.busy ||
            s.modal ||
            !!drag ||
            !!creating ||
            !!chunkDrag ||
            gizmo.controls.dragging;
          if (compass.current) {
            const view = cam.camera.getWorldDirection(new THREE.Vector3());
            const heading = cam.angles().yaw - 180;
            compass.current.style.setProperty("--heading", `${heading}deg`);
            const label = compass.current.querySelector("span");
            if (label)
              label.textContent =
                cam.mode !== "top" && Math.abs(view.y) > 0.95
                  ? view.y > 0
                    ? "上 +Y"
                    : "下 −Y"
                  : ["北 −Z", "东 +X", "南 +Z", "西 −X"][
                      Math.round((heading + 360) / 90) % 4
                    ];
          }
          cam.setMode(s.mode);
          cam.setSpeed(s.speed);
          cam.tick(dt, s.tool !== "browse" || s.pasteOpen);
          container.dataset.looking = cam.looking ? "true" : "false";
          preview.root.visible = s.pasteOpen;
          if (document.activeElement !== renderer.domElement) cam.release();
          let target = cam.target();
          const wx = target.x + ox,
            wz = target.z + oz;
          if (Math.abs(target.x) > 512 || Math.abs(target.z) > 512) {
            const nx = Math.floor(wx / 256) * 256,
              nz = Math.floor(wz / 256) * 256;
            cam.rebase(nx - ox, nz - oz);
            ox = nx;
            oz = nz;
            data.setOrigin(ox, oz);
            target = cam.target();
          }
          preview.position(s.pasteOrigin, ox, oz);
          if (s.pasteOpen && p.ready)
            preview.updateView(
              p.id,
              p.summary.revision,
              s.pasteTransform,
              s.skipUnsupported,
              {
                x: wx,
                y: cam.camera.position.y,
                z: wz,
              },
              s.radius,
              s.pasteOrigin,
            );
          gizmo.controls.camera = cam.viewCamera;
          gizmo.sync(
            s.pasteOrigin,
            s.pasteTransform,
            ox,
            oz,
            s.pasteOpen,
            s.gizmoMode,
            s.snap,
            !p.disabled && !s.busy && !s.modal,
          );
          const eye = cam.camera.position;
          const currentPosition = {
            x: Math.round((eye.x + ox) * 100) / 100,
            y: Math.round(eye.y * 100) / 100,
            z: Math.round((eye.z + oz) * 100) / 100,
          };
          if (now - lastPositionSend > 100) {
            lastPositionSend = now;
            const angles = cam.angles();
            const rounded = {
              yaw: Math.round(angles.yaw * 100) / 100,
              pitch: Math.round(angles.pitch * 100) / 100,
            };
            if (
              rounded.yaw !== viewAnglesRef.current.yaw ||
              rounded.pitch !== viewAnglesRef.current.pitch
            ) {
              viewAnglesRef.current = rounded;
              setViewAngles(rounded);
            }
            if (
              currentPosition.x !== positionRef.current.x ||
              currentPosition.y !== positionRef.current.y ||
              currentPosition.z !== positionRef.current.z
            ) {
              positionRef.current = currentPosition;
              setPosition(currentPosition);
            }
          }
          data.setCeiling(s.cut ? s.ceiling : 2047);
          data.setDisplayKinds(
            s.displayKinds ?? ["terrain", "air", "unreadable"],
          );
          if (p.ready) {
            if (preloading) {
              preloadView ??= { x: wx, z: wz, radius: s.radius };
              data.update(preloadView.x, preloadView.z, preloadView.radius);
            } else data.update(wx, wz, s.radius);
          }
          if (preloading && p.ready) {
            const progress = data.preloadProgress;
            if (progress.failed) {
              preloading = false;
              setStartup(null);
              setFailure(
                "首批区块未能完整加载，请检查错误提示后重新加载场景。",
              );
            } else if (
              progress.total > 0 &&
              progress.loaded === progress.total
            ) {
              preloading = false;
              setStartup(null);
            } else {
              const key = `${progress.loaded}/${progress.total}`;
              if (key !== progressKey) {
                progressKey = key;
                setStartup({
                  stage: "正在预加载区块…",
                  ...progress,
                  unit: "chunks",
                });
              }
            }
          }
          data.setBrightness(s.brightness);
          chunkHighlight.update(
            p.selectedChunks ?? emptyChunkSelection,
            p.summary.dimension,
            wx,
            wz,
            s.radius,
            ox,
            oz,
          );
          entities.update(
            {
              revision: p.summary.revision,
              ready: p.ready,
              x: wx,
              z: wz,
              radius: s.radius,
            },
            ox,
            oz,
            s.cut ? s.ceiling : 2047,
          );
          const selectedBox = entitySelection.current
            ? entities.bounds(entitySelection.current.id)
            : null;
          entityOutline.visible =
            !!selectedBox && s.tool === "browse" && !s.pasteOpen;
          if (selectedBox) entityOutline.box.copy(selectedBox);
          markers.update({
            revision: p.summary.revision,
            ready: p.ready,
            x: wx,
            z: wz,
            radius: s.radius,
            overlays: p.overlays,
          });
          ground.update(wx, wz, s.radius, p.summary.dimension, ox, oz);
          chunkGrid.visible = !!p.grid || !!p.chunkSelecting;
          chunkGrid.position.set(
            Math.floor(wx / 16) * 16 - ox,
            s.planeY,
            Math.floor(wz / 16) * 16 - oz,
          );
          ambient.intensity = 0.25 + s.brightness * 2.5;
          accum += dt * 1000;
          count++;
          if (count >= 90) {
            average = accum / count;
            accum = 0;
            count = 0;
            if (s.quality === "auto")
              pixelRatio =
                average > 30
                  ? Math.max(0.6, pixelRatio - 0.15)
                  : average < 18
                    ? Math.min(1.5, pixelRatio + 0.1)
                    : pixelRatio;
          }
          if (lastQuality !== s.quality) {
            lastQuality = s.quality;
            const cores = navigator.hardwareConcurrency || 2;
            pixelRatio =
              s.quality === "low"
                ? 1
                : s.quality === "high"
                  ? 1.5
                  : s.quality === "standard"
                    ? 1.25
                    : cores <= 4
                      ? 1
                      : 1.25;
            data.setBudget(
              s.quality === "low" ? 128 : s.quality === "high" ? 512 : 256,
            );
          }
          const ratio = Math.min(window.devicePixelRatio || 1, pixelRatio);
          if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
          if (
            cam.looking &&
            lastPointer &&
            s.tool === "select" &&
            !s.pasteOpen
          ) {
            const fresh = pick(lastPointer);
            if (
              fresh &&
              (!lastHit ||
                fresh.point.x !== lastHit.point.x ||
                fresh.point.y !== lastHit.point.y ||
                fresh.point.z !== lastHit.point.z)
            ) {
              lastHit = fresh;
              setHit(fresh);
            }
          }
          if (lastHit) {
            outline.visible = true;
            outline.position.set(
              lastHit.point.x - ox + 0.5,
              lastHit.point.y + 0.5,
              lastHit.point.z - oz + 0.5,
            );
          } else outline.visible = false;
          cornerDots.forEach((dot, index) => {
            dot.visible =
              !!s.corners[index] && !s.pasteOpen && !p.selectedChunks?.size;
            if (s.corners[index])
              dot.position.set(
                s.corners[index].x - ox + 0.5,
                s.corners[index].y + 0.5,
                s.corners[index].z - oz + 0.5,
              );
          });
          if (s.corners.length && !s.pasteOpen && !p.selectedChunks?.size) {
            const bounds = selectionBounds(
              s.corners[0],
              s.corners[1] ?? s.corners[0],
              s.sphere,
            );
            boxOutline.visible = true;
            boxOutline.position.set(
              (bounds.low.x + bounds.high.x + 1) / 2 - ox,
              (bounds.low.y + bounds.high.y + 1) / 2,
              (bounds.low.z + bounds.high.z + 1) / 2 - oz,
            );
            boxOutline.scale.set(
              bounds.high.x - bounds.low.x + 1,
              bounds.high.y - bounds.low.y + 1,
              bounds.high.z - bounds.low.z + 1,
            );
            selectionSurface.geometry = s.sphere ? surfaceSphere : surfaceBox;
            selectionSurface.visible = s.corners.length === 2;
            selectionSurface.position.copy(boxOutline.position);
            selectionSurface.scale.copy(boxOutline.scale);
            if (s.sphere) {
              const r = sphereRadius(s.corners[0], s.corners[1]) + 0.5;
              selectionSurface.scale.setScalar(r);
              boxOutline.visible = false;
            }
          } else {
            boxOutline.visible = false;
            selectionSurface.visible = false;
          }
          if (chunkDrag) {
            const area = chunkBounds(
              chunkDrag.start,
              chunkDrag.end,
              p.chunkShape ?? "rectangle",
            );
            const [minY, maxY] = dimensionHeight(p.summary.dimension);
            boxOutline.visible = true;
            boxOutline.position.set(
              (area.min_x + area.max_x + 1) * 8 - ox,
              (minY + maxY + 1) / 2,
              (area.min_z + area.max_z + 1) * 8 - oz,
            );
            boxOutline.scale.set(
              (area.max_x - area.min_x + 1) * 16,
              maxY - minY + 1,
              (area.max_z - area.min_z + 1) * 16,
            );
            selectionSurface.geometry = surfaceBox;
            selectionSurface.visible = true;
            selectionSurface.position.copy(boxOutline.position);
            selectionSurface.scale.copy(boxOutline.scale);
          }
          const highlightNormal: THREE.Vector3 =
            surfaceMaterial.userData.highlightNormal.value;
          highlightNormal.set(0, 0, 0);
          const canResize =
            selectionSurface.visible &&
            s.corners.length === 2 &&
            s.tool !== "browse" &&
            !s.pasteOpen &&
            !s.busy &&
            !s.modal &&
            !live.current.disabled &&
            live.current.ready &&
            !live.current.chunkSelecting &&
            !creating &&
            !chunkDrag &&
            !cam.looking;
          if (canResize && drag) {
            highlightNormal[drag.axis] = drag.upper ? 1 : -1;
          } else if (canResize && lastPointer) {
            selectionSurface.updateMatrixWorld(true);
            updateRay(lastPointer);
            const face = ray.intersectObject(selectionSurface)[0]?.face;
            if (face) highlightNormal.copy(face.normal).normalize();
          }
          renderer.domElement.style.cursor =
            highlightNormal.lengthSq() > 0 ? (drag ? "grabbing" : "grab") : "";
          if (
            now - lastCameraSend > 750 &&
            (Math.abs(wx - lastCenter.x) > 0.5 ||
              Math.abs(wz - lastCenter.z) > 0.5)
          ) {
            lastCameraSend = now;
            lastCenter = { x: wx, z: wz };
            p.onCamera({ ...p.camera, x: wx, z: wz });
          }
          renderer.render(world, cam.viewCamera);
          markers.draw(
            cam.viewCamera,
            ox,
            oz,
            container.clientWidth,
            container.clientHeight,
            p.summary.spawn,
            s.cut ? s.ceiling : 2047,
          );
          frame = requestAnimationFrame(animate);
        };
        frame = requestAnimationFrame(animate);
        cleanup.push(() => {
          edgeGeometry.dispose();
          outlineMaterial.dispose();
          selectMaterial.dispose();
        });
      } catch (error) {
        if (!disposed) setFailure(`3D 初始化失败：${(error as Error).message}`);
      }
    };
    void init();
    return () => {
      disposed = true;
      controller.abort();
      cancelAnimationFrame(frame);
      observer?.disconnect();
      cleanup.forEach((fn) => fn());
      cam?.dispose();
      data?.dispose();
      texture?.dispose();
      renderer?.dispose();
      renderer?.domElement.remove();
      controls.current = null;
      loader.current = null;
    };
  }, [props.id, props.summary.dimension, rendererAttempt]);
  return (
    <div
      className={`chunk-scene-3d scene-studio ${propertiesOpen ? "" : "scene-properties-hidden"}`}
    >
      <div className="scene-viewport" ref={host} />
      {startup && !failure && !props.indexError && props.active !== false && (
        <WorldLoading {...startup} />
      )}
      {entityNotice && (
        <div className="chunk-marker-notice" role="status">
          {entityNotice}
        </div>
      )}
      {markerNotice && (
        <div className="chunk-marker-notice" role="status">
          {markerNotice}
        </div>
      )}
      <Dialog
        open={!!markerCluster}
        onOpenChange={(open) => {
          if (!open) setMarkerCluster(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>选择地图对象</DialogTitle>
            <DialogDescription>选择对象查看或编辑 NBT。</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="搜索地图对象"
            placeholder="搜索名称或类型"
            value={markerQuery}
            onChange={(event) => {
              setMarkerQuery(event.target.value);
              setMarkerPage(0);
            }}
          />
          <div className="scene-marker-list">
            {markerItems
              .slice(markerPage * 100, (markerPage + 1) * 100)
              .map((marker) => (
                <Button
                  key={marker.id}
                  variant="ghost"
                  disabled={props.disabled || !marker.object_ref}
                  onClick={() => {
                    setMarkerCluster(null);
                    props.onObject(marker.object_ref!, marker.label);
                  }}
                >
                  {markerStyle(marker).icon && (
                    <img
                      src={markerStyle(marker).icon}
                      alt=""
                      width={20}
                      height={20}
                    />
                  )}
                  <span>
                    {marker.label}
                    <small>
                      {marker.object_type ?? marker.kind} · X {marker.x} · Y{" "}
                      {marker.y ?? "—"} · Z {marker.z}
                    </small>
                  </span>
                </Button>
              ))}
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              disabled={markerPage === 0}
              onClick={() => setMarkerPage((page) => page - 1)}
            >
              上一页
            </Button>
            <span>
              {markerPage + 1} /{" "}
              {Math.max(1, Math.ceil(markerItems.length / 100))}
            </span>
            <Button
              variant="secondary"
              disabled={(markerPage + 1) * 100 >= markerItems.length}
              onClick={() => setMarkerPage((page) => page + 1)}
            >
              下一页
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {pasteOpen && (
        <div
          className="scene-transform-tools"
          role="toolbar"
          aria-label="粘贴变换工具"
        >
          <Button
            variant={gizmoMode === "translate" ? "default" : "secondary"}
            onClick={() => setGizmoMode("translate")}
          >
            移动 · G
          </Button>
          <Button
            variant={gizmoMode === "rotate" ? "default" : "secondary"}
            onClick={() => setGizmoMode("rotate")}
          >
            旋转 · R
          </Button>
        </div>
      )}
      <div className="scene-topbar" aria-label="3D 视角控制">
        {" "}
        <label>
          视角
          <select
            value={mode}
            disabled={props.disabled || busy}
            onChange={(e) => {
              if (e.target.value === "map") props.onView?.("map");
              else changeMode(e.target.value as typeof mode);
            }}
          >
            <option value="orbit">环绕</option>
            <option value="fly">自由飞行</option>
            <option value="top">俯视 · {shortcutHint("toggleView")}</option>
            <option value="map">地图俯视</option>
          </select>
        </label>
        <label>
          速度
          <Input
            aria-label="飞行速度（格每秒）"
            type="number"
            min={FLIGHT_SPEED.min}
            max={FLIGHT_SPEED.max}
            step="any"
            value={Number((speed * FLIGHT_SPEED.base).toFixed(2))}
            disabled={props.disabled || busy}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (
                Number.isFinite(v) &&
                v >= FLIGHT_SPEED.min &&
                v <= FLIGHT_SPEED.max
              )
                setSpeed(v / FLIGHT_SPEED.base);
            }}
          />
          <small>格/秒</small>
        </label>{" "}
        <div className="scene-position" aria-label="当前视角坐标">
          <span>坐标</span>
          {(["x", "y", "z"] as const).map((axis) => (
            <label key={axis}>
              {axis.toUpperCase()}
              <SceneCoordinate
                value={position[axis]}
                axis={axis}
                disabled={props.disabled || busy || !!failure}
                onCommit={(value) => {
                  const next = { ...positionRef.current, [axis]: value };
                  locate.current(next.x, next.y, next.z);
                }}
              />
            </label>
          ))}
        </div>
        <ViewAngle
          label="偏航"
          value={viewAngles.yaw}
          disabled={props.disabled || busy || !!failure}
          onCommit={(value) => commitAngle("yaw", value)}
        />
        {mode !== "top" && (
          <ViewAngle
            label="俯仰"
            value={viewAngles.pitch}
            disabled={props.disabled || busy || !!failure}
            onCommit={(value) => commitAngle("pitch", value)}
          />
        )}
        <Button
          size="sm"
          variant="secondary"
          aria-label="聚焦选区"
          title={`聚焦选区 · ${shortcutHint("focus")}`}
          disabled={!corners.length || busy || props.disabled}
          onClick={() => focusSelection.current()}
        >
          <Focus />
        </Button>
        <Button
          size="sm"
          variant={viewOpen ? "default" : "secondary"}
          aria-label="视图设置"
          aria-expanded={viewOpen}
          disabled={busy || props.disabled}
          onClick={() => setViewOpen((v) => !v)}
        >
          <Settings2 />
        </Button>
        <Button
          size="sm"
          variant="secondary"
          aria-label="切换属性栏"
          aria-expanded={propertiesOpen}
          onClick={() => setPropertiesOpen((v) => !v)}
        >
          工具 · {shortcutHint("tools")}
        </Button>
      </div>
      <div className="scene-compass" ref={compass} aria-label="相机朝向">
        <div className="scene-compass-dial">
          <b>N</b>
          <i>↑</i>
        </div>
        <span>北 −Z</span>
      </div>
      <aside className="scene-view-settings" hidden={!viewOpen}>
        <header>
          <strong>视图设置</strong>
          <Button
            size="icon"
            variant="ghost"
            aria-label="关闭视图设置"
            onClick={() => setViewOpen(false)}
          >
            <X />
          </Button>
        </header>
        <div className="scene-options" aria-label="3D 视图设置">
          <Button
            size="sm"
            variant="secondary"
            disabled={props.disabled || busy}
            onClick={() => {
              setLocation({
                x: String(position.x),
                y: String(position.y),
                z: String(position.z),
              });
              setLocating(true);
            }}
          >
            定位
          </Button>
          <label>
            距离
            <SceneInteger
              label="3D 渲染距离"
              min={RENDER_DISTANCE.min}
              max={RENDER_DISTANCE.max}
              value={radius}
              onChange={setRadius}
            />
          </label>
          <label>
            画质
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
            >
              <option value="auto">自动</option>
              <option value="low">低</option>
              <option value="standard">标准</option>
              <option value="high">高</option>
            </select>
          </label>
          {props.ceiling === undefined && (
            <label>
              <input
                type="checkbox"
                checked={cut}
                onChange={(e) => setCut(e.target.checked)}
              />
              剖切
            </label>
          )}
          {(props.ceiling !== undefined || cut) && (
            <label>
              最高 Y
              <SceneInteger
                label="3D 最高 Y"
                min={-2048}
                max={2047}
                value={props.ceiling ?? ceiling}
                onChange={props.onCeiling ?? setCeiling}
              />
            </label>
          )}
          <label>
            洞穴亮度
            <input
              aria-label="洞穴亮度"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={brightness}
              onChange={(e) => setBrightness(Number(e.target.value))}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!props.grid}
              onChange={(event) => props.onGrid?.(event.target.checked)}
            />
            区块网格
          </label>
          <label>
            构建平面 Y
            <SceneInteger
              label="构建平面 Y"
              min={-2048}
              max={2047}
              value={planeY}
              onChange={setPlaneY}
            />
          </label>
        </div>
      </aside>

      <aside
        className="scene-properties"
        aria-label="3D 编辑属性"
        hidden={!propertiesOpen || (tool === "browse" && !pasteOpen)}
      >
        <header className="scene-panel-heading">
          <strong>
            {pasteOpen
              ? "粘贴与变换"
              : tool === "fill"
                ? "方块操作"
                : "方块选取"}
          </strong>
          <Button
            variant="ghost"
            size="icon"
            aria-label="收起工具面板"
            onClick={() => setPropertiesOpen(false)}
          >
            <X />
          </Button>
        </header>
        {!pasteOpen && (
          <div className="scene-selection-setup">
            <label>
              选取形状
              <select
                aria-label="选取形状"
                value={props.voxelShape}
                disabled={busy || props.disabled || !!chunkArea}
                onChange={(e) =>
                  props.onShape?.(e.target.value as SelectionShape)
                }
              >
                <option value="rectangle">长方体</option>
                <option value="single">单个方块</option>
                <option value="circle">球体</option>
              </select>
            </label>
            <label>
              选点距离
              <SceneInteger
                label="选点距离"
                min={1}
                max={1024}
                value={selectionDistance}
                onChange={setSelectionDistance}
              />
            </label>
            {!corners.length && (
              <>
                <p>在场景中拖拽，或依次点击两个角。</p>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    busy || props.disabled || !props.ready || !!chunkArea
                  }
                  onClick={() => {
                    const p = {
                      x: Math.floor(position.x),
                      y: Math.floor(position.y),
                      z: Math.floor(position.z),
                    };
                    setCorners(sphere ? sphereCorners(p, 1) : [p, p]);
                  }}
                >
                  从当前坐标建立选区
                </Button>
              </>
            )}
          </div>
        )}
        {corners.length > 0 && !pasteOpen && (
          <aside className="scene-selection-panel" aria-label="选区坐标">
            <div className="scene-selection-actions">
              <Button
                size="sm"
                variant="secondary"
                title={`删除方块 · ${shortcutHint("delete")}`}
                disabled={
                  corners.length !== 2 || busy || props.disabled || !props.ready
                }
                onClick={() => setConfirm("minecraft:air")}
              >
                <Trash2 />
                删除方块
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  corners.length !== 2 || busy || props.disabled || !props.ready
                }
                onClick={() => void copySelection()}
              >
                复制区域
              </Button>
              <Button
                size="sm"
                variant="secondary"
                title={`移动方块选区 · ${shortcutHint("move")} · 确认粘贴后移动`}
                disabled={
                  corners.length !== 2 || busy || props.disabled || !props.ready
                }
                onClick={() => void beginMove()}
              >
                <Scissors />
                剪切 / 移动
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!clipboard || busy || props.disabled || !props.ready}
                onClick={() => beginPaste()}
              >
                粘贴预览…
              </Button>
            </div>
            {(sphere ? corners.slice(0, 1) : corners).map((point, index) => (
              <fieldset
                className={`scene-corner scene-corner-${index + 1}`}
                key={index}
                disabled={busy || props.disabled || !!chunkArea}
              >
                <legend>{sphere ? "球心" : `点 ${index + 1}`}</legend>
                {(["x", "y", "z"] as const).map((axis) => (
                  <label key={axis}>
                    {axis.toUpperCase()}
                    <SceneInteger
                      label={
                        sphere
                          ? `球心 ${axis.toUpperCase()}`
                          : `点 ${index + 1} ${axis.toUpperCase()}`
                      }
                      min={axis === "y" ? -2048 : -(2 ** 35)}
                      max={axis === "y" ? 2047 : 2 ** 35 - 1}
                      value={point[axis]}
                      onChange={(value) =>
                        setCorners((previous) =>
                          sphere
                            ? sphereCorners(
                                { ...previous[0], [axis]: value },
                                sphereRadius(previous[0], previous[1]),
                              )
                            : previous.map((p, i) =>
                                i === index ? { ...p, [axis]: value } : p,
                              ),
                        )
                      }
                    />
                  </label>
                ))}
              </fieldset>
            ))}
            {sphere && (
              <fieldset disabled={busy || props.disabled}>
                <label>
                  半径
                  <SceneInteger
                    label="球体半径"
                    min={0}
                    max={2047}
                    value={sphereRadius(corners[0], corners[1])}
                    onChange={(value) =>
                      setCorners((previous) =>
                        sphereCorners(previous[0], value),
                      )
                    }
                  />
                </label>
              </fieldset>
            )}
            {corners.length === 2 && (
              <>
                <div className="scene-selection-size">
                  {(() => {
                    const size = selectionSize(corners, sphere)!;
                    return (
                      <>
                        <strong>
                          {size.x} × {size.y} × {size.z}
                        </strong>
                        <span>
                          {(chunkArea
                            ? BigInt(chunkArea.mask.length) *
                              256n *
                              BigInt(size.y)
                            : size.volume
                          ).toLocaleString()}{" "}
                          {sphere || hollow ? "格包围盒" : "格"}
                        </span>
                      </>
                    );
                  })()}
                </div>
                <SceneNudge
                  corners={corners}
                  sphere={sphere}
                  disabled={
                    busy || props.disabled || !props.ready || !!chunkArea
                  }
                  onChange={setCorners}
                />
              </>
            )}
            {!chunkArea && props.voxelShape !== "single" && (
              <label>
                <input
                  type="checkbox"
                  checked={hollow}
                  disabled={busy || props.disabled}
                  onChange={(event) => setHollow(event.target.checked)}
                />
                空心（一格厚）
              </label>
            )}
            <label>
              <input
                type="checkbox"
                checked={copyBlockEntities}
                disabled={busy || props.disabled}
                onChange={(event) => setCopyBlockEntities(event.target.checked)}
              />
              复制方块实体
            </label>
            <label>
              <input
                type="checkbox"
                checked={copyEntities}
                disabled={busy || props.disabled}
                onChange={(event) => setCopyEntities(event.target.checked)}
              />
              复制实体
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || props.disabled}
              onClick={() => setCorners([])}
            >
              清除选区
            </Button>
          </aside>
        )}
        {tool === "fill" && !pasteOpen && (
          <section className="scene-operation" aria-label="方块操作">
            <strong>填充 / 替换</strong>
            <label>
              目标方块
              <Input
                aria-label="填充方块名称"
                value={operationBlock}
                disabled={busy || props.disabled}
                onChange={(e) => setOperationBlock(e.target.value)}
                placeholder="minecraft:stone"
                list="scene-block-presets"
              />
            </label>
            <datalist id="scene-block-presets">
              {[
                "stone",
                "air",
                "glass",
                "dirt",
                "grass_block",
                "water",
                "sand",
                "oak_planks",
              ].map((name) => (
                <option key={name} value={`minecraft:${name}`} />
              ))}
            </datalist>
            <label>
              仅替换
              <Input
                aria-label="仅替换方块名称"
                value={operationMatch}
                disabled={busy || props.disabled}
                onChange={(e) => setOperationMatch(e.target.value)}
                placeholder="留空则填充全部"
              />
            </label>
            <Button
              size="sm"
              disabled={
                corners.length !== 2 ||
                !operationBlock.trim() ||
                busy ||
                props.disabled ||
                !props.ready
              }
              onClick={() => setConfirm(operationBlock.trim())}
            >
              {operationMatch.trim() ? "替换选区方块…" : "填充选区方块…"}
            </Button>
          </section>
        )}
        {clipboard && !pasteOpen && corners.length === 0 && (
          <div className="scene-clipboard">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || props.disabled || !props.ready}
              onClick={() => beginPaste()}
            >
              粘贴预览…
            </Button>
          </div>
        )}
        {pasteOpen && (
          <aside className="scene-paste-panel" aria-label="粘贴预览位置">
            <strong>粘贴预览</strong>
            <fieldset disabled={busy || props.disabled}>
              {(["x", "y", "z"] as const).map((axis) => (
                <label key={axis}>
                  {axis.toUpperCase()}
                  <SceneInteger
                    label={`粘贴 ${axis.toUpperCase()}`}
                    value={pasteOrigin[axis]}
                    min={axis === "y" ? -2048 : -(2 ** 35)}
                    max={axis === "y" ? 2047 : 2 ** 35 - 1}
                    onChange={(value) =>
                      setPasteOrigin((old) =>
                        snapPosition({ ...old, [axis]: value }, snap),
                      )
                    }
                  />
                </label>
              ))}
            </fieldset>
            <fieldset disabled={busy || props.disabled}>
              <legend>旋转 / 翻转 / 缩放</legend>
              <label>
                等比例缩放
                <SceneScale
                  value={pasteTransform.scale ?? 1}
                  onChange={(scale) => {
                    if (Number.isFinite(scale) && scale > 0)
                      setPasteTransform((old) => ({ ...old, scale }));
                  }}
                />
              </label>
              <label>
                交换坐标轴
                <select
                  aria-label="交换坐标轴"
                  value={pasteTransform.axisOrder ?? "xyz"}
                  onChange={(e) =>
                    setPasteTransform((old) => ({
                      ...old,
                      axisOrder: e.target.value as typeof old.axisOrder,
                    }))
                  }
                >
                  <option value="xyz">不交换</option>
                  <option value="yxz">X ↔ Y（横竖互换）</option>
                  <option value="xzy">Y ↔ Z（横竖互换）</option>
                  <option value="zyx">X ↔ Z</option>
                  <option value="yzx">XYZ → YZX</option>
                  <option value="zxy">XYZ → ZXY</option>
                </select>
              </label>
              {axes.map((axis, i) => (
                <label key={axis}>
                  {axis.toUpperCase()}
                  <select
                    aria-label={`旋转 ${axis.toUpperCase()}`}
                    value={pasteTransform.rotation[i]}
                    onChange={(e) =>
                      setPasteTransform((old) => ({
                        ...old,
                        rotation: old.rotation.map((v, j) =>
                          i === j ? quarterTurn(Number(e.target.value)) : v,
                        ) as [number, number, number],
                      }))
                    }
                  >
                    {[0, 90, 180, 270].map((angle) => (
                      <option key={angle} value={angle}>
                        {angle}°
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`${axis.toUpperCase()} 轴翻转 180°`}
                    onClick={() =>
                      setPasteTransform((old) => ({
                        ...old,
                        rotation: old.rotation.map((v, j) =>
                          i === j ? quarterTurn(v + 180) : v,
                        ) as [number, number, number],
                      }))
                    }
                  >
                    翻转
                  </Button>
                </label>
              ))}
              <div className="scene-mirror-axes">
                {axes.map((axis, i) => (
                  <label key={axis}>
                    <input
                      type="checkbox"
                      aria-label={`镜像 ${axis.toUpperCase()}`}
                      checked={pasteTransform.mirror[i]}
                      onChange={(e) =>
                        setPasteTransform((old) => ({
                          ...old,
                          mirror: old.mirror.map((v, j) =>
                            i === j ? e.target.checked : v,
                          ) as [boolean, boolean, boolean],
                        }))
                      }
                    />
                    {axis.toUpperCase()} 镜像
                  </label>
                ))}
              </div>
              <label>
                网格吸附
                <select
                  aria-label="网格吸附"
                  value={snap}
                  onChange={(e) => {
                    const step = Number(e.target.value);
                    setSnap(step);
                    setPasteOrigin((old) => snapPosition(old, step));
                  }}
                >
                  {[1, 2, 4, 8, 16].map((v) => (
                    <option key={v} value={v}>
                      {v} 格
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPasteTransform(identityTransform())}
              >
                重置变换
              </Button>
            </fieldset>
            <fieldset
              disabled={busy || props.disabled || moveSource.current !== null}
            >
              <label>
                <input
                  type="checkbox"
                  checked={replaceExisting}
                  onChange={(e) => setReplaceExisting(e.target.checked)}
                />
                替换原方块
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={pasteAir}
                  onChange={(e) => setPasteAir(e.target.checked)}
                />
                粘贴空气
              </label>
            </fieldset>
            {pasteError ? (
              <p role="alert">{pasteError}</p>
            ) : !pasteReady ? (
              <p>正在生成预览…</p>
            ) : (
              <p>拖动 XYZ 轴定位；旋转环按 90° 吸附。</p>
            )}
            <div className="scene-paste-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setPasteOpen(false)}
              >
                取消
              </Button>
              <Button
                disabled={
                  busy ||
                  props.disabled ||
                  !props.ready ||
                  !pasteReady ||
                  pastePreview.current?.isReadyFor(pasteTransform) === false
                }
                onClick={() => void pasteSelection()}
              >
                {busy ? "处理中…" : "粘贴"}
              </Button>
            </div>
          </aside>
        )}
      </aside>
      {menu && (
        <div
          ref={menuRef}
          className="scene-context-menu"
          role="menu"
          aria-label="3D 快捷操作"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setMenu(null);
              host.current?.querySelector("canvas")?.focus();
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const buttons = Array.from(
                menuRef.current?.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ) ?? [],
              );
              const i = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              buttons[
                (i + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
                  buttons.length
              ]?.focus();
            }
          }}
        >
          {menu.entity && (
            <button
              role="menuitem"
              disabled={
                busy ||
                props.disabled ||
                !props.ready ||
                !menu.entity.object_ref
              }
              onClick={() => {
                const target = menu.entity!;
                setMenu(null);
                setSelectedEntity(target);
                props.onObject(target.object_ref!, target.label);
              }}
            >
              编辑实体 NBT
            </button>
          )}
          <button
            role="menuitem"
            disabled={!menu.hit || busy || props.disabled || !props.ready}
            onClick={() => {
              const target = menu.hit;
              setMenu(null);
              if (target) void nbtAction.current(target);
            }}
          >
            预览方块 NBT
          </button>
          <button
            role="menuitem"
            disabled={
              corners.length !== 2 || busy || props.disabled || !props.ready
            }
            onClick={() => {
              setMenu(null);
              void copySelection();
            }}
          >
            复制区域 <kbd>{shortcutHint("copy")}</kbd>
          </button>
          <button
            role="menuitem"
            disabled={
              corners.length !== 2 || busy || props.disabled || !props.ready
            }
            onClick={() => {
              setMenu(null);
              void beginMove();
            }}
          >
            移动方块选区
          </button>
          <button
            role="menuitem"
            disabled={!clipboard || busy || props.disabled || !props.ready}
            onClick={() => beginPaste()}
          >
            粘贴预览… <kbd>{shortcutHint("paste")}</kbd>
          </button>
          <button
            role="menuitem"
            disabled={
              corners.length !== 2 ||
              pasteOpen ||
              busy ||
              props.disabled ||
              !props.ready
            }
            onClick={() => {
              setMenu(null);
              setConfirm(props.fillBlock ?? "minecraft:stone");
            }}
          >
            填充方块…
          </button>
          <button
            role="menuitem"
            disabled={
              corners.length !== 2 ||
              pasteOpen ||
              busy ||
              props.disabled ||
              !props.ready
            }
            onClick={() => {
              setMenu(null);
              setConfirm("minecraft:air");
            }}
          >
            删除方块… <kbd>Del</kbd>
          </button>
          <button
            role="menuitem"
            disabled={!corners.length || busy || props.disabled}
            onClick={() => {
              setMenu(null);
              setCorners([]);
            }}
          >
            清除选区
          </button>
          {pasteOpen && (
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setPasteOpen(false);
              }}
            >
              取消粘贴 <kbd>Esc</kbd>
            </button>
          )}
        </div>
      )}
      <SceneToolbar
        tool={tool}
        disabled={props.disabled || busy || !props.ready || nbtDirty}
        pasteOpen={pasteOpen}
        canPaste={clipboard}
        onTool={(next) => {
          setPasteOpen(false);
          moveSource.current = null;
          setPropertiesOpen(true);
          props.onTool?.(next);
          host.current?.querySelector("canvas")?.focus();
        }}
        onPaste={() => beginPaste()}
        onExport={(format) => void editorActions.exportStructure(format)}
        onImport={(file) => void editorActions.importStructure(file)}
        onChunks={props.onBack}
      />
      <div className="scene-coordinate">
        {selectedEntity && tool === "browse"
          ? `${selectedEntity.label} · ${selectedEntity.x}, ${selectedEntity.y}, ${selectedEntity.z}`
          : ""}
        {hit
          ? `${hit.name ? hit.name + " · " : ""}方块 ${hit.point.x}, ${hit.point.y}, ${hit.point.z}`
          : ""}
        {corners.length
          ? sphere
            ? ` · 球体半径 ${sphereRadius(corners[0], corners[1])}`
            : ` · 选角 ${corners.length}/2`
          : ""}
      </div>
      <div className="scene-hint">
        {props.chunkSelecting
          ? "区块选取 · 拖动框选 · Ctrl 增减 · 覆盖维度完整高度"
          : pasteOpen
            ? "G 移动 · R 旋转 · Enter 粘贴 · Esc 取消 · Shift 右键菜单"
            : tool !== "browse"
              ? sphere
                ? "单击确定球心 · 拖动球面修改半径 · 右键转向 / WASD 移动"
                : `拖拽 / 两角选取 · 拖面拉伸 · R / F 调整距离 · ${shortcutHint("focus")} 聚焦`
              : mode === "top"
                ? `俯视 · 右键拖动平移 · 滚轮缩放 · WASD 移动 · ${shortcutHint("toggleView")} 返回 3D`
                : mode === "fly"
                  ? "右键点击锁定 / 拖动转向 · WASD 飞行 · Space / Shift 升降 · 滚轮调速 · Esc 释放"
                  : "左键环绕 · 右键平移 · 滚轮缩放 · 双击编辑 NBT"}
      </div>
      {failure && (
        <div className="scene-failure" role="alert">
          <p>{failure}</p>
          <Button onClick={() => setRendererAttempt((value) => value + 1)}>
            重新加载场景
          </Button>
        </div>
      )}
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === "minecraft:air" ? "删除选区方块" : "填充选区方块"}
            </DialogTitle>
            <DialogDescription>
              {corners.length === 2
                ? (() => {
                    const { low, high } = bounds(corners[0], corners[1]);
                    return `范围 ${low.x}, ${low.y}, ${low.z} → ${high.x}, ${high.y}, ${high.z}，${hollow ? "空心（一格厚）" : "实心"}${sphere ? "球体选区。" : "长方体选区。"}操作暂存后可撤销，保存后写入存档。`;
                  })()
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              取消
            </Button>
            <Button
              disabled={busy || props.disabled}
              onClick={() => {
                if (corners.length !== 2) return;
                const { low, high } = bounds(corners[0], corners[1]);
                void edit(
                  low,
                  high,
                  confirm ?? "minecraft:air",
                  confirm !== "minecraft:air" && tool === "fill"
                    ? operationMatch.trim() || null
                    : null,
                );
              }}
            >
              {busy ? "处理中…" : "确认"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!blockNbt}
        onOpenChange={(open) => {
          if (
            !open &&
            !busy &&
            (!nbtDirty || window.confirm("放弃尚未应用的方块 NBT 修改？"))
          ) {
            setBlockNbt(null);
            setNbtDirty(false);
            props.onDraft(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>方块 NBT</DialogTitle>
            <DialogDescription>
              {blockNbt
                ? `${blockNbt.point.x}, ${blockNbt.point.y}, ${blockNbt.point.z}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {nbtError && <p role="alert">{nbtError}</p>}
          <label>
            名称
            <Input
              aria-label="方块 NBT 名称"
              disabled={busy}
              value={blockNbt?.name ?? ""}
              onChange={(e) => {
                setBlockNbt((p) => p && { ...p, name: e.target.value });
                setNbtDirty(true);
                props.onDraft(true);
              }}
            />
          </label>
          <label>
            states（SNBT）
            <textarea
              aria-label="方块 states"
              disabled={busy}
              rows={6}
              value={blockNbt?.states ?? "{}"}
              onChange={(e) => {
                setBlockNbt((p) => p && { ...p, states: e.target.value });
                setNbtDirty(true);
                props.onDraft(true);
              }}
            />
          </label>
          <DialogFooter>
            {blockNbt?.entity_pending && (
              <Button variant="secondary" disabled>
                保存后编辑方块实体 NBT
              </Button>
            )}
            {blockNbt?.entity && (
              <Button
                variant="secondary"
                disabled={busy || nbtDirty}
                onClick={() => {
                  const nbt = blockNbt;
                  setBlockNbt(null);
                  props.onObject(
                    nbt.entity!,
                    `方块实体 ${nbt.point.x}, ${nbt.point.y}, ${nbt.point.z}`,
                  );
                }}
              >
                编辑方块实体 NBT
              </Button>
            )}
            <Button
              disabled={busy || !nbtDirty || props.disabled}
              onClick={() => {
                if (blockNbt)
                  void edit(
                    blockNbt.point,
                    blockNbt.point,
                    blockNbt.name,
                    null,
                    blockNbt.states,
                  );
              }}
            >
              应用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={locating} onOpenChange={setLocating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改当前视角坐标</DialogTitle>
            <DialogDescription>输入相机坐标，保留当前朝向。</DialogDescription>
          </DialogHeader>
          {(["x", "y", "z"] as const).map((key) => (
            <label key={key}>
              {key.toUpperCase()}
              <Input
                inputMode="numeric"
                value={location[key]}
                onChange={(e) =>
                  setLocation((previous) => ({
                    ...previous,
                    [key]: e.target.value,
                  }))
                }
              />
            </label>
          ))}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setLocating(false)}>
              取消
            </Button>
            <Button
              disabled={
                !Object.values(location).every(
                  (value) =>
                    value.trim() !== "" && Number.isFinite(Number(value)),
                ) ||
                Number(location.y) < -2048 ||
                Number(location.y) > 2047 ||
                Math.abs(Number(location.x)) >= 2 ** 35 ||
                Math.abs(Number(location.z)) >= 2 ** 35
              }
              onClick={() => {
                locate.current(
                  Number(location.x),
                  Number(location.y),
                  Number(location.z),
                );
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
