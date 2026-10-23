import {
  visibleBounds,
  type Bounds,
  type Camera,
  type Point,
} from "./map-view";

export interface TerrainLevel {
  resolution: number;
  span: number;
}

/** World-aligned cache units; moving the camera never changes their content or identity. */
export function terrainPatches(bounds: Bounds, level: TerrainLevel) {
  const cells = level.span > 1 ? 32 : 16;
  const side = cells * level.span;
  const count =
    (Math.floor(bounds.max_x / side) - Math.floor(bounds.min_x / side) + 1) *
    (Math.floor(bounds.max_z / side) - Math.floor(bounds.min_z / side) + 1);
  if (
    count > 4096 ||
    count * (cells * level.resolution) ** 2 * 4 > 64 * 1024 * 1024
  )
    return null;
  const result = [];
  for (
    let x = Math.floor(bounds.min_x / side) * side;
    x <= bounds.max_x;
    x += side
  )
    for (
      let z = Math.floor(bounds.min_z / side) * side;
      z <= bounds.max_z;
      z += side
    )
      result.push({
        x,
        z,
        cells,
        key: `${level.resolution}:${level.span}:${x}:${z}`,
      });
  return result;
}

export class TerrainPatch {
  readonly indicators = new Map<
    string,
    Point & { kind: string; span: number }
  >();
  readonly canvas = document.createElement("canvas");
  readonly camera: Camera;
  readonly width: number;
  readonly height: number;
  readonly bounds: Bounds;
  private readonly ctx: CanvasRenderingContext2D;
  cursor: number | null = 0;
  points: Point[] | null = null;
  nextCursor: number | null = null;

  constructor(
    readonly context: string,
    readonly origin: Point,
    readonly level: TerrainLevel,
    readonly cells: number,
  ) {
    const side = cells * level.span;
    this.width = this.height = cells * level.resolution;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建地图瓦片");
    this.ctx = ctx;
    ctx.imageSmoothingEnabled = false;
    this.camera = {
      x: (origin.x + side / 2) * 16,
      z: (origin.z + side / 2) * 16,
      scale: level.resolution / (16 * level.span),
    };
    this.bounds = {
      min_x: Math.max(-2147483648, origin.x),
      max_x: Math.min(2147483647, origin.x + side - 1),
      min_z: Math.max(-2147483648, origin.z),
      max_z: Math.min(2147483647, origin.z + side - 1),
    };
  }

  get bytes() {
    return this.width * this.height * 4 + this.indicators.size * 96;
  }
  get complete() {
    return this.cursor === null && this.points === null;
  }

  paint(
    tile: Point & {
      error?: string;
      deleted?: boolean;
      rgba?: string;
      kind?: string;
    },
  ) {
    const { span, resolution } = this.level;
    const x = Math.floor((tile.x - this.origin.x) / span);
    const z = Math.floor((tile.z - this.origin.z) / span);
    if (x < 0 || x >= this.cells || z < 0 || z >= this.cells)
      throw new Error("地图区块超出瓦片范围");
    const key = `${Math.floor(tile.x / span)},${Math.floor(tile.z / span)}`;
    this.indicators.delete(key);
    this.ctx.clearRect(x * resolution, z * resolution, resolution, resolution);
    if (tile.kind === "missing" || tile.kind === "unreadable" || tile.error)
      return;
    {
      this.indicators.set(key, {
        x: Math.floor(tile.x / span) * span,
        z: Math.floor(tile.z / span) * span,
        kind: "loaded",
        span,
      });
    }
    if (tile.kind === "air") return;
    const pixels = tile.rgba
      ? Uint8ClampedArray.from(atob(tile.rgba), (c) => c.charCodeAt(0))
      : undefined;
    if (pixels && pixels.length !== resolution * resolution * 4)
      throw new Error("地图像素数据长度无效");
    // Aggregated pixels use one real sample, including its original alpha.
    if (pixels && tile.kind !== "air") {
      this.ctx.putImageData(
        new ImageData(pixels, resolution, resolution),
        x * resolution,
        z * resolution,
      );
    } else if (tile.deleted) {
      this.ctx.fillStyle = "#633938";
      this.ctx.fillRect(x * resolution, z * resolution, resolution, resolution);
    }
  }
}

export function pruneTerrainCache(
  cache: Map<string, TerrainPatch>,
  active: Set<string>,
) {
  let bytes = 0,
    visibleBytes = 0;
  for (const [key, patch] of cache) {
    bytes += patch.bytes;
    if (active.has(key)) visibleBytes += patch.bytes;
  }
  // Keep the active viewport plus a bounded recent margin, even on large HiDPI displays.
  const budget = Math.max(64 * 1024 * 1024, visibleBytes * 2);
  const count = Math.max(512, active.size * 2);
  for (const [key, patch] of cache) {
    if (bytes <= budget && cache.size <= count) break;
    if (active.has(key)) continue;
    cache.delete(key);
    bytes -= patch.bytes;
  }
}

