import * as THREE from "three";
import { api } from "@/lib/api";
import {
  hitMarker,
  markerLayers,
  markerStyle,
  type MapMarker,
  type MarkerGroup,
  type Overlays,
} from "./marker-view";

export function projectMarker(
  x: number,
  y: number,
  z: number,
  camera: THREE.Camera,
  ox: number,
  oz: number,
  width: number,
  height: number,
) {
  const point = new THREE.Vector3(x - ox, y, z - oz).project(camera);
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(point.z) ||
    point.z < -1 ||
    point.z > 1
  )
    return null;
  return { x: ((point.x + 1) * width) / 2, y: ((1 - point.y) * height) / 2 };
}

interface View {
  revision: number;
  ready: boolean;
  x: number;
  z: number;
  radius: number;
  overlays: Overlays;
}
interface Page {
  items: MapMarker[];
  truncated: boolean;
  unreadable: number;
  next_cursor?: number | null;
}
interface Bounds {
  min_x: number;
  max_x: number;
  min_z: number;
  max_z: number;
}

function contains(outer: Bounds, inner: Bounds) {
  return (
    outer.min_x <= inner.min_x &&
    outer.max_x >= inner.max_x &&
    outer.min_z <= inner.min_z &&
    outer.max_z >= inner.max_z
  );
}

function inBounds(marker: MapMarker, bounds: Bounds) {
  const area = marker.area;
  const cx = Math.floor(marker.x / 16),
    cz = Math.floor(marker.z / 16);
  return area
    ? area.max_x >= bounds.min_x * 16 &&
        area.min_x < (bounds.max_x + 1) * 16 &&
        area.max_z >= bounds.min_z * 16 &&
        area.min_z < (bounds.max_z + 1) * 16
    : cx >= bounds.min_x &&
        cx <= bounds.max_x &&
        cz >= bounds.min_z &&
        cz <= bounds.max_z;
}

