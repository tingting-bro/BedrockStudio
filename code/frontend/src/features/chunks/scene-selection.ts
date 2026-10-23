import type { VoxelPoint } from "./scene-data";
import { selectionBounds } from "./scene-data";

export function selectionSize(corners: VoxelPoint[], sphere: boolean) {
  if (!corners.length) return null;
  const { low, high } = selectionBounds(
    corners[0],
    corners[1] ?? corners[0],
    sphere,
  );
  const size = {
    x: high.x - low.x + 1,
    y: high.y - low.y + 1,
    z: high.z - low.z + 1,
  };
  // A displayed volume may exceed JS's exact integer range even though coordinates do not.
  return { ...size, volume: BigInt(size.x) * BigInt(size.y) * BigInt(size.z) };
}

export function nudgeSelection(
  corners: VoxelPoint[],
  target: "first" | "second" | "box",
  delta: VoxelPoint,
): VoxelPoint[] {
  const moved = corners.map((point, index) =>
    target === "box" || index === (target === "first" ? 0 : 1)
      ? { x: point.x + delta.x, y: point.y + delta.y, z: point.z + delta.z }
      : { ...point },
  );
  if (
    moved.some(
      (p) =>
        !Number.isSafeInteger(p.x) ||
        !Number.isSafeInteger(p.y) ||
        !Number.isSafeInteger(p.z) ||
        p.y < -2048 ||
        p.y > 2047 ||
        p.x < -(2 ** 35) ||
        p.x >= 2 ** 35 ||
        p.z < -(2 ** 35) ||
        p.z >= 2 ** 35,
    )
  )
    return corners;
  return moved;
}
