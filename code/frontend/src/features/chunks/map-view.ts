import { MAP_QUALITY } from "@/lib/constants";

export interface Point {
  x: number;
  z: number;
}
export interface Camera {
  x: number;
  z: number;
  scale: number;
}
/** Unrotated canvas coverage needed to fill a viewport after CSS rotation. */
const groundPatterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();

/** World-aligned 16-block checker tiles, shared visually with the scene floor. */
export function drawMapGround(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  size: { width: number; height: number },
) {
  const unit = 16 * camera.scale;
  ctx.fillStyle = unit < 4 ? "#474c54" : "#50555d";
  ctx.fillRect(0, 0, size.width, size.height);
  if (unit < 4) return;
  // Tile in a single canvas operation during pan/zoom instead of drawing each
  // visible square separately. The fallback also works in logic-test canvases.
  if (
    typeof DOMMatrix !== "undefined" &&
    typeof ctx.createPattern === "function"
  ) {
    let pattern = groundPatterns.get(ctx);
    if (!pattern) {
      const tile = document.createElement("canvas");
      tile.width = tile.height = 2;
      const paint = tile.getContext("2d");
      if (paint) {
        paint.fillStyle = "#50555d";
        paint.fillRect(0, 0, 2, 2);
        paint.fillStyle = "#3e434b";
        paint.fillRect(0, 1, 1, 1);
        paint.fillRect(1, 0, 1, 1);
        pattern = ctx.createPattern(tile, "repeat") ?? undefined;
        if (pattern) groundPatterns.set(ctx, pattern);
      }
    }
    if (pattern) {
      pattern.setTransform(
        new DOMMatrix([
          unit,
          0,
          0,
          unit,
          size.width / 2 - (camera.x % 32) * camera.scale,
          size.height / 2 - (camera.z % 32) * camera.scale,
        ]),
      );
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, size.width, size.height);
      return;
    }
  }
  const left = Math.floor((camera.x - size.width / 2 / camera.scale) / 16);
  const top = Math.floor((camera.z - size.height / 2 / camera.scale) / 16);
  const right = Math.ceil((camera.x + size.width / 2 / camera.scale) / 16);
  const bottom = Math.ceil((camera.z + size.height / 2 / camera.scale) / 16);
  ctx.fillStyle = "#3e434b";
  for (let x = left; x < right; x++)
    for (let z = top; z < bottom; z++) {
      if ((x + z) % 2 === 0) continue;
      const px = Math.floor(
        (x * 16 - camera.x) * camera.scale + size.width / 2,
      );
      const pz = Math.floor(
        (z * 16 - camera.z) * camera.scale + size.height / 2,
      );
      const endX = Math.ceil(
        ((x + 1) * 16 - camera.x) * camera.scale + size.width / 2,
      );
      const endZ = Math.ceil(
        ((z + 1) * 16 - camera.z) * camera.scale + size.height / 2,
      );
      ctx.fillRect(px, pz, endX - px, endZ - pz);
    }
}

export function rotatedMapSize(width: number, height: number, yaw: number) {
  const angle = ((180 - yaw) * Math.PI) / 180;
  const c = Math.abs(Math.cos(angle)) < 1e-12 ? 0 : Math.abs(Math.cos(angle)),
    s = Math.abs(Math.sin(angle)) < 1e-12 ? 0 : Math.abs(Math.sin(angle));
  return {
    width: Math.ceil(width * c + height * s),
    height: Math.ceil(width * s + height * c),
  };
}
export function unrotateMapPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  yaw: number,
) {
  const angle = ((180 - yaw) * Math.PI) / 180;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return { x: width / 2 + x * c + y * s, y: height / 2 - x * s + y * c };
}
export interface Bounds {
  min_x: number;
  max_x: number;
  min_z: number;
  max_z: number;
}
export const chunkId = ({ x, z }: Point) => `${x},${z}`;
export type SelectionMode = "existing" | "empty";
export type SelectionShape = "single" | "rectangle" | "circle";
export type ChunkKind = "terrain" | "air" | "unreadable" | "missing";
export const chunkKinds: readonly [ChunkKind, string][] = [
  ["terrain", "普通地形区块"],
  ["air", "全空气区块"],
  ["unreadable", "无法预览区块"],
  ["missing", "未生成位置"],
];
/** Vector floor for successfully loaded chunks, beneath transparent terrain pixels. */
export function drawChunkIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  unit: number,
  kind: string,
  chunkX = 0,
  chunkZ = 0,
) {
  if (kind !== "loaded") return;
  ctx.fillStyle =
    (((chunkX + chunkZ) % 2) + 2) % 2 === 0 ? "#9db9de" : "#889fca";
  ctx.fillRect(x, y, unit, unit);
}
export const selectionShapes: readonly [SelectionShape, string][] = [
  ["single", "单击选取"],
  ["rectangle", "矩形选取"],
  ["circle", "圆形选取"],
];
export function selectionBounds(
  start: Point,
  end: Point,
  shape: SelectionShape,
): Bounds {
  if (shape === "single")
    return { min_x: end.x, max_x: end.x, min_z: end.z, max_z: end.z };
  if (shape === "circle") {
    const radius = Math.max(
      Math.abs(end.x - start.x),
      Math.abs(end.z - start.z),
    );
    return {
      min_x: start.x - radius,
      max_x: start.x + radius,
      min_z: start.z - radius,
      max_z: start.z + radius,
    };
  }
  return {
    min_x: Math.min(start.x, end.x),
    max_x: Math.max(start.x, end.x),
    min_z: Math.min(start.z, end.z),
    max_z: Math.max(start.z, end.z),
  };
}
export type SelectionCommand = {
  kind: "all" | "invert" | "clear";
  serial: number;
};
export function updateSelection(
  existing: Set<string>,
  points: Point[],
  operation: "replace" | "add" | "invert" | "subtract",
): Set<string> {
  const next = operation === "replace" ? new Set<string>() : new Set(existing);
  for (const p of points) {
    const key = chunkId(p);
    if (operation === "subtract" || (operation === "invert" && next.has(key)))
      next.delete(key);
    else next.add(key);
  }
  return next;
}
// Numerical guards cover the entire int32 chunk space; these are not UI zoom limits.
export const MIN_SCALE = 1e-9;
export const MAX_SCALE = 1e6;
export function mapDetail(
  camera: Camera,
  _width: number,
  _height: number,
  blur = true,
  dpr = 1,
  quality = MAP_QUALITY.default,
) {
  const multiplier =
    Number.isFinite(quality) && quality > 0 ? quality : MAP_QUALITY.default;
  const pixels = (16 * camera.scale * Math.max(1, dpr)) / multiplier;
  const resolution = blur
    ? Math.min(16, 2 ** Math.ceil(Math.log2(Math.max(1, pixels))))
    : 16;
  const span = blur ? Math.min(2 ** 32, Math.max(1, Math.ceil(2 / pixels))) : 1;
  return { resolution: span > 1 ? 1 : resolution, span };
}
export const dimensionLabel = (id: number) =>
  ["主世界", "下界", "末地"][id] ?? `dm${id}`;

