import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { api } from "@/lib/api";
import { MAP_QUALITY } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useRecordSelection } from "../editor/useRecordSelection";
import SelectionBar from "../editor/SelectionBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  groupMarkers,
  hitMarker,
  markerLayers,
  markerStyle,
  type MapMarker,
  type MarkerGroup,
  type Overlays,
} from "./marker-view";
import {
  drawMapGround,
  drawChunkIndicator,
  chunkAt,
  chunkId,
  mapDetail,
  panCamera,
  visibleBounds,
  worldPoint,
  zoomCamera,
  selectionRuns,
  visibleSelectionRuns,
  selectionBounds,
  rotatedMapSize,
  unrotateMapPoint,
  type SelectionShape,
  type ChunkKind,
  type Camera,
  type Point,
  type SelectionMode,
  type SelectionCommand,
} from "./map-view";

import {
  TerrainFrame,
  TerrainPatch,
  terrainPatches,
  pruneTerrainCache,
  framePlacement,
  exposedBounds,
} from "./terrain-view";

export interface ChunkTile extends Point {
  rgba?: string;
  error?: string;
  kind?: ChunkKind;
  deleted?: boolean;
  created?: boolean;
}
interface RenderTile extends ChunkTile {
  pixels?: Uint8ClampedArray;
  resolution?: number;
  frame?: TerrainFrame | TerrainPatch;
}
export interface ChunkSummary {
  voxel_changes?: { base_revision: number; chunks: Point[] };
  voxel_can_undo?: boolean;
  voxel_can_redo?: boolean;
  dimension: number;
  revision: number;
  world_dirty: boolean;
  total: number;
  bounds: import("./map-view").Bounds | null;
  focus: Point | null;
  pending: (Point & { dimension: number })[];
  created?: (Point & { dimension: number })[];
  cleared?: (Point & { dimension: number })[];
  spawn: (Point & { y?: number }) | null;
  object_pending?: number;
  chunk_pending?: number;
  reset?: { dimension: number; records: number } | null;
}

