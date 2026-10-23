import type { Atlas, Block, MeshPart, VoxelChunk } from "./scene-data";

const offsets = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const isAir = (block?: Block) =>
  !block ||
  /^(?:minecraft:)?(?:air|cave_air|void_air|structure_void)$/.test(block.name);
const contextual = (block: Block) =>
  /stairs|fence|pane|(?:^|_)wall$|door|chest|redstone_wire|chorus|(?:^|:)kelp$/.test(
    block.name,
  );
interface Query {
  block: Block;
  neighbors?: (Block | null)[];
}
export interface AmuletModel {
  solid: boolean;
  ambientOcclusion?: boolean;
  transparency?: number;
  name: string;
  fluid?: {
    family: "water" | "lava";
    still: number[];
    flow: number[];
  };
  parts: {
    cull: number;
    kind: number;
    p: number[];
    u: number[];
    n: number[];
    c: number[];
  }[];
}
export type ModelLibrary = Map<string, AmuletModel>;
const key = (query: Query) => JSON.stringify(query);

/** Session-local LRU: immutable model keys include states, types and neighbors. */
export class AmuletModelCache {
  private entries = new Map<string, { model: AmuletModel; bytes: number }>();
  bytes = 0;
  constructor(private limit: number) {}
  get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry;
  }
  set(id: string, model: AmuletModel, bytes: number) {
    if (bytes > this.limit) return;
    const previous = this.entries.get(id);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(id);
    this.entries.set(id, { model, bytes });
    this.bytes += bytes;
    this.setLimit(this.limit);
  }
  setLimit(limit: number) {
    this.limit = Math.max(0, limit);
    while (this.bytes > this.limit && this.entries.size) {
      const id = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(id)!.bytes;
      this.entries.delete(id);
    }
  }
}

function sampler(
  chunk: VoxelChunk,
  chunks: Map<string, VoxelChunk>,
  ceiling: number,
) {
  const columns = new Map(
    [...chunks].map(([id, column]) => [
      id,
      new Map(
        column.sections.filter((s) => !s.error).map((s) => [s.y, s.layers]),
      ),
    ]),
  );
  return (x: number, y: number, z: number, layer: number) => {
    if (y > ceiling) return undefined;
    const column = columns.get(
      `${chunk.x + Math.floor(x / 16)},${chunk.z + Math.floor(z / 16)}`,
    );
    const storage = column?.get(Math.floor(y / 16))?.[layer];
    return storage?.palette[
      storage.indices[
        storage.indices.length === 1
          ? 0
          : ((x & 15) << 8) | ((z & 15) << 4) | (y & 15)
      ]
    ];
  };
}

function* cells(
  chunk: VoxelChunk,
  chunks: Map<string, VoxelChunk>,
  ceiling: number,
  contextualOnly = false,
  occludedInterior?: (block: Block) => boolean,
) {
  const at = sampler(chunk, chunks, ceiling);
  const blocks = new Map<
    Block,
    {
      query: Query;
      id: string;
      context: boolean;
      index: number;
      air: boolean;
      skipInterior: boolean;
    }
  >();
  const variants = new Map<string, { query: Query; id: string }>();
  const info = (block: Block) => {
    let value = blocks.get(block);
    if (!value) {
      const query = { block };
      value = {
        query,
        id: key(query),
        context: contextual(block),
        index: blocks.size + 1,
        air: isAir(block),
        skipInterior: occludedInterior?.(block) ?? false,
      };
      blocks.set(block, value);
    }
    return value;
  };
  for (const section of chunk.sections) {
    if (section.error || section.y * 16 > ceiling) continue;
    for (const [layer, storage] of section.layers.entries()) {
      if (storage.palette.every(isAir)) continue;
      if (contextualOnly && !storage.palette.some(contextual)) continue;
      for (let i = 0; i < 4096; i++) {
        const block =
          storage.palette[
            storage.indices[storage.indices.length === 1 ? 0 : i]
          ];
        const base = info(block);
        if (base.air) continue;
        if (contextualOnly && !base.context) continue;
        const x = i >> 8,
          y = section.y * 16 + (i % 16),
          z = (i >> 4) % 16;
        if (y > ceiling) continue;
        if (
          storage.indices.length === 1 &&
          section.layers.length === 1 &&
          base.skipInterior &&
          x > 0 &&
          x < 15 &&
          z > 0 &&
          z < 15 &&
          (i & 15) > 0 &&
          (i & 15) < 15 &&
          y < ceiling
        )
          continue;
        const neighbors = offsets.map(
          ([dx, dy, dz]) => at(x + dx, y + dy, z + dz, layer) ?? null,
        );
        let variant: { query: Query; id: string } = base;
        if (base.context) {
          const signature = `${base.index}:${neighbors.map((b) => (b ? info(b).index : 0)).join(",")}`;
          let cached = variants.get(signature);
          if (!cached) {
            const query = { block, neighbors };
            cached = { query, id: key(query) };
            variants.set(signature, cached);
          }
          variant = cached;
        }
        yield {
          x,
          y,
          z,
          section: section.y,
          layer,
          ...variant,
          neighbors,
        };
      }
    }
  }
}

