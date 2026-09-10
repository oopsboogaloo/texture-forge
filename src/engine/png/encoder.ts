import { crc32 } from './crc32.ts';

/** PNG colour types we emit: 0 = 8-bit greyscale (masks), 6 = 8-bit RGBA. */
export type ColourType = 0 | 6;

export const CHANNELS: Record<ColourType, number> = { 0: 1, 6: 4 };

/**
 * Fills one horizontal band of scanlines.
 *
 * The buffer is laid out as the PNG expects it: `rows` scanlines of `rowStride`
 * bytes, each starting with a filter byte that the encoder has already written.
 * Pixel data for row `r` therefore begins at `r * rowStride + pixelOffset`.
 * Writing straight into this buffer avoids a second copy of the band, which
 * matters when a band is tens of megabytes.
 */
export type BandRenderer = (
  buf: Uint8Array,
  y0: number,
  rows: number,
  rowStride: number,
  pixelOffset: number,
) => void;

export interface EncodeRequest {
  width: number;
  height: number;
  colourType: ColourType;
  /** Scanlines rendered and compressed per step. Bounds peak memory. */
  bandRows: number;
  renderBand: BandRenderer;
  onProgress?: (rowsDone: number, height: number) => void;
  signal?: AbortSignal;
}

export interface EncodeResult {
  blob: Blob;
  /** Milliseconds spent inside renderBand. */
  generateMs: number;
  /** Milliseconds spent compressing and assembling chunks. */
  encodeMs: number;
  /** Total IDAT payload, i.e. the compressed size of the pixel data. */
  compressedBytes: number;
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// The explicit ArrayBuffer parameter keeps these assignable to BlobPart: a
// Uint8Array<ArrayBufferLike> could be backed by a SharedArrayBuffer, which Blob
// will not take.
function chunk(type: string, data: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function ihdr(width: number, height: number, colourType: ColourType): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = colourType;
  data[10] = 0; // deflate
  data[11] = 0; // adaptive filtering
  data[12] = 0; // no interlace
  return chunk('IHDR', data);
}

/**
 * Encodes a PNG band by band, streaming scanlines through the platform deflate
 * implementation so a full-size uncompressed image is never held in memory.
 *
 * A 10,000 x 10,000 RGBA image is 400 MB raw, well past what an iPad tab will
 * give us, and past Safari's per-canvas limits besides; only the compressed
 * output and one band are ever resident.
 */
export async function encodePng(req: EncodeRequest): Promise<EncodeResult> {
  const { width, height, colourType, renderBand, onProgress, signal } = req;
  const bandRows = Math.max(1, Math.min(req.bandRows, height));
  const channels = CHANNELS[colourType];
  const rowStride = 1 + width * channels;

  const parts: BlobPart[] = [SIGNATURE, ihdr(width, height, colourType)];

  // 'deflate' is the zlib-wrapped variant (RFC 1950), which is what IDAT wants.
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  let compressedBytes = 0;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      compressedBytes += value.byteLength;
      parts.push(chunk('IDAT', value));
    }
  })();

  const band = new Uint8Array(bandRows * rowStride);
  // Filter byte 0 (None) on every row. Adaptive filtering would shrink grid
  // output further but costs a pass over the band; revisit once the probe says
  // what export time actually looks like.
  for (let r = 0; r < bandRows; r++) band[r * rowStride] = 0;

  let generateMs = 0;
  const startedAt = performance.now();

  try {
    for (let y = 0; y < height; y += bandRows) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const rows = Math.min(bandRows, height - y);

      const genStart = performance.now();
      renderBand(band, y, rows, rowStride, 1);
      generateMs += performance.now() - genStart;

      // Awaiting the write yields to the event loop between bands, which is
      // what lets a cancel message reach the worker at all.
      await writer.write(rows === bandRows ? band : band.subarray(0, rows * rowStride));
      onProgress?.(y + rows, height);
    }
    await writer.close();
    await pump;
  } catch (err) {
    await writer.abort(err).catch(() => {});
    await reader.cancel().catch(() => {});
    throw err;
  }

  parts.push(chunk('IEND', new Uint8Array(0)));

  const blob = new Blob(parts, { type: 'image/png' });
  const totalMs = performance.now() - startedAt;
  return { blob, generateMs, encodeMs: totalMs - generateMs, compressedBytes };
}
