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
  private readonly maxSpan_: number;

  constructor(items: T[]) {
    this.items = items.sort((a, b) => a.minY - b.minY);
    let span = 0;
    for (const item of this.items) span = Math.max(span, item.maxY - item.minY);
    this.maxSpan_ = span;
  }

  get size(): number {
    return this.items.length;
  }

  /** The tallest element, which is how far a row query has to look back. */
  get maxSpan(): number {
    return this.maxSpan_;
  }

  /** Calls `visit` for every element that can touch the output-space rows [top, bottom). */
  forEachInRows(top: number, bottom: number, visit: (item: T) => void): void {
    const from = top - this.maxSpan_;
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
 * Every whole-image shift that brings some part of [min, max] onto the canvas.
 *
 * An element is not limited to one shift per axis: a scratch can be longer than
 * the image, and then the parts more than one canvas away have to come back too,
 * or the texture does not tile however it is advertised.
 */
function spanOffsets(min: number, max: number, size: number): number[] {
  const first = Math.ceil(-max / size);
  const last = Math.floor((size - min) / size);
  const offsets: number[] = [];
  for (let k = first; k <= last; k++) offsets.push(k * size);
  // Always include the element where it was generated, even if it lies wholly
  // outside — the caller filters by tile anyway.
  if (!offsets.includes(0)) offsets.push(0);
  return offsets;
}

/**
 * Offsets at which an element must be redrawn so it wraps at the image edge.
 * Always includes (0,0); in seamless mode it adds every shift that brings part
 * of the element back onto the canvas.
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
  const offsets: { dx: number; dy: number }[] = [];
  for (const dx of spanOffsets(minX, maxX, width)) {
    for (const dy of spanOffsets(minY, maxY, height)) offsets.push({ dx, dy });
  }
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
  // An element may be shifted by more than one image height, so the row window
  // has to reach past its own span as well as the image.
  const reach = ctx.seamless ? ctx.outputHeight + index.maxSpan : 0;

  index.forEachInRows(top - reach, bottom + reach, (item) => {
    for (const offset of item.wraps) {
      if (item.maxY + offset.dy <= top || item.minY + offset.dy >= bottom) continue;
      visit(item, offset.dx, offset.dy);
    }
  });
}