/** Bounded job library with optional reuse within one immutable atlas session. */
export async function loadAmuletModels(
  chunk: VoxelChunk,
  chunks: Map<string, VoxelChunk>,
  atlas: Atlas,
  ceiling: number,
  signal?: AbortSignal,
  cache?: AmuletModelCache,
  progress?: () => void,
): Promise<ModelLibrary> {
  const queries = new Map<string, Query>();
  const seen = new Set<Block>();
  const add = (block?: Block) => {
    if (!block || seen.has(block) || isAir(block)) return;
    seen.add(block);
    const query = { block };
    queries.set(key(query), query);
    if (queries.size > 8192) throw new Error("此区块的 3D 模型超过显示预算");
  };
  const at = sampler(chunk, chunks, ceiling);
  for (const section of chunk.sections) {
    if (section.error || section.y * 16 > ceiling) continue;
    for (const [layer, storage] of section.layers.entries()) {
      if (storage.palette.every(isAir)) continue;
      // Ordinary blocks need one model per used palette entry, not per voxel.
      if (section.y * 16 + 15 <= ceiling)
        for (const index of new Set(storage.indices))
          add(storage.palette[index]);
      else
        for (let i = 0; i < 4096; i++)
          if (section.y * 16 + (i & 15) <= ceiling)
            add(
              storage.palette[
                storage.indices[storage.indices.length === 1 ? 0 : i]
              ],
            );
      // Only four boundary planes can introduce blocks outside this column.
      for (
        let y = section.y * 16;
        y <= Math.min(ceiling, section.y * 16 + 15);
        y++
      )
        for (let p = 0; p < 16; p++) {
          add(at(-1, y, p, layer));
          add(at(16, y, p, layer));
          add(at(p, y, -1, layer));
          add(at(p, y, 16, layer));
        }
      if (atlas.source?.bedrock)
        for (
          let y = section.y * 16;
          y <= Math.min(ceiling, section.y * 16 + 15);
          y++
        )
          for (const x of [-1, 16])
            for (const z of [-1, 16]) add(at(x, y, z, layer));
    }
  }
  for (const cell of cells(chunk, chunks, ceiling, true)) {
    queries.set(cell.id, cell.query);
    if (queries.size > 8192) throw new Error("此区块的 3D 模型超过显示预算");
  }
  const library: ModelLibrary = new Map();
  let bytes = 0;
  const entries = [...queries].filter(([id]) => {
    const cached = cache?.get(id);
    if (!cached) return true;
    bytes += cached.bytes;
    library.set(id, cached.model);
    return false;
  });
  signal?.throwIfAborted();
  if (bytes > 24 * 1024 ** 2)
    throw new Error("此区块的 Amulet 模型超过 24 MB 显示预算");
  for (let start = 0; start < entries.length; start += 256) {
    const batch = entries.slice(start, start + 256);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("方块模型读取超时")),
      15000,
    );
    try {
      signal?.throwIfAborted();
      const response = await fetch(`${atlas.amulet!.url}/models`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "X-Editor-Token": atlas.amulet!.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ queries: batch.map(([, query]) => query) }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.detail ?? "Amulet 方块模型读取失败");
      }
      const text = await response.text();
      bytes += text.length * 2;
      if (bytes > 24 * 1024 ** 2)
        throw new Error("此区块的 Amulet 模型超过 24 MB 显示预算");
      const { models } = JSON.parse(text) as { models: AmuletModel[] };
      if (models.length !== batch.length)
        throw new Error("Amulet 方块模型数据不完整");
      batch.forEach(([id], i) => {
        library.set(id, models[i]);
        cache?.set(
          id,
          models[i],
          id.length * 2 + JSON.stringify(models[i]).length * 2 + 128,
        );
      });
      progress?.();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return library;
}

