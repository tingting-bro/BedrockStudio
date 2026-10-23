// Generated from the offline vanilla pack; see resource_packs/minecraft/manifest.json.
import textures from "./minecraft-textures.json";
const icons: Readonly<Record<string, string>> = textures;
const aliases: Record<string, string> = {
  players: "player",
  player_spawns: "bed",
  entities: "egg",
  blocks: "chest",
  maps: "map",
  tickingareas: "timer",
  structures: "structure_block",
  portals: "portal",
  villages: "villager",
  villager_v2: "villager",
  mooshroom: "cow",
  cave_spider: "spider",
  zombie_villager: "villager",
  zombie_villager_v2: "villager",
  wandering_trader: "villager",
  chestminecart: "chest_minecart",
  minecartchest: "chest_minecart",
  enderchest: "ender_chest",
  blastfurnace: "blast_furnace",
  shulker_box: "shulkerbox",
  command_block: "commandblock",
  enchantingtable: "enchanting_table",
  enchanttable: "enchanting_table",
  brewingstand: "brewing_stand",
  structureblock: "structure_block",
  book: "book_normal",
  enchanted_book: "book_enchanted",
  totem_of_undying: "totem",
  porkchop: "porkchop_raw",
  beef: "beef_raw",
  golden_apple: "apple_golden",
  enchanted_golden_apple: "apple_golden",
  fire_charge: "fireball",
  filled_map: "map",
  tropical_fish: "fish_clownfish",
  pufferfish: "fish_pufferfish",
  oak_door: "door_wood",
};
export function minecraftIcon(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "");
  if (!/^[a-z0-9_]+$/.test(normalized)) return undefined;
  // Bedrock atlas filenames sometimes reverse the identifier's material/type.
  const reordered = normalized.replace(
    /^(.+)_(bucket|boat|door|bed)$/,
    "$2_$1",
  );
  for (const key of [normalized, aliases[normalized], reordered]) {
    if (key && Object.hasOwn(icons, key)) return icons[key];
  }
  return undefined;
}