export default function ChunkMap({
  id,
  summary,
  camera,
  yaw = 180,
  onCamera,
  layer,
  ceiling,
  grid,
  selecting,
  selected,
  onSelected,
  onHover,
  onSize,
  onError,
  disabled,
  ready = true,
  selectionMode = "existing",
  selectionCommand,
  shape = "rectangle",
  kinds,
  displayKinds,
  onSelectionBusy,
  blur = true,
  quality = MAP_QUALITY.default,
  onObject,
  onDeleteObjects,
  overlays = {
    entities: false,
    blocks: false,
    structures: false,
    spawn: false,
  },
}: {
  id: string;
  summary: ChunkSummary;
  camera: Camera;
  yaw?: number;
  onCamera: (camera: Camera) => void;
  layer: "surface" | "height";
  ceiling: number;
  grid: boolean;
  selecting: boolean;
  selected: Set<string>;
  onSelected: (selected: Set<string>) => void;
  onHover: (point: Point | null) => void;
  onSize: (size: { width: number; height: number }) => void;
  onError: (error: string) => void;
  disabled: boolean;
  ready?: boolean;
  selectionMode?: SelectionMode;
  selectionCommand?: SelectionCommand | null;
  shape?: SelectionShape;
  kinds?: ChunkKind[];
  displayKinds?: ChunkKind[];
  onSelectionBusy?: (busy: boolean) => void;
  blur?: boolean;
  quality?: number;
  onObject?: (reference: string, label: string) => void;
  onDeleteObjects?: (references: string[]) => Promise<void>;
  overlays?: Overlays;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [tiles, setTiles] = useState<RenderTile[]>([]);
  const [rectangle, setRectangle] = useState<{
    start: Point;
    end: Point;
  } | null>(null);
  const cache = useRef(new Map<string, TerrainPatch>());
  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [markerHover, setMarkerHover] = useState<MarkerGroup | null>(null);
  const [markerNotice, setMarkerNotice] = useState("");
  const [cluster, setCluster] = useState<MapMarker[] | null>(null);
  const [clusterQuery, setClusterQuery] = useState("");
  const [clusterPage, setClusterPage] = useState(0);
  const [iconRevision, setIconRevision] = useState(0);
  const markerSession = useRef("");
  const skipObjectClick = useRef(false);
  const groupsCache = useRef<{
    camera: Camera;
    markers: MapMarker[];
    overlays: Overlays;
    size: typeof size;
    spawn: Point | null;
    dimension: number;
    groups: MarkerGroup[];
  } | null>(null);
  const enabledLayers = markerLayers
    .map(([key]) => key)
    .filter((key) => key !== "spawn" && overlays[key]);
  const layersKey = enabledLayers.join(",");
  const gesture = useRef<{
    x: number;
    y: number;
    start: Point;
    additive: boolean;
    subtract: boolean;
    select: boolean;
    moved: boolean;
  } | null>(null);
  const viewRef = useRef({ camera, size, disabled });
  const lastCameraProp = useRef(camera);
  if (lastCameraProp.current !== camera) {
    viewRef.current.camera = camera;
    lastCameraProp.current = camera;
  }
  viewRef.current.size = size;
  viewRef.current.disabled = disabled;
  const selectionRequest = useRef<AbortController | null>(null);
  const selectionRef = useRef(selected);
  const lastSelectionProp = useRef(selected);
  const selectionDrawing = useRef<{
    selected: Set<string>;
    runs: ReturnType<typeof selectionRuns>;
  } | null>(null);
  const iconImages = useRef(new Map<string, HTMLImageElement>());
  function iconImage(src: string | undefined) {
    if (!src) return undefined;
    let image = iconImages.current.get(src);
    if (!image) {
      image = new Image();
      iconImages.current.set(src, image);
      image.onload = () => setIconRevision((value) => value + 1);
      image.src = src;
    }
    return image.complete && image.naturalWidth ? image : undefined;
  }
  if (lastSelectionProp.current !== selected) {
    selectionRef.current = selected;
    lastSelectionProp.current = selected;
  }
  function commitSelection(next: Set<string>) {
    selectionRef.current = next;
    onSelected(next);
  }
  function moveCamera(next: Camera) {
    viewRef.current.camera = next;
    onCamera(next);
  }
  const viewportRef = useRef<HTMLDivElement>(null);
  const yawRef = useRef(yaw);
  yawRef.current = yaw;
  function canvasPoint(event: { clientX: number; clientY: number }) {
    const rect = canvasRef.current!.getBoundingClientRect();
    if (yawRef.current === 180)
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const size = viewRef.current.size;
    return unrotateMapPoint(
      event.clientX - rect.left - rect.width / 2,
      event.clientY - rect.top - rect.height / 2,
      size.width,
      size.height,
      yawRef.current,
    );
  }
  useEffect(() => {
    gesture.current = null;
    setRectangle(null);
    return () => {
      selectionRequest.current?.abort();
      onSelectionBusy?.(false);
    };
  }, [
    id,
    summary.dimension,
    summary.revision,
    selectionMode,
    selecting,
    disabled,
    shape,
    kinds,
  ]);
  useEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      const expanded = rotatedMapSize(next.width, next.height, yaw);
      canvas.style.width = `${expanded.width}px`;
      canvas.style.height = `${expanded.height}px`;
      setSize(expanded);
      onSize(next);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [onSize, yaw]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function wheel(event: WheelEvent) {
      event.preventDefault();
      const view = viewRef.current;
      if (view.disabled) return;
      const point = canvasPoint(event);
      const next = zoomCamera(
        view.camera,
        view.size.width,
        view.size.height,
        point.x,
        point.y,
        Math.exp(-event.deltaY * 0.0015),
      );
      viewRef.current.camera = next;
      onCamera(next);
    }
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [onCamera]);
  useEffect(() => {
    cache.current.clear();
    setTiles([]);
  }, [
    id,
    summary.dimension,
    summary.revision,
    summary.total,
    ceiling,
    layer,
    displayKinds,
  ]);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const bounds = visibleBounds(camera, size.width, size.height);
    const dpr = window.devicePixelRatio || 1;
    const detail = mapDetail(
      camera,
      size.width,
      size.height,
      blur,
      dpr,
      quality,
    );
    const context = `${id}:${summary.dimension}:${summary.revision}:${ceiling}:${layer}:${(displayKinds ?? []).join(",")}`;
    const timer = setTimeout(async () => {
      try {
        const plans = terrainPatches(bounds, detail);
        if (!plans) {
          // With graded thumbnails disabled, a huge sparse viewport must not allocate
          // millions of empty cache canvases. Stream into a screen-sized buffer instead.
          const old = tiles.find((tile) => tile.frame instanceof TerrainFrame)
            ?.frame as TerrainFrame | undefined;
          const previous =
            detail.span === 1 &&
            old?.complete &&
            old.context === context &&
            old.camera.scale === camera.scale &&
            old.level?.resolution === detail.resolution
              ? old
              : undefined;
          const frame = new TerrainFrame(context, camera, size, dpr, previous);
          frame.level = detail;
          let last = 0;
          const publish = (force = false) => {
            const now = performance.now();
            if (
              !controller.signal.aborted &&
              (force || !last || now - last >= 100)
            ) {
              last = now;
              startTransition(() => setTiles([{ x: 0, z: 0, frame }]));
            }
          };
          for (const area of exposedBounds(bounds, previous?.bounds)) {
            const sampleArea =
              detail.span > 1
                ? {
                    min_x: Math.max(
                      -2147483648,
                      Math.floor(area.min_x / detail.span) * detail.span,
                    ),
                    max_x: Math.min(
                      2147483647,
                      (Math.floor(area.max_x / detail.span) + 1) * detail.span -
                        1,
                    ),
                    min_z: Math.max(
                      -2147483648,
                      Math.floor(area.min_z / detail.span) * detail.span,
                    ),
                    max_z: Math.min(
                      2147483647,
                      (Math.floor(area.max_z / detail.span) + 1) * detail.span -
                        1,
                    ),
                  }
                : area;
            let cursor: number | null = 0;
            do {
              const query = new URLSearchParams({
                dimension: String(summary.dimension),
                revision: String(summary.revision),
                cursor: String(cursor),
                page_size: "512",
                span: String(detail.span),
                ...Object.fromEntries(
                  Object.entries(sampleArea).map(([key, value]) => [
                    key,
                    String(value),
                  ]),
                ),
              });
              const region: { items: Point[]; next_cursor: number | null } =
                await api(
                  `/documents/${id}/chunks/terrain-page?${query}`,
                  "GET",
                  undefined,
                  controller.signal,
                );
              if (controller.signal.aborted) return;
              for (let i = 0; i < region.items.length; i += 64) {
                const result = await api<{ items: ChunkTile[] }>(
                  `/documents/${id}/chunks/tiles`,
                  "POST",
                  {
                    dimension: summary.dimension,
                    revision: summary.revision,
                    chunks: region.items.slice(i, i + 64),
                    ceiling,
                    layer,
                    resolution: detail.resolution,
                    span: detail.span,
                  },
                  controller.signal,
                );
                if (controller.signal.aborted) return;
                for (const tile of result.items)
                  if (
                    !displayKinds ||
                    displayKinds.includes(tile.kind ?? "terrain")
                  )
                    frame.paint(
                      tile,
                      tile.rgba
                        ? Uint8ClampedArray.from(atob(tile.rgba), (c) =>
                            c.charCodeAt(0),
                          )
                        : undefined,
                      detail.resolution,
                      detail.span,
                    );
                publish();
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                if (controller.signal.aborted) return;
              }
              cursor = region.next_cursor ?? null;
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              if (controller.signal.aborted) return;
            } while (cursor !== null);
          }
          frame.complete = true;
          publish(true);
          return;
        }

        const active = new Set(plans.map((plan) => plan.key));
        const patches = plans.map((plan) => {
          let patch = cache.current.get(plan.key);
          if (!patch || patch.context !== context)
            patch = new TerrainPatch(context, plan, detail, plan.cells);
          cache.current.delete(plan.key);
          cache.current.set(plan.key, patch);
          return patch;
        });
        pruneTerrainCache(cache.current, active);
        let lastPublish = 0;
        const show = (force = false) => {
          if (controller.signal.aborted) return;
          const now = performance.now();
          if (force || !lastPublish || now - lastPublish >= 100) {
            lastPublish = now;
            startTransition(() =>
              setTiles(patches.map((frame) => ({ x: 0, z: 0, frame }))),
            );
          }
        };
        // Cached world-aligned patches stay intact; only missing/unfinished patches do I/O.
        show(true);
        const centerX = (bounds.min_x + bounds.max_x) / 2;
        const centerZ = (bounds.min_z + bounds.max_z) / 2;
        const loading = patches
          .filter((patch) => !patch.complete)
          .sort(
            (a, b) =>
              Math.hypot(
                (a.bounds.min_x + a.bounds.max_x) / 2 - centerX,
                (a.bounds.min_z + a.bounds.max_z) / 2 - centerZ,
              ) -
              Math.hypot(
                (b.bounds.min_x + b.bounds.max_x) / 2 - centerX,
                (b.bounds.min_z + b.bounds.max_z) / 2 - centerZ,
              ),
          );
        while (loading.length) {
          const patch = loading.shift()!;
          if (!patch.complete) {
            if (patch.points === null) {
              const query = new URLSearchParams({
                dimension: String(summary.dimension),
                revision: String(summary.revision),
                cursor: String(patch.cursor),
                page_size: "512",
                span: String(detail.span),
                ...Object.fromEntries(
                  Object.entries(patch.bounds).map(([key, value]) => [
                    key,
                    String(value),
                  ]),
                ),
              });
              const region = await api<{
                items: Point[];
                next_cursor: number | null;
              }>(
                `/documents/${id}/chunks/terrain-page?${query}`,
                "GET",
                undefined,
                controller.signal,
              );
              if (controller.signal.aborted) return;
              patch.points = region.items;
              patch.nextCursor = region.next_cursor ?? null;
            }
            if (patch.points.length) {
              const result = await api<{ items: ChunkTile[] }>(
                `/documents/${id}/chunks/tiles`,
                "POST",
                {
                  dimension: summary.dimension,
                  revision: summary.revision,
                  chunks: patch.points.slice(0, 64),
                  ceiling,
                  layer,
                  resolution: detail.resolution,
                  span: detail.span,
                },
                controller.signal,
              );
              if (controller.signal.aborted) return;
              for (const tile of result.items) {
                if (
                  !displayKinds ||
                  displayKinds.includes(tile.kind ?? "terrain")
                )
                  patch.paint(tile);
              }
              patch.points = patch.points.slice(64);
            }
            if (!patch.points.length) {
              patch.cursor = patch.nextCursor;
              patch.points = null;
            }
            show();
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (controller.signal.aborted) return;
            // Rotate after each batch so a large aggregate patch cannot starve its neighbours.
            if (!patch.complete) loading.push(patch);
          }
        }
        show(true);
      } catch (error) {
        if (!controller.signal.aborted) onError((error as Error).message);
      }
    }, 160);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    id,
    summary.dimension,
    summary.revision,
    summary.total,
    camera,
    size,
    ceiling,
    layer,
    onError,
    blur,
    quality,
    displayKinds,
    ready,
  ]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(size.width * dpr),
        height = Math.round(size.height * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      drawMapGround(ctx, camera, size);
      const unit = 16 * camera.scale;
      const position = (x: number, z: number) => ({
        x: (x * 16 - camera.x) * camera.scale + size.width / 2,
        y: (z * 16 - camera.z) * camera.scale + size.height / 2,
      });
      for (const tile of tiles) {
        if (tile.frame) {
          if (
            tile.frame.context !==
            `${id}:${summary.dimension}:${summary.revision}:${ceiling}:${layer}:${(displayKinds ?? []).join(",")}`
          )
            continue;
          for (const indicator of tile.frame.indicators.values()) {
            const point = position(indicator.x, indicator.z);
            const spanUnit = unit * indicator.span;
            if (
              point.x > size.width ||
              point.y > size.height ||
              point.x + spanUnit < 0 ||
              point.y + spanUnit < 0
            )
              continue;
            drawChunkIndicator(
              ctx,
              point.x,
              point.y,
              spanUnit,
              indicator.kind,
              indicator.x,
              indicator.z,
            );
          }
        } else if (
          !tile.error &&
          tile.kind !== "missing" &&
          tile.kind !== "unreadable" &&
          (!displayKinds || displayKinds.includes(tile.kind ?? "terrain"))
        ) {
          const point = position(tile.x, tile.z);
          drawChunkIndicator(
            ctx,
            point.x,
            point.y,
            unit,
            "loaded",
            tile.x,
            tile.z,
          );
        }
      }
      for (const tile of tiles) {
        if (tile.frame) {
          if (
            tile.frame.context !==
            `${id}:${summary.dimension}:${summary.revision}:${ceiling}:${layer}:${(displayKinds ?? []).join(",")}`
          )
            continue;
          const at = framePlacement(camera, size, tile.frame);
          ctx.drawImage(tile.frame.canvas, at.x, at.y, at.width, at.height);
          continue;
        }
        if (displayKinds && !displayKinds.includes(tile.kind ?? "terrain"))
          continue;
        if (tile.kind === "missing" || tile.kind === "unreadable" || tile.error)
          continue;
        const point = position(tile.x, tile.z);
        const tileUnit = unit;
        if (
          point.x > size.width ||
          point.y > size.height ||
          point.x + tileUnit < 0 ||
          point.y + tileUnit < 0
        )
          continue;
        if (tile.deleted) {
          ctx.fillStyle = "#633938";
          ctx.fillRect(point.x, point.y, tileUnit, tileUnit);
        }
        if ((grid && unit >= 6) || tile.deleted || tile.created) {
          ctx.strokeStyle = selected.has(chunkId(tile))
            ? "#64c8e8"
            : tile.deleted
              ? "#ec8d84"
              : "#0e151766";
          ctx.lineWidth = selected.has(chunkId(tile)) ? 2 : 1;
          ctx.strokeRect(point.x, point.y, unit, unit);
        }
      }
      // Selection and staged deletion always overlay real coordinates, including far view.
      if (selectionDrawing.current?.selected !== selected)
        selectionDrawing.current = { selected, runs: selectionRuns(selected) };
      ctx.fillStyle = "#54bbdf55";
      ctx.strokeStyle = "#64c8e8";
      ctx.lineWidth = 1;
      for (const run of visibleSelectionRuns(
        selectionDrawing.current.runs,
        visibleBounds(camera, size.width, size.height),
      )) {
        const at = position(run.min_x, run.z);
        const width = (run.max_x - run.min_x + 1) * unit;
        ctx.fillRect(at.x, at.y, Math.max(1, width), Math.max(1, unit));
        if (unit >= 4) ctx.strokeRect(at.x, at.y, width, unit);
      }
      for (const [points, fill, stroke] of [
        [
          summary.pending.filter((p) => p.dimension === summary.dimension),
          "#633938bb",
          "#ec8d84",
        ],
        [
          (summary.created ?? []).filter(
            (p) => p.dimension === summary.dimension,
          ),
          "#46846e66",
          "#8ed9b2",
        ],
        [
          (summary.cleared ?? []).filter(
            (p) => p.dimension === summary.dimension,
          ),
          "#8c74bd44",
          "#b4a0d8",
        ],
      ] as const) {
        ctx.fillStyle = fill;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        for (const p of points) {
          const at = position(p.x, p.z);
          if (
            at.x > size.width ||
            at.y > size.height ||
            at.x + unit < 0 ||
            at.y + unit < 0
          )
            continue;
          ctx.fillRect(at.x, at.y, Math.max(1, unit), Math.max(1, unit));
          if (unit >= 4) ctx.strokeRect(at.x, at.y, unit, unit);
        }
      }
      if (
        (grid ||
          (selecting &&
            (selectionMode === "empty" || kinds?.includes("missing")))) &&
        unit >= 6
      ) {
        const bounds = visibleBounds(camera, size.width, size.height);
        ctx.strokeStyle = "#71899d44";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = bounds.min_x; x <= bounds.max_x + 1; x++) {
          const at = position(x, 0).x;
          ctx.moveTo(at, 0);
          ctx.lineTo(at, size.height);
        }
        for (let z = bounds.min_z; z <= bounds.max_z + 1; z++) {
          const at = position(0, z).y;
          ctx.moveTo(0, at);
          ctx.lineTo(size.width, at);
        }
        ctx.stroke();
      }
      for (const marker of markers) {
        if (!overlays[marker.kind]) continue;
        const x = (marker.x - camera.x) * camera.scale + size.width / 2;
        const y = (marker.z - camera.z) * camera.scale + size.height / 2;
        if (x < -12 || y < -12 || x > size.width + 12 || y > size.height + 12)
          continue;
        const { color } = markerStyle(marker);
        if (marker.area) {
          const a = position(marker.area.min_x / 16, marker.area.min_z / 16);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.strokeRect(
            a.x,
            a.y,
            (marker.area.max_x - marker.area.min_x + 1) * camera.scale,
            (marker.area.max_z - marker.area.min_z + 1) * camera.scale,
          );
        }
      }
      for (const group of screenGroups(camera)) {
        const marker = group.members[0];
        const { symbol, color, icon } = markerStyle(marker);
        const { x, y } = group;
        const count = group.members.length;
        ctx.fillStyle = "#1c242b";
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, count > 1 ? 14 : 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        const image = iconImage(icon);
        if (image) ctx.drawImage(image, x - 10, y - 10, 20, 20);
        ctx.fillStyle = color;
        ctx.font = "bold 12px Segoe UI, Segoe UI Emoji";
        ctx.textAlign = "center";
        if (count > 1) {
          ctx.fillStyle = "#1c242b";
          ctx.fillRect(x + 5, y + 1, String(count).length * 8 + 4, 16);
          ctx.fillStyle = "#fff";
          ctx.textAlign = "left";
          ctx.fillText(String(count), x + 7, y + 14);
        } else if (!image) ctx.fillText(symbol, x, y + 4);
      }
      if (rectangle) {
        const bounds = selectionBounds(rectangle.start, rectangle.end, shape);
        const a = position(bounds.min_x, bounds.min_z);
        const b = position(bounds.max_x + 1, bounds.max_z + 1);
        ctx.fillStyle = "#54bbdf33";
        ctx.strokeStyle = "#64c8e8";
        if (shape === "circle") {
          ctx.beginPath();
          ctx.arc(
            (a.x + b.x) / 2,
            (a.y + b.y) / 2,
            (b.x - a.x) / 2,
            0,
            Math.PI * 2,
          );
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
          ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    camera,
    size,
    id,
    ceiling,
    layer,
    summary.revision,
    tiles,
    selected,
    grid,
    rectangle,
    summary.spawn,
    summary.dimension,
    summary.pending,
    summary.created,
    summary.cleared,
    markers,
    overlays,
    selecting,
    selectionMode,
    shape,
    kinds,
    displayKinds,
    iconRevision,
  ]);
  function pointer(event: PointerEvent<HTMLCanvasElement>) {
    const { x, y } = canvasPoint(event);
    return {
      x,
      y,
      chunk: chunkAt(
        worldPoint(viewRef.current.camera, size.width, size.height, x, y),
      ),
    };
  }
  function screenGroups(view: Camera) {
    const previous = groupsCache.current;
    if (
      previous &&
      previous.camera === view &&
      previous.markers === markers &&
      previous.overlays === overlays &&
      previous.size === size &&
      previous.spawn === summary.spawn &&
      previous.dimension === summary.dimension
    )
      return previous.groups;
    const all = [...markers];
    if (summary.spawn && summary.dimension === 0)
      all.push({
        id: "spawn",
        kind: "spawn",
        label: "世界出生点",
        object_ref: "spawn",
        x: summary.spawn.x,
        y: null,
        z: summary.spawn.z,
      });
    const groups = groupMarkers(all, overlays, view, size.width, size.height);
    groupsCache.current = {
      camera: view,
      markers,
      overlays,
      size,
      spawn: summary.spawn,
      dimension: summary.dimension,
      groups,
    };
    return groups;
  }
  function hitObject(x: number, y: number) {
    return hitMarker(screenGroups(viewRef.current.camera), x, y);
  }
  function openGroup(group: MarkerGroup) {
    if (group.members.length > 1) {
      setCluster(group.members);
      setClusterQuery("");
      setClusterPage(0);
    } else {
      const marker = group.members[0];
      if (marker.object_ref) onObject?.(marker.object_ref, marker.label);
    }
  }
  async function selectArea(
    start: Point,
    end: Point,
    operation: "replace" | "add" | "invert" | "subtract",
    areaShape: SelectionShape = shape,
  ) {
    if (!ready) return;
    selectionRequest.current?.abort();
    const controller = new AbortController();
    selectionRequest.current = controller;
    onSelectionBusy?.(true);
    const query = new URLSearchParams({
      dimension: String(summary.dimension),
      revision: String(summary.revision),
      selection: "true",
      empty: String(selectionMode === "empty"),
      min_x: String(Math.min(start.x, end.x)),
      max_x: String(Math.max(start.x, end.x)),
      min_z: String(Math.min(start.z, end.z)),
      max_z: String(Math.max(start.z, end.z)),
    });
    try {
      const next =
        operation === "replace"
          ? new Set<string>()
          : new Set(selectionRef.current);
      const append = async (points: Point[]) => {
        for (let i = 0; i < points.length; i += 4096) {
          if (controller.signal.aborted) return;
          for (const p of points.slice(i, i + 4096)) {
            const key = chunkId(p);
            if (
              operation === "subtract" ||
              (operation === "invert" && next.has(key))
            )
              next.delete(key);
            else next.add(key);
          }
          if (i + 4096 <= points.length)
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      };
      if (kinds) {
        const bounds = selectionBounds(start, end, areaShape);
        let cursor: number | null = 0;
        do {
          const region: { items: Point[]; next_cursor: number | null } =
            await api(
              `/documents/${id}/chunks/select`,
              "POST",
              {
                dimension: summary.dimension,
                revision: summary.revision,
                ...bounds,
                kinds,
                shape: areaShape === "circle" ? "circle" : "rectangle",
                cursor,
                page_size: ["terrain", "air", "unreadable"].every((key) =>
                  kinds.includes(key as ChunkKind),
                )
                  ? 4096
                  : 32,
              },
              controller.signal,
            );
          if (controller.signal.aborted) return;
          await append(region.items);
          cursor = region.next_cursor ?? null;
        } while (cursor !== null);
      } else {
        const region = await api<{ items: Point[] }>(
          `/documents/${id}/chunks/region?${query}`,
          "GET",
          undefined,
          controller.signal,
        );
        await append(region.items);
      }
      if (controller.signal.aborted) return;
      commitSelection(next);
    } catch (error) {
      if (!controller.signal.aborted) onError((error as Error).message);
    } finally {
      if (selectionRequest.current === controller) onSelectionBusy?.(false);
    }
  }
  useEffect(() => {
    if (!selectionCommand || disabled || !ready) return;
    selectionRequest.current?.abort();
    if (selectionCommand.kind === "clear") commitSelection(new Set());
    else {
      const bounds = visibleBounds(
        viewRef.current.camera,
        size.width,
        size.height,
      );
      void selectArea(
        { x: bounds.min_x, z: bounds.min_z },
        { x: bounds.max_x, z: bounds.max_z },
        selectionCommand.kind === "invert" ? "invert" : "add",
        "rectangle",
      );
    }
    return () => selectionRequest.current?.abort();
    // Commands use the current viewport and selection; moving the camera does not replay them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionCommand]);
  useEffect(() => {
    const controller = new AbortController();
    const session = `${id}:${summary.dimension}:${summary.revision}`;
    const retain = markerSession.current === session;
    if (!retain) setMarkers([]);
    markerSession.current = session;
    setCluster(null);
    setMarkerHover(null);
    setMarkerNotice("");
    const layers = enabledLayers;
    if (!layers.length || !ready) {
      setMarkers([]);
      return () => controller.abort();
    }
    const timer = setTimeout(async () => {
      try {
        const bounds = visibleBounds(camera, size.width, size.height);
        const collected = new Map<string, MapMarker>(
          (retain ? markers : [])
            .filter(
              (marker) =>
                overlays[marker.kind] &&
                marker.x >= bounds.min_x * 16 &&
                marker.x < (bounds.max_x + 1) * 16 &&
                marker.z >= bounds.min_z * 16 &&
                marker.z < (bounds.max_z + 1) * 16,
            )
            .map((marker) => [marker.id, marker]),
        );
        let cursor: number | null = 0;
        let truncated = false,
          unreadable = 0;
        let changed = false;
        let published = 0;
        let lastPublish = 0;
        do {
          const response: {
            items: MapMarker[];
            truncated: boolean;
            unreadable: number;
            next_cursor?: number | null;
          } = await api<{
            items: MapMarker[];
            truncated: boolean;
            unreadable: number;
            next_cursor?: number | null;
          }>(
            `/documents/${id}/chunks/markers`,
            "POST",
            {
              dimension: summary.dimension,
              revision: summary.revision,
              ...visibleBounds(camera, size.width, size.height),
              layers,
              cursor,
              page_size: 8,
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          for (let index = 0; index < response.items.length; index++) {
            if (controller.signal.aborted) return;
            const item = response.items[index];
            collected.set(item.id, item);
            changed = true;
            if (collected.size >= 100000) {
              truncated = true;
              break;
            }
            // Dense sources must yield to input events before processing another batch.
            if (index && index % 512 === 0)
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          if (controller.signal.aborted) return;
          truncated ||= response.truncated;
          unreadable += response.unreadable;
          cursor = response.next_cursor ?? null;
          const now = Date.now();
          if (
            changed &&
            (published === 0 || cursor === null || now - lastPublish >= 100)
          ) {
            const next = [...collected.values()];
            startTransition(() => setMarkers(next));
            published++;
            lastPublish = now;
            changed = false;
          }
          if (collected.size >= 100000) {
            truncated = true;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } while (cursor !== null && !controller.signal.aborted);
        if (controller.signal.aborted) return;
        if (changed) startTransition(() => setMarkers([...collected.values()]));
        setMarkerNotice(
          truncated
            ? "信息图层仅显示部分位置，请拉近查看"
            : unreadable
              ? "部分信息记录无法读取"
              : "",
        );
      } catch (error) {
        if (!controller.signal.aborted)
          setMarkerNotice((error as Error).message);
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [id, summary.dimension, summary.revision, camera, size, layersKey, ready]);
  const clusterItems = (cluster ?? []).filter((marker) =>
    `${marker.label} ${marker.object_type ?? ""} ${marker.id}`
      .toLocaleLowerCase()
      .includes(clusterQuery.toLocaleLowerCase()),
  );
  const clusterSelection = useRecordSelection(
    clusterItems,
    `${id}:${summary.dimension}:${summary.revision}:${cluster?.[0]?.id ?? ""}:${clusterQuery}`,
  );
  const [objectDeletion, setObjectDeletion] = useState<MapMarker[] | null>(
    null,
  );
  const [objectDeleteBusy, setObjectDeleteBusy] = useState(false);
  const [objectDeleteError, setObjectDeleteError] = useState("");
  useEffect(
    () => () => {
      for (const image of iconImages.current.values()) image.onload = null;
    },
    [],
  );
  function requestObjectDelete() {
    const targets = (cluster ?? []).filter(
      (marker) => clusterSelection.ids.has(marker.id) && marker.object_ref,
    );
    if (targets.length && !disabled && !objectDeleteBusy) {
      setObjectDeleteError("");
      setObjectDeletion(targets);
    }
  }
  return (
    <>
      <div ref={viewportRef} className="chunk-map-viewport">
        <canvas
          ref={canvasRef}
          style={{
            left: "50%",
            top: "50%",
            right: "auto",
            bottom: "auto",
            transform: `translate(-50%, -50%) rotate(${180 - yaw}deg)`,
          }}
          className={`chunk-canvas ${selecting ? "selecting" : ""}`}
          tabIndex={0}
          aria-label="世界区块地图；滚轮缩放，拖动平移，选择模式中点击或框选区块"
          onDoubleClick={(event) => {
            if (disabled || selecting || !onObject || skipObjectClick.current)
              return;
            const { x, y } = canvasPoint(event);
            const hit = hitObject(x, y);
            if (hit) openGroup(hit);
          }}
          onClick={(event) => {
            if (disabled || selecting || skipObjectClick.current) return;
            const { x, y } = canvasPoint(event);
            const hit = hitObject(x, y);
            if (hit && hit.members.length > 1) openGroup(hit);
          }}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(event) => {
            skipObjectClick.current = false;
            if (disabled || ![0, 1, 2].includes(event.button)) return;
            selectionRequest.current?.abort();
            const p = pointer(event);
            event.currentTarget.setPointerCapture(event.pointerId);
            gesture.current = {
              x: p.x,
              y: p.y,
              start: p.chunk,
              additive: event.ctrlKey || event.metaKey,
              subtract: event.shiftKey && (event.ctrlKey || event.metaKey),
              select: ready && selecting && event.button === 0 && !event.altKey,
              moved: false,
            };
          }}
          onPointerMove={(event) => {
            const p = pointer(event);
            onHover(p.chunk);
            const drag = gesture.current;
            if (!drag) setMarkerHover(hitObject(p.x, p.y));
            if (!drag || disabled) return;
            drag.moved ||= Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) > 4;
            skipObjectClick.current = drag.moved;
            if (drag.select)
              setRectangle({
                start: shape === "single" ? p.chunk : drag.start,
                end: p.chunk,
              });
            else {
              moveCamera(
                panCamera(viewRef.current.camera, p.x - drag.x, p.y - drag.y),
              );
              drag.x = p.x;
              drag.y = p.y;
            }
          }}
          onPointerUp={(event) => {
            const drag = gesture.current;
            gesture.current = null;
            setRectangle(null);
            if (!drag || disabled) return;
            const p = pointer(event);
            if (drag.select) {
              if (
                !drag.moved &&
                drag.additive &&
                !drag.subtract &&
                selectionRef.current.has(chunkId(p.chunk))
              ) {
                const next = new Set(selectionRef.current);
                next.delete(chunkId(p.chunk));
                commitSelection(next);
              } else
                void selectArea(
                  drag.start,
                  p.chunk,
                  drag.subtract
                    ? "subtract"
                    : drag.additive
                      ? "add"
                      : "replace",
                );
            }
          }}
          onPointerCancel={() => {
            gesture.current = null;
            setRectangle(null);
          }}
          onPointerLeave={() => {
            onHover(null);
            setMarkerHover(null);
          }}
          onKeyDown={(event) => {
            if (disabled) return;
            if (event.key === "Escape") {
              selectionRequest.current?.abort();
              commitSelection(new Set());
            }
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "a"
            ) {
              event.preventDefault();
              const bounds = visibleBounds(
                viewRef.current.camera,
                size.width,
                size.height,
              );
              void selectArea(
                { x: bounds.min_x, z: bounds.min_z },
                { x: bounds.max_x, z: bounds.max_z },
                "add",
                "rectangle",
              );
            }
          }}
        />
      </div>
      {markerHover && (
        <div className="chunk-marker-info">
          <strong>
            {markerHover.members.length > 1
              ? `${markerHover.members.length} 个对象 · 点击选择`
              : markerHover.members[0].label}
          </strong>
          <span>
            {markerHover.members.length === 1
              ? `X ${markerHover.members[0].x} · Y ${markerHover.members[0].y ?? "—"} · Z ${markerHover.members[0].z}`
              : "拉近地图可展开图标"}
          </span>
        </div>
      )}
      <Dialog
        open={!!cluster}
        onOpenChange={(open) => {
          if (!open && !objectDeleteBusy && !objectDeletion) {
            setCluster(null);
            clusterSelection.clear();
          }
        }}
      >
        <DialogContent
          onKeyDown={(event) => {
            if (event.target instanceof HTMLInputElement) return;
            if (event.key === "Delete") {
              event.preventDefault();
              requestObjectDelete();
            } else
              clusterSelection.keyDown(
                event,
                disabled || objectDeleteBusy || !!objectDeletion,
              );
          }}
        >
          <DialogHeader>
            <DialogTitle>选择对象（{cluster?.length ?? 0}）</DialogTitle>
            <DialogDescription>
              单击选择，Ctrl 多选，Shift 连选，双击打开 NBT。
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="筛选聚合对象"
            placeholder="搜索名称或类型…"
            value={clusterQuery}
            onChange={(event) => {
              setClusterQuery(event.target.value);
              setClusterPage(0);
            }}
          />
          <SelectionBar
            count={clusterSelection.ids.size}
            disabled={disabled || objectDeleteBusy || !!objectDeletion}
            onAll={() => void clusterSelection.all()}
            onClear={clusterSelection.clear}
            onDelete={requestObjectDelete}
          />
          <div
            className="map-cluster-list"
            role="listbox"
            aria-multiselectable
            aria-label="地图对象"
          >
            {clusterItems
              .slice(clusterPage * 100, (clusterPage + 1) * 100)
              .map((marker) => (
                <button
                  key={marker.id}
                  role="option"
                  aria-selected={clusterSelection.ids.has(marker.id)}
                  className={cn(
                    clusterSelection.ids.has(marker.id) && "selected",
                  )}
                  disabled={!marker.object_ref || disabled}
                  onClick={(event) => clusterSelection.click(marker.id, event)}
                  onDoubleClick={(event) => {
                    if (event.ctrlKey || event.metaKey || event.shiftKey)
                      return;
                    setCluster(null);
                    if (marker.object_ref)
                      onObject?.(marker.object_ref, marker.label);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && marker.object_ref) {
                      event.preventDefault();
                      setCluster(null);
                      onObject?.(marker.object_ref, marker.label);
                    }
                  }}
                >
                  <span style={{ color: markerStyle(marker).color }}>
                    {markerStyle(marker).icon ? (
                      <img
                        className="minecraft-icon"
                        src={markerStyle(marker).icon}
                        alt=""
                        draggable={false}
                      />
                    ) : (
                      markerStyle(marker).symbol
                    )}
                  </span>
                  <span>
                    <strong>{marker.label}</strong>
                    <small>
                      {marker.object_type ?? marker.kind} · X {marker.x} · Y{" "}
                      {marker.y ?? "—"} · Z {marker.z}
                      <br />
                      {marker.source_name ?? marker.id}
                    </small>
                  </span>
                </button>
              ))}
          </div>
          {clusterItems.length > 100 && (
            <div className="map-cluster-pages">
              <Button
                variant="outline"
                disabled={clusterPage === 0}
                onClick={() => setClusterPage(clusterPage - 1)}
              >
                上一页
              </Button>
              <span>
                {clusterPage + 1} / {Math.ceil(clusterItems.length / 100)}
              </span>
              <Button
                variant="outline"
                disabled={(clusterPage + 1) * 100 >= clusterItems.length}
                onClick={() => setClusterPage(clusterPage + 1)}
              >
                下一页
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!objectDeletion}
        onOpenChange={(open) => {
          if (!open && !objectDeleteBusy) setObjectDeletion(null);
        }}
      >
        <DialogContent
          showCloseButton={!objectDeleteBusy}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (objectDeleteBusy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              删除选中的 {objectDeletion?.length ?? 0} 个对象？
            </DialogTitle>
            <DialogDescription>
              只删除所选对象的数据，保留地形和其他对象。玩家删除整条玩家记录；村庄仅删除
              INFO 记录。
              {objectDeletion?.some((marker) => marker.kind === "spawn") &&
                "世界出生点所在的 level.dat 保留文件并清空全部标签。"}
              {objectDeletion?.some((marker) => marker.kind === "spawn") &&
                "地图还原不恢复 level.dat，可在 NBT 编辑中撤销。"}
              {objectDeletion?.some(
                (marker) => marker.kind === "player_spawns",
              ) &&
                "玩家重生点仅清除 SpawnX、SpawnY、SpawnZ、SpawnDimension 字段。"}
              修改先暂存，点击保存更改后写入。
            </DialogDescription>
          </DialogHeader>
          {objectDeleteError && (
            <p className="field-error" role="alert">
              {objectDeleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={objectDeleteBusy}
              onClick={() => setObjectDeletion(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={objectDeleteBusy || !onDeleteObjects}
              onClick={async () => {
                if (!objectDeletion || !onDeleteObjects || objectDeleteBusy)
                  return;
                setObjectDeleteBusy(true);
                setObjectDeleteError("");
                try {
                  await onDeleteObjects([
                    ...new Set(
                      objectDeletion.map((marker) => marker.object_ref!),
                    ),
                  ]);
                  setObjectDeletion(null);
                  setCluster(null);
                  clusterSelection.clear();
                } catch (error) {
                  setObjectDeleteError((error as Error).message);
                } finally {
                  setObjectDeleteBusy(false);
                }
              }}
            >
              暂存删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {markerNotice && (
        <div className="chunk-marker-notice" role="status">
          {markerNotice}
        </div>
      )}
    </>
  );
}
