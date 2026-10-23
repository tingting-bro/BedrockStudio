import * as THREE from "three";
import { api } from "@/lib/api";
import { minecraftIcon } from "@/lib/minecraft-icons";
import type { MapMarker } from "./marker-view";
import { entityGeometry, entityType, type EntityCatalog } from "./entity-model";

interface View {
  revision: number;
  ready: boolean;
  x: number;
  z: number;
  radius: number;
}
interface Page {
  items: MapMarker[];
  truncated: boolean;
  unreadable: number;
  next_cursor?: number | null;
}
interface Model {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshLambertMaterial;
}
interface Batch {
  mesh: THREE.InstancedMesh;
  members: MapMarker[];
}

function entityMaterial(texture: THREE.Texture, clip: THREE.Plane) {
  return new THREE.MeshLambertMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.1,
    depthWrite: true,
    side: THREE.DoubleSide,
    clippingPlanes: [clip],
  });
}

/** Real scene objects, independent of information overlays. One draw call per model. */
export class SceneEntities {
  readonly root = new THREE.Group();
  private catalog?: EntityCatalog;
  private lifetime = new AbortController();
  private request?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private key = "";
  private revision = -1;
  private items = new Map<string, MapMarker>();
  private models = new Map<string, Model>();
  private textures = new Map<string, THREE.Texture>();
  private pending = new Set<string>();
  private batches: Batch[] = [];
  private targets = new Map<
    string,
    { mesh: THREE.InstancedMesh; index: number }
  >();
  private dirty = false;
  private origin = { x: 0, z: 0 };
  private ceiling = 2047;
  private clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 2048);
  private placeholder: Model = {
    geometry: new THREE.BoxGeometry(0.6, 1, 0.6).translate(0, 0.5, 0),
    material: new THREE.MeshLambertMaterial({
      color: 0xd663d9,
      wireframe: true,
    }),
  };

  constructor(
    readonly id: string,
    readonly dimension: number,
    readonly notice: (message: string) => void,
    private resources?: { url: string; token: string },
  ) {
    this.placeholder.geometry.computeBoundingBox();
    this.placeholder.material.clippingPlanes = [this.clip];
    void this.loadCatalog();
  }

  private async loadCatalog() {
    try {
      const response = await fetch(
        this.resources
          ? `${this.resources.url}/entity-models`
          : "/minecraft/scene/entity-models.json",
        {
          signal: this.lifetime.signal,
          ...(this.resources
            ? { headers: { "X-Editor-Token": this.resources.token } }
            : {}),
        },
      );
      if (!response.ok)
        throw new Error("本地实体模型索引无法读取，使用占位模型");
      const catalog = (await response.json()) as EntityCatalog;
      if (this.lifetime.signal.aborted) return;
      this.catalog = catalog;
      this.dirty = true;
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.notice((error as Error).message);
    }
  }

  update(view: View, ox: number, oz: number, ceiling: number) {
    if (
      ox !== this.origin.x ||
      oz !== this.origin.z ||
      ceiling !== this.ceiling
    ) {
      this.origin = { x: ox, z: oz };
      this.ceiling = ceiling;
      this.clip.constant = ceiling + 1;
      this.dirty = true;
    }
    const cx = Math.floor(view.x / 16),
      cz = Math.floor(view.z / 16);
    const key = JSON.stringify([
      view.revision,
      view.ready,
      cx,
      cz,
      view.radius,
    ]);
    if (key !== this.key) {
      this.key = key;
      this.request?.abort();
      clearTimeout(this.timer);
      const generation = ++this.generation;
      if (view.revision !== this.revision || !view.ready) this.items.clear();
      this.revision = view.revision;
      for (const [id, item] of this.items) {
        if (!inRange(item, cx, cz, view.radius)) this.items.delete(id);
      }
      this.dirty = true;
      if (view.ready) {
        const controller = new AbortController();
        this.request = controller;
        this.timer = setTimeout(() => {
          void this.load(view, cx, cz, controller, generation);
        }, 180);
      }
    }
    if (this.dirty) {
      this.rebuild();
      this.dirty = false;
    }
  }

  private async load(
    view: View,
    cx: number,
    cz: number,
    controller: AbortController,
    generation: number,
  ) {
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
            min_x: cx - view.radius,
            max_x: cx + view.radius,
            min_z: cz - view.radius,
            max_z: cz + view.radius,
            layers: ["entities"],
            cursor,
            page_size: 8,
          },
          controller.signal,
        );
        if (controller.signal.aborted || generation !== this.generation) return;
        for (let i = 0; i < page.items.length; i++) {
          const marker = page.items[i];
          if (marker.kind === "entities" && marker.y !== null)
            this.items.set(marker.id, marker);
          if (i && i % 512 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (controller.signal.aborted) return;
          }
        }
        cursor = page.next_cursor ?? null;
        truncated ||= page.truncated;
        unreadable += page.unreadable;
        if (Date.now() - lastPublish >= 100 || cursor === null) {
          this.dirty = true;
          lastPublish = Date.now();
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } while (cursor !== null && !controller.signal.aborted);
      if (controller.signal.aborted) return;
      this.dirty = true;
      this.notice(
        truncated
          ? "部分实体记录超过读取预算，请缩小渲染距离"
          : unreadable
            ? "部分实体记录无法读取"
            : "",
      );
    } catch (error) {
      if (!controller.signal.aborted) this.notice((error as Error).message);
    }
  }

  private modelKey(item: MapMarker) {
    const type = entityType(item.object_type);
    return `${type}:${item.render?.baby ? "baby" : "adult"}:${item.render?.sheared ? "sheared" : ""}:${type === "minecraft:item" ? (item.icon_type ?? "") : ""}`;
  }

  private model(item: MapMarker): Model {
    const key = this.modelKey(item);
    const cached = this.models.get(key);
    if (cached) return cached;
    const definition = this.catalog?.entities[entityType(item.object_type)];
    const geometryId =
      item.render?.baby && definition?.baby_geometry
        ? definition.baby_geometry
        : item.render?.sheared && definition?.sheared_geometry
          ? definition.sheared_geometry
          : definition?.geometry;
    const model = geometryId ? this.catalog?.geometries[geometryId] : undefined;
    const itemIcon =
      entityType(item.object_type) === "minecraft:item"
        ? minecraftIcon(item.icon_type)
        : undefined;
    if ((!model && !itemIcon) || this.pending.has(key)) {
      const bounds = definition?.collision_box;
      if (bounds?.every((v) => Number.isFinite(v) && v > 0 && v <= 100)) {
        const geometry = new THREE.BoxGeometry(
          bounds[0],
          bounds[1],
          bounds[0],
        ).translate(0, bounds[1] / 2, 0);
        geometry.computeBoundingBox();
        const fallback = {
          geometry,
          material: this.placeholder.material.clone(),
        };
        this.models.set(key, fallback);
        return fallback;
      }
      return this.placeholder;
    }
    this.pending.add(key);
    let geometry: THREE.BufferGeometry;
    try {
      const babyTexture = item.render?.baby && definition?.baby_texture;
      geometry = itemIcon
        ? new THREE.PlaneGeometry(0.5, 0.5).translate(0, 0.3, 0)
        : entityGeometry(model!, {
            width: babyTexture
              ? (definition?.baby_texture_width ??
                definition?.texture_width ??
                64)
              : (definition?.texture_width ?? 64),
            height: babyTexture
              ? (definition?.baby_texture_height ??
                definition?.texture_height ??
                32)
              : (definition?.texture_height ?? 32),
          });
      geometry.computeBoundingBox();
    } catch {
      return this.placeholder;
    }
    const url =
      itemIcon ??
      (item.render?.baby && definition!.baby_texture
        ? definition!.baby_texture
        : definition!.texture);
    let texture = this.textures.get(url);
    if (!texture) {
      texture = new THREE.TextureLoader().load(
        url,
        (loaded) => {
          if (this.lifetime.signal.aborted) loaded.dispose();
        },
        undefined,
        () => {
          if (!this.lifetime.signal.aborted) {
            const broken = this.models.get(key);
            if (broken) {
              broken.geometry.dispose();
              broken.material.dispose();
              this.models.delete(key);
              this.dirty = true;
            }
          }
        },
      );
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.colorSpace = THREE.SRGBColorSpace;
      this.textures.set(url, texture);
    }
    const material = entityMaterial(texture, this.clip);
    const result = { geometry, material };
    this.models.set(key, result);
    return result;
  }

  private clearBatches() {
    for (const { mesh } of this.batches) {
      this.root.remove(mesh);
      mesh.dispose();
    }
    this.batches = [];
    this.targets.clear();
  }

  private rebuild() {
    this.clearBatches();
    const groups = new Map<Model, MapMarker[]>();
    for (const item of this.items.values()) {
      if (item.y === null || item.y > this.ceiling + 1) continue;
      const model = this.model(item);
      const group = groups.get(model);
      if (group) group.push(item);
      else groups.set(model, [item]);
    }
    const transform = new THREE.Object3D();
    for (const [model, members] of groups) {
      const mesh = new THREE.InstancedMesh(
        model.geometry,
        model.material,
        members.length,
      );
      for (let index = 0; index < members.length; index++) {
        const item = members[index];
        const definition = this.catalog?.entities[entityType(item.object_type)];
        const babyScale =
          item.render?.baby && !definition?.baby_geometry ? 0.5 : 1;
        transform.position.set(
          item.x - this.origin.x,
          item.y!,
          item.z - this.origin.z,
        );
        transform.rotation.set(
          0,
          Math.PI - THREE.MathUtils.degToRad(item.render?.rotation[0] ?? 0),
          0,
        );
        const resourceScale = item.render?.baby
          ? (definition?.baby_scale ?? definition?.scale ?? 1)
          : (definition?.scale ?? 1);
        transform.scale.setScalar(
          (item.render?.scale ?? 1) * babyScale * resourceScale,
        );
        transform.updateMatrix();
        mesh.setMatrixAt(index, transform.matrix);
        this.targets.set(item.id, { mesh, index });
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.userData.entities = members;
      this.root.add(mesh);
      this.batches.push({ mesh, members });
    }
    this.root.updateMatrixWorld(true);
  }

  pick(
    ray: THREE.Raycaster,
    terrainDistance = Infinity,
  ): { marker: MapMarker; box: THREE.Box3 } | null {
    for (const hit of ray.intersectObjects(this.root.children, false)) {
      if (hit.distance > terrainDistance + 0.002) break;
      if (hit.point.y > this.ceiling + 1) continue;
      const mesh = hit.object as THREE.InstancedMesh;
      const marker = (mesh.userData.entities as MapMarker[])[hit.instanceId!];
      const matrix = new THREE.Matrix4();
      mesh.getMatrixAt(hit.instanceId!, matrix);
      const box = mesh.geometry
        .boundingBox!.clone()
        .applyMatrix4(matrix)
        .applyMatrix4(mesh.matrixWorld);
      return { marker, box };
    }
    return null;
  }

  dispose() {
    this.lifetime.abort();
    this.request?.abort();
    clearTimeout(this.timer);
    this.generation++;
    this.clearBatches();
    for (const model of this.models.values()) {
      model.geometry.dispose();
      model.material.dispose();
    }
    this.placeholder.geometry.dispose();
    this.placeholder.material.dispose();
    for (const texture of this.textures.values()) texture.dispose();
    this.items.clear();
    this.models.clear();
    this.textures.clear();
    this.root.removeFromParent();
  }

  bounds(id: string): THREE.Box3 | null {
    const target = this.targets.get(id);
    if (!target) return null;
    const matrix = new THREE.Matrix4();
    target.mesh.getMatrixAt(target.index, matrix);
    return target.mesh.geometry
      .boundingBox!.clone()
      .applyMatrix4(matrix)
      .applyMatrix4(target.mesh.matrixWorld);
  }
}

function inRange(marker: MapMarker, cx: number, cz: number, radius: number) {
  return (
    marker.x >= (cx - radius) * 16 &&
    marker.x < (cx + radius + 1) * 16 &&
    marker.z >= (cz - radius) * 16 &&
    marker.z < (cz + radius + 1) * 16
  );
}
