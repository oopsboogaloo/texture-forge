import { hash01 } from './random.ts';

interface Lattice {
  cells: Float32Array;
  w: number;
  h: number;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export interface NoiseOptions {
  outputWidth: number;
  outputHeight: number;
  /** Feature size of the first octave, in output pixels. */
  cellPx: number;
  octaves: number;
  seed: number;
}

/**
 * Value-noise fBm sampled in output-pixel space.
 *
 * The lattice always wraps at the image boundary, so output is tileable by
 * construction. That costs a little precision in feature size — the cell size
 * is rounded so a whole number of cells spans the image — and buys seamless
 * mode for free rather than as a retrofit that would change what existing
 * recipes render.
 */
export class FractalNoise {
  private readonly layers: { lattice: Lattice; amplitude: number }[] = [];
  private readonly norm: number;
  private readonly width: number;
  private readonly height: number;
  private tables: { xa: Int32Array; xb: Int32Array; wx: Float32Array }[] = [];
  private tableKey = '';

  constructor(options: NoiseOptions) {
    this.width = options.outputWidth;
    this.height = options.outputHeight;
    let amplitude = 1;
    let total = 0;
    const octaves = Math.max(1, Math.round(options.octaves));
    for (let o = 0; o < octaves; o++) {
      const cellPx = Math.max(2, options.cellPx / 2 ** o);
      const w = Math.max(1, Math.round(options.outputWidth / cellPx));
      const h = Math.max(1, Math.round(options.outputHeight / cellPx));
      const cells = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) cells[y * w + x] = hash01(x, y, options.seed + o * 7919);
      }
      this.layers.push({ lattice: { cells, w, h }, amplitude });
      total += amplitude;
      amplitude *= 0.5;
    }
    this.norm = 1 / total;
  }

  /**
   * Fills `out` with samples along one row: x = startX + k * step.
   *
   * Column indices and weights are identical for every row of a pass, so they
   * are computed once and reused. At a hundred megapixels this is the
   * difference between a few seconds and a few tens of seconds.
   */
  sampleRow(out: Float32Array, y: number, startX: number, step: number): void {
    const count = out.length;
    const key = `${startX}:${step}:${count}`;
    if (this.tableKey !== key) {
      this.tables = this.layers.map(({ lattice }) => {
        const xa = new Int32Array(count);
        const xb = new Int32Array(count);
        const wx = new Float32Array(count);
        for (let k = 0; k < count; k++) {
          const g = ((startX + k * step) * lattice.w) / this.width;
          const i = Math.floor(g);
          xa[k] = ((i % lattice.w) + lattice.w) % lattice.w;
          xb[k] = (xa[k] + 1) % lattice.w;
          wx[k] = smoothstep(g - i);
        }
        return { xa, xb, wx };
      });
      this.tableKey = key;
    }

    out.fill(0);
    for (let l = 0; l < this.layers.length; l++) {
      const { lattice, amplitude } = this.layers[l];
      const { xa, xb, wx } = this.tables[l];
      const { cells, w, h } = lattice;
      const g = (y * h) / this.height;
      const j = Math.floor(g);
      const ya = (((j % h) + h) % h) * w;
      const yb = ((((j % h) + h) % h) + 1) % h * w;
      const wy = smoothstep(g - j);
      for (let k = 0; k < count; k++) {
        const ia = xa[k];
        const ib = xb[k];
        const fx = wx[k];
        const top = cells[ya + ia] + (cells[ya + ib] - cells[ya + ia]) * fx;
        const bottom = cells[yb + ia] + (cells[yb + ib] - cells[yb + ia]) * fx;
        out[k] += (top + (bottom - top) * wy) * amplitude;
      }
    }
    const n = this.norm;
    for (let k = 0; k < count; k++) out[k] *= n;
  }

  /**
   * Samples at a single output-space coordinate.
   *
   * Delegates to sampleRow so there is exactly one implementation: two paths
   * that agree to within a rounding error still disagree, and the difference
   * shows up as a stray pixel. Not for bulk work — it rebuilds the row tables
   * on every call.
   */
  sample(x: number, y: number): number {
    const single = new Float32Array(1);
    this.sampleRow(single, y, x, 1);
    return single[0];
  }
}