// Information is drawn above terrain so underground and unknown objects stay visible.
export class SceneMarkers {
  private key = "";
  private request?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private items: MapMarker[] = [];
  private groups: MarkerGroup[] = [];
  private images = new Map<string, HTMLImageElement>();
  private overlays: Overlays = {};
  private overlayKey = "";
  private coverage?: Bounds;
  private view?: Bounds;
  private drawDirty = true;
  private drawState: number[] = [];
  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly id: string,
    readonly dimension: number,
    readonly notice: (message: string) => void,
  ) {}

  update(view: View) {
    this.overlays = view.overlays;
    const overlayKey = markerLayers
      .map(([kind]) => !!view.overlays[kind])
      .join();
    if (overlayKey !== this.overlayKey) this.drawDirty = true;
    this.overlayKey = overlayKey;
    const layers = markerLayers
      .filter(([kind]) => kind !== "spawn" && view.overlays[kind])
      .map(([kind]) => kind);
    const cx = Math.floor(view.x / 16),
      cz = Math.floor(view.z / 16);
    const bounds = {
      min_x: cx - view.radius,
      max_x: cx + view.radius,
      min_z: cz - view.radius,
      max_z: cz + view.radius,
    };
    if (
      !this.view ||
      !contains(this.view, bounds) ||
      !contains(bounds, this.view)
    ) {
      this.view = bounds;
      this.drawDirty = true;
    }
    const key = JSON.stringify([view.revision, view.ready, layers]);
    const invalidated = key !== this.key;
    if (!invalidated && this.coverage && contains(this.coverage, bounds))
      return;
    if (!invalidated && (!view.ready || !layers.length)) return;
    this.key = key;
    this.request?.abort();
    clearTimeout(this.timer);
    if (invalidated) {
      this.items = [];
      this.groups = [];
      this.coverage = undefined;
      this.drawDirty = true;
      this.notice("");
    }
    if (!view.ready || !layers.length) return;
    // Reuse the same snapshot while the visible range stays inside this small buffer.
    const margin = Math.max(1, Math.min(4, Math.ceil(view.radius / 4)));
    const coverage = {
      min_x: bounds.min_x - margin,
      max_x: bounds.max_x + margin,
      min_z: bounds.min_z - margin,
      max_z: bounds.max_z + margin,
    };
    this.coverage = coverage;
    this.items = this.items.filter((marker) => inBounds(marker, coverage));
    const controller = new AbortController();
    this.request = controller;
    this.timer = setTimeout(() => {
      void this.load(view, layers, coverage, controller);
    }, 220);
  }

  private async load(
    view: View,
    layers: string[],
    bounds: Bounds,
    controller: AbortController,
  ) {
    const collected = new Map<string, MapMarker>();
    const retained = this.items;
    const publish = (complete: boolean) => {
      const visible = new Map<string, MapMarker>(
        complete ? [] : retained.map((marker) => [marker.id, marker]),
      );
      for (const [id, marker] of collected) visible.set(id, marker);
      this.items = [...visible.values()].slice(0, 100000);
      this.drawDirty = true;
    };
    let cursor: number | null = 0,
      truncated = false,
      unreadable = 0;
    let lastPublish = 0;
    try {
      do {
        const page: Page = await api<Page>(
          `/documents/${this.id}/chunks/markers`,
          "POST",
          {
            dimension: this.dimension,
            revision: view.revision,
            ...bounds,
            layers,
            cursor,
            page_size: 8,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        for (let i = 0; i < page.items.length; i++) {
          const marker = page.items[i];
          collected.set(marker.id, marker);
          if (collected.size >= 100000) {
            truncated = true;
            break;
          }
          if (i && i % 512 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (controller.signal.aborted) return;
          }
        }
        truncated ||= page.truncated;
        unreadable += page.unreadable;
        cursor = page.next_cursor ?? null;
        if (
          Date.now() - lastPublish >= 100 ||
          cursor === null ||
          collected.size >= 100000
        ) {
          publish(cursor === null || collected.size >= 100000);
          lastPublish = Date.now();
        }
        if (collected.size >= 100000) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } while (cursor !== null && !controller.signal.aborted);
      if (controller.signal.aborted) return;
      this.notice(
        truncated
          ? "信息图层仅显示部分位置，请缩小渲染距离"
          : unreadable
            ? "部分信息记录无法读取"
            : "",
      );
    } catch (error) {
      if (!controller.signal.aborted) this.notice((error as Error).message);
    }
  }

  draw(
    camera: THREE.Camera,
    ox: number,
    oz: number,
    width: number,
    height: number,
    spawn: { x: number; y?: number; z: number } | null | undefined,
    ceiling: number,
  ) {
    const state = [
      ox,
      oz,
      width,
      height,
      ceiling,
      spawn?.x ?? NaN,
      spawn?.y ?? NaN,
      spawn?.z ?? NaN,
      ...camera.matrixWorldInverse.elements,
      ...camera.projectionMatrix.elements,
    ];
    if (
      !this.drawDirty &&
      this.canvas.width === width &&
      this.canvas.height === height &&
      state.every((value, i) => Object.is(value, this.drawState[i]))
    )
      return;
    this.drawState = state;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    this.drawDirty = false;
    ctx.clearRect(0, 0, width, height);
    const cells = new Map<string, MarkerGroup>();
    const all =
      spawn && this.dimension === 0
        ? [
            ...this.items,
            {
              id: "spawn",
              kind: "spawn" as const,
              label: "世界出生点",
              object_ref: "spawn",
              x: spawn.x,
              y:
                spawn.y !== undefined && spawn.y >= -64 && spawn.y <= 319
                  ? spawn.y
                  : 64,
              z: spawn.z,
            },
          ]
        : this.items;
    for (const marker of all) {
      if (!this.overlays[marker.kind]) continue;
      if (marker.kind !== "spawn" && this.view && !inBounds(marker, this.view))
        continue;
      const y = marker.y ?? 64;
      if (y > ceiling) continue;
      const point = projectMarker(
        marker.x,
        y,
        marker.z,
        camera,
        ox,
        oz,
        width,
        height,
      );
      if (marker.area) {
        const a = marker.area;
        const corners = [
          [a.min_x, a.min_z],
          [a.max_x + 1, a.min_z],
          [a.max_x + 1, a.max_z + 1],
          [a.min_x, a.max_z + 1],
        ];
        ctx.strokeStyle = markerStyle(marker).color;
        ctx.lineWidth = 1;
        // Clip each edge at the camera's near/far planes before projecting.
        const matrix = new THREE.Matrix4().multiplyMatrices(
          camera.projectionMatrix,
          camera.matrixWorldInverse,
        );
        for (let i = 0; i < 4; i++) {
          const start = corners[i],
            end = corners[(i + 1) % 4];
          const a = new THREE.Vector4(
            start[0] - ox,
            y,
            start[1] - oz,
            1,
          ).applyMatrix4(matrix);
          const b = new THREE.Vector4(
            end[0] - ox,
            y,
            end[1] - oz,
            1,
          ).applyMatrix4(matrix);
          let low = 0,
            high = 1;
          for (const sign of [-1, 1]) {
            const da = a.w + sign * a.z,
              db = b.w + sign * b.z;
            if (da < 0 && db < 0) {
              high = -1;
              break;
            }
            if (da < 0) low = Math.max(low, da / (da - db));
            if (db < 0) high = Math.min(high, da / (da - db));
          }
          if (low > high) continue;
          const p = a.clone().lerp(b, low),
            q = a.clone().lerp(b, high);
          ctx.beginPath();
          ctx.moveTo(
            ((p.x / p.w + 1) * width) / 2,
            ((1 - p.y / p.w) * height) / 2,
          );
          ctx.lineTo(
            ((q.x / q.w + 1) * width) / 2,
            ((1 - q.y / q.w) * height) / 2,
          );
          ctx.stroke();
        }
      }
      if (
        !point ||
        point.x < -16 ||
        point.y < -16 ||
        point.x > width + 16 ||
        point.y > height + 16
      )
        continue;
      const key = `${Math.floor(point.x / 28)},${Math.floor(point.y / 28)}`;
      const group = cells.get(key);
      if (group) {
        const n = group.members.length;
        group.x = (group.x * n + point.x) / (n + 1);
        group.y = (group.y * n + point.y) / (n + 1);
        group.members.push(marker);
      } else cells.set(key, { ...point, members: [marker] });
    }
    this.groups = [...cells.values()];
    for (const group of this.groups) {
      const { color, icon, symbol } = markerStyle(group.members[0]);
      const { x, y } = group;
      ctx.fillStyle = "#1c242b";
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      let image = icon ? this.images.get(icon) : undefined;
      if (icon && !image) {
        image = new Image();
        image.onload = () => {
          this.drawDirty = true;
        };
        image.src = icon;
        this.images.set(icon, image);
      }
      ctx.font = "bold 12px Segoe UI, Segoe UI Emoji";
      ctx.textAlign = "center";
      ctx.fillStyle = color;
      if (image?.complete && image.naturalWidth)
        ctx.drawImage(image, x - 10, y - 10, 20, 20);
      else ctx.fillText(symbol, x, y + 4);
      if (group.members.length > 1) {
        const text = String(group.members.length);
        ctx.fillStyle = "#1c242b";
        ctx.fillRect(x + 5, y + 1, text.length * 8 + 4, 16);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.fillText(text, x + 7, y + 14);
      }
    }
  }

  hit(x: number, y: number) {
    return hitMarker(this.groups, x, y);
  }

  dispose() {
    this.request?.abort();
    clearTimeout(this.timer);
    this.items = [];
    this.groups = [];
    for (const image of this.images.values()) image.onload = null;
    this.images.clear();
    this.canvas.remove();
  }
}
