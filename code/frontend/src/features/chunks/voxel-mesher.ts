import {
  air,
  blockModel,
  connectionFamily,
  type Model,
  type Box,
} from "./block-models";
import type { Atlas, Block, MeshPart, VoxelChunk } from "./scene-data";
const directions = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
export function meshChunk(
  chunk: VoxelChunk,
  chunks: Map<string, VoxelChunk>,
  atlas: Atlas,
  ceiling: number,
): MeshPart[] {
  const modelCache = new Map<Block, Model>();
  const model = (b: Block) => {
    let m = modelCache.get(b);
    if (!m) {
      m = blockModel(b, atlas);
      modelCache.set(b, m);
    }
    return m;
  };
  function at(
    x: number,
    y: number,
    z: number,
    layer: number,
  ): Block | undefined {
    if (y > ceiling) return undefined;
    const c = chunks.get(
      `${chunk.x + Math.floor(x / 16)},${chunk.z + Math.floor(z / 16)}`,
    );
    const s = c?.sections.find((s) => s.y === Math.floor(y / 16));
    const l = s?.layers[layer];
    return l?.palette[
      l.indices[
        l.indices.length === 1
          ? 0
          : (((x % 16) + 16) % 16) * 256 +
            (((z % 16) + 16) % 16) * 16 +
            (((y % 16) + 16) % 16)
      ]
    ];
  }
  const parts: MeshPart[] = [];
  const uniformCache = new Map<object, Model | null>();
  const uniform = (
    section: import("./scene-data").VoxelSection | undefined,
  ): Model | null => {
    if (!section || section.error || !section.layers.length) return null;
    if (uniformCache.has(section)) return uniformCache.get(section)!;
    const layer = section.layers[0],
      index = layer.indices[0],
      m = model(layer.palette[index]);
    const result =
      m.solid &&
      m.boxes.length === 1 &&
      m.boxes[0].every((n, i) => n === (i < 3 ? 0 : 1)) &&
      layer.indices.every((value) => value === index)
        ? m
        : null;
    uniformCache.set(section, result);
    return result;
  };
  for (const section of chunk.sections) {
    if (section.y * 16 > ceiling || section.error) continue;
    const batches = Array.from({ length: 3 }, () => ({
      p: [] as number[],
      n: [] as number[],
      u: [] as number[],
      c: [] as number[],
      t: [] as number[],
    }));
    const uniformModel = uniform(section);
    if (uniformModel) {
      const bottom = section.y * 16,
        top = Math.min(bottom + 15, ceiling),
        batch = batches[uniformModel.kind];
      for (let face = 0; face < 6; face++) {
        const [nx, ny, nz] = directions[face];
        const neighborColumn = chunks.get(`${chunk.x + nx},${chunk.z + nz}`);
        const neighborSection = neighborColumn?.sections.find(
          (s) => s.y === section.y + ny,
        );
        if ((ny !== 1 || top + 1 <= ceiling) && uniform(neighborSection))
          continue;
        for (let u = 0; u < 16; u++)
          for (
            let v = 0;
            v < (face === 2 || face === 3 ? 16 : top - bottom + 1);
            v++
          ) {
            const x = face === 0 ? 15 : face === 1 ? 0 : u,
              z = face === 4 ? 15 : face === 5 ? 0 : face < 2 ? u : v,
              y = face === 2 ? top : face === 3 ? bottom : bottom + v;
            const neighbor = at(x + nx, y + ny, z + nz, 0);
            if (neighbor && model(neighbor).solid) continue;
            const a = x,
              b = y,
              c = z,
              d = x + 1,
              e = y + 1,
              f = z + 1;
            const faces = [
              [
                [d, b, f],
                [d, e, f],
                [d, e, c],
                [d, b, c],
              ],
              [
                [a, b, c],
                [a, e, c],
                [a, e, f],
                [a, b, f],
              ],
              [
                [a, e, f],
                [a, e, c],
                [d, e, c],
                [d, e, f],
              ],
              [
                [a, b, c],
                [a, b, f],
                [d, b, f],
                [d, b, c],
              ],
              [
                [a, b, f],
                [a, e, f],
                [d, e, f],
                [d, b, f],
              ],
              [
                [d, b, c],
                [d, e, c],
                [a, e, c],
                [a, b, c],
              ],
            ];
            const tile = uniformModel.faces[face],
              tx = (tile % atlas.columns) * 20 + 2,
              ty = Math.floor(tile / atlas.columns) * 20 + 2,
              uv = [
                [0, 0],
                [0, 1],
                [1, 1],
                [1, 0],
              ],
              shade = [0.78, 0.65, 1, 0.5, 0.85, 0.7][face];
            for (const j of [0, 2, 1, 0, 3, 2]) {
              batch.p.push(...faces[face][j]);
              batch.n.push(nx, ny, nz);
              batch.u.push(
                (tx + uv[j][0] * 16) / atlas.size,
                1 - (ty + (1 - uv[j][1]) * 16) / atlas.size,
              );
              batch.c.push(shade, shade, shade);
              batch.t.push(tx / atlas.size, 1 - (ty + 16) / atlas.size);
            }
          }
      }
    }
    for (
      let layer = 0;
      !uniformModel && layer < section.layers.length;
      layer++
    ) {
      const storage = section.layers[layer];
      if (storage.palette.every((block) => air(block.name))) continue;
      for (let x = 0; x < 16; x++)
        for (let z = 0; z < 16; z++)
          for (let dy = 0; dy < 16; dy++) {
            const y = section.y * 16 + dy;
            if (y > ceiling) continue;
            let block =
              storage.palette[
                storage.indices[
                  storage.indices.length === 1 ? 0 : x * 256 + z * 16 + dy
                ]
              ];
            if (air(block.name)) continue;
            if (/door/.test(block.name) && !/trapdoor/.test(block.name)) {
              const upper = Number(block.states.upper_block_bit ?? 0) === 1,
                other = at(x, y + (upper ? -1 : 1), z, layer);
              if (other && other.name === block.name)
                block = {
                  name: block.name,
                  states: {
                    ...(upper ? block.states : other.states),
                    ...(upper ? other.states : block.states),
                    upper_block_bit: upper ? 1 : 0,
                  },
                };
            }
            let m = model(block);
            if (/stairs/.test(block.name))
              m = blockModel(
                block,
                atlas,
                undefined,
                [
                  [0, 0, -1],
                  [1, 0, 0],
                  [0, 0, 1],
                  [-1, 0, 0],
                ].map(([a, b, c]) => at(x + a, y + b, z + c, layer)),
              );
            if (connectionFamily(block.name))
              m = blockModel(
                block,
                atlas,
                [
                  [0, 0, -1],
                  [1, 0, 0],
                  [0, 0, 1],
                  [-1, 0, 0],
                ].map(([a, b, c]) => {
                  const v = at(x + a, y + b, z + c, layer);
                  return (
                    !!v &&
                    !air(v.name) &&
                    (model(v).solid ||
                      (connectionFamily(v.name) ===
                        connectionFamily(block.name) &&
                        (connectionFamily(block.name) !== "fence" ||
                          /nether_brick/.test(v.name) ===
                            /nether_brick/.test(block.name))) ||
                      (connectionFamily(block.name) === "fence" &&
                        /fence_gate$/.test(v.name)))
                  );
                }),
              );
            if (layer === 1) {
              // Layer 1 is the liquid overlay used by waterlogged blocks.
              // It must be meshed even when layer 0 contains a solid block;
              // the renderer then blends the liquid over that block instead
              // of leaving a visible cavity.
            }
            const batch = batches[m.kind];
            const emit = (
              points: number[][],
              face: number,
              normal: number[],
              crop = false,
            ) => {
              const tile = m.faces[face],
                tx = (tile % atlas.columns) * 20 + 2,
                ty = Math.floor(tile / atlas.columns) * 20 + 2;
              const uv = [
                [0, 0],
                [0, 1],
                [1, 1],
                [1, 0],
              ];
              const shade = [0.78, 0.65, 1, 0.5, 0.85, 0.7][face];
              for (const j of [0, 2, 1, 0, 3, 2]) {
                const [px, py, pz] = points[j];
                const mapped = crop
                  ? [
                      [1 - pz, py],
                      [pz, py],
                      [px, 1 - pz],
                      [px, pz],
                      [px, py],
                      [1 - px, py],
                    ][face]
                  : uv[j];
                batch.p.push(
                  x + points[j][0],
                  y + points[j][1],
                  z + points[j][2],
                );
                batch.n.push(...normal);
                batch.u.push(
                  (tx + mapped[0] * 16) / atlas.size,
                  1 - (ty + (1 - mapped[1]) * 16) / atlas.size,
                );
                batch.c.push(shade, shade, shade);
                batch.t.push(tx / atlas.size, 1 - (ty + 16) / atlas.size);
              }
            };
            if (m.cross) {
              emit(
                [
                  [0, 0, 0],
                  [0, 1, 0],
                  [1, 1, 1],
                  [1, 0, 1],
                ],
                0,
                [0.707, 0, -0.707],
              );
              emit(
                [
                  [1, 0, 0],
                  [1, 1, 0],
                  [0, 1, 1],
                  [0, 0, 1],
                ],
                0,
                [0.707, 0, 0.707],
              );
              continue;
            }
            for (const box of m.boxes) {
              const [a, b, c, d, e, f] = box;
              const faces = [
                [
                  [d, b, f],
                  [d, e, f],
                  [d, e, c],
                  [d, b, c],
                ],
                [
                  [a, b, c],
                  [a, e, c],
                  [a, e, f],
                  [a, b, f],
                ],
                [
                  [a, e, f],
                  [a, e, c],
                  [d, e, c],
                  [d, e, f],
                ],
                [
                  [a, b, c],
                  [a, b, f],
                  [d, b, f],
                  [d, b, c],
                ],
                [
                  [a, b, f],
                  [a, e, f],
                  [d, e, f],
                  [d, b, f],
                ],
                [
                  [d, b, c],
                  [d, e, c],
                  [a, e, c],
                  [a, b, c],
                ],
              ];
              for (let face = 0; face < 6; face++) {
                const [nx, ny, nz] = directions[face];
                const boundary = [
                  d === 1,
                  a === 0,
                  e === 1,
                  b === 0,
                  f === 1,
                  c === 0,
                ][face];
                if (boundary) {
                  const neighbor = at(x + nx, y + ny, z + nz, layer);
                  if (neighbor && !air(neighbor.name)) {
                    const nm = model(neighbor);
                    if (
                      nm.solid ||
                      ((m.kind === 2 || /leaves/.test(block.name)) &&
                        ((neighbor.name === block.name &&
                          liquidFaceCovered(box, nm.boxes, face)) ||
                          (liquidFamily(block.name) !== undefined &&
                            liquidFamily(block.name) ===
                              liquidFamily(neighbor.name) &&
                            liquidFaceCovered(box, nm.boxes, face))))
                    )
                      continue;
                  }
                }
                // Clip overlaps as well as fully buried faces (inner stair corners).
                for (const visible of exposedFace(box, m.boxes, face)) {
                  const points = faces[face].map((point) =>
                    point.map((n, axis) =>
                      Math.max(visible[axis], Math.min(visible[axis + 3], n)),
                    ),
                  );
                  emit(
                    points,
                    face,
                    directions[face],
                    !/door/.test(block.name),
                  );
                }
              }
            }
          }
    }
    batches.forEach((batch, kind) => {
      if (batch.p.length)
        parts.push({
          y: section.y,
          kind,
          positions: new Float32Array(batch.p),
          normals: new Float32Array(batch.n),
          uvs: new Float32Array(batch.u),
          colors: new Float32Array(batch.c),
          tiles: new Float32Array(batch.t),
        });
    });
    if (
      parts.reduce(
        (n, p) =>
          n +
          p.positions.byteLength +
          p.normals.byteLength +
          p.uvs.byteLength +
          p.colors.byteLength,
        0,
      ) >
      24 * 1024 * 1024
    )
      throw new Error("此区块网格超过 24 MB 上限");
  }
  return parts.map((part) => mergeFaces(part, atlas));
}

