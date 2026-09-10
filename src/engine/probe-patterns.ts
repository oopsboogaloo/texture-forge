import type { BandRenderer } from './png/encoder.ts';

export type ProbePattern = 'grid' | 'paper' | 'static';

/** Integer hash -> [0,1). Deterministic across engines; no Math.random anywhere. */
function hash01(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

interface Layer {
  cells: Float32Array;
  w: number;
  h: number;
  xa: Int32Array;
  xb: Int32Array;
  wx: Float32Array;
  amp: number;
}

/**
 * Value-noise fBm on a lattice that wraps at the image edge, so output is
 * tileable by construction rather than by a later fix-up. Per-row x lookups are
 * precomputed once, which is what keeps 100 megapixels tractable in JS.
 */
class FractalNoise {
  private readonly layers: Layer[] = [];
  private readonly norm: number;
  private readonly width: number;
  private readonly height: number;

  constructor(width: number, height: number, octaves: number, baseCellPx: number, seed: number) {
    this.width = width;
    this.height = height;
    let amp = 1;
    let total = 0;
    for (let o = 0; o < octaves; o++) {
      const cellPx = Math.max(2, baseCellPx / 2 ** o);
      const w = Math.max(1, Math.round(width / cellPx));
      const h = Math.max(1, Math.round(height / cellPx));
      const cells = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) cells[y * w + x] = hash01(x, y, seed + o * 7919);
      }
      const xa = new Int32Array(width);
      const xb = new Int32Array(width);
      const wx = new Float32Array(width);
      for (let x = 0; x < width; x++) {
        const g = (x * w) / width;
        const i = Math.floor(g);
        xa[x] = ((i % w) + w) % w;
        xb[x] = (xa[x] + 1) % w;
        wx[x] = smoothstep(g - i);
      }
      this.layers.push({ cells, w, h, xa, xb, wx, amp });
      total += amp;
      amp *= 0.5;
    }
    this.norm = 1 / total;
  }

  fillRow(out: Float32Array, y: number): void {
    out.fill(0);
    for (const layer of this.layers) {
      const { cells, w, h, xa, xb, wx, amp } = layer;
      const g = (y * h) / this.height;
      const j = Math.floor(g);
      const ya = (((j % h) + h) % h) * w;
      const yb = ((((j % h) + h) % h) + 1) % h * w;
      const wy = smoothstep(g - j);
      for (let x = 0; x < this.width; x++) {
        const ia = xa[x];
        const ib = xb[x];
        const fx = wx[x];
        const top = cells[ya + ia] + (cells[ya + ib] - cells[ya + ia]) * fx;
        const bot = cells[yb + ia] + (cells[yb + ib] - cells[yb + ia]) * fx;
        out[x] += (top + (bot - top) * wy) * amp;
      }
    }
    const n = this.norm;
    for (let x = 0; x < this.width; x++) out[x] *= n;
  }
}

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
    const noise = new FractalNoise(width, height, 4, Math.max(16, width / 24), seed);
    const row = new Float32Array(width);
    return (buf, y0, rowCount, rowStride, pixelOffset) => {
      for (let r = 0; r < rowCount; r++) {
        noise.fillRow(row, y0 + r);
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