export function meshAmuletChunk(
  chunk: VoxelChunk,
  chunks: Map<string, VoxelChunk>,
  ceiling: number,
  library: ModelLibrary,
): MeshPart[] {
  const batches = new Map<
    string,
    {
      y: number;
      kind: number;
      p: number[];
      n: number[];
      u: number[];
      c: number[];
    }
  >();
  let bytes = 0;
  const adjacentModels = new Map<Block, AmuletModel | undefined>();
  const adjacentModel = (block: Block) => {
    if (!adjacentModels.has(block))
      adjacentModels.set(block, library.get(key({ block })));
    return adjacentModels.get(block);
  };
  const at = sampler(chunk, chunks, ceiling);
  const solidAt = (x: number, y: number, z: number) => {
    const block = at(x, y, z, 0);
    return !!block && !!adjacentModel(block)?.solid;
  };
  const fluidAt = (x: number, y: number, z: number, family: string) => {
    for (let layer = 0; layer < 2; layer++) {
      const block = at(x, y, z, layer);
      if (
        block &&
        block.name.replace(/^minecraft:/, "").replace(/^flowing_/, "") ===
          family
      )
        return block;
    }
    return undefined;
  };
  for (const cell of cells(chunk, chunks, ceiling, false, (block) => {
    const model = adjacentModel(block);
    return (
      !contextual(block) &&
      !!model?.solid &&
      model.parts.every((face) => face.cull < 6)
    );
  })) {
    const model = library.get(cell.id);
    if (!model) throw new Error("Amulet 方块模型尚未准备完成");
    const nativeFluid = model.fluid;
    if (nativeFluid && cell.layer > 0) {
      const primary = at(cell.x, cell.y, cell.z, 0);
      if (
        primary &&
        adjacentModel(primary)?.fluid?.family === nativeFluid.family
      )
        continue;
    }
    const faces = nativeFluid
      ? fluidFaces(
          cell.x,
          cell.y,
          cell.z,
          nativeFluid,
          (x, y, z) => fluidAt(x, y, z, nativeFluid.family),
          solidAt,
        )
      : model.parts;
    for (const face of faces) {
      if (face.cull < 6) {
        const neighbor = cell.neighbors[face.cull];
        const adjacent = neighbor ? adjacentModel(neighbor) : undefined;
        const [dx, dy, dz] = offsets[face.cull];
        if (
          solidAt(cell.x + dx, cell.y + dy, cell.z + dz) ||
          (model.transparency === 1 &&
            adjacent?.transparency === 1 &&
            model.name === adjacent.name) ||
          (face.kind === 5 &&
            adjacent?.name === model.name &&
            /glass|ice/.test(model.name))
        )
          continue;
      }
      const id = `${cell.section}:${face.kind}`;
      let batch = batches.get(id);
      if (!batch) {
        batch = {
          y: cell.section,
          kind: face.kind,
          p: [],
          n: [],
          u: [],
          c: [],
        };
        batches.set(id, batch);
      }
      for (let i = 0; i < face.p.length; i += 3) {
        batch.p.push(
          cell.x + face.p[i],
          cell.y + face.p[i + 1],
          cell.z + face.p[i + 2],
        );
        batch.n.push(...face.n);
        let ao = 1;
        if (model.ambientOcclusion && face.cull < 6) {
          const normal = offsets[face.cull];
          const axes = [0, 1, 2].filter((axis) => normal[axis] === 0);
          const origin = [
            cell.x + normal[0],
            cell.y + normal[1],
            cell.z + normal[2],
          ];
          const steps = axes.map((axis) => (face.p[i + axis] < 0.5 ? -1 : 1));
          const blocked = (a: boolean, b: boolean) => {
            const p = [...origin];
            if (a) p[axes[0]] += steps[0];
            if (b) p[axes[1]] += steps[1];
            return Number(solidAt(p[0], p[1], p[2]));
          };
          const sideA = blocked(true, false),
            sideB = blocked(false, true);
          const level =
            sideA && sideB ? 3 : sideA + sideB + blocked(true, true);
          ao = [1, 0.8, 0.6, 0.45][level];
        }
        batch.c.push(face.c[i] * ao, face.c[i + 1] * ao, face.c[i + 2] * ao);
      }
      batch.u.push(...face.u);
      bytes += (face.p.length * 3 + face.u.length * 2) * 4;
      if (bytes > 24 * 1024 ** 2) throw new Error("此区块网格超过 24 MB 上限");
    }
  }
  return [...batches.values()].map((b) => ({
    y: b.y,
    kind: b.kind,
    positions: new Float32Array(b.p),
    normals: new Float32Array(b.n),
    uvs: new Float32Array(b.u),
    colors: new Float32Array(b.c),
    tiles: new Float32Array(b.u.length),
  }));
}