function liquidFamily(name: string) {
  const value = name.replace(/^minecraft:/, "");
  if (/^(flowing_)?water$/.test(value)) return "water";
  if (/^(flowing_)?lava$/.test(value)) return "lava";
  return undefined;
}

/** Return true only when the neighboring liquid fully covers this face. */
function liquidFaceCovered(
  box: import("./block-models").Box,
  neighbors: import("./block-models").Box[],
  face: number,
) {
  const axis = Math.floor(face / 2),
    positive = face % 2 === 0,
    plane = box[axis + (positive ? 3 : 0)],
    u = [0, 1, 2].filter((value) => value !== axis)[0],
    v = [0, 1, 2].filter((value) => value !== axis)[1];
  return neighbors.some((neighbor) => {
    const opposite = neighbor[axis + (positive ? 0 : 3)] + (positive ? 1 : -1);
    if (Math.abs(opposite - plane) > 1e-6) return false;
    return (
      neighbor[u] <= box[u] + 1e-6 &&
      neighbor[u + 3] >= box[u + 3] - 1e-6 &&
      neighbor[v] <= box[v] + 1e-6 &&
      neighbor[v + 3] >= box[v + 3] - 1e-6
    );
  });
}

/** Merge coplanar unit cube faces; shader UVs repeat each original atlas tile. */
function mergeFaces(part: MeshPart, atlas: Atlas): MeshPart {
  const groups = new Map<
    string,
    { face: number; plane: number; tile: number[]; cells: Set<string> }
  >();
  const output = {
    p: [] as number[],
    n: [] as number[],
    u: [] as number[],
    c: [] as number[],
    t: [] as number[],
  };
  const emit = (
    vertices: number[][],
    face: number,
    tile: number[],
    width: number,
    height: number,
  ) => {
    const uv = [
        [0, 0],
        [0, height],
        [width, height],
        [width, 0],
      ],
      normal = directions[face],
      shade = [0.78, 0.65, 1, 0.5, 0.85, 0.7][face];
    for (const j of [0, 2, 1, 0, 3, 2]) {
      output.p.push(...vertices[j]);
      output.n.push(...normal);
      output.u.push(...uv[j]);
      output.t.push(...tile);
      output.c.push(shade, shade, shade);
    }
  };
  for (let start = 0; start < part.positions.length; start += 18) {
    const vertices = Array.from({ length: 6 }, (_, i) =>
      Array.from(part.positions.slice(start + i * 3, start + i * 3 + 3)),
    );
    const low = [0, 1, 2].map((k) => Math.min(...vertices.map((p) => p[k]))),
      high = [0, 1, 2].map((k) => Math.max(...vertices.map((p) => p[k])));
    const normal = Array.from(part.normals.slice(start, start + 3));
    const face = directions.findIndex((d) =>
      d.every((n, i) => n === normal[i]),
    );
    const uvStart = (start / 3) * 2,
      uv = Array.from(part.uvs.slice(uvStart, uvStart + 12));
    const tile = [
      part.tiles[uvStart] ?? Math.min(...uv.filter((_, i) => i % 2 === 0)),
      part.tiles[uvStart + 1] ?? Math.min(...uv.filter((_, i) => i % 2 === 1)),
    ];
    const k = Math.floor(face / 2),
      u = k === 0 ? 2 : 0,
      v = k === 1 ? 2 : 1;
    if (
      face >= 0 &&
      high[u] - low[u] === 1 &&
      high[v] - low[v] === 1 &&
      low.every(Number.isInteger) &&
      high.every(Number.isInteger)
    ) {
      const key = `${face}:${low[k]}:${tile.join(",")}`;
      let group = groups.get(key);
      if (!group) {
        group = { face, plane: low[k], tile, cells: new Set() };
        groups.set(key, group);
      }
      group.cells.add(`${low[u]},${low[v]}`);
    } else {
      for (let i = 0; i < 6; i++) {
        output.p.push(...vertices[i]);
        output.n.push(
          ...Array.from(part.normals.slice(start + i * 3, start + i * 3 + 3)),
        );
        output.c.push(
          ...Array.from(part.colors.slice(start + i * 3, start + i * 3 + 3)),
        );
        output.u.push(
          ((part.uvs[uvStart + i * 2] - tile[0]) * atlas.size) / 16,
          ((part.uvs[uvStart + i * 2 + 1] - tile[1]) * atlas.size) / 16,
        );
        output.t.push(...tile);
      }
    }
  }
  for (const { face, plane, tile, cells } of groups.values()) {
    const k = Math.floor(face / 2),
      uAxis = k === 0 ? 2 : 0,
      vAxis = k === 1 ? 2 : 1;
    const sorted = [...cells]
      .map((s) => s.split(",").map(Number))
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const [u, v] of sorted) {
      if (!cells.has(`${u},${v}`)) continue;
      let width = 1,
        height = 1;
      while (cells.has(`${u + width},${v}`)) width++;
      outer: while (true) {
        for (let i = 0; i < width; i++)
          if (!cells.has(`${u + i},${v + height}`)) break outer;
        height++;
      }
      for (let row = 0; row < height; row++)
        for (let col = 0; col < width; col++)
          cells.delete(`${u + col},${v + row}`);
      const low = [0, 0, 0],
        high = [0, 0, 0];
      low[k] = high[k] = plane;
      low[uAxis] = u;
      high[uAxis] = u + width;
      low[vAxis] = v;
      high[vAxis] = v + height;
      const [a, b, c] = low,
        [d, e, f] = high;
      const faces = [
        [
          [d, b, f],
          [d, e, f],
          [d, e, c],
          [d, b, c],
        ],
        [
          [a, b, c],
          [a, e, c],
          [a, e, f],
          [a, b, f],
        ],
        [
          [a, e, f],
          [a, e, c],
          [d, e, c],
          [d, e, f],
        ],
        [
          [a, b, c],
          [a, b, f],
          [d, b, f],
          [d, b, c],
        ],
        [
          [a, b, f],
          [a, e, f],
          [d, e, f],
          [d, b, f],
        ],
        [
          [d, b, c],
          [d, e, c],
          [a, e, c],
          [a, b, c],
        ],
      ];
      emit(faces[face], face, tile, width, height);
    }
  }
  return {
    ...part,
    positions: new Float32Array(output.p),
    normals: new Float32Array(output.n),
    uvs: new Float32Array(output.u),
    colors: new Float32Array(output.c),
    tiles: new Float32Array(output.t),
  };
}
function exposedFace(a: Box, boxes: Box[], face: number): Box[] {
  const k = Math.floor(face / 2);
  const plane = a[k + (face % 2 === 0 ? 3 : 0)];
  const [u, v] = [0, 1, 2].filter((i) => i !== k);
  let visible: Box[] = [a];
  for (const b of boxes) {
    if (b === a) continue;
    const end = b[k + (face % 2 === 0 ? 3 : 0)];
    const buried =
      face % 2 === 0
        ? b[k] <= plane && b[k + 3] > plane
        : b[k] < plane && b[k + 3] >= plane;
    if (!buried && !(end === plane && boxes.indexOf(b) < boxes.indexOf(a)))
      continue;
    visible = visible.flatMap((part) => {
      const left = Math.max(part[u], b[u]),
        right = Math.min(part[u + 3], b[u + 3]);
      const bottom = Math.max(part[v], b[v]),
        top = Math.min(part[v + 3], b[v + 3]);
      if (left >= right || bottom >= top) return [part];
      const result: Box[] = [];
      for (const [loU, hiU, loV, hiV] of [
        [part[u], left, part[v], part[v + 3]],
        [right, part[u + 3], part[v], part[v + 3]],
        [left, right, part[v], bottom],
        [left, right, top, part[v + 3]],
      ]) {
        if (loU >= hiU || loV >= hiV) continue;
        const piece = [...part] as Box;
        piece[u] = loU;
        piece[u + 3] = hiU;
        piece[v] = loV;
        piece[v + 3] = hiV;
        result.push(piece);
      }
      return result;
    });
  }
  return visible;
}
