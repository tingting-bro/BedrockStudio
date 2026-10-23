import type { Atlas, Block } from "./scene-data";
export type Box = [number, number, number, number, number, number];
export interface Model {
  boxes: Box[];
  faces: number[];
  kind: number;
  solid: boolean;
  cross?: boolean;
  unknown?: boolean;
}
export const air = (name: string) =>
  /^(air|cave_air|void_air|structure_void)$/.test(
    name.replace("minecraft:", ""),
  );
/** Only actual connecting blocks; wall signs, coral fans, etc. are not walls. */
export function connectionFamily(name: string) {
  name = name.replace(/^minecraft:/, "");
  if (
    name === "iron_bars" ||
    name === "glass_pane" ||
    name.endsWith("_stained_glass_pane")
  )
    return "pane";
  if (name === "cobblestone_wall" || name.endsWith("_wall")) return "wall";
  if (name === "fence" || name.endsWith("_fence")) return "fence";
  return undefined;
}
const aliases: Record<string, string> = {
  grass_block: "grass",
  oak_log: "oak_log",
  stone_bricks: "stonebrick",
  bricks: "brick_block",
  snow_block: "snow",
  sugar_cane: "reeds",
  lily_pad: "waterlily",
  oak_fence: "fence",
  oak_door: "wooden_door",
  oak_trapdoor: "trapdoor",
  stone_block_slab: "stone_slab",
  double_stone_block_slab: "stone_slab",
  stone_block_slab2: "red_sandstone_slab",
  stone_block_slab3: "end_stone_brick_slab",
  stone_block_slab4: "mossy_stone_brick_slab",
};
export function blockModel(
  block: Block,
  atlas: Atlas,
  connects: boolean[] = [false, false, false, false],
  neighbors: (Block | undefined)[] = [],
): Model {
  const name = block.name.replace(/^minecraft:/, ""),
    states = block.states;
  const read = (key: string) => states[key] ?? states[`minecraft:${key}`];
  const flag = (key: string) => read(key) === 1 || read(key) === "true";
  const full: Box = [0, 0, 0, 1, 1, 1];
  const water = /^(flowing_)?water$/.test(name),
    lava = /^(flowing_)?lava$/.test(name);
  const transparent = water || /glass|(?:^|_)ice$/.test(name);
  const cutout =
    /leaves|sapling|flower|fern|vine|bush|torch|rail|tallgrass|short_grass|seagrass|kelp|crops|wheat|carrot|potato|beetroot|sprouts|dripleaf|fire|glow_lichen/.test(
      name,
    ) ||
    /^(brown_mushroom|red_mushroom|deadbush|tall_grass|reeds|sugar_cane|double_plant|pink_petals|leaf_litter|waterlily|lily_pad|ladder|bamboo)$/.test(
      name,
    );
  let boxes: Box[] = air(block.name) ? [] : [full];
  let solid = boxes.length > 0 && !transparent && !cutout;
  let cross = false;
  if (water || lava) {
    const level = Number(read("liquid_depth") ?? 0);
    boxes = [[0, 0, 0, 1, level === 0 || level >= 8 ? 1 : (8 - level) / 8, 1]];
    solid = false;
  }
  if (/slab/.test(name) && !/double/.test(name)) {
    const top = flag("top_slot_bit") || read("vertical_half") === "top";
    boxes = [[0, top ? 0.5 : 0, 0, 1, top ? 1 : 0.5, 1]];
    solid = false;
  } else if (/stairs/.test(name)) {
    const top = flag("upside_down_bit");
    boxes = [
      [0, top ? 0.5 : 0, 0, 1, top ? 1 : 0.5, 1],
      [0.5, top ? 0 : 0.5, 0, 1, top ? 0.5 : 1, 1],
    ];
    const direction = Number(read("weirdo_direction") ?? 0);
    boxes = boxes.map((b) => rotateBox(b, [0, 2, 1, 3][direction % 4]));
    const facing = [1, 3, 2, 0][direction % 4]; // neighbors: north, east, south, west
    const turn = [0, 2, 1, 3][direction % 4];
    const neighborTurn = (neighbor: Block | undefined) =>
      neighbor &&
      /stairs/.test(neighbor.name) &&
      Number(
        neighbor.states.upside_down_bit ??
          neighbor.states["minecraft:upside_down_bit"] ??
          0,
      ) === Number(top)
        ? [0, 2, 1, 3][
            Number(
              neighbor.states.weirdo_direction ??
                neighbor.states["minecraft:weirdo_direction"] ??
                0,
            ) % 4
          ]
        : null;
    const front = neighborTurn(neighbors[facing]),
      back = neighborTurn(neighbors[(facing + 2) % 4]);
    const half = boxes[1];
    const facingForTurn = [1, 2, 3, 0];
    if (
      front !== null &&
      front % 2 !== turn % 2 &&
      neighborTurn(neighbors[(facingForTurn[front] + 2) % 4]) !== turn
    ) {
      const other = rotateBox(
        [0.5, top ? 0 : 0.5, 0, 1, top ? 0.5 : 1, 1],
        front,
      );
      boxes[1] = [
        Math.max(half[0], other[0]),
        half[1],
        Math.max(half[2], other[2]),
        Math.min(half[3], other[3]),
        half[4],
        Math.min(half[5], other[5]),
      ];
    } else if (
      back !== null &&
      back % 2 !== turn % 2 &&
      neighborTurn(neighbors[facingForTurn[back]]) !== turn
    ) {
      boxes.push(rotateBox([0.5, top ? 0 : 0.5, 0, 1, top ? 0.5 : 1, 1], back));
    }
    solid = false;
  } else if (/trapdoor/.test(name)) {
    const open = flag("open_bit"),
      top = flag("upside_down_bit");
    boxes = [
      open
        ? [0, 0, 0, 1, 1, 0.1875]
        : [0, top ? 0.8125 : 0, 0, 1, top ? 1 : 0.1875, 1],
    ];
    boxes = boxes.map((b) => rotateBox(b, Number(read("direction") ?? 0)));
    solid = false;
  } else if (/door/.test(name)) {
    const direction =
      (Number(read("direction") ?? 0) +
        (flag("open_bit") ? (flag("door_hinge_bit") ? 3 : 1) : 0)) %
      4;
    boxes = [rotateBox([0, 0, 0, 1, 1, 0.1875], direction)];
    solid = false;
  } else if (/fence_gate/.test(name)) {
    const open = flag("open_bit");
    boxes = open
      ? [
          [0, 0, 0.375, 0.125, 1, 0.625],
          [0.875, 0, 0.375, 1, 1, 0.625],
        ]
      : [[0, 0, 0.375, 1, 1, 0.625]];
    boxes = boxes.map((box) => rotateBox(box, Number(read("direction") ?? 0)));
    solid = false;
  } else if (connectionFamily(name)) {
    const pane = connectionFamily(name) === "pane",
      wall = connectionFamily(name) === "wall",
      lo = pane ? 0.4375 : wall ? 0.25 : 0.375;
    boxes =
      wall && read("wall_post_bit") !== undefined && !flag("wall_post_bit")
        ? []
        : [[lo, 0, lo, 1 - lo, 1, 1 - lo]];
    connects.forEach((yes, i) => {
      const state = wall
        ? read(`wall_connection_type_${["north", "east", "south", "west"][i]}`)
        : undefined;
      if (state !== undefined ? state === "none" : !yes) return;
      // A clockwise quarter turn maps north to east (rotateBox itself turns west).
      const turn = (4 - i) % 4;
      if (pane || wall)
        boxes.push(
          rotateBox(
            [
              wall ? 0.3125 : lo,
              0,
              0,
              wall ? 0.6875 : 1 - lo,
              wall && state !== "tall" ? 0.8125 : 1,
              0.5,
            ],
            turn,
          ),
        );
      else boxes.push(rotateBox([0.375, 0, 0, 0.625, 1, 0.5], turn));
    });
    solid = false;
  } else if (/pointed_dripstone/.test(name)) {
    // Bedrock stores the tip shape as states, not a block geometry reference.
    // Build the four tapered segments used by the vanilla model.
    const down =
      read("vertical_direction") === "down" ||
      Number(read("vertical_direction")) === 1;
    const thickness = String(read("thickness") ?? "tip");
    const heights: Record<string, number[]> = {
      tip: [0.125, 0.125, 0.125, 0.125],
      frustum: [0.25, 0.25, 0.25, 0.25],
      middle: [0.5, 0.25, 0.125, 0.125],
      base: [1, 0.5, 0.25, 0.125],
    };
    const widths = heights[thickness] ?? heights.tip;
    boxes = widths.map((width, i) => {
      const y0 = i / 4,
        y1 = (i + 1) / 4;
      const w0 = Math.max(0.0625, width - (down ? i : 3 - i) * 0.125);
      const w1 = Math.max(0.0625, width - (down ? i + 1 : 2 - i) * 0.125);
      return [
        0.5 - w1 / 2,
        down ? 1 - y1 : y0,
        0.5 - w1 / 2,
        0.5 + w1 / 2,
        down ? 1 - y0 : y1,
        0.5 + w1 / 2,
      ];
    });
    solid = false;
  } else if (name === "glow_lichen") {
    // multi_face_direction_bits uses the Bedrock face mask. Keep the plate
    // inside the voxel so adjacent blocks can still occlude its back side.
    const mask = Number(read("multi_face_direction_bits") ?? 63);
    const faces: [number, Box][] = [
      [1, [0, 0, 0.9375, 1, 1, 1]],
      [2, [0, 0, 0, 1, 1, 0.0625]],
      [4, [0, 0, 0, 0.0625, 1, 1]],
      [8, [0.9375, 0, 0, 1, 1, 1]],
      [16, [0, 0.9375, 0, 1, 1, 1]],
      [32, [0, 0, 0, 1, 0.0625, 1]],
    ];
    boxes = faces.filter(([bit]) => (mask & bit) !== 0).map(([, box]) => box);
    solid = false;
  } else if (/snow_layer/.test(name)) {
    boxes = [[0, 0, 0, 1, (Number(read("height") ?? 0) + 1) / 8, 1]];
    solid = false;
  } else if (/carpet/.test(name)) {
    boxes = [[0, 0, 0, 1, 0.0625, 1]];
    solid = false;
  } else if (/farmland|grass_path|dirt_path/.test(name)) {
    boxes = [[0, 0, 0, 1, 0.9375, 1]];
    solid = false;
  } else if (
    /^(pink_petals|wildflowers|leaf_litter|waterlily|lily_pad)$/.test(name) ||
    /rail$/.test(name)
  ) {
    boxes = [[0, 0, 0, 1, 1 / 64, 1]];
    solid = false;
  } else if (name === "bamboo") {
    boxes = [[0.40625, 0, 0.40625, 0.59375, 1, 0.59375]];
    solid = false;
  } else if (name === "cactus") {
    boxes = [[0.0625, 0, 0.0625, 0.9375, 1, 0.9375]];
    solid = false;
  } else if (name === "ladder") {
    const facing = Number(read("facing_direction") ?? 2);
    boxes = [
      rotateBox(
        [0, 0, 0.9375, 1, 1, 1],
        ({ 2: 0, 3: 2, 4: 1, 5: 3 } as Record<number, number>)[facing] ?? 0,
      ),
    ];
    solid = false;
  } else if (name === "vine") {
    const mask = Number(read("vine_direction_bits") ?? 0);
    const plates: [number, Box][] = [
      [1, [0, 0, 0.9375, 1, 1, 1]],
      [2, [0, 0, 0, 0.0625, 1, 1]],
      [4, [0, 0, 0, 1, 1, 0.0625]],
      [8, [0.9375, 0, 0, 1, 1, 1]],
    ];
    boxes = mask
      ? plates.filter(([bit]) => (mask & bit) !== 0).map(([, box]) => box)
      : [[0, 0.9375, 0, 1, 1, 1]];
    solid = false;
  } else if (cutout && !/leaves/.test(name)) {
    cross = true;
    solid = false;
  }
  const key = atlas.blocks[name] ? name : (aliases[name] ?? name);
  let textures = atlas.blocks[key];
  if (water) textures = atlas.blocks.water;
  if (lava) textures = atlas.blocks.lava;
  const variant =
    Number(read("stone_slab_type") ?? read("stone_type") ?? 0) || 0;
  const faceNames = ["east", "west", "up", "down", "south", "north"];
  const faces = faceNames.map((side, i) => {
    let material =
      typeof textures === "string"
        ? textures
        : (textures?.[side] ??
          textures?.[i === 2 ? "up" : i === 3 ? "down" : "side"]);
    if (
      /door/.test(name) &&
      !/trapdoor/.test(name) &&
      typeof textures !== "string"
    )
      material = flag("upper_block_bit") ? textures?.side : textures?.up;
    const axis = read("pillar_axis");
    if (axis === "x" && typeof textures !== "string")
      material = i < 2 ? textures?.up : textures?.side;
    if (axis === "z" && typeof textures !== "string")
      material = i >= 4 ? textures?.up : textures?.side;
    const variants = atlas.textures[material ?? ""];
    return variants?.[variant % variants.length] ?? 0;
  });
  return {
    boxes,
    faces,
    kind: transparent ? 2 : cutout || cross ? 1 : 0,
    solid,
    cross,
    unknown: !textures && boxes.length > 0,
  };
}
export function rotateBox(b: Box, turns: number): Box {
  let r = b;
  for (let i = 0; i < turns; i++)
    r = [1 - r[5], r[1], r[0], 1 - r[2], r[4], r[3]];
  return r;
}
