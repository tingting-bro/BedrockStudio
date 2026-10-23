import * as THREE from "three";
import { api } from "@/lib/api";
import {
  selectionBounds,
  updateSelection,
  type Point,
  type ChunkKind,
  type SelectionShape,
} from "./map-view";
import type { VoxelPoint } from "./scene-data";

export function dimensionHeight(dimension: number): [number, number] {
  return dimension === 0
    ? [-64, 319]
    : dimension === 1
      ? [0, 127]
      : dimension === 2
        ? [0, 255]
        : [-2048, 2047];
}

export function chunkSelection(selected: Set<string>, dimension: number) {
  if (!selected.size) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  const mask = [...selected].map((key) => {
    const [x, z] = key.split(",").map(Number);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    return { x, z };
  });
  const [minY, maxY] = dimensionHeight(dimension);
  const corners: VoxelPoint[] = [
    { x: minX * 16, y: minY, z: minZ * 16 },
    { x: maxX * 16 + 15, y: maxY, z: maxZ * 16 + 15 },
  ];
  return { corners, mask };
}

/** Fetch every real selection page; commit only after the whole query succeeds. */
export async function selectSceneChunks(
  id: string,
  dimension: number,
  revision: number,
  start: Point,
  end: Point,
  shape: SelectionShape,
  kinds: ChunkKind[],
  selected: Set<string>,
  operation: "replace" | "add" | "invert" | "subtract",
  signal: AbortSignal,
) {
  const bounds = selectionBounds(start, end, shape);
  let cursor: number | null = 0;
  let result = operation === "replace" ? new Set<string>() : new Set(selected);
  do {
    const page: { items: Point[]; next_cursor: number | null } = await api(
      `/documents/${id}/chunks/select`,
      "POST",
      {
        dimension,
        revision,
        ...bounds,
        kinds,
        shape: shape === "circle" ? "circle" : "rectangle",
        cursor,
        page_size: ["terrain", "air", "unreadable"].every((kind) =>
          kinds.includes(kind as ChunkKind),
        )
          ? 4096
          : 32,
      },
      signal,
    );
    if (signal.aborted) return null;
    result = updateSelection(
      result,
      page.items,
      operation === "replace" ? "add" : operation,
    );
    cursor = page.next_cursor;
  } while (cursor !== null);
  return result;
}

/** Exact disjoint full-height chunk volumes, using only nearby display geometry. */
export class SceneChunkSelection {
  readonly root = new THREE.Group();
  private material = new THREE.LineBasicMaterial({
    color: 0x9beba2,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  private geometry = new THREE.BufferGeometry();
  private lines = new THREE.LineSegments(this.geometry, this.material);
  private previous?: Set<string>;
  private key = "";
  constructor() {
    this.lines.renderOrder = 8;
    this.root.add(this.lines);
  }
  update(
    selected: Set<string>,
    dimension: number,
    x: number,
    z: number,
    radius: number,
    ox: number,
    oz: number,
  ) {
    const cx = Math.floor(x / 16),
      cz = Math.floor(z / 16);
    const key = `${dimension}:${cx}:${cz}:${radius}:${ox}:${oz}`;
    if (this.previous === selected && this.key === key) return;
    this.previous = selected;
    this.key = key;
    const [lo, hi] = dimensionHeight(dimension);
    const vertices: number[] = [];
    for (let a = cx - radius; a <= cx + radius; a++)
      for (let b = cz - radius; b <= cz + radius; b++) {
        if (!selected.has(`${a},${b}`)) continue;
        const points = [
          [a * 16 - ox, lo, b * 16 - oz],
          [a * 16 + 16 - ox, lo, b * 16 - oz],
          [a * 16 + 16 - ox, lo, b * 16 + 16 - oz],
          [a * 16 - ox, lo, b * 16 + 16 - oz],
          [a * 16 - ox, hi + 1, b * 16 - oz],
          [a * 16 + 16 - ox, hi + 1, b * 16 - oz],
          [a * 16 + 16 - ox, hi + 1, b * 16 + 16 - oz],
          [a * 16 - ox, hi + 1, b * 16 + 16 - oz],
        ];
        for (const [i, j] of [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 0],
          [4, 5],
          [5, 6],
          [6, 7],
          [7, 4],
          [0, 4],
          [1, 5],
          [2, 6],
          [3, 7],
        ])
          vertices.push(...points[i], ...points[j]);
      }
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );
    this.lines.geometry = this.geometry;
    this.root.visible = vertices.length > 0;
  }
  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
