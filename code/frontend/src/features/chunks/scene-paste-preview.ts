import * as THREE from "three";
import { beginLoading } from "@/lib/loading";
import { config } from "@/lib/api";
import { repeatAtlas, amuletMaterials } from "./scene-material";
import type { Atlas, MeshPart, VoxelPoint } from "./scene-data";
import { identityTransform, type PasteTransform } from "./scene-transform";

export class ScenePastePreview {
  readonly root = new THREE.Group();
  private worker: Worker | null = null;
  private request: AbortController | null = null;
  private materials: THREE.MeshBasicMaterial[];
  private lowY = 0;
  private lowX = 0;
  private lowZ = 0;
  private cache = new Map<string, { meshes: THREE.Mesh[]; bytes: number }>();
  private cacheBytes = 0;
  private budget = 64 * 1024 ** 2;
  private wanted = new Set<string>();
  private wantedKey = "";
  private viewKey = "";
  private lastLoad = 0;
  private finishLoading: (() => void) | null = null;
  private serial = 0;
  private readySession: string | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readyTransform: string | null = null;
  constructor(
    private atlas: Atlas,
    texture: THREE.Texture,
    private state: (ready: boolean, error?: string) => void,
  ) {
    this.materials = [0.55, 0.55, 0.4].map((opacity) =>
      repeatAtlas(
        new THREE.MeshBasicMaterial({
          map: texture,
          vertexColors: true,
          transparent: true,
          opacity,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
        }),
        atlas.size,
      ),
    );
    if (atlas.amulet) {
      const direct = amuletMaterials();
      direct.forEach((material) => {
        material.map = texture;
        material.transparent = true;
        material.opacity = 0.55;
        material.depthWrite = false;
        material.side = THREE.DoubleSide;
        material.polygonOffset = true;
        material.polygonOffsetFactor = -2;
      });
      this.materials.push(...direct);
    }
    this.root.renderOrder = 15;
  }
  async load(
    id: string,
    revision: number,
    transform: PasteTransform = identityTransform(),
    skipUnsupported = false,
    camera?: { x: number; y: number; z: number },
    renderDistance = 12,
    origin?: { x: number; y: number; z: number },
  ) {
    const session = JSON.stringify([id, revision, transform, skipUnsupported]);
    const sameTransform = this.readySession === session;
    this.cancel();
    if (!sameTransform) this.clearGeometry();
    if (!sameTransform) {
      this.readyTransform = null;
      this.readySession = null;
    }
    this.viewKey = this.key(
      id,
      revision,
      transform,
      skipUnsupported,
      camera,
      renderDistance,
      origin,
    );
    this.lastLoad = Date.now();
    if (camera && sameTransform) {
      this.syncView(camera, renderDistance, origin);
      if ([...this.wanted].every((key) => this.cache.has(key))) {
        this.state(true);
        return;
      }
    }
    if (sameTransform && this.cacheBytes > this.budget / 2) {
      // Reserve room for newly entered chunks, evicting only offscreen geometry.
      this.trimCache(this.budget / 2);
    }
    const cached = sameTransform
      ? [...this.cache.keys()].map((key) => key.split(",").map(Number))
      : [];
    this.finishLoading = beginLoading();
    const serial = this.serial;
    const controller = new AbortController();
    this.request = controller;
    this.state(sameTransform);
    const watch = () => {
      if (this.watchdog !== null) clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        if (serial !== this.serial) return;
        this.cancel();
        this.state(
          this.readySession === session,
          "预览生成超时，请重新打开粘贴预览",
        );
      }, 60_000);
    };
    watch();
    try {
      const { token, resources } = await config();
      if (resources) {
        const heap =
          typeof performance === "undefined"
            ? undefined
            : (
                performance as Performance & {
                  memory?: { jsHeapSizeLimit: number };
                }
              ).memory?.jsHeapSizeLimit;
        this.budget =
          Math.max(
            16,
            Math.min(
              resources.display_mb / 4,
              heap ? (heap / 1024 ** 2) * 0.1 : 384,
            ),
          ) *
          1024 ** 2;
      }
      if (controller.signal.aborted || serial !== this.serial) return;
      const view = camera
        ? `&camera_x=${camera.x}&camera_y=${camera.y}&camera_z=${camera.z}&origin_x=${origin?.x ?? 0}&origin_y=${origin?.y ?? 0}&origin_z=${origin?.z ?? 0}&render_distance=${renderDistance}`
        : "";
      const response = await fetch(
        `/api/documents/${id}/chunks/voxels/clipboard/preview?revision=${revision}&rx=${transform.rotation[0]}&ry=${transform.rotation[1]}&rz=${transform.rotation[2]}&mx=${transform.mirror[0]}&my=${transform.mirror[1]}&mz=${transform.mirror[2]}&axis_order=${transform.axisOrder ?? "xyz"}&scale=${transform.scale ?? 1}&skip_unsupported=${skipUnsupported}${view}`,
        {
          method: "POST",
          body: JSON.stringify({ cached }),
          signal: controller.signal,
          headers: {
            "X-Editor-Token": token,
            "Content-Type": "application/json",
          },
        },
      );
      if (!response.ok) {
        const data = await response.json();
        throw new Error(
          typeof data.detail === "string" ? data.detail : "无法读取粘贴预览",
        );
      }
      const buffer = await response.arrayBuffer();
      if (controller.signal.aborted || serial !== this.serial) return;
      const worker = new Worker(
        new URL("./paste-preview.worker.ts", import.meta.url),
        { type: "module" },
      );
      this.worker = worker;
      watch();
      worker.onmessage = (event) => {
        if (serial !== this.serial) return;
        watch();
        const result = event.data;
        const done = result.partial !== true;
        if (done || result.error) {
          worker.terminate();
          this.worker = null;
        }
        if (result.error) {
          this.complete();
          this.state(this.readySession === session, result.error);
          return;
        }
        try {
          this.lowY = result.low[1];
          this.lowX = result.low[0];
          this.lowZ = result.low[2];
          for (const chunk of result.chunks as {
            x: number;
            z: number;
            parts: MeshPart[];
          }[]) {
            const key = `${Math.round((chunk.x + this.lowX) / 16)},${Math.round((chunk.z + this.lowZ) / 16)}`;
            if (this.cache.has(key)) continue;
            const entry = { meshes: [] as THREE.Mesh[], bytes: 0 };
            for (const part of chunk.parts) {
              const geometry = new THREE.BufferGeometry();
              for (const [key, array, size] of [
                ["position", part.positions, 3],
                ["normal", part.normals, 3],
                ["uv", part.uvs, 2],
                ["color", part.colors, 3],
                ["voxelTile", part.tiles, 2],
              ] as const)
                geometry.setAttribute(
                  key,
                  new THREE.BufferAttribute(array, size),
                );
              const mesh = new THREE.Mesh(geometry, this.materials[part.kind]);
              mesh.position.set(chunk.x, -this.lowY, chunk.z);
              mesh.renderOrder = 15;
              this.root.add(mesh);
              entry.meshes.push(mesh);
              entry.bytes +=
                part.positions.byteLength +
                part.normals.byteLength +
                part.uvs.byteLength +
                part.colors.byteLength +
                part.tiles.byteLength;
            }
            this.cache.set(key, entry);
            this.cacheBytes += entry.bytes;
          }
          if (done && !result.truncated && camera) {
            // Missing terrain is implicit air; remember empty positions too.
            const covered = this.range(camera, renderDistance, origin);
            for (const key of covered)
              if (!this.cache.has(key))
                this.cache.set(key, { meshes: [], bytes: 0 });
          }
          if (camera) this.syncView(camera, renderDistance, origin, true);
          if (
            !this.root.children.some(
              (child) => child instanceof THREE.LineSegments,
            )
          ) {
            const box = new THREE.BoxGeometry(
              ...(result.size as [number, number, number]),
            );
            const edges = new THREE.EdgesGeometry(box);
            box.dispose();
            const outline = new THREE.LineSegments(
              edges,
              new THREE.LineBasicMaterial({
                color: 0x58edff,
                depthTest: false,
              }),
            );
            outline.position.set(
              result.size[0] / 2,
              result.size[1] / 2,
              result.size[2] / 2,
            );
            outline.renderOrder = 16;
            this.root.add(outline);
          }
          if (result.chunks.length || done) {
            this.readyTransform = JSON.stringify(transform);
            this.readySession = session;
            this.state(true);
          }
          if (done) this.complete();
        } catch (error) {
          this.clear();
          this.state(false, (error as Error).message);
        }
      };
      const failWorker = () => {
        if (serial === this.serial) {
          this.cancel();
          this.state(
            this.readySession === session,
            "粘贴模型预览生成失败，请重新打开粘贴预览",
          );
        }
      };
      worker.onerror = failWorker;
      worker.onmessageerror = failWorker;
      worker.postMessage(
        {
          buffer,
          atlas: this.atlas,
          budget: Math.max(
            0,
            Math.min(this.budget / 2, this.budget - this.cacheBytes),
          ),
        },
        [buffer],
      );
    } catch (error) {
      if (!controller.signal.aborted && serial === this.serial) {
        this.complete();
        this.state(this.readySession === session, (error as Error).message);
      }
    }
  }
  position(origin: VoxelPoint, x: number, z: number) {
    this.root.position.set(origin.x - x, origin.y, origin.z - z);
  }
  isReadyFor(transform: PasteTransform) {
    return this.readyTransform === JSON.stringify(transform);
  }
  private key(
    id: string,
    revision: number,
    transform: PasteTransform,
    skip: boolean,
    camera?: VoxelPoint,
    radius = 12,
    origin?: VoxelPoint,
  ) {
    return JSON.stringify([
      id,
      revision,
      transform,
      skip,
      radius,
      Math.floor(((camera?.x ?? 0) - (origin?.x ?? 0) + this.lowX) / 16),
      Math.floor(((camera?.z ?? 0) - (origin?.z ?? 0) + this.lowZ) / 16),
    ]);
  }
  updateView(
    id: string,
    revision: number,
    transform: PasteTransform,
    skip: boolean,
    camera: VoxelPoint,
    radius: number,
    origin: VoxelPoint,
  ) {
    this.syncView(camera, radius, origin);
    if (this.request || Date.now() - this.lastLoad < 350) return;
    if (
      this.key(id, revision, transform, skip, camera, radius, origin) !==
      this.viewKey
    )
      void this.load(id, revision, transform, skip, camera, radius, origin);
  }
  private range(camera: VoxelPoint, radius: number, origin?: VoxelPoint) {
    const cx = Math.floor((camera.x - (origin?.x ?? 0) + this.lowX) / 16);
    const cz = Math.floor((camera.z - (origin?.z ?? 0) + this.lowZ) / 16);
    const result: string[] = [];
    for (let x = cx - radius; x <= cx + radius; x++)
      for (let z = cz - radius; z <= cz + radius; z++) result.push(`${x},${z}`);
    return result;
  }
  private syncView(
    camera: VoxelPoint,
    radius: number,
    origin?: VoxelPoint,
    force = false,
  ) {
    const viewKey = `${Math.floor((camera.x - (origin?.x ?? 0) + this.lowX) / 16)},${Math.floor((camera.z - (origin?.z ?? 0) + this.lowZ) / 16)},${radius}`;
    if (!force && viewKey === this.wantedKey) return;
    this.wantedKey = viewKey;
    this.wanted = new Set(this.range(camera, radius, origin));
    for (const [key, entry] of this.cache) {
      const visible = this.wanted.has(key);
      for (const mesh of entry.meshes) mesh.visible = visible;
    }
    this.trimCache(this.budget);
  }
  private trimCache(budget: number) {
    for (const [key, entry] of this.cache) {
      if (this.cacheBytes <= budget && this.cache.size <= 8192) break;
      if (this.wanted.has(key)) continue;
      this.cache.delete(key);
      this.cacheBytes -= entry.bytes;
      for (const mesh of entry.meshes) {
        mesh.geometry.dispose();
        this.root.remove(mesh);
      }
    }
  }
  private complete() {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.request = null;
    this.finishLoading?.();
    this.finishLoading = null;
  }
  private cancel() {
    this.serial++;
    this.request?.abort();
    this.worker?.terminate();
    this.worker = null;
    this.complete();
  }
  clear() {
    this.cancel();
    this.readyTransform = null;
    this.readySession = null;
    this.viewKey = "";
    this.clearGeometry();
    this.lowX = this.lowZ = 0;
  }
  private clearGeometry() {
    this.cache.clear();
    this.cacheBytes = 0;
    this.wanted.clear();
    this.wantedKey = "";
    for (const child of [...this.root.children]) {
      (child as THREE.Mesh).geometry.dispose();
      if (child instanceof THREE.LineSegments)
        (child.material as THREE.Material).dispose();
      this.root.remove(child);
    }
  }
  dispose() {
    this.clear();
    this.materials.forEach((material) => material.dispose());
  }
}