/** Disjoint strips newly exposed by a same-scale pan. */
export function exposedBounds(next: Bounds, previous?: Bounds): Bounds[] {
  if (!previous) return [next];
  const x0 = Math.max(next.min_x, previous.min_x),
    x1 = Math.min(next.max_x, previous.max_x);
  const z0 = Math.max(next.min_z, previous.min_z),
    z1 = Math.min(next.max_z, previous.max_z);
  if (x0 > x1 || z0 > z1) return [next];
  return [
    { min_x: next.min_x, max_x: next.max_x, min_z: next.min_z, max_z: z0 - 1 },
    { min_x: next.min_x, max_x: next.max_x, min_z: z1 + 1, max_z: next.max_z },
    { min_x: next.min_x, max_x: x0 - 1, min_z: z0, max_z: z1 },
    { min_x: x1 + 1, max_x: next.max_x, min_z: z0, max_z: z1 },
  ].filter((b) => b.min_x <= b.max_x && b.min_z <= b.max_z);
}

export function framePlacement(
  camera: Camera,
  size: { width: number; height: number },
  source: { camera: Camera; width: number; height: number },
) {
  const scale = camera.scale / source.camera.scale;
  return {
    x:
      (source.camera.x - camera.x) * camera.scale +
      size.width / 2 -
      (source.width * scale) / 2,
    y:
      (source.camera.z - camera.z) * camera.scale +
      size.height / 2 -
      (source.height * scale) / 2,
    width: source.width * scale,
    height: source.height * scale,
  };
}

/** A screen-sized backing store, not an aggregated terrain tile. Each chunk keeps its own footprint. */
export class TerrainFrame {
  readonly indicators = new Map<
    string,
    Point & { kind: string; span: number }
  >();
  readonly canvas = document.createElement("canvas");
  private readonly sprite = document.createElement("canvas");
  readonly width: number;
  readonly height: number;
  readonly bounds: Bounds;
  complete = false;
  level?: TerrainLevel;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    readonly context: string,
    readonly camera: Camera,
    size: { width: number; height: number },
    dpr: number,
    previous?: TerrainFrame,
  ) {
    this.width = size.width;
    this.height = size.height;
    this.bounds = visibleBounds(camera, size.width, size.height);
    this.canvas.width = Math.max(1, Math.round(size.width * dpr));
    this.canvas.height = Math.max(1, Math.round(size.height * dpr));
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建地图画布");
    this.ctx = ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    if (
      previous?.context === context &&
      previous.camera.scale === camera.scale
    ) {
      const at = framePlacement(camera, size, previous);
      ctx.drawImage(previous.canvas, at.x, at.y, at.width, at.height);
      for (const [key, indicator] of previous.indicators) {
        if (
          indicator.x + indicator.span > this.bounds.min_x &&
          indicator.x <= this.bounds.max_x &&
          indicator.z + indicator.span > this.bounds.min_z &&
          indicator.z <= this.bounds.max_z
        )
          this.indicators.set(key, indicator);
      }
    }
  }

  paint(
    tile: Point & { error?: string; deleted?: boolean; kind?: string },
    pixels: Uint8ClampedArray | undefined,
    resolution: number,
    span = 1,
  ) {
    const unit = 16 * span * this.camera.scale;
    const x =
      (Math.floor(tile.x / span) * span * 16 - this.camera.x) *
        this.camera.scale +
      this.width / 2;
    const y =
      (Math.floor(tile.z / span) * span * 16 - this.camera.z) *
        this.camera.scale +
      this.height / 2;
    const ctx = this.ctx;
    ctx.clearRect(x, y, unit, unit);
    const key = `${Math.floor(tile.x / span)},${Math.floor(tile.z / span)}`;
    this.indicators.delete(key);
    if (tile.kind === "missing" || tile.kind === "unreadable" || tile.error)
      return;
    {
      this.indicators.set(key, {
        x: Math.floor(tile.x / span) * span,
        z: Math.floor(tile.z / span) * span,
        kind: "loaded",
        span,
      });
    }
    if (tile.kind === "air") return;
    if (pixels && tile.kind !== "air") {
      if (
        ![1, 2, 4, 8, 16].includes(resolution) ||
        pixels.length !== resolution * resolution * 4
      )
        throw new Error("地图像素数据长度无效");
      if (this.sprite.width !== resolution)
        this.sprite.width = this.sprite.height = resolution;
      this.sprite
        .getContext("2d")
        ?.putImageData(new ImageData(pixels, resolution, resolution), 0, 0);
      ctx.drawImage(this.sprite, x, y, unit, unit);
    } else if (tile.deleted) {
      ctx.fillStyle = "#633938";
      ctx.fillRect(x, y, unit, unit);
    }
  }
}
