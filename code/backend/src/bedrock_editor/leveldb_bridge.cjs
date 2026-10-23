// A private stdio adapter; Python owns the documents, validation and save policy.
const { createRequire } = require("node:module");
const { createInterface } = require("node:readline");
const { createHash } = require("node:crypto");
const { availableParallelism, freemem } = require("node:os");
const requireFrontend = createRequire(process.argv[2]);
const { LevelDB } = requireFrontend("@8crafter/leveldb-zlib");
let db;
let markerCoordinateCache = null;
const readConcurrency = Math.max(1, Math.min(4, availableParallelism() - 1));

async function parallelRead(items, read) {
  let next = 0;
  const result = new Array(items.length);
  // Drain every iterator before reporting an error, so the next stdio command is safe.
  const workers = await Promise.allSettled(
    Array.from(
      { length: Math.min(readConcurrency, items.length) },
      async () => {
        while (next < items.length) {
          const index = next++;
          result[index] = await read(items[index]);
        }
      },
    ),
  );
  const failure = workers.find((worker) => worker.status === "rejected");
  if (failure) throw failure.reason;
  return result;
}

function markerCoordinate(key, coordinate = chunkKey(key)) {
  let kind;
  if (coordinate) {
    kind = { 49: "blocks", 50: "entities", 57: "structures" }[
      key[key.length <= 10 ? 8 : 12]
    ];
  } else if (
    [12, 16].includes(key.length) &&
    key.subarray(0, 4).equals(Buffer.from("digp")) &&
    namedKey(key) === null
  ) {
    coordinate = {
      x: key.readInt32LE(4),
      z: key.readInt32LE(8),
      dimension: key.length === 16 ? key.readInt32LE(12) : 0,
    };
    kind = "entities";
  }
  return kind ? { ...coordinate, kind } : null;
}

function chunkKey(key) {
  if (![9, 10, 13, 14].includes(key.length)) return null;
  if (namedKey(key) !== null) return null;
  const offset = key.length <= 10 ? 8 : 12;
  const dimension = offset === 8 ? 0 : key.readInt32LE(8);
  const tag = key[offset];
  if (!((tag >= 0x2b && tag <= 0x40) || tag === 0x76)) return null;
  if ((key.length === offset + 2) !== (tag === 0x2f)) return null;
  return { dimension, x: key.readInt32LE(0), z: key.readInt32LE(4) };
}

function validCoordinate({ dimension, x, z }) {
  if (
    ![dimension, x, z].every(
      (v) => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647,
    )
  )
    throw new Error("区块坐标或维度无效");
}

async function chunkRecords(coordinate, terrainOnly = false) {
  validCoordinate(coordinate);
  const { dimension, x, z } = coordinate;
  const prefixes =
    dimension === 0 ? [Buffer.alloc(8), Buffer.alloc(12)] : [Buffer.alloc(12)];
  const entries = [];
  let bytes = 0;
  for (const prefix of prefixes) {
    prefix.writeInt32LE(x, 0);
    prefix.writeInt32LE(z, 4);
    if (prefix.length === 12) prefix.writeInt32LE(dimension, 8);
    // A fixed prefix followed by 0xff bounds all coordinate record tags.
    await iterate(
      db,
      {
        fillCache: true,
        gte: terrainOnly
          ? Buffer.concat([prefix, Buffer.from([0x2f])])
          : prefix,
        lt: Buffer.concat([
          prefix,
          Buffer.from([
            terrainOnly ? (coordinate.fullHeight ? 0x31 : 0x30) : 0xff,
          ]),
        ]),
      },
      async (key, value) => {
        const parsed = chunkKey(key);
        if (
          !parsed ||
          parsed.dimension !== dimension ||
          parsed.x !== x ||
          parsed.z !== z ||
          (terrainOnly &&
            !coordinate.fullHeight &&
            (key[prefix.length] !== 0x2f ||
              key.readInt8(key.length - 1) * 16 > coordinate.ceiling))
        )
          return;
        if (value.length > 16 * 1024 * 1024)
          throw new Error("区块记录大小无效");
        bytes += value.length;
        if (bytes > 64 * 1024 * 1024)
          throw new Error("单区块读取超过 64 MB 上限");
        if (!entries.some((entry) => entry.key === key.toString("hex")))
          entries.push({
            key: key.toString("hex"),
            value: value.toString("base64"),
          });
      },
    );
  }
  return entries;
}

async function iterate(database, options, visit) {
  const iterator = database.getIterator(options);
  try {
    let pair;
    // The native iterator returns [value, key]. End it explicitly, even on failure.
    while ((pair = await iterator.next()) !== null) {
      const pending = visit(pair[1], pair[0]);
      if (pending) await pending;
    }
  } finally {
    await iterator.end();
  }
}

