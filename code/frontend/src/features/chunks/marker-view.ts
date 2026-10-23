import type { Camera } from "./map-view";
import { minecraftIcon } from "@/lib/minecraft-icons";

export const markerLayers = [
  ["players", "玩家"],
  ["player_spawns", "玩家重生点"],
  ["entities", "实体"],
  ["blocks", "方块实体（箱子等）"],
  ["portals", "传送门记录"],
  ["villages", "村庄范围"],
  ["tickingareas", "常加载区域"],
  ["maps", "物品地图中心"],
  ["structures", "建筑 / 结构生成区域"],
  ["spawn", "世界出生点"],
] as const;
export type MarkerKind = (typeof markerLayers)[number][0];
export type Overlays = Partial<Record<MarkerKind, boolean>>;
export interface MapMarker {
  id: string;
  kind: MarkerKind;
  label: string;
  object_ref?: string | null;
  object_type?: string;
  icon_type?: string;
  source_name?: string;
  render?: {
    rotation: [number, number];
    scale: number;
    baby: boolean;
    sheared?: boolean;
  } | null;
  x: number;
  y: number | null;
  z: number;
  area?: { min_x: number; max_x: number; min_z: number; max_z: number } | null;
}
export interface MarkerGroup {
  x: number;
  y: number;
  members: MapMarker[];
}
const kinds: Record<MarkerKind, [string, string]> = {
  players: ["☺", "#75c9f1"],
  player_spawns: ["⚑", "#84abea"],
  entities: ["●", "#e7b879"],
  blocks: ["▣", "#8ed9b2"],
  portals: ["◈", "#d190ec"],
  villages: ["⌂", "#edc79b"],
  tickingareas: ["◇", "#71d9d0"],
  maps: ["▧", "#dcd289"],
  structures: ["△", "#c9a5eb"],
  spawn: ["★", "#efc476"],
};
const symbols: Record<string, string> = {
  pig: "🐖",
  cow: "🐄",
  sheep: "🐑",
  chicken: "🐔",
  horse: "🐎",
  wolf: "🐺",
  cat: "🐈",
  villager: "👤",
  villager_v2: "👤",
  zombie: "Z",
  skeleton: "骨",
  creeper: "C",
  item: "◆",
  boat: "舟",
  chest_boat: "舟",
  minecart: "轨",
  armor_stand: "架",
  chest: "箱",
  barrel: "桶",
  shulkerbox: "盒",
  sign: "牌",
  hangingsign: "牌",
  furnace: "炉",
  mobspawner: "笼",
  commandblock: ">_",
  beacon: "光",
  bed: "床",
  hopper: "漏",
  endgateway: "◎",
};
export function markerStyle(marker: MapMarker) {
  const type = marker.object_type?.replace(/^minecraft:/, "").toLowerCase();
  const [symbol, color] = kinds[marker.kind];
  return {
    symbol: symbols[type ?? ""] ?? symbol,
    color,
    icon:
      minecraftIcon(marker.icon_type) ??
      minecraftIcon(type) ??
      minecraftIcon(marker.kind),
  };
}

// Groups use screen pixels, so icon size and hit targets remain stable at any zoom.
export function groupMarkers(
  markers: MapMarker[],
  overlays: Overlays,
  camera: Camera,
  width: number,
  height: number,
): MarkerGroup[] {
  const cells = new Map<string, MarkerGroup>();
  const radius = camera.scale < 0.75 ? 40 : 24;
  for (const marker of markers) {
    if (!overlays[marker.kind]) continue;
    const x = (marker.x - camera.x) * camera.scale + width / 2;
    const y = (marker.z - camera.z) * camera.scale + height / 2;
    if (x < -16 || y < -16 || x > width + 16 || y > height + 16) continue;
    const key = `${Math.floor(x / radius)},${Math.floor(y / radius)}`;
    const group = cells.get(key);
    if (group) {
      const count = group.members.length;
      group.x = (group.x * count + x) / (count + 1);
      group.y = (group.y * count + y) / (count + 1);
      group.members.push(marker);
    } else cells.set(key, { x, y, members: [marker] });
  }
  return [...cells.values()];
}
export function hitMarker(groups: MarkerGroup[], x: number, y: number) {
  let nearest: MarkerGroup | null = null;
  let distance = 16 ** 2;
  for (const group of groups) {
    const d = (group.x - x) ** 2 + (group.y - y) ** 2;
    if (d < distance) {
      nearest = group;
      distance = d;
    }
  }
  return nearest;
}
