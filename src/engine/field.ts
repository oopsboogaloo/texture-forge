import { hash01, hashInt } from './random.ts';

/**
 * Coverage of a destination pixel by a line of the given half-width, from its
 * distance to the line's centre. Distances and widths are in output pixels;
 * `scale` converts to destination pixels.
 *
 * Lines thinner than a destination pixel keep a one-pixel footprint at reduced
 * intensity rather than disappearing, so a grid previewed at a tenth size still
 * reads as a grid instead of flickering in and out between rows.
 */
export function edgeCoverage(distance: number, halfWidth: number, scale: number): number {
  const deviceHalf = halfWidth * scale;
  const effective = deviceHalf < 0.5 ? 0.5 : deviceHalf;
  const fade = deviceHalf < 0.5 ? deviceHalf / 0.5 : 1;
  const coverage = effective - distance * scale + 0.5;
  return coverage <= 0 ? 0 : (coverage >= 1 ? 1 : coverage) * fade;
}

/** Distance from a point to the nearest line of a rotated, evenly spaced family. */
export function stripeDistance(x: number, y: number, cos: number, sin: number, spacing: number, phase: number): number {
  const projected = x * cos + y * sin - phase;
  const offset = projected - Math.floor(projected / spacing) * spacing;
  return Math.min(offset, spacing - offset);
}

export interface NearestSites {
  /** Distance to the closest site. */
  first: number;
  /** Distance to the second closest, which is what puts a boundary between them. */
  second: number;
  /** Stable identity of the closest cell, for per-cell colour or value. */
  cell: number;
}

/**
 * A wrapping lattice of jittered sites — the basis of cellular patterns.
 *
 * Voronoi cells, cracked stone, scales and a hexagonal grid are all the same
 * construction: a hex grid is simply the boundary diagram of an unjittered
 * triangular lattice. Because the lattice wraps at the image edge, everything
 * built on it tiles by construction.
 */
export class SiteLattice {
  private readonly columns: number;
  private readonly rows: number;
  private readonly cellWidth: number;
  private readonly cellHeight: number;
  private readonly jitter: number;
  private readonly seed: number;
  private readonly stagger: number;

  constructor(
    outputWidth: number,
    outputHeight: number,
    cellPx: number,
    jitter: number,
    seed: number,
    /** Offsets alternate rows by half a cell and squashes them, giving a triangular lattice. */
    triangular = false,
  ) {
    const spacing = Math.max(2, cellPx);
    this.columns = Math.max(1, Math.round(outputWidth / spacing));
    const rowSpacing = triangular ? spacing * (Math.sqrt(3) / 2) : spacing;
    this.rows = Math.max(1, Math.round(outputHeight / rowSpacing));
    // Rows must be even for a staggered lattice to meet itself when it wraps.
    if (triangular && this.rows % 2 === 1) this.rows += 1;
    this.cellWidth = outputWidth / this.columns;
    this.cellHeight = outputHeight / this.rows;
    this.jitter = Math.max(0, Math.min(0.5, jitter));
    this.seed = seed;
    this.stagger = triangular ? 0.5 : 0;
  }

  /** Centre-to-centre spacing, which is what a caller needs to size line widths. */
  get spacing(): number {
    return Math.min(this.cellWidth, this.cellHeight);
  }

  private siteX(i: number, j: number): number {
    const stagger = this.stagger === 0 ? 0 : (((j % 2) + 2) % 2) * this.stagger;
    const jx = this.jitter === 0 ? 0 : (hash01(i, j, this.seed) - 0.5) * 2 * this.jitter;
    return (i + 0.5 + stagger + jx) * this.cellWidth;
  }

  private siteY(i: number, j: number): number {
    const jy = this.jitter === 0 ? 0 : (hash01(i, j, this.seed + 9161) - 0.5) * 2 * this.jitter;
    return (j + 0.5 + jy) * this.cellHeight;
  }

  /**
   * The two closest sites to a point.
   *
   * Only the nine surrounding cells are searched. With jitter capped at half a
   * cell no site outside that neighbourhood can be closer, and the wrapped
   * indices are what make the pattern continue across the image edge.
   */
  nearest(px: number, py: number, outputWidth: number, outputHeight: number): NearestSites {
    // Defined for any coordinate, not only those inside the image: the pattern
    // is periodic, so a point a whole image away is the same point. That is what
    // makes it testable as a tiling rather than only as a picture.
    const x = px - Math.floor(px / outputWidth) * outputWidth;
    const y = py - Math.floor(py / outputHeight) * outputHeight;
    const baseI = Math.floor(x / this.cellWidth);
    const baseJ = Math.floor(y / this.cellHeight);
    let first = Infinity;
    let second = Infinity;
    let cell = 0;

    for (let dj = -1; dj <= 1; dj++) {
      const j = baseJ + dj;
      const wrappedJ = ((j % this.rows) + this.rows) % this.rows;
      const offsetY = j < 0 ? -outputHeight : j >= this.rows ? outputHeight : 0;

      for (let di = -1; di <= 1; di++) {
        const i = baseI + di;
        const wrappedI = ((i % this.columns) + this.columns) % this.columns;
        const offsetX = i < 0 ? -outputWidth : i >= this.columns ? outputWidth : 0;

        const sx = this.siteX(wrappedI, wrappedJ) + offsetX;
        const sy = this.siteY(wrappedI, wrappedJ) + offsetY;
        const dx = x - sx;
        const dy = y - sy;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < first) {
          second = first;
          first = distance;
          cell = hashInt(wrappedI, wrappedJ, this.seed + 4703);
        } else if (distance < second) {
          second = distance;
        }
      }
    }

    return { first, second, cell };
  }
}