async function resetSources(dimension) {
  validCoordinate({ dimension, x: 0, z: 0 });
  const prefixes = new Set();
  await iterate(db, { values: false }, async (key) => {
    const coordinate = chunkKey(key);
    if (coordinate?.dimension === dimension) {
      prefixes.add(key.subarray(0, key.length <= 10 ? 8 : 12).toString("hex"));
      if (dimension === 0) {
        prefixes.add(key.subarray(0, 8).toString("hex"));
        prefixes.add(
          Buffer.concat([key.subarray(0, 8), Buffer.alloc(4)]).toString("hex"),
        );
      }
    }
  });
  const items = [];
  const signature = createHash("sha256");
  await iterate(db, {}, async (key, value) => {
    const name = namedKey(key);
    let item;
    if (
      [12, 16].includes(key.length) &&
      key.subarray(0, 4).equals(Buffer.from("digp")) &&
      name === null
    ) {
      item = {
        kind: "link",
        dimension: key.length === 12 ? 0 : key.readInt32LE(12),
      };
    } else if (
      key.length === 19 &&
      key.subarray(0, 11).equals(Buffer.from("actorprefix"))
    ) {
      item = { kind: "actor" };
    } else if (
      name !== null &&
      (value[0] === 10 ||
        categoryOf(name) !== "other" ||
        name.startsWith("VILLAGE_"))
    ) {
      item = { kind: "named", name };
    } else if (name === null && [9, 10, 13, 14].includes(key.length)) {
      const owner = key.length <= 10 ? 0 : key.readInt32LE(8);
      const prefix = key.subarray(0, key.length <= 10 ? 8 : 12).toString("hex");
      if (owner === dimension && prefixes.has(prefix))
        item = { kind: "coordinate", dimension: owner };
    }
    if (!item) return;
    if (value.length > 16 * 1024 * 1024)
      throw new Error("维度记录超过 16 MB，已取消重置");
    const hex = key.toString("hex");
    signature.update(
      `${hex}:${createHash("sha256").update(value).digest("hex")}\n`,
    );
    items.push({ key: hex, ...item });
  });
  return { items, signature: signature.digest("hex") };
}

function namedKey(key) {
  // Coordinate keys usually contain zero bytes: avoid allocating UTF-8 strings/buffers.
  for (const byte of key) if (byte < 32 || byte === 127) return null;
  const name = key.toString("utf8");
  if (
    !key.length ||
    !Buffer.from(name, "utf8").equals(key) ||
    /[\x00-\x1f\x7f]/.test(name)
  )
    return null;
  return name;
}

function categoryOf(name) {
  if (
    name === "~local_player" ||
    name === "~local_player.Editor" ||
    name.startsWith("player_")
  )
    return "players";
  if (/^map_-?\d+$/.test(name)) return "maps";
  if (name.startsWith("tickingarea_")) return "tickingareas";
  if (name.startsWith("structuretemplate_")) return "structures";
  if (name === "portals") return "portals";
  if (name === "scoreboard") return "scoreboard";
  return "other";
}

async function describe(key, knownCategory) {
  const name = namedKey(key);
  if (name === null) return null;
  const category = knownCategory ?? categoryOf(name);
  if (category === "other") {
    const value = await db.get(key);
    if (!value || value.length < 3 || value[0] !== 10) return null;
  } else {
    let found = false;
    await iterate(
      db,
      { gte: key, lte: key, values: false },
      async (candidate) => {
        found = candidate.equals(key);
      },
    );
    if (!found) return null;
  }
  return { id: key.toString("hex"), name, category };
}

