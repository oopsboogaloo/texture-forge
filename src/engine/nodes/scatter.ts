/**
 * Scattered elements — fibres, speckles — are generated for the whole image up
 * front, not per tile: a tile only sees part of the picture, and an element
 * whose centre lies outside it may still cross into it. Sorting by top edge
 * lets each tile walk only the elements that can reach it.
 */
export interface ScatterItem {
  minY: number;
  maxY: number;
}

export class ScatterIndex<T extends ScatterItem> {
  private readonly items: T[];
  private readonly maxSpan: number;

  constructor(items: T[]) {
    this.items = items.sort((a, b) => a.minY - b.minY);
    let span = 0;
    for (const item of this.items) span = Math.max(span, item.maxY - item.minY);
    this.maxSpan = span;
  }

  get size(): number {
    return this.items.length;
  }

  /** Calls `visit` for every element that can touch the output-space rows [top, bottom). */
  forEachInRows(top: number, bottom: number, visit: (item: T) => void): void {
    const from = top - this.maxSpan;
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.items[mid].minY < from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.items.length; i++) {
      const item = this.items[i];
      if (item.minY >= bottom) break;
      if (item.maxY > top) visit(item);
    }
  }
}

/** Number of scattered elements for an image, from a density in items per megapixel. */
export function scatterCount(density: number, outputWidth: number, outputHeight: number): number {
  return Math.max(0, Math.round((density * outputWidth * outputHeight) / 1e6));
}

/**
 * Offsets at which an element must be redrawn so it wraps at the image edge.
 * Always includes (0,0); in seamless mode it adds the mirrored positions for
 * elements that cross a boundary.
 */
export function wrapOffsets(
  seamless: boolean,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  width: number,
  height: number,
): { dx: number; dy: number }[] {
  if (!seamless) return [{ dx: 0, dy: 0 }];
  const xs = [0];
  if (minX < 0) xs.push(width);
  if (maxX > width) xs.push(-width);
  const ys = [0];
  if (minY < 0) ys.push(height);
  if (maxY > height) ys.push(-height);
  const offsets: { dx: number; dy: number }[] = [];
  for (const dx of xs) for (const dy of ys) offsets.push({ dx, dy });
  return offsets;
}
