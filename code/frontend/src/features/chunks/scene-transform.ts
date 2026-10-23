import type { VoxelPoint } from "./scene-data";

export const axes = ["x", "y", "z"] as const;
export interface PasteTransform {
  rotation: [number, number, number];
  mirror: [boolean, boolean, boolean];
  axisOrder?: "xyz" | "xzy" | "yxz" | "yzx" | "zxy" | "zyx";
  scale?: number;
}
export const identityTransform = (): PasteTransform => ({
  rotation: [0, 0, 0],
  mirror: [false, false, false],
  axisOrder: "xyz",
  scale: 1,
});
export const quarterTurn = (angle: number) =>
  (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
export function snapPosition(point: VoxelPoint, step: number): VoxelPoint {
  const snap = Math.max(1, Math.round(step));
  return Object.fromEntries(
    axes.map((axis) => {
      const value = Math.round(point[axis] / snap) * snap;
      const min = axis === "y" ? -2048 : -(2 ** 35);
      const max = axis === "y" ? 2047 : 2 ** 35 - 1;
      return [
        axis,
        Math.max(
          Math.ceil(min / snap) * snap,
          Math.min(Math.floor(max / snap) * snap, value),
        ),
      ];
    }),
  ) as unknown as VoxelPoint;
}
