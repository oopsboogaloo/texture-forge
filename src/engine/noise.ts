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
  /**
   * Folds each octave about its midline before summing.
   *
   * Smooth noise gives soft blobs; folding leaves creases where the octave
   * crossed the middle, and those creases are what read as wisps, filaments and
   * smoke rather than as cloud.
   */
  turbulent?: boolean;
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
  private readonly turbulent: boolean;
  private readonly width: number;
  private readonly height: number;
  private tables: { xa: Int32Array; xb: Int32Array; wx: Float32Array }[] = [];
  private tableKey = '';

  constructor(options: NoiseOptions) {
    this.width = options.outputWidth;
    this.height = options.outputHeight;
    this.turbulent = options.turbulent === true;
    let amplitude = 1;
    let total = 0;
    const octaves = Math.max(1, Math.round(options.octaves));
    for (let o = 0; o < octaves; o++) {
      const cellPx = Math.max(2, options.cellPx / 2 ** o);
      // At least two cells per axis. A single wrapping cell has the same value
      // at every corner, so the field is constant and the generator built on it
      // produces nothing at all — which is what happens when a feature scale is
      // larger than the canvas it is asked for.
      const w = Math.max(2, Math.round(options.outputWidth / cellPx));
      const h = Math.max(2, Math.round(options.outputHeight / cellPx));
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
        const value = top + (bottom - top) * wy;
        out[k] += (this.turbulent ? Math.abs(2 * value - 1) : value) * amplitude;
      }
    }
    const n = this.norm;
    for (let k = 0; k < count; k++) out[k] *= n;
  }

  /**
   * Samples at a single output-space coordinate.
   *
   * Random access, for callers whose sample points do not lie on a row — a
   * warped field displaces both coordinates, so its samples never do. Going
   * through sampleRow would rebuild the row tables on every pixel, which is
   * ruinous at export size; this allocates nothing.
   *
   * The arithmetic is deliberately identical to the row path, and a test
   * requires the two to agree exactly rather than closely: agreeing to within a
   * rounding error still shows up as a stray pixel. That is also why the running
   * total is rounded to single precision at each step — the row path accumulates
   * into a Float32Array, and a double here would drift from it by about one part
   * in ten million, which is enough to move a rounded byte.
   */
  sample(x: number, y: number): number {
    let sum = 0;
    for (const { lattice, amplitude } of this.layers) {
      const { cells, w, h } = lattice;
      const gx = (x * w) / this.width;
      const gy = (y * h) / this.height;
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      // Single precision again: the row path keeps its column weights in a
      // Float32Array, and only the row weight stays a double.
      const fx = Math.fround(smoothstep(gx - ix));
      const xa = ((ix % w) + w) % w;
      const xb = (xa + 1) % w;
      const ya = (((iy % h) + h) % h) * w;
      const yb = ((((iy % h) + h) % h) + 1) % h * w;
      const top = cells[ya + xa] + (cells[ya + xb] - cells[ya + xa]) * fx;
      const bottom = cells[yb + xa] + (cells[yb + xb] - cells[yb + xa]) * fx;
      const value = top + (bottom - top) * smoothstep(gy - iy);
      sum = Math.fround(sum + (this.turbulent ? Math.abs(2 * value - 1) : value) * amplitude);
    }
    return Math.fround(sum * this.norm);
  }
}
