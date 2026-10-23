export interface Block {
  name: string;
  states: Record<string, string | number>;
  version?: number;
  stateTypes?: Record<string, number>;
}
export interface VoxelPoint {
  x: number;
  y: number;
  z: number;
}
export function initialCameraHeight(
  dimension: number,
  spawnY?: number,
): number {
  // Out-of-world spawn heights (such as 32767) are not usable camera positions.
  const feetY =
    dimension === 0 &&
    spawnY !== undefined &&
    Number.isFinite(spawnY) &&
    spawnY >= -64 &&
    spawnY <= 319
      ? spawnY
      : 80;
  return feetY + 1.62;
}
export interface VoxelLayer {
  palette: Block[];
  indices: Uint16Array;
}
export interface VoxelSection {
  y: number;
  layers: VoxelLayer[];
  error?: string;
}
export interface VoxelChunk {
  x: number;
  z: number;
  missing: boolean;
  sections: VoxelSection[];
}
export interface Atlas {
  size: number;
  columns: number;
  textures: Record<string, number[]>;
  blocks: Record<string, string | Record<string, string>>;
  amulet?: { url: string; token: string };
  source?: { bedrock: string; mode: "classic"; complexModels: "java-adapter" };
}
export interface MeshPart {
  y: number;
  kind: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  tiles: Float32Array;
}
export function decodeScene(buffer: ArrayBuffer): VoxelChunk {
  if (buffer.byteLength < 4) throw new Error("3D 数据不完整");
  const length = new DataView(buffer).getUint32(0, true);
  if (length > buffer.byteLength - 4) throw new Error("3D 数据头无效");
  const meta = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, length)),
  );
  return {
    ...meta,
    sections: meta.sections.map(
      (s: {
        y: number;
        error?: string;
        layers: { palette: Block[]; offset: number }[];
      }) => ({
        ...s,
        layers: s.layers.map((l) => {
          const start = 4 + length + l.offset;
          if (start < 4 + length || start + 8192 > buffer.byteLength)
            throw new Error("3D 方块索引无效");
          const data = new DataView(buffer, start, 8192);
          const indices = Uint16Array.from({ length: 4096 }, (_, i) =>
            data.getUint16(i * 2, true),
          );
          if (indices.some((i) => i >= l.palette.length))
            throw new Error("3D 调色板索引越界");
          return {
            palette: l.palette,
            indices: l.palette.length === 1 ? new Uint16Array([0]) : indices,
          };
        }),
      }),
    ),
  };
}
export function renderRange(x: number, z: number, radius: number) {
  if (!Number.isInteger(radius) || radius < 4 || radius > 32)
    throw new Error("渲染距离须为 4～32");
  const cx = Math.floor(x / 16),
    cz = Math.floor(z / 16);
  const points: { x: number; z: number }[] = [];
  for (
    let a = Math.max(-2147483648, cx - radius);
    a <= Math.min(2147483647, cx + radius);
    a++
  )
    for (
      let b = Math.max(-2147483648, cz - radius);
      b <= Math.min(2147483647, cz + radius);
      b++
    )
      points.push({ x: a, z: b });
  return points.sort(
    (a, b) =>
      (a.x - cx) ** 2 + (a.z - cz) ** 2 - (b.x - cx) ** 2 - (b.z - cz) ** 2,
  );
}
export function boxBounds(a: VoxelPoint, b: VoxelPoint) {
  return {
    low: {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      z: Math.min(a.z, b.z),
    },
    high: {
      x: Math.max(a.x, b.x),
      y: Math.max(a.y, b.y),
      z: Math.max(a.z, b.z),
    },
  };
}

export function sphereRadius(a: VoxelPoint, b: VoxelPoint = a) {
  return Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
}
export function sphereCorners(
  center: VoxelPoint,
  radius: number,
): VoxelPoint[] {
  return [
    { ...center },
    { ...center, x: center.x + Math.max(0, Math.round(radius)) },
  ];
}
export function selectionBounds(a: VoxelPoint, b: VoxelPoint, sphere: boolean) {
  if (!sphere) return boxBounds(a, b);
  const radius = sphereRadius(a, b);
  return {
    low: { x: a.x - radius, y: a.y - radius, z: a.z - radius },
    high: { x: a.x + radius, y: a.y + radius, z: a.z + radius },
  };
}
export function stretchSelection(
  corners: VoxelPoint[],
  sphere: boolean,
  axis: "x" | "y" | "z",
  upper: boolean,
  value: number,
): VoxelPoint[] {
  if (sphere)
    return sphereCorners(
      corners[0],
      Math.max(0, upper ? value - corners[0][axis] : corners[0][axis] - value),
    );
  const { low, high } = boxBounds(corners[0], corners[1] ?? corners[0]);
  if (upper) high[axis] = Math.max(low[axis], value);
  else low[axis] = Math.min(high[axis], value);
  return [low, high];
}
