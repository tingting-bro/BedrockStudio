import {
  decodeScene,
  type Atlas,
  type MeshPart,
  type VoxelChunk,
} from "./scene-data";
import { meshChunk } from "./voxel-mesher";
import { loadAmuletModels, meshAmuletChunk } from "./amulet-mesher";

function decodePreview(buffer: ArrayBuffer) {
  if (buffer.byteLength < 4 || buffer.byteLength > 64 * 1024 ** 2)
    throw new Error("粘贴预览数据超出限制");
  const length = new DataView(buffer).getUint32(0, true);
  if (length > buffer.byteLength - 4) throw new Error("粘贴预览数据不完整");
  const meta = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, length)),
  ) as {
    truncated?: boolean;
    low: number[];
    size: number[];
    chunks: { offset: number; length: number; render?: boolean }[];
  };
  const chunks = new Map<string, VoxelChunk>();
  const targets = new Set<string>();
  for (const item of meta.chunks) {
    const start = 4 + length + item.offset;
    if (
      item.offset < 0 ||
      item.length < 4 ||
      start + item.length > buffer.byteLength
    )
      throw new Error("粘贴预览区块无效");
    const chunk = decodeScene(buffer.slice(start, start + item.length));
    const key = `${chunk.x},${chunk.z}`;
    chunks.set(key, chunk);
    if (item.render !== false) targets.add(key);
  }
  return { meta, chunks, targets };
}

function* previewParts(
  buffer: ArrayBuffer,
  atlas: Atlas,
  budget = 32 * 1024 ** 2,
) {
  const { meta, chunks, targets } = decodePreview(buffer);
  let bytes = 0;
  yield { low: meta.low, size: meta.size, chunks: [], partial: true };
  let truncated = meta.truncated ?? false;
  for (const chunk of chunks.values()) {
    if (!targets.has(`${chunk.x},${chunk.z}`)) continue;
    const parts = meshChunk(chunk, chunks, atlas, 2047);
    let chunkBytes = 0;
    for (const part of parts)
      chunkBytes +=
        part.positions.byteLength +
        part.normals.byteLength +
        part.uvs.byteLength +
        part.colors.byteLength +
        part.tiles.byteLength;
    // A geometry budget limits display only. The full clipboard remains on
    // the server and is still atomically validated when the user pastes it.
    if (bytes + chunkBytes > Math.max(0, budget)) {
      truncated = true;
      break;
    }
    bytes += chunkBytes;
    yield {
      low: meta.low,
      size: meta.size,
      partial: true,
      chunks: [
        { x: chunk.x * 16 - meta.low[0], z: chunk.z * 16 - meta.low[2], parts },
      ],
    };
  }
  yield {
    low: meta.low,
    size: meta.size,
    chunks: [],
    partial: false,
    truncated,
  };
}

async function* amuletPreviewParts(
  buffer: ArrayBuffer,
  atlas: Atlas,
  budget = 32 * 1024 ** 2,
) {
  const { meta, chunks, targets } = decodePreview(buffer);
  let bytes = 0,
    truncated = meta.truncated ?? false;
  yield { low: meta.low, size: meta.size, chunks: [], partial: true };
  for (const chunk of chunks.values()) {
    if (!targets.has(`${chunk.x},${chunk.z}`)) continue;
    const library = await loadAmuletModels(chunk, chunks, atlas, 2047);
    const parts = meshAmuletChunk(chunk, chunks, 2047, library);
    const size = parts.reduce(
      (n, p) =>
        n +
        p.positions.byteLength +
        p.normals.byteLength +
        p.uvs.byteLength +
        p.colors.byteLength +
        p.tiles.byteLength,
      0,
    );
    if (bytes + size > Math.max(0, budget)) {
      truncated = true;
      break;
    }
    bytes += size;
    yield {
      low: meta.low,
      size: meta.size,
      partial: true,
      chunks: [
        { x: chunk.x * 16 - meta.low[0], z: chunk.z * 16 - meta.low[2], parts },
      ],
    };
  }
  yield {
    low: meta.low,
    size: meta.size,
    chunks: [],
    partial: false,
    truncated,
  };
}

// Synchronous entry point for pure geometry tests; runtime streams each chunk.
export function buildPastePreview(buffer: ArrayBuffer, atlas: Atlas) {
  const chunks: { x: number; z: number; parts: MeshPart[] }[] = [];
  let low: number[] = [],
    size: number[] = [];
  for (const part of previewParts(buffer, atlas)) {
    low = part.low;
    size = part.size;
    chunks.push(...part.chunks);
  }
  return { low, size, chunks };
}
self.onmessage = async (event) => {
  try {
    const generate = event.data.atlas.amulet
      ? amuletPreviewParts
      : previewParts;
    for await (const result of generate(
      event.data.buffer,
      event.data.atlas,
      event.data.budget,
    )) {
      const transfer = result.chunks.flatMap((chunk) =>
        chunk.parts.flatMap((p) => [
          p.positions.buffer,
          p.normals.buffer,
          p.uvs.buffer,
          p.colors.buffer,
          p.tiles.buffer,
        ]),
      );
      self.postMessage(result, { transfer });
      // Yield between chunks so progress is observable and cancellation stays prompt.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
