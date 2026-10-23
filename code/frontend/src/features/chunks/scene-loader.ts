import * as THREE from "three";
import { beginLoading } from "@/lib/loading";
import { config } from "@/lib/api";
import {
  renderRange,
  type Atlas,
  type MeshPart,
  type VoxelChunk,
} from "./scene-data";
import { repeatAtlas, amuletMaterials } from "./scene-material";
interface Entry {
  x: number;
  z: number;
  group: THREE.Group;
  bytes: number;
  geometryBytes: number;
  missing: boolean;
  failed: boolean;
  budgetFailed?: boolean;
  requiredBytes?: number;
  requiredSnapshotBytes?: number;
  ticket?: number;
  buffer?: ArrayBuffer;
  chunk?: VoxelChunk;
  meshed?: boolean;
  dirty?: boolean;
  retries?: number;
}
interface Job {
  kind: "load" | "mesh";
  key: string;
  serial: number;
  generation: number;
  ticket?: number;
  job: number;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}
export class SceneLoader {
  readonly root = new THREE.Group();
  readonly entries = new Map<string, Entry>();
  private workers: Worker[] = [];
  private busy = new Map<Worker, Job>();
  private get working(): string | null {
    return this.busy.values().next().value?.key ?? null;
  }
  private requestLimit = 2;
  private decoding = new Set<string>();
  private job = 0;
  private pumping = false;
  private repump = false;
  private transient = 0;
  private workerCount = 1;
  private workerCaches = new Map<Worker, number>();
  private get usage() {
    return (
      this.cpu +
      this.gpu * 2 +
      this.transient +
      [...this.workerCaches.values()].reduce((n, bytes) => n + bytes, 0)
    );
  }
  private queue: string[] = [];
  private meshQueue = new Set<string>();
  private wanted = new Set<string>();
  private requests = new Map<string, AbortController>();
  private serial = 0;
  private generation = 0;
  private ticket = 0;
  private disposed = false;
  private finishLoading: (() => void) | null = null;
  private center = "";
  private view?: { x: number; z: number; radius: number };
  private radiusLimit = Infinity;
  private errors = new Set<string>();
  private ceiling = 2047;
  private budget = 256 * 1024 * 1024;
  private resourceBudget?: number;
  private qualityBudget = 256;
  private cpu = 0;
  private gpu = 0;
  private origin = { x: 0, z: 0 };
  private materials: THREE.MeshBasicMaterial[];
  private atlas: Atlas;
  constructor(
    readonly id: string,
    public revision: number,
    readonly dimension: number,
    atlas: Atlas,
    texture: THREE.Texture,
    readonly status: (s: string) => void,
    readonly fail: (s: string) => void,
  ) {
    this.atlas = atlas;
    this.materials = [
      new THREE.MeshBasicMaterial({ map: texture, vertexColors: true }),
      new THREE.MeshBasicMaterial({
        map: texture,
        vertexColors: true,
        alphaTest: 0.45,
        side: THREE.DoubleSide,
      }),
      new THREE.MeshBasicMaterial({
        map: texture,
        vertexColors: true,
        transparent: true,
        opacity: 0.62,
        alphaTest: 0.02,
        depthWrite: false,
        side: THREE.FrontSide,
      }),
    ];
    this.materials.forEach((material) => repeatAtlas(material, atlas.size));
    if (atlas.amulet) {
      const direct = amuletMaterials();
      direct.forEach((material) => {
        material.map = texture;
      });
      this.materials.push(...direct);
    }
    const hardware =
      typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency || 1;
    const memory =
      typeof navigator === "undefined"
        ? 1
        : ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ??
          4);
    // A small shared pool takes the nearest unfinished job on any idle worker.
    const count = Math.max(
      1,
      Math.min(
        8,
        Math.floor(hardware * 0.9),
        Math.floor((memory * 0.9 * 1024) / 128),
      ),
    );
    this.requestLimit = Math.max(2, Math.min(16, count * 2));
    this.workerCount = count;
    for (let i = 0; i < count; i++) {
      this.workers.push(this.createWorker());
    }
    void config()
      .then(({ resources }) => {
        if (!resources || this.disposed) return;
        const heap =
          typeof performance === "undefined"
            ? undefined
            : (
                performance as Performance & {
                  memory?: { jsHeapSizeLimit: number };
                }
              ).memory?.jsHeapSizeLimit;
        this.resourceBudget = Math.max(
          32,
          Math.min(
            resources.display_mb,
            heap ? (heap / 1024 ** 2) * 0.35 : 1536,
          ),
        );
        this.setBudget(this.qualityBudget);
      })
      .catch(() => {});
  }
  private createWorker() {
    const worker = new Worker(
      new URL("./voxel-mesher.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.postMessage({
      kind: "init",
      atlas: this.atlas,
      modelBudget: this.modelBudget,
    });
    worker.onmessage = (e) => this.receive(worker, e);
    worker.onerror = () => this.restart(worker, "区块网格线程失败");
    return worker;
  }
  private get modelBudget() {
    return Math.min(8 * 1024 ** 2, (this.budget * 0.1) / this.workerCount);
  }
  private release(worker: Worker) {
    const task = this.busy.get(worker);
    if (task) {
      clearTimeout(task.timer);
      this.transient -= task.bytes;
      this.busy.delete(worker);
    }
    return task;
  }
  private restart(worker: Worker, message: string) {
    if (this.disposed || !this.workers.includes(worker)) return;
    const task = this.release(worker);
    this.workerCaches.delete(worker);
    worker.terminate();
    this.workers[this.workers.indexOf(worker)] = this.createWorker();
    const entry = task && this.entries.get(task.key);
    if (entry && entry.ticket === task.ticket) {
      if (task.kind === "mesh" && (entry.retries ?? 0) < 1) {
        entry.retries = (entry.retries ?? 0) + 1;
        this.meshQueue.add(task.key);
      } else {
        if (task.kind === "load") {
          this.cpu -= entry.bytes;
          entry.bytes = 0;
        }
        entry.failed = true;
        this.errors.add(task.key);
        if (!entry.meshed) this.marker(entry);
        this.fail(`区块 ${task.key}：${message}`);
      }
    }
    this.pump();
    this.report();
  }
  private receive(worker: Worker, e: MessageEvent) {
    if (this.disposed || !this.workers.includes(worker)) return;
    const data = e.data,
      entry = this.entries.get(data.key);
    if (data.kind === "cache") {
      this.workerCaches.set(worker, data.bytes);
      this.pump();
      this.report();
      return;
    }
    const task = this.busy.get(worker);
    if (
      task &&
      (data.kind === "mesh" ||
        data.kind === "loaded" ||
        data.kind === "progress" ||
        data.kind === "cancelled" ||
        data.kind === "error") &&
      task.key === data.key &&
      task.job === data.job &&
      task.ticket === data.ticket &&
      task.serial === data.serial &&
      task.generation === data.generation
    ) {
      if (data.kind === "progress") {
        clearTimeout(task.timer);
        task.timer = setTimeout(
          () => this.restart(worker, "区块加载超时"),
          30000,
        );
        this.workerCaches.set(worker, data.cacheBytes ?? 0);
        return;
      }
      this.release(worker);
    } else return;
    this.workerCaches.set(worker, data.cacheBytes ?? 0);
    if (
      (data.generation !== undefined && data.generation !== this.generation) ||
      (data.ticket !== undefined && data.ticket !== entry?.ticket)
    ) {
      this.pump();
      return;
    }
    if (task.kind === "mesh" && data.serial !== this.serial) {
      if (entry) this.remeshAround(entry.x, entry.z);
      this.pump();
      return;
    }
    if (data.kind === "loaded") {
      if (!entry) return;
      this.cpu -= entry.bytes;
      entry.bytes = data.bytes;
      entry.chunk = data.chunk;
      this.cpu += entry.bytes;
      entry.missing = data.missing;
      if (data.errors.length) {
        entry.failed = true;
        this.errors.add(data.key);
        this.marker(entry);
        this.fail(`区块 ${data.key}：${data.errors.join("；")}`);
      }
      this.remeshAround(entry.x, entry.z);
    } else if (data.kind === "mesh") {
      if (entry && data.serial === this.serial && !entry.failed)
        this.install(entry, data.parts);
    } else if (data.kind === "cancelled") {
      if (entry && this.wanted.has(data.key)) this.meshQueue.add(data.key);
    } else if (data.kind === "error") {
      if (entry) {
        if (task.kind === "mesh" && (entry.retries ?? 0) < 1) {
          entry.retries = (entry.retries ?? 0) + 1;
          this.meshQueue.add(data.key);
          this.pump();
          this.report();
          return;
        }
        if (task.kind === "load") {
          this.cpu -= entry.bytes;
          entry.bytes = 0;
        }
        entry.failed = true;
        if (!entry.meshed) this.marker(entry);
        this.errors.add(data.key);
      }
      this.fail(`区块 ${data.key}：${data.message}`);
    }
    this.pump();
    this.report();
  }
  private neighbors(key: string) {
    const [x, z] = key.split(",").map(Number);
    return [
      key,
      `${x - 1},${z}`,
      `${x + 1},${z}`,
      `${x},${z - 1}`,
      `${x},${z + 1}`,
      ...(this.atlas.source?.bedrock
        ? [
            `${x - 1},${z - 1}`,
            `${x - 1},${z + 1}`,
            `${x + 1},${z - 1}`,
            `${x + 1},${z + 1}`,
          ]
        : []),
    ];
  }
  setOrigin(x: number, z: number) {
    this.origin = { x, z };
    for (const entry of this.entries.values())
      entry.group.position.set(entry.x * 16 - x, 0, entry.z * 16 - z);
  }
  setBrightness(value: number) {
    // Directional shading is baked into vertex colours, as in a world editor.
    // Keep cave surfaces readable without applying a second directional light.
    this.materials.forEach((material) =>
      material.color.setScalar(0.35 + value * 0.65),
    );
  }
  setRevision(
    revision: number,
    changes?: { base_revision: number; chunks: { x: number; z: number }[] },
  ) {
    if (revision === this.revision) return;
    const targets =
      changes?.base_revision === this.revision
        ? new Set(changes.chunks.map(({ x, z }) => `${x},${z}`))
        : new Set(this.entries.keys());
    this.revision = revision;
    this.serial++;
    this.generation++;
    for (const [worker, task] of this.busy)
      worker.postMessage({ kind: "cancel", job: task.job });
    for (const task of this.busy.values()) this.meshQueue.add(task.key);
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    for (const [key, entry] of this.entries)
      if (targets.has(key) || !entry.chunk) this.drop(key, entry);
    this.center = "";
    if (this.view) this.update(this.view.x, this.view.z, this.view.radius);
  }
  private drop(key: string, entry: Entry) {
    this.cpu -= entry.bytes;
    this.clearGeometry(entry);
    this.root.remove(entry.group);
    this.entries.delete(key);
    this.meshQueue.delete(key);
    this.errors.delete(key);
    this.decoding.delete(key);
    for (const [worker, task] of this.busy)
      if (task.key === key)
        worker.postMessage({ kind: "cancel", job: task.job });
    this.remeshAround(entry.x, entry.z);
  }
  setBudget(mb: number) {
    const previous = this.budget;
    this.qualityBudget = mb;
    // A larger requested range contains quadratically more chunks. Let it use
    // more of the display allowance instead of always shrinking to the same
    // quality-only range. This is a limit, not an eager memory allocation.
    const area = ((2 * (this.view?.radius ?? 4) + 1) / 9) ** 2;
    const base =
      this.resourceBudget === undefined
        ? mb
        : this.resourceBudget * Math.min(1, mb / 512);
    this.budget =
      Math.min(this.resourceBudget ?? 1536, base * area) * 1024 ** 2;
    for (const worker of this.workers)
      worker.postMessage({ kind: "budget", bytes: this.modelBudget });
    if (this.budget > previous) {
      for (const [key, entry] of this.entries)
        if (entry.budgetFailed) {
          entry.failed = false;
          entry.budgetFailed = false;
          this.errors.delete(key);
          this.meshQueue.add(key);
        }
      if (this.view && Number.isFinite(this.radiusLimit)) {
        this.radiusLimit = Infinity;
        this.update(this.view.x, this.view.z, this.view.radius);
      }
    }
    this.pump();
  }
  setCeiling(y: number) {
    if (y === this.ceiling) return;
    this.ceiling = y;
    this.materials.forEach((material) => {
      material.clippingPlanes =
        y === 2047 ? [] : [new THREE.Plane(new THREE.Vector3(0, -1, 0), y + 1)];
      material.needsUpdate = true;
    });
    this.serial++;
    for (const [worker, task] of this.busy)
      if (task.kind === "mesh")
        worker.postMessage({ kind: "cancel", job: task.job });
    for (const [key, entry] of this.entries)
      if (entry.chunk && !entry.missing && !entry.failed)
        this.meshQueue.add(key);
    this.pump();
  }
  update(x: number, z: number, radius: number) {
    const distanceChanged = radius !== (this.view?.radius ?? 4);
    if (distanceChanged) this.radiusLimit = Infinity;
    this.view = { x, z, radius };
    const key = `${Math.floor(x / 16)},${Math.floor(z / 16)},${radius},${this.radiusLimit}`;
    if (key === this.center) return;
    this.center = key;
    const range = renderRange(x, z, radius).filter(
      (p) =>
        Math.max(
          Math.abs(p.x - Math.floor(x / 16)),
          Math.abs(p.z - Math.floor(z / 16)),
        ) <= this.radiusLimit,
    );
    this.wanted = new Set(range.map((p) => `${p.x},${p.z}`));
    for (const [id, request] of this.requests)
      if (!this.wanted.has(id)) {
        request.abort();
        this.requests.delete(id);
      }
    // Both camera projections use these same decoded sections and GPU meshes.
    // Keep offscreen entries until the shared display budget needs the space.
    for (const [id, entry] of this.entries) {
      if (!this.wanted.has(id) && (entry.failed || !entry.chunk))
        this.drop(id, entry);
      else {
        entry.group.visible = this.wanted.has(id);
        if (entry.group.visible && entry.dirty && entry.chunk && !entry.failed)
          this.meshQueue.add(id);
      }
    }
    for (const [worker, task] of this.busy)
      if (task.kind === "mesh" && !this.wanted.has(task.key)) {
        this.meshQueue.add(task.key);
        worker.postMessage({ kind: "cancel", job: task.job });
      }
    this.queue = range
      .map((p) => `${p.x},${p.z}`)
      .filter((id) => !this.entries.has(id) && !this.requests.has(id));
    if (distanceChanged) this.setBudget(this.qualityBudget);
    this.pump();
    this.report();
  }
  private remeshAround(x: number, z: number) {
    for (const key of this.neighbors(`${x},${z}`)) {
      const entry = this.entries.get(key);
      if (entry?.chunk && !entry.missing && !entry.failed) {
        entry.dirty = true;
        this.meshQueue.add(key);
      }
    }
  }
  private clearGeometry(entry: Entry) {
    for (const child of [...entry.group.children]) {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        if (child.userData.marker) (child.material as THREE.Material).dispose();
      }
      entry.group.remove(child);
    }
    this.gpu -= entry.geometryBytes;
    entry.geometryBytes = 0;
  }
  private marker(entry: Entry) {
    this.clearGeometry(entry);
  }
  private loadedFloor(entry: Entry) {
    const geometry = new THREE.PlaneGeometry(16, 16);
    const color =
      (((entry.x + entry.z) % 2) + 2) % 2 === 0 ? 0x9db9de : 0x889fca;
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    const floor =
      this.dimension === 0
        ? -64
        : this.dimension === 1 || this.dimension === 2
          ? 0
          : -2048;
    mesh.position.set(8, floor - 0.02, 8);
    mesh.userData.marker = true;
    mesh.userData.markerKind = "terrain";
    mesh.name = "loaded-chunk-floor";
    // Draw after the gray background and before all terrain, without depth conflicts.
    mesh.renderOrder = -1;
    entry.group.add(mesh);
    const bytes =
      Object.values(geometry.attributes).reduce(
        (n, attr) => n + attr.array.byteLength,
        0,
      ) + (geometry.index?.array.byteLength ?? 0);
    entry.geometryBytes += bytes;
    this.gpu += bytes;
  }
  setDisplayKinds(kinds: readonly string[]) {
    for (const entry of this.entries.values())
      for (const child of entry.group.children)
        child.visible =
          !entry.failed &&
          !entry.missing &&
          kinds.includes(child.userData.markerKind ?? "terrain");
  }
  private install(entry: Entry, parts: MeshPart[]) {
    // Every face consists of two triangles. Share its four vertices and pack
    // lighting attributes while retaining exact positions and texture values.
    const geometries = parts.map((p) => {
      const geometry = new THREE.BufferGeometry();
      if (p.kind >= 3) {
        // Amulet triangles are not required to form axis-aligned quads.
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(p.positions, 3),
        );
        geometry.setAttribute(
          "normal",
          new THREE.BufferAttribute(p.normals, 3),
        );
        geometry.setAttribute("uv", new THREE.BufferAttribute(p.uvs, 2));
        geometry.setAttribute("color", new THREE.BufferAttribute(p.colors, 3));
        // These triangles already have independent vertices. An identity index
        // duplicates memory and spends main-thread time without sharing vertices.
        return geometry;
      }
      const vertices = (p.positions.length / 3 / 6) * 4;
      for (const [name, values, size] of [
        ["position", p.positions, 3],
        ["normal", p.normals, 3],
        ["color", p.colors, 3],
        ["uv", p.uvs, 2],
        ["voxelTile", p.tiles, 2],
      ] as const) {
        const packed =
          name === "normal"
            ? new Int8Array(vertices * size)
            : name === "color"
              ? new Uint8Array(vertices * size)
              : new Float32Array(vertices * size);
        for (let face = 0; face < vertices / 4; face++)
          for (const [i, source] of [0, 1, 2, 4].entries())
            for (let c = 0; c < size; c++) {
              const value = values[(face * 6 + source) * size + c];
              packed[(face * 4 + i) * size + c] =
                name === "normal"
                  ? Math.round(value * 127)
                  : name === "color"
                    ? Math.round(value * 255)
                    : value;
            }
        geometry.setAttribute(
          name,
          new THREE.BufferAttribute(
            packed,
            size,
            name === "normal" || name === "color",
          ),
        );
      }
      const indices =
        vertices > 65536
          ? new Uint32Array((vertices / 4) * 6)
          : new Uint16Array((vertices / 4) * 6);
      for (let face = 0; face < vertices / 4; face++)
        indices.set(
          [0, 1, 2, 0, 3, 1].map((i) => face * 4 + i),
          face * 6,
        );
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      return geometry;
    });
    const hasFloor =
      !!entry.chunk &&
      !entry.missing &&
      !entry.failed &&
      !entry.chunk.sections.some((section) => section.error);
    // PlaneGeometry: four positions/normals/UVs plus six uint16 indices.
    const floorBytes = hasFloor ? 140 : 0;
    const bytes = geometries.reduce(
      (n, g) =>
        n +
        (g.index?.array.byteLength ?? 0) +
        Object.values(g.attributes).reduce((s, a) => s + a.array.byteLength, 0),
      floorBytes,
    );
    // Reserve the incoming mesh before deciding to reduce the visible range.
    // Hidden decoded chunks and meshes still consume the shared budget.
    const available = this.budget - (bytes - entry.geometryBytes) * 2;
    this.evictOffscreen(available);
    while (
      this.entries.get(`${entry.x},${entry.z}`) === entry &&
      this.usage + (bytes - entry.geometryBytes) * 2 > this.budget &&
      !this.busy.size &&
      this.shrinkRange()
    ) {
      this.evictOffscreen(available);
    }
    if (this.entries.get(`${entry.x},${entry.z}`) !== entry) {
      geometries.forEach((g) => g.dispose());
      return;
    }
    if (this.usage + (bytes - entry.geometryBytes) * 2 > this.budget) {
      geometries.forEach((g) => g.dispose());
      entry.budgetFailed = true;
      entry.requiredBytes = bytes;
      entry.requiredSnapshotBytes = 0;
      this.status("3D 内存预算不足，请缩短渲染距离或选择更高画质档位");
      return;
    }
    entry.budgetFailed = false;
    entry.meshed = true;
    entry.retries = 0;
    this.clearGeometry(entry);
    for (const [i, geometry] of geometries.entries()) {
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this.materials[parts[i].kind]);
      mesh.userData.voxel = true;
      mesh.userData.chunk = { x: entry.x, z: entry.z };
      entry.group.add(mesh);
    }
    entry.geometryBytes = bytes - floorBytes;
    this.gpu += bytes - floorBytes;
    if (hasFloor) this.loadedFloor(entry);
  }
  private evictOffscreen(limit: number) {
    if (!this.view) return;
    for (const [key, entry] of this.entries) {
      if (this.usage <= limit) break;
      if (!this.wanted.has(key)) this.drop(key, entry);
    }
  }
  private shrinkRange() {
    if (!this.view) return false;
    const radius = Math.min(this.view.radius, this.radiusLimit);
    if (radius <= 0) return false;
    this.radiusLimit = radius - 1;
    this.update(this.view.x, this.view.z, this.view.radius);
    return true;
  }
  private pump() {
    if (this.disposed) return;
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.repump = false;
        this.schedule();
      } while (this.repump && !this.disposed);
    } finally {
      this.pumping = false;
    }
    this.syncLoading();
  }
  private distance(key: string) {
    const [x, z] = key.split(",").map(Number);
    return this.view
      ? (x - Math.floor(this.view.x / 16)) ** 2 +
          (z - Math.floor(this.view.z / 16)) ** 2
      : 0;
  }
  private schedule() {
    const threshold = this.queue.length ? this.budget * 0.88 : this.budget;
    this.evictOffscreen(threshold);
    // Active snapshots are temporary. Let them finish before shrinking terrain.
    if (!this.busy.size && this.usage >= threshold && this.shrinkRange())
      return;
    for (const [key, entry] of this.entries) {
      if (!entry.budgetFailed) continue;
      const required =
        this.usage +
        (entry.requiredSnapshotBytes ?? 0) +
        ((entry.requiredBytes ?? entry.geometryBytes) - entry.geometryBytes) *
          2;
      if (required <= this.budget) {
        entry.budgetFailed = false;
        this.meshQueue.add(key);
      } else if (!this.busy.size && this.wanted.has(key) && this.shrinkRange())
        return;
    }
    const active = new Set([...this.busy.values()].map((task) => task.key));
    const meshes = [...this.meshQueue]
      .filter((key) => {
        const entry = this.entries.get(key);
        if (!entry || entry.failed || entry.missing || entry.budgetFailed) {
          this.meshQueue.delete(key);
          return false;
        }
        if (this.view && !this.wanted.has(key)) {
          entry.dirty = true;
          this.meshQueue.delete(key);
          return false;
        }
        if (
          entry.meshed &&
          this.view &&
          this.neighbors(key).some((id) => {
            const neighbor = this.entries.get(id);
            return this.wanted.has(id) && !neighbor?.chunk && !neighbor?.failed;
          })
        )
          return false;
        return (
          !!entry.chunk &&
          !active.has(key) &&
          (!this.view || this.wanted.has(key))
        );
      })
      .sort(
        (a, b) =>
          Number(!!this.entries.get(a)?.meshed) -
            Number(!!this.entries.get(b)?.meshed) ||
          this.distance(a) - this.distance(b),
      );
    const decodes = [...this.decoding]
      .filter((key) => !active.has(key))
      .sort((a, b) => this.distance(a) - this.distance(b));
    for (const worker of this.workers) {
      if (this.busy.has(worker)) continue;
      // Do not spend the pool on repeated boundary refinements while holes wait.
      const firstMesh = meshes[0] && !this.entries.get(meshes[0])?.meshed;
      const kind = firstMesh || !decodes.length ? "mesh" : "load";
      const key = kind === "load" ? decodes.shift() : meshes.shift();
      if (!key) break;
      const entry = this.entries.get(key)!;
      const chunks =
        kind === "mesh"
          ? this.neighbors(key).flatMap((id) => {
              const neighbor = this.entries.get(id);
              return neighbor?.chunk ? [[id, neighbor.chunk] as const] : [];
            })
          : [];
      const bytes =
        kind === "mesh"
          ? chunks.reduce(
              (total, [id]) => total + this.entries.get(id)!.bytes,
              0,
            )
          : 0;
      this.evictOffscreen(this.budget - bytes);
      if (this.entries.get(key) !== entry) continue;
      if (this.usage + bytes > this.budget) {
        if (!this.busy.size && this.shrinkRange()) return;
        if (!this.busy.size) {
          entry.budgetFailed = true;
          entry.requiredSnapshotBytes = bytes;
          entry.requiredBytes = undefined;
          this.meshQueue.delete(key);
        }
        break;
      }
      this.meshQueue.delete(key);
      if (kind === "mesh") entry.dirty = false;
      this.decoding.delete(key);
      const task = {
        kind,
        key,
        serial: this.serial,
        generation: this.generation,
        ticket: entry.ticket,
        job: ++this.job,
        bytes,
        timer: setTimeout(() => this.restart(worker, "区块加载超时"), 30000),
      } satisfies Job;
      this.busy.set(worker, task);
      this.transient += bytes;
      if (kind === "load") {
        const buffer = entry.buffer!;
        entry.buffer = undefined;
        worker.postMessage({ ...task, timer: undefined, buffer }, [buffer]);
      } else
        worker.postMessage({
          ...task,
          timer: undefined,
          chunks,
          ceiling: this.ceiling,
        });
    }
    while (
      this.requests.size < this.requestLimit &&
      this.requests.size +
        [...this.entries.values()].filter(
          (entry) => !entry.meshed && !entry.failed && !entry.missing,
        ).length <
        this.requestLimit &&
      this.queue.length &&
      this.usage < this.budget * 0.88
    ) {
      const key = this.queue.shift()!;
      if (!this.wanted.has(key) || this.entries.has(key)) continue;
      const controller = new AbortController();
      const generation = this.generation;
      const revision = this.revision;
      const ticket = ++this.ticket;
      this.requests.set(key, controller);
      const [x, z] = key.split(",").map(Number);
      const timer = setTimeout(() => {
        controller.abort(new Error("3D 区块读取超时"));
      }, 20000);
      controller.signal.addEventListener("abort", () => clearTimeout(timer), {
        once: true,
      });
      void config()
        .then(async ({ token }) => {
          if (controller.signal.aborted) return;
          const response = await fetch(
            `/api/documents/${this.id}/chunks/voxels?dimension=${this.dimension}&revision=${revision}&x=${x}&z=${z}`,
            { headers: { "X-Editor-Token": token }, signal: controller.signal },
          );
          if (!response.ok) {
            const error = await response
              .json()
              .catch(() => ({ detail: "3D 区块读取失败" }));
            throw new Error(
              typeof error.detail === "string" ? error.detail : "3D 数据无效",
            );
          }
          const buffer = await response.arrayBuffer();
          if (
            controller.signal.aborted ||
            this.disposed ||
            generation !== this.generation ||
            !this.wanted.has(key)
          )
            return;
          const group = new THREE.Group();
          group.position.set(x * 16 - this.origin.x, 0, z * 16 - this.origin.z);
          this.root.add(group);
          this.entries.set(key, {
            x,
            z,
            group,
            bytes: buffer.byteLength,
            geometryBytes: 0,
            missing: false,
            failed: false,
            ticket,
            buffer,
          });
          this.cpu += buffer.byteLength;
          this.decoding.add(key);
        })
        .catch((error) => {
          if (
            (!controller.signal.aborted ||
              controller.signal.reason?.message === "3D 区块读取超时") &&
            !this.disposed &&
            generation === this.generation &&
            this.wanted.has(key)
          ) {
            this.errors.add(key);
            this.fail((error as Error).message);
            const group = new THREE.Group();
            group.position.set(
              x * 16 - this.origin.x,
              0,
              z * 16 - this.origin.z,
            );
            this.root.add(group);
            const entry = {
              x,
              z,
              group,
              bytes: 0,
              geometryBytes: 0,
              missing: false,
              failed: true,
            };
            this.entries.set(key, entry);
            this.marker(entry);
          }
        })
        .finally(() => {
          clearTimeout(timer);
          if (this.requests.get(key) === controller) this.requests.delete(key);
          if (!this.disposed) {
            this.pump();
            this.report();
          }
        });
    }
  }
  private syncLoading() {
    const active =
      this.requests.size +
      this.decoding.size +
      this.busy.size +
      [...this.meshQueue].filter((key) => !this.view || this.wanted.has(key))
        .length;
    if (active && !this.finishLoading) this.finishLoading = beginLoading();
    if (!active) {
      this.finishLoading?.();
      this.finishLoading = null;
    }
  }
  get preloadProgress() {
    let loaded = 0,
      failed = 0;
    for (const key of this.wanted) {
      const entry = this.entries.get(key);
      if (entry?.failed || entry?.budgetFailed) failed++;
      else if (entry?.meshed || entry?.missing) loaded++;
    }
    return { loaded, total: this.wanted.size, failed };
  }
  private report() {
    const waiting =
      this.queue.length +
      this.requests.size +
      this.decoding.size +
      [...this.meshQueue].filter((key) => !this.view || this.wanted.has(key))
        .length +
      this.busy.size;
    this.syncLoading();
    this.status(
      `${waiting ? `加载中 · 余 ${waiting} 项` : `已读取 ${this.entries.size} 个位置`}${this.errors.size ? ` · ${this.errors.size} 个位置未完成` : ""}${Number.isFinite(this.radiusLimit) ? ` · 内存适配距离 ${this.radiusLimit}` : ""}${[...this.entries.values()].some((entry) => entry.budgetFailed) ? " · 内存预算不足，请提高档位" : ""}`,
    );
  }
  readable(x: number, z: number) {
    const e = this.entries.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
    return !!e && !e.failed && !e.missing && !!e.chunk;
  }
  blockName(x: number, y: number, z: number) {
    const entry = this.entries.get(
      `${Math.floor(x / 16)},${Math.floor(z / 16)}`,
    );
    if (!entry || entry.failed || entry.missing) return undefined;
    const section = entry.chunk?.sections.find(
      (s) => s.y === Math.floor(y / 16),
    );
    const index =
      (((x % 16) + 16) % 16) * 256 +
      (((z % 16) + 16) % 16) * 16 +
      (((y % 16) + 16) % 16);
    for (const layer of section?.layers ?? []) {
      const name =
        layer.palette[layer.indices[layer.indices.length === 1 ? 0 : index]]
          ?.name;
      if (name && name !== "minecraft:air") return name;
    }
    return undefined;
  }
  dispose() {
    this.disposed = true;
    this.finishLoading?.();
    this.finishLoading = null;
    this.requests.forEach((c) => c.abort());
    this.workers.forEach((worker) => {
      this.release(worker);
      worker.terminate();
    });
    this.workerCaches.clear();
    this.decoding.clear();
    for (const e of this.entries.values()) this.clearGeometry(e);
    this.entries.clear();
    this.materials.forEach((m) => m.dispose());
    this.root.clear();
  }
}