export interface SelectionRun {
  z: number;
  min_x: number;
  max_x: number;
}

/** Build once per selection, not once per pointer event or camera frame. */
export function selectionRuns(selected: Set<string>): SelectionRun[] {
  const rows = new Map<number, number[]>();
  for (const key of selected) {
    const split = key.indexOf(",");
    const x = Number(key.slice(0, split)),
      z = Number(key.slice(split + 1));
    const row = rows.get(z);
    if (row) row.push(x);
    else rows.set(z, [x]);
  }
  const runs: SelectionRun[] = [];
  for (const [z, xs] of [...rows].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b);
    let run: SelectionRun | undefined;
    for (const x of xs) {
      if (run && x === run.max_x + 1) run.max_x = x;
      else {
        run = { z, min_x: x, max_x: x };
        runs.push(run);
      }
    }
  }
  return runs;
}

export function* visibleSelectionRuns(runs: SelectionRun[], bounds: Bounds) {
  let lo = 0,
    hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (runs[mid].z < bounds.min_z) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < runs.length && runs[i].z <= bounds.max_z; i++) {
    const run = runs[i];
    if (run.max_x >= bounds.min_x && run.min_x <= bounds.max_x)
      yield {
        z: run.z,
        min_x: Math.max(bounds.min_x, run.min_x),
        max_x: Math.min(bounds.max_x, run.max_x),
      };
  }
}
export function panCamera(camera: Camera, dx: number, dy: number): Camera {
  return {
    ...camera,
    x: camera.x - dx / camera.scale,
    z: camera.z - dy / camera.scale,
  };
}

export function worldPoint(
  camera: Camera,
  width: number,
  height: number,
  x: number,
  y: number,
): Point {
  return {
    x: (x - width / 2) / camera.scale + camera.x,
    z: (y - height / 2) / camera.scale + camera.z,
  };
}
export function chunkAt(point: Point): Point {
  return { x: Math.floor(point.x / 16), z: Math.floor(point.z / 16) };
}
export function zoomCamera(
  camera: Camera,
  width: number,
  height: number,
  x: number,
  y: number,
  factor: number,
): Camera {
  const point = worldPoint(camera, width, height, x, y);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * factor));
  return {
    x: point.x - (x - width / 2) / scale,
    z: point.z - (y - height / 2) / scale,
    scale,
  };
}
export function fitCamera(
  bounds: Bounds | null,
  width: number,
  height: number,
  _focus?: Point,
): Camera {
  if (!bounds) return { x: 0, z: 0, scale: 3 };
  const scale = Math.min(
    Math.max(1, width - 96) / ((bounds.max_x - bounds.min_x + 1) * 16),
    Math.max(1, height - 96) / ((bounds.max_z - bounds.min_z + 1) * 16),
    MAX_SCALE,
  );
  return {
    x: (bounds.min_x + bounds.max_x + 1) * 8,
    z: (bounds.min_z + bounds.max_z + 1) * 8,
    scale: Math.max(MIN_SCALE, scale),
  };
}
export function visibleBounds(
  camera: Camera,
  width: number,
  height: number,
): Bounds {
  const start = chunkAt(worldPoint(camera, width, height, 0, 0));
  const end = chunkAt(worldPoint(camera, width, height, width, height));
  const clamp = (value: number) =>
    Math.max(-2147483648, Math.min(2147483647, value));
  return {
    min_x: clamp(start.x),
    max_x: clamp(end.x),
    min_z: clamp(start.z),
    max_z: clamp(end.z),
  };
}
export function selectRectangle(
  existing: Set<string>,
  start: Point,
  end: Point,
  available: Point[],
  additive: boolean,
): Set<string> {
  const next = additive ? new Set(existing) : new Set<string>();
  for (const point of available) {
    if (
      point.x >= Math.min(start.x, end.x) &&
      point.x <= Math.max(start.x, end.x) &&
      point.z >= Math.min(start.z, end.z) &&
      point.z <= Math.max(start.z, end.z)
    )
      next.add(chunkId(point));
  }
  return next;
}
