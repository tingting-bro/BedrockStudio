import * as THREE from "three";

type Triple = [number, number, number];
interface FaceUV {
  uv: [number, number];
  uv_size?: [number, number];
}
interface Cube {
  origin: Triple;
  size: Triple;
  uv?: [number, number] | Partial<Record<string, FaceUV>>;
  inflate?: number;
  pivot?: Triple;
  rotation?: Triple;
  mirror?: boolean;
}
interface Bone {
  name: string;
  parent?: string;
  pivot?: Triple;
  rotation?: Triple;
  bind_pose_rotation?: Triple;
  position?: Triple;
  scale?: Triple;
  mirror?: boolean;
  neverRender?: boolean;
  cubes?: Cube[];
}
export interface EntityGeometry {
  description?: { texture_width?: number; texture_height?: number };
  texturewidth?: number;
  textureheight?: number;
  bones: Bone[];
}
export interface EntityDefinition {
  geometry: string;
  texture: string;
  texture_width?: number;
  texture_height?: number;
  baby_geometry?: string;
  baby_texture?: string;
  baby_texture_width?: number;
  baby_texture_height?: number;
  sheared_geometry?: string;
  scale?: number;
  baby_scale?: number;
  collision_box?: [number, number];
}
export interface EntityCatalog {
  entities: Record<string, EntityDefinition>;
  geometries: Record<string, EntityGeometry>;
}

function pivotRotation(
  pivot: Triple = [0, 0, 0],
  rotation: Triple = [0, 0, 0],
) {
  const [x, y, z] = pivot;
  const angles = rotation.map(THREE.MathUtils.degToRad);
  return new THREE.Matrix4()
    .makeTranslation(x, y, z)
    .multiply(
      new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(angles[0], angles[1], angles[2], "ZYX"),
      ),
    )
    .multiply(new THREE.Matrix4().makeTranslation(-x, -y, -z));
}

/** Static Bedrock cuboids, bone hierarchy, pivots, inflation and both UV formats. */
export function entityGeometry(
  model: EntityGeometry,
  textureSize?: { width: number; height: number },
): THREE.BufferGeometry {
  const width =
    model.description?.texture_width ??
    model.texturewidth ??
    textureSize?.width ??
    64;
  const height =
    model.description?.texture_height ??
    model.textureheight ??
    textureSize?.height ??
    32;
  if (!(width > 0 && height > 0) || model.bones.length > 2048)
    throw new Error("实体模型无效");
  const bones = new Map(model.bones.map((bone) => [bone.name, bone]));
  const matrices = new Map<string, THREE.Matrix4>();
  const visiting = new Set<string>();
  function boneMatrix(bone: Bone): THREE.Matrix4 {
    const cached = matrices.get(bone.name);
    if (cached) return cached;
    if (visiting.has(bone.name)) throw new Error("实体骨骼循环引用");
    visiting.add(bone.name);
    const parent = bone.parent ? bones.get(bone.parent) : undefined;
    const result = (parent ? boneMatrix(parent).clone() : new THREE.Matrix4())
      .multiply(
        new THREE.Matrix4().makeTranslation(...(bone.position ?? [0, 0, 0])),
      )
      .multiply(pivotRotation(bone.pivot, bone.rotation));
    if (bone.scale) {
      const [x, y, z] = bone.pivot ?? [0, 0, 0];
      result
        .multiply(new THREE.Matrix4().makeTranslation(x, y, z))
        .multiply(new THREE.Matrix4().makeScale(...bone.scale))
        .multiply(new THREE.Matrix4().makeTranslation(-x, -y, -z));
    }
    visiting.delete(bone.name);
    matrices.set(bone.name, result);
    return result;
  }
  const positions: number[] = [],
    uvs: number[] = [];
  for (const bone of model.bones) {
    if (bone.neverRender) continue;
    const transform = boneMatrix(bone)
      .clone()
      .multiply(pivotRotation(bone.pivot, bone.bind_pose_rotation));
    for (const cube of bone.cubes ?? []) {
      if (positions.length > 2_000_000) throw new Error("实体模型超过预算");
      const [x, y, z] = cube.origin,
        [w, h, d] = cube.size;
      const inflate = cube.inflate ?? 0;
      const low = [x - inflate, y - inflate, z - inflate];
      const high = [x + w + inflate, y + h + inflate, z + d + inflate];
      const [a, b, c] = low,
        [e, f, g] = high;
      const faces = [
        [
          [e, b, g],
          [e, f, g],
          [e, f, c],
          [e, b, c],
        ],
        [
          [a, b, c],
          [a, f, c],
          [a, f, g],
          [a, b, g],
        ],
        [
          [a, f, g],
          [a, f, c],
          [e, f, c],
          [e, f, g],
        ],
        [
          [a, b, c],
          [a, b, g],
          [e, b, g],
          [e, b, c],
        ],
        [
          [a, b, g],
          [a, f, g],
          [e, f, g],
          [e, b, g],
        ],
        [
          [e, b, c],
          [e, f, c],
          [a, f, c],
          [a, b, c],
        ],
      ];
      const matrix = transform
        .clone()
        .multiply(
          pivotRotation(
            cube.pivot ?? [x + w / 2, y + h / 2, z + d / 2],
            cube.rotation,
          ),
        );
      const mirror = cube.mirror ?? bone.mirror ?? false;
      const uv = cube.uv ?? [0, 0];
      const names = ["east", "west", "up", "down", "south", "north"];
      const [u, v] = Array.isArray(uv) ? uv : [0, 0];
      const boxUV = [
        [u + d + w, v + d, d, h],
        [u, v + d, d, h],
        [u + d, v, w, d],
        [u + d + w, v + d, w, -d],
        [u + 2 * d + w, v + d, w, h],
        [u + d, v + d, w, h],
      ];
      for (let face = 0; face < 6; face++) {
        const custom = !Array.isArray(uv) ? uv[names[face]] : undefined;
        if (!Array.isArray(uv) && !custom) continue;
        const [fu, fv, fw, fh] = custom
          ? [
              ...custom.uv,
              ...(custom.uv_size ??
                (face < 2 ? [d, h] : face < 4 ? [w, d] : [w, h])),
            ]
          : boxUV[mirror && face < 2 ? 1 - face : face];
        const corners = [
          [0, 1],
          [0, 0],
          [1, 0],
          [1, 1],
        ];
        for (const index of [0, 2, 1, 0, 3, 2]) {
          const point = new THREE.Vector3(...(faces[face][index] as Triple))
            .applyMatrix4(matrix)
            .multiplyScalar(1 / 16);
          if (![point.x, point.y, point.z].every(Number.isFinite))
            throw new Error("实体模型坐标无效");
          positions.push(point.x, point.y, point.z);
          const [s, t] = corners[index];
          uvs.push(
            (fu + (mirror ? 1 - s : s) * fw) / width,
            1 - (fv + t * fh) / height,
          );
        }
      }
    }
  }
  if (!positions.length) throw new Error("实体模型不含可绘制方块");
  const result = new THREE.BufferGeometry();
  result.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  result.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  result.computeVertexNormals();
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

export function entityType(name: string | undefined) {
  const type = (name ?? "unknown").toLowerCase();
  // A mod namespace must never accidentally select a vanilla model.
  const full = type.includes(":") ? type : `minecraft:${type}`;
  const aliases: Record<string, string> = {
    "minecraft:villager_v2": "minecraft:villager",
  };
  return aliases[full] ?? full;
}
