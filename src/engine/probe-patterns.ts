import { FractalNoise } from './noise.ts';
import { hash01 } from './random.ts';
import type { BandRenderer } from './png/encoder.ts';

export type ProbePattern = 'grid' | 'paper' | 'static';

/** Marks each column/row as plain (0), minor line (1) or major line (2). */
function gridAxis(size: number, cell: number, minor: number, major: number, everyN: number): Uint8Array {
  const axis = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const cellIndex = Math.floor(i / cell);
    const within = i - cellIndex * cell;
    const isMajor = cellIndex % everyN === 0;
    const thickness = isMajor ? major : minor;
    if (within < thickness) axis[i] = isMajor ? 2 : 1;
  }
  return axis;
}

export interface ProbeSpec {
  pattern: ProbePattern;
  width: number;
  height: number;
  seed: number;
}

/**
 * The three probe patterns bracket what real presets will cost:
 * `grid` is the cheapest and most compressible, `paper` is representative,
 * and `static` is the worst case deflate can be handed.
 */
export function createProbeRenderer(spec: ProbeSpec): BandRenderer {
  const { width, height, seed } = spec;

  if (spec.pattern === 'grid') {
    const cell = Math.max(8, Math.round(width / 200));
    const minor = Math.max(1, Math.round(cell / 24));
    const cols = gridAxis(width, cell, minor, minor * 2, 10);
    const rows = gridAxis(height, cell, minor, minor * 2, 10);
    return (buf, y0, rowCount, rowStride, pixelOffset) => {
      buf.fill(0);
      for (let r = 0; r < rowCount; r++) {
        const rowMark = rows[y0 + r];
        let p = r * rowStride + pixelOffset;
        for (let x = 0; x < width; x++, p += 4) {
          const mark = Math.max(cols[x], rowMark);
          if (mark === 0) continue;
          const v = mark === 2 ? 0 : 60;
          buf[p] = v;
          buf[p + 1] = v;
          buf[p + 2] = v;
          buf[p + 3] = 255;
        }
      }
    };
  }

  if (spec.pattern === 'paper') {
    const noise = new FractalNoise({
      outputWidth: width,
      outputHeight: height,
      cellPx: Math.max(16, width / 24),
      octaves: 4,
      seed,
    });
    const row = new Float32Array(width);
    return (buf, y0, rowCount, rowStride, pixelOffset) => {
      for (let r = 0; r < rowCount; r++) {
        noise.sampleRow(row, y0 + r, 0, 1);
        let p = r * rowStride + pixelOffset;
        for (let x = 0; x < width; x++, p += 4) {
          const shade = 0.82 + row[x] * 0.28;
          buf[p] = Math.min(255, (238 * shade) | 0);
          buf[p + 1] = Math.min(255, (230 * shade) | 0);
          buf[p + 2] = Math.min(255, (212 * shade) | 0);
          buf[p + 3] = 255;
        }
      }
    };
  }

  return (buf, y0, rowCount, rowStride, pixelOffset) => {
    for (let r = 0; r < rowCount; r++) {
      const y = y0 + r;
      let p = r * rowStride + pixelOffset;
      for (let x = 0; x < width; x++, p += 4) {
        const v = (hash01(x, y, seed) * 256) | 0;
        buf[p] = v;
        buf[p + 1] = v;
        buf[p + 2] = v;
        buf[p + 3] = 255;
      }
    }
  };
}
