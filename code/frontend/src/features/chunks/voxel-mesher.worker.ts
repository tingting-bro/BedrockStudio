import { decodeScene, type Atlas, type VoxelChunk } from "./scene-data";
import { meshChunk } from "./voxel-mesher";
import {
  AmuletModelCache,
  loadAmuletModels,
  meshAmuletChunk,
} from "./amulet-mesher";

let atlas: Atlas;
let cache = new AmuletModelCache(0);
let active: { job: number; controller: AbortController } | undefined;
self.onmessage = async (event: MessageEvent) => {
  const data = event.data;
  if (data.kind === "init") {
    atlas = data.atlas;
    cache = new AmuletModelCache(data.modelBudget);
    return;
  }
  if (data.kind === "budget") {
    cache.setLimit(data.bytes);
    self.postMessage({ kind: "cache", bytes: cache.bytes });
    return;
  }
  if (data.kind === "cancel") {
    if (active && active.job === data.job) active.controller.abort();
    return;
  }
  const identity = {
    key: data.key,
    serial: data.serial,
    generation: data.generation,
    ticket: data.ticket,
    job: data.job,
  };
  try {
    if (data.kind === "load") {
      const chunk = decodeScene(data.buffer);
      const transfer = chunk.sections.flatMap((section) =>
        section.layers.map((layer) => layer.indices.buffer),
      );
      self.postMessage(
        {
          ...identity,
          kind: "loaded",
          chunk,
          bytes:
            256 +
            chunk.sections.reduce(
              (total, section) =>
                total +
                section.layers.reduce(
                  (n, layer) =>
                    n +
                    layer.indices.byteLength +
                    JSON.stringify(layer.palette).length * 2,
                  0,
                ),
              0,
            ),
          missing: chunk.missing,
          errors: chunk.sections
            .filter((s) => s.error)
            .map((s) => `Y=${s.y * 16}: ${s.error}`),
          cacheBytes: cache.bytes,
        },
        { transfer },
      );
      return;
    }
    if (data.kind !== "mesh") return;
    const chunks = new Map<string, VoxelChunk>(data.chunks);
    const chunk = chunks.get(data.key);
    if (!chunk) throw new Error("区块网格缺少已解码的源数据");
    const task = { job: data.job, controller: new AbortController() };
    active = task;
    try {
      const parts = atlas.amulet
        ? meshAmuletChunk(
            chunk,
            chunks,
            data.ceiling,
            await loadAmuletModels(
              chunk,
              chunks,
              atlas,
              data.ceiling,
              task.controller.signal,
              cache,
              () =>
                self.postMessage({
                  ...identity,
                  kind: "progress",
                  cacheBytes: cache.bytes,
                }),
            ),
          )
        : meshChunk(chunk, chunks, atlas, data.ceiling);
      task.controller.signal.throwIfAborted();
      const transfer = parts.flatMap((p) => [
        p.positions.buffer,
        p.normals.buffer,
        p.uvs.buffer,
        p.colors.buffer,
        p.tiles.buffer,
      ]);
      self.postMessage(
        { ...identity, kind: "mesh", parts, cacheBytes: cache.bytes },
        { transfer },
      );
    } finally {
      if (active === task) active = undefined;
    }
  } catch (error) {
    self.postMessage({
      ...identity,
      kind: (error as Error).name === "AbortError" ? "cancelled" : "error",
      message: (error as Error).message,
      cacheBytes: cache.bytes,
    });
  }
};
