import type { MaskBuffer } from './types.ts';

/**
 * Shapes are drawn with analytic coverage rather than through a canvas, so the
 * same recipe rasterises identically in a browser worker and under Node, and
 * sub-pixel features at preview scale fade instead of flickering in and out.
 */

function addCoverage(mask: MaskBuffer, index: number, coverage: number, intensity: number): void {
  const add = coverage * intensity * 255;
  if (add <= 0) return;
  const current = mask.data[index];
  // Union rather than sum: overlapping strokes saturate towards opaque instead
  // of clipping abruptly where two fibres cross.
  mask.data[index] = current + add * (1 - current / 255);
}

/**
 * Draws a thick line segment. Thicknesses below one pixel keep a one-pixel
 * footprint at proportionally reduced intensity, which preserves apparent
 * density when the same texture is previewed at a fraction of export size.
 */
export function drawLine(
  mask: MaskBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  intensity: number,
): void {
  const effective = Math.max(thickness, 1);
  const fade = thickness < 1 ? thickness : 1;
  const radius = effective / 2;
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - radius - 1));
  const maxY = Math.min(mask.height - 1, Math.ceil(Math.max(y0, y1) + radius + 1));
  if (minY > maxY) return;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSq = dx * dx + dy * dy;
  const spanLeft = Math.min(x0, x1) - radius - 1;
  const spanRight = Math.max(x0, x1) + radius + 1;

  // How far sideways the stroke reaches from where its centreline crosses a row.
  // A sloped segment reaches radius / sin(angle), not radius: at 45 degrees that
  // is half again as far, and using the smaller figure clips real coverage off
  // thick strokes. Shallow segments fall back to the full span.
  const sideways =
    Math.abs(dy) > 1e-6 ? Math.min((radius * Math.sqrt(lengthSq)) / Math.abs(dy), spanRight - spanLeft) + 1 : 0;

  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;

    // Only the columns this row can actually reach. For a steep segment that is
    // a handful of pixels rather than the width of its bounding box, which is
    // the difference between a fibre costing a hundred pixel tests and ten
    // thousand of them.
    let left = spanLeft;
    let right = spanRight;
    if (Math.abs(dy) > 1e-6) {
      const ta = (py - 0.5 - y0) / dy;
      const tb = (py + 0.5 - y0) / dy;
      const clamp = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
      const xa = x0 + clamp(ta) * dx;
      const xb = x0 + clamp(tb) * dx;
      left = Math.max(left, Math.min(xa, xb) - sideways);
      right = Math.min(right, Math.max(xa, xb) + sideways);
    }

    const minX = Math.max(0, Math.floor(left));
    const maxX = Math.min(mask.width - 1, Math.ceil(right));
    if (minX > maxX) continue;

    const rowOffset = y * mask.width;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      let t = lengthSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lengthSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ox = px - (x0 + t * dx);
      const oy = py - (y0 + t * dy);
      const distance = Math.sqrt(ox * ox + oy * oy);
      const coverage = 1 - (distance - (radius - 0.5));
      if (coverage <= 0) continue;
      addCoverage(mask, rowOffset + x, coverage < 1 ? coverage : 1, intensity * fade);
    }
  }
}

/**
 * A stroke's own coverage, kept apart from the page it is laid on.
 *
 * Reused between calls rather than allocated per stroke: a page of hatching is
 * tens of thousands of strokes, and every one of them would otherwise cost a
 * buffer the width of the image. Always left zeroed for the next caller.
 */
let strokeCoverage = new Float32Array(0);

/**
 * Draws a polyline of varying thickness as a single mark.
 *
 * The segments are combined by taking the greater coverage, not by compositing
 * one after another. Two overlapping half-opaque capsules are more opaque than
 * either, so a stroke drawn as a run of separate segments darkens at every
 * joint — which reads as a bead, turning a solid line into a dotted one. Within
 * one stroke the ink is the same ink; only where two strokes cross does it
 * build up.
 *
 * `points` holds x, y, thickness triples along the centreline.
 */