async function command(request) {
  switch (request.command) {
    case "open":
      markerCoordinateCache = null;
      db = new LevelDB(request.path, {
        createIfMissing: false,
        cacheSize: Math.max(
          8 << 20,
          Math.min(128 << 20, Math.floor(freemem() / 32)),
        ),
      });
      await db.open();
      return true;
    case "players": {
      const keys = [];
      for (const [gte, lt] of [
        ["player_", "player`"],
        ["~local_player", "~local_playes"],
      ]) {
        await iterate(db, { gte, lt, values: false }, async (key) => {
          const name = key.toString("utf8");
          if (
            name === "~local_player" ||
            name === "~local_player.Editor" ||
            name.startsWith("player_")
          ) {
            keys.push({ id: key.toString("hex"), name });
          }
        });
      }
      return keys.sort((a, b) => {
        if (a.name === b.name) return 0;
        if (a.name === "~local_player") return -1;
        if (b.name === "~local_player") return 1;
        return a.name.localeCompare(b.name);
      });
    }
    case "data": {
      const category = request.category;
      const ranges = {
        maps: { gte: "map_", lt: "map`" },
        tickingareas: { gte: "tickingarea_", lt: "tickingarea`" },
        structures: { gte: "structuretemplate_", lt: "structuretemplate`" },
      };
      if (category === "portals" || category === "scoreboard") {
        const entry = await describe(Buffer.from(category), category);
        return entry ? [entry] : [];
      }
      if (category && category !== "other" && !ranges[category])
        throw new Error("data 分类无效");
      const keys = [];
      await iterate(db, { ...ranges[category], values: false }, async (key) => {
        const name = namedKey(key);
        if (name === null) return;
        const kind = categoryOf(name);
        if (kind === "players" || (category && kind !== category)) return;
        if (kind === "other") {
          const entry = await describe(key, kind);
          if (entry) keys.push(entry);
        } else {
          keys.push({ id: key.toString("hex"), name, category: kind });
        }
      });
      return keys;
    }
    case "lookup":
      return describe(Buffer.from(request.key, "hex"));
    case "chunks": {
      const chunks = new Map();
      let objects = new Map();
      const ranges = Array.from({ length: readConcurrency }, (_, index) => ({
        gte: Buffer.from([Math.floor((index * 256) / readConcurrency)]),
        ...(index + 1 < readConcurrency
          ? {
              lt: Buffer.from([
                Math.floor(((index + 1) * 256) / readConcurrency),
              ]),
            }
          : {}),
        values: false,
        fillCache: false,
      }));
      await parallelRead(ranges, (range) =>
        iterate(db, range, (key) => {
          const coordinate = chunkKey(key);
          if (objects) {
            const object = markerCoordinate(key, coordinate);
            if (object)
              objects.set(
                `${object.kind},${object.dimension},${object.x},${object.z}`,
                object,
              );
            // This optional cache must not impose a new restriction on terrain indexing.
            if (objects.size > 1000000) objects = null;
          }
          if (
            coordinate &&
            (request.dimension === undefined ||
              coordinate.dimension === request.dimension)
          )
            chunks.set(
              `${coordinate.dimension},${coordinate.x},${coordinate.z}`,
              coordinate,
            );
          if (chunks.size > 1000000)
            throw new Error("区块索引超过 100 万个上限");
        }),
      );
      // The terrain scan also discovers object sources; enabling a layer avoids a second full scan.
      markerCoordinateCache = objects ? [...objects.values()] : null;
      return [...chunks.values()];
    }
    case "chunk":
      return chunkRecords(request);
    case "reset-sources":
      return resetSources(request.dimension);
    case "marker-coordinates": {
      if (markerCoordinateCache !== null) return markerCoordinateCache;
      const coordinates = new Map();
      await iterate(db, { values: false }, async (key) => {
        const coordinate = markerCoordinate(key);
        if (!coordinate) return;
        coordinates.set(
          `${coordinate.kind},${coordinate.dimension},${coordinate.x},${coordinate.z}`,
          coordinate,
        );
        if (coordinates.size > 1000000)
          throw new Error("地图对象索引超过 100 万个上限");
      });
      markerCoordinateCache = [...coordinates.values()];
      return markerCoordinateCache;
    }
    case "map-villages": {
      const entries = [];
      await iterate(
        db,
        { gte: "VILLAGE_", lt: "VILLAGE`", values: false },
        async (key) => {
          const name = namedKey(key);
          if (name && name.endsWith("_INFO"))
            entries.push({ id: key.toString("hex"), name });
          if (entries.length > 100000) throw new Error("村庄记录索引超过上限");
        },
      );
      return entries;
    }
    case "actor-links": {
      const suffix = Buffer.from(request.suffix, "hex");
      if (suffix.length !== 8) throw new Error("实体索引标识无效");
      const links = [];
      let bytes = 0;
      await iterate(db, { gte: "digp", lt: "digq" }, async (key, value) => {
        if (![12, 16].includes(key.length) || namedKey(key) !== null) return;
        bytes += value.length;
        if (bytes > 64 * 1024 * 1024 || value.length % 8)
          throw new Error("实体索引过大或损坏，已取消删除");
        for (let i = 0; i < value.length; i += 8) {
          if (value.subarray(i, i + 8).equals(suffix)) {
            links.push(key.toString("hex"));
            break;
          }
        }
        if (links.length > 10000) throw new Error("实体索引引用数量超过上限");
      });
      return links;
    }
    case "chunk-markers": {
      if (!Array.isArray(request.chunks) || request.chunks.length > 64)
        throw new Error("标记查询最多支持 64 个区块");
      const layers = new Set(request.layers);
      const entries = new Map();
      let bytes = 0;
      let truncated = false;
      async function readMarker(key, kind) {
        const value = await db.get(key);
        if (value === null) return null;
        if (
          value.length > 16 * 1024 * 1024 ||
          bytes + value.length > 8 * 1024 * 1024
        ) {
          truncated = true;
          return null;
        }
        if (!entries.has(key.toString("hex"))) {
          bytes += value.length;
          entries.set(key.toString("hex"), {
            key: key.toString("hex"),
            kind,
            value: value.toString("base64"),
          });
        }
        return value;
      }
      for (const point of request.chunks) {
        validCoordinate({ ...point, dimension: request.dimension });
        const prefix = Buffer.alloc(request.dimension === 0 ? 8 : 12);
        prefix.writeInt32LE(point.x, 0);
        prefix.writeInt32LE(point.z, 4);
        if (prefix.length === 12) prefix.writeInt32LE(request.dimension, 8);
        const prefixes =
          prefix.length === 8
            ? [prefix, Buffer.concat([prefix, Buffer.alloc(4)])]
            : [prefix];
        for (const p of prefixes) {
          if (layers.has("blocks"))
            await readMarker(Buffer.concat([p, Buffer.from([0x31])]), "blocks");
          if (layers.has("structures"))
            await readMarker(
              Buffer.concat([p, Buffer.from([0x39])]),
              "structures",
            );
          if (layers.has("entities")) {
            await readMarker(
              Buffer.concat([p, Buffer.from([0x32])]),
              "entities",
            );
            const digest = await db.get(
              Buffer.concat([Buffer.from("digp"), p]),
            );
            if (!digest) continue;
            if (digest.length % 8 || digest.length > 8 * 2048) {
              truncated = true;
              continue;
            }
            for (let i = 0; i < digest.length; i += 8) {
              if (entries.size >= 2048 || truncated) {
                truncated = true;
                break;
              }
              await readMarker(
                Buffer.concat([
                  Buffer.from("actorprefix"),
                  digest.subarray(i, i + 8),
                ]),
                "entities",
              );
            }
          }
        }
        if (truncated) break;
      }
      return { items: [...entries.values()], truncated };
    }
    case "chunk-terrains": {
      if (
        !Array.isArray(request.chunks) ||
        request.chunks.length > 64 ||
        !Number.isInteger(request.ceiling) ||
        request.ceiling < -2048 ||
        request.ceiling > 2047
      )
        throw new Error("地形预览参数无效");
      for (const point of request.chunks)
        validCoordinate({ ...point, dimension: request.dimension });
      return parallelRead(request.chunks, (point) =>
        chunkRecords(
          {
            ...point,
            dimension: request.dimension,
            ceiling: request.ceiling,
            fullHeight: request.full_height === true,
          },
          true,
        ),
      );
    }
    case "get": {
      const value = await db.get(Buffer.from(request.key, "hex"));
      if (value === null) {
        if (request.optional) return null;
        throw new Error("玩家记录已不存在");
      }
      if (value.length > 16 * 1024 * 1024)
        throw new Error("玩家记录超过 16 MB 上限");
      return value.toString("base64");
    }
    case "write": {
      markerCoordinateCache = null;
      if (request.reset_check) {
        const current = await resetSources(request.reset_check.dimension);
        if (current.signature !== request.reset_check.signature)
          throw new Error("维度数据在保存前发生变化，已取消写入");
      }
      // Recheck the exact coordinate-key set and bytes inside the private driver,
      // immediately before the single synchronous batch shared with NBT edits.
      for (const check of request.chunk_checks ?? []) {
        const current = await chunkRecords(check);
        if (
          current.length !== Object.keys(check.hashes).length ||
          current.some(
            ({ key, value }) =>
              createHash("sha256")
                .update(Buffer.from(value, "base64"))
                .digest("hex") !== check.hashes[key],
          )
        )
          throw new Error("区块在保存前发生变化，已取消写入");
      }
      for (const check of request.object_checks ?? []) {
        const raw = await db.get(Buffer.from(check.key, "hex"));
        const hash =
          raw === null ? null : createHash("sha256").update(raw).digest("hex");
        if (hash !== check.hash)
          throw new Error("地图对象在保存前发生变化，已取消写入");
      }
      await db.batch(
        request.items.map(({ key, value }) => {
          if (value === null)
            return { type: "del", key: Buffer.from(key, "hex") };
          return {
            type: "put",
            key: Buffer.from(key, "hex"),
            value: Buffer.from(value, "base64"),
          };
        }),
        { sync: true },
      );
      return true;
    }
    case "close":
      markerCoordinateCache = null;
      if (db) await db.close();
      return true;
    default:
      throw new Error("未知数据库命令");
  }
}

async function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      try {
        const request = JSON.parse(line);
        const result = await command(request);
        process.stdout.write(`${JSON.stringify({ result })}\n`);
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({ error: String(error.message ?? error) })}\n`,
        );
      }
    }
  } finally {
    if (db) await db.close();
  }
}
main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
