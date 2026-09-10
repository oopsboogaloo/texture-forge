import type { RenderContext } from '../types.ts';

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

export interface WrapOffset {
  dx: number;
  dy: number;
}

export interface PlacedItem extends ScatterItem {
  wraps: WrapOffset[];
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

/**
 * Visits every (element, wrap offset) pair that lands in the tile, exactly once.
 *
 * Asking the index separately for each wrapped row window would match a
 * boundary-crossing element in more than one of them and draw its whole set of
 * offsets each time. Coverage accumulates, so the element would darken and the
 * result would depend on band height — the one thing a tiled renderer must
 * never do. Instead the index is asked once over the widest window that can
 * reach this tile, and each offset is tested against the tile itself.
 */
export function forEachPlacement<T extends PlacedItem>(
  index: ScatterIndex<T>,
  ctx: RenderContext,
  visit: (item: T, dx: number, dy: number) => void,
): void {
  const top = ctx.tile.y / ctx.scale;
  const bottom = (ctx.tile.y + ctx.tile.height) / ctx.scale;
  const reach = ctx.seamless ? ctx.outputHeight : 0;

  index.forEachInRows(top - reach, bottom + reach, (item) => {
    for (const offset of item.wraps) {
      if (item.maxY + offset.dy <= top || item.minY + offset.dy >= bottom) continue;
      visit(item, offset.dx, offset.dy);
    }
  });
}