export function drawPath(mask: MaskBuffer, points: ArrayLike<number>, intensity: number): void {
  const segments = Math.floor(points.length / 3) - 1;
  if (segments < 1) return;
  if (strokeCoverage.length < mask.width) strokeCoverage = new Float32Array(mask.width);
  const coverage = strokeCoverage;

  // Segment bounds, and the order to bring them into play as the sweep descends.
  const tops = new Float32Array(segments);
  const bottoms = new Float32Array(segments);
  const order = new Int32Array(segments);
  let firstRow = Infinity;
  let lastRow = -Infinity;

  for (let s = 0; s < segments; s++) {
    const i = s * 3;
    const radius = Math.max(points[i + 2], points[i + 5], 1) / 2;
    const top = Math.min(points[i + 1], points[i + 4]) - radius - 1;
    const bottom = Math.max(points[i + 1], points[i + 4]) + radius + 1;
    tops[s] = top;
    bottoms[s] = bottom;
    order[s] = s;
    if (top < firstRow) firstRow = top;
    if (bottom > lastRow) lastRow = bottom;
  }

  const rowStart = Math.max(0, Math.floor(firstRow));
  const rowEnd = Math.min(mask.height - 1, Math.ceil(lastRow));
  if (rowStart > rowEnd) return;

  const sorted = Array.from(order).sort((a, b) => tops[a] - tops[b]);
  const active: number[] = [];
  let next = 0;

  for (let y = rowStart; y <= rowEnd; y++) {
    const py = y + 0.5;
    while (next < segments && tops[sorted[next]] <= py) active.push(sorted[next++]);
    for (let a = active.length - 1; a >= 0; a--) {
      if (bottoms[active[a]] >= py) continue;
      active[a] = active[active.length - 1];
      active.pop();
    }
    if (active.length === 0) continue;

    let touchedLeft = mask.width;
    let touchedRight = -1;

    for (const s of active) {
      const i = s * 3;
      const x0 = points[i];
      const y0 = points[i + 1];
      const x1 = points[i + 3];
      const y1 = points[i + 4];
      const thickness = (points[i + 2] + points[i + 5]) / 2;
      const effective = Math.max(thickness, 1);
      const fade = thickness < 1 ? thickness : 1;
      const radius = effective / 2;

      const dx = x1 - x0;
      const dy = y1 - y0;
      const lengthSq = dx * dx + dy * dy;
      const spanLeft = Math.min(x0, x1) - radius - 1;
      const spanRight = Math.max(x0, x1) + radius + 1;

      // As in drawLine: a sloped segment reaches radius / sin(angle) sideways
      // from where its centreline crosses the row, not radius.
      const sideways =
        Math.abs(dy) > 1e-6 ? Math.min((radius * Math.sqrt(lengthSq)) / Math.abs(dy), spanRight - spanLeft) + 1 : 0;

      let left = spanLeft;
      let right = spanRight;
      if (Math.abs(dy) > 1e-6) {
        const ta = (py - 0.5 - y0) / dy;
        const tb = (py + 0.5 - y0) / dy;
        const clamp = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
        const xa = x0 + clamp(ta) * dx;
        const xb = x0 + clamp(tb) * dx;
        left = Math.max(left, Math.min(xa, xb) - sideways);
        right = Math.min(right, Math.max(xa, xb) + sideways);
      }

      const minX = Math.max(0, Math.floor(left));
      const maxX = Math.min(mask.width - 1, Math.ceil(right));
      if (minX > maxX) continue;

      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        let t = lengthSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lengthSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ox = px - (x0 + t * dx);
        const oy = py - (y0 + t * dy);
        const distance = Math.sqrt(ox * ox + oy * oy);
        let value = 1 - (distance - (radius - 0.5));
        if (value <= 0) continue;
        if (value > 1) value = 1;
        value *= fade;
        if (value > coverage[x]) {
          coverage[x] = value;
          if (x < touchedLeft) touchedLeft = x;
          if (x > touchedRight) touchedRight = x;
        }
      }
    }

    const rowOffset = y * mask.width;
    for (let x = touchedLeft; x <= touchedRight; x++) {
      const value = coverage[x];
      if (value > 0) {
        addCoverage(mask, rowOffset + x, value, intensity);
        coverage[x] = 0;
      }
    }
  }
}

/** Draws a filled ellipse, with the same sub-pixel treatment as drawLine. */
export function drawEllipse(
  mask: MaskBuffer,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number,
  intensity: number,
): void {
  const smallest = Math.min(rx, ry);
  const fade = smallest < 0.5 ? Math.max(0.05, smallest / 0.5) : 1;
  const erx = Math.max(rx, 0.5);
  const ery = Math.max(ry, 0.5);
  const reach = Math.max(erx, ery) + 1;
  const minX = Math.max(0, Math.floor(cx - reach));
  const maxX = Math.min(mask.width - 1, Math.ceil(cx + reach));
  const minY = Math.max(0, Math.floor(cy - reach));
  const maxY = Math.min(mask.height - 1, Math.ceil(cy + reach));
  if (minX > maxX || minY > maxY) return;

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  // Feather over roughly one destination pixel, expressed in normalised radius.
  const feather = 1 / Math.max(erx, ery);

  for (let y = minY; y <= maxY; y++) {
    const dy = y + 0.5 - cy;
    for (let x = minX; x <= maxX; x++) {
      const dx = x + 0.5 - cx;
      const rxr = (dx * cos + dy * sin) / erx;
      const ryr = (-dx * sin + dy * cos) / ery;
      const d = Math.sqrt(rxr * rxr + ryr * ryr);
      const coverage = (1 - d) / feather + 0.5;
      if (coverage <= 0) continue;
      addCoverage(mask, y * mask.width + x, Math.min(1, coverage), intensity * fade);
    }
  }
}

/**
 * Coverage of the output-space span [a,b) by a periodic stripe of the given
 * width starting at each multiple of `period`. Exact, so grid lines survive any
 * downscale instead of aliasing away, and fractional line widths work at export
 * scale too.
 */
export function stripeCoverage(a: number, b: number, period: number, width: number, phase: number): number {
  if (width <= 0 || period <= 0 || b <= a) return 0;
  const clamped = Math.min(width, period);
  const start = a - phase;
  const end = b - phase;
  const first = Math.floor(start / period);
  const last = Math.floor(end / period);
  let covered = 0;
  for (let k = first; k <= last; k++) {
    const lineStart = k * period;
    const lineEnd = lineStart + clamped;
    const lo = Math.max(start, lineStart);
    const hi = Math.min(end, lineEnd);
    if (hi > lo) covered += hi - lo;
  }
  return Math.min(1, covered / (b - a));
}