/** Classic fluid surfaces are shared across storage layers and chunk borders.
 * Models provide texture rectangles only; all liquid geometry is generated here.
 */
function fluidFaces(
  x: number,
  y: number,
  z: number,
  fluid: NonNullable<AmuletModel["fluid"]>,
  at: (x: number, y: number, z: number) => Block | undefined,
  solid: (x: number, y: number, z: number) => boolean,
): AmuletModel["parts"] {
  if (solid(x, y, z)) return [];
  const visible = offsets.map(
    ([dx, dy, dz]) =>
      !at(x + dx, y + dy, z + dz) && !solid(x + dx, y + dy, z + dz),
  );
  if (!visible.some(Boolean)) return [];
  const height = (block: Block) => {
    const depth = Number(
      block.states.liquid_depth ?? block.states["minecraft:liquid_depth"] ?? 0,
    );
    return (8 - (depth >= 8 ? 0 : Math.max(0, Math.min(7, depth)))) / 9;
  };
  const corner = (cx: number, cz: number) => {
    let sum = 0,
      weight = 0;
    for (const dx of [cx - 1, cx])
      for (const dz of [cz - 1, cz]) {
        const block = at(x + dx, y, z + dz);
        if (block && at(x + dx, y + 1, z + dz)) return 1;
        if (solid(x + dx, y, z + dz)) continue;
        const h = block ? height(block) : 0;
        const w = h >= 0.8 ? 10 : 1;
        sum += h * w;
        weight += w;
      }
    return Math.max(0, sum / Math.max(1, weight) - 0.001);
  };
  const h00 = corner(0, 0),
    h10 = corner(1, 0),
    h01 = corner(0, 1),
    h11 = corner(1, 1);
  const quads = [
    [
      [1, 0, 1],
      [1, 0, 0],
      [1, h10, 0],
      [1, h11, 1],
    ],
    [
      [0, 0, 0],
      [0, 0, 1],
      [0, h01, 1],
      [0, h00, 0],
    ],
    [
      [0, h01, 1],
      [1, h11, 1],
      [1, h10, 0],
      [0, h00, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [1, 0, 1],
      [1, h11, 1],
      [0, h01, 1],
    ],
    [
      [1, 0, 0],
      [0, 0, 0],
      [0, h00, 0],
      [1, h10, 0],
    ],
  ];
  const parts: AmuletModel["parts"] = [];
  const gx = h00 + h01 - h10 - h11,
    gz = h00 + h10 - h01 - h11;
  const flowing = Math.abs(gx) + Math.abs(gz) > 1e-5;
  for (let side = 0; side < 6; side++) {
    if (!visible[side]) continue;
    const top = side === 2;
    const [u, v, w, h] =
      side < 2 || side > 3 || (top && flowing) ? fluid.flow : fluid.still;
    const uv = quads[side].map(([px, py, pz], i) => {
      if (top && flowing) {
        const angle = Math.atan2(gz, gx) - Math.PI / 2;
        const a = px - 0.5,
          b = pz - 0.5;
        return [
          u + w * (0.5 + (a * Math.cos(angle) - b * Math.sin(angle)) * 0.5),
          1 - v - h * (0.5 + (a * Math.sin(angle) + b * Math.cos(angle)) * 0.5),
        ];
      }
      if (side === 2 || side === 3) return [u + px * w, 1 - v - pz * h];
      return [
        u + (i === 1 || i === 2 ? 0.5 : 0) * w,
        1 - v - (1 - py) * h * 0.5,
      ];
    });
    const order = [0, 1, 2, 0, 2, 3];
    const shade =
      fluid.family === "lava" ? 1 : [0.6, 0.6, 1, 0.5, 0.8, 0.8][side];
    parts.push({
      cull: 6,
      kind: fluid.family === "water" ? 6 : 3,
      p: order.flatMap((i) => quads[side][i]),
      u: order.flatMap((i) => uv[i]),
      n: offsets[side],
      c: Array(18).fill(shade),
    });
  }
  return parts;
}
