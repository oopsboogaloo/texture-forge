import { createRandom, hash01, type Random } from '../random.ts';
import { drawPath } from '../raster.ts';
import { numberParam, registerNode, seedParamValue, stringParam, type NodeInstance, type ParamMap, type PassInfo } from '../registry.ts';
import { createMaskBuffer, type PixelBuffer, type RenderContext } from '../types.ts';
import { ScatterIndex, forEachPlacement, wrapOffsets, type PlacedItem } from './scatter.ts';

interface Stroke extends PlacedItem {
  /** The centreline, as x, y, thickness triples. A ruled stroke has two points. */
  path: Float32Array;
  intensity: number;
}

/** The last fraction of a stroke over which the end hook builds. */
const HOOK_SPAN = 0.22;

/** How far into each end the pressure tapers off, as a fraction of the stroke. */
const TAPER_SPAN = 0.15;

/**
 * How the pen behaves along a stroke, as distinct from where the strokes go.
 *
 * Held together because a real pen varies all of these at once and from the
 * same cause: the hand slows, the nib turns, contact lightens. Separating them
 * into independent effects is what makes ruled hatching look ruled.
 */
export interface Pen {
  thickness: number;
  /** Bow across the stroke, as a fraction of its length. */
  curve: number;
  /** Extra turn at the end where the hand lifts, as a fraction of length. */
  hook: number;
  /** Distance along the stroke over which contact varies. */
  weightScale: number;
  /** How much of the line's weight that variation accounts for. */
  weightAmount: number;
  /** How readily the pen leaves the paper altogether. */
  broken: number;
}

/**
 * Smooth noise along one axis, in [-1, 1]: the pen's contact with the paper.
 *
 * One field drives both the swell of the line and where it breaks, because
 * those are one phenomenon — a stroke thins before it skips, and comes back
 * thin, which is exactly what a dry nib does and what a random gap does not.
 */
function contact(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  const a = hash01(i, 0, seed) * 2 - 1;
  const b = hash01(i + 1, 0, seed) * 2 - 1;
  return a + (b - a) * s;
}

/**
 * Drawn hatching, as a pen lays it down.
 *
 * Stripes gives perfect ruled lines; this gives strokes — bowed, of uneven
 * weight and length, hooking where the hand lifts, each starting and stopping
 * where a hand would. That irregularity is the whole point, and it is what no
 * arrangement of ruled lines can imitate. Crossing families build tone the way
 * an engraver builds it; the weave lays them in blocks instead, the way a
 * pattern is filled rather than shaded.
 */
class HatchingNode implements NodeInstance {
  private readonly index: ScatterIndex<Stroke>;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    const random = createRandom(seedParamValue(params, 'seed', nodeId));
    const spacing = Math.max(3, numberParam(params, 'spacing'));
    const strokeLength = Math.max(4, numberParam(params, 'strokeLength'));
    const gap = Math.max(0, numberParam(params, 'gap'));
    const jitter = numberParam(params, 'jitter');
    const base = (numberParam(params, 'angle') * Math.PI) / 180;
    const style = stringParam(params, 'style');

    const pen: Pen = {
      thickness: numberParam(params, 'thickness'),
      curve: numberParam(params, 'curve'),
      hook: numberParam(params, 'hook'),
      weightScale: Math.max(2, numberParam(params, 'weightScale')),
      weightAmount: numberParam(params, 'weightAmount'),
      broken: numberParam(params, 'broken'),
    };

    const strokes: Stroke[] = [];
    const lay = (
      originX: number,
      originY: number,
      ux: number,
      uy: number,
      from: number,
      to: number,
      side: number,
    ): void => {
      // Start before the span so the first stroke is not always cut at the same
      // place, which would leave a visible edge down the run of lines.
      let along = from - random.next() * strokeLength;
      while (along < to) {
        const length = strokeLength * random.range(0.45, 1.35);
        const start = Math.max(along, from);
        const end = Math.min(along + length, to);
        along += length + gap * random.range(0.4, 1.8);
        if (end - start < 2) continue;
        this.emit(strokes, originX + ux * start, originY + uy * start, ux, uy, end - start, side, pen, random, pass);
      }
    };

    if (style === 'weave') {
      this.layWeave(lay, params, base, spacing, jitter, random, pass);
    } else {
      const angles =
        style === 'cross'
          ? [base, base + Math.PI / 2]
          : style === 'triple'
            ? [base, base + Math.PI / 2, base + Math.PI / 4]
            : [base];

      const diagonal = Math.hypot(pass.outputWidth, pass.outputHeight);
      const centreX = pass.outputWidth / 2;
      const centreY = pass.outputHeight / 2;

      for (const angle of angles) {
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        const nx = -uy;
        const ny = ux;
        const lines = Math.ceil(diagonal / spacing) + 2;

        for (let line = -lines; line <= lines; line++) {
          const offset = line * spacing + random.range(-jitter, jitter) * spacing;
          const wobble = random.range(-jitter, jitter) * spacing * 0.5;
          const originX = centreX + nx * (offset + wobble);
          const originY = centreY + ny * (offset + wobble);
          lay(originX, originY, ux, uy, -diagonal / 2, diagonal / 2, random.next() < 0.5 ? -1 : 1);
        }
      }
    }

    this.index = new ScatterIndex(strokes);
  }

  /**
   * Blocks of parallel strokes at alternating angles, the way a pattern is
   * filled in rather than shaded.
   *
   * The grid turns with the angle, so the strokes always run along the block
   * edges rather than across them. That is what makes it read as woven strips
   * passing over and under one another: a grid left square to the canvas while
   * the strokes run diagonally reads as a pinwheel instead.
   *
   * Each block is inset slightly and its lines are phase-shifted, so
   * neighbours meet at a seam rather than running into one continuous field.
   */
  private layWeave(
    lay: (
      originX: number,
      originY: number,
      ux: number,
      uy: number,
      from: number,
      to: number,
      side: number,
    ) => void,
    params: ParamMap,
    base: number,
    spacing: number,
    jitter: number,
    random: Random,
    pass: PassInfo,
  ): void {
    const patch = Math.max(spacing * 3, numberParam(params, 'patchSize'));
    const seed = Math.floor(random.next() * 0x7fffffff);
    const inset = Math.min(patch * 0.08, spacing * 0.6);
    const half = patch / 2 - inset;
    if (half <= 1) return;

    // The grid's own axes. Everything below is laid out in this frame and
    // mapped back, so the blocks stay square to their strokes at any angle.
    const ax = Math.cos(base);
    const ay = Math.sin(base);
    const bx = -ay;
    const by = ax;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of [
      [0, 0],
      [pass.outputWidth, 0],
      [0, pass.outputHeight],
      [pass.outputWidth, pass.outputHeight],
    ]) {
      const u = x * ax + y * ay;
      const v = x * bx + y * by;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const fromI = Math.floor(minU / patch) - 1;
    const toI = Math.ceil(maxU / patch) + 1;
    const fromJ = Math.floor(minV / patch) - 1;
    const toJ = Math.ceil(maxV / patch) + 1;

    for (let j = fromJ; j <= toJ; j++) {
      for (let i = fromI; i <= toI; i++) {
        const u = (i + 0.5) * patch;
        const v = (j + 0.5) * patch;
        const cx = u * ax + v * bx;
        const cy = u * ay + v * by;

        // A hand-laid block is never quite square to the last one.
        const skew = (hash01(i, j, seed) * 2 - 1) * jitter * 0.12;
        const across = ((i + j) & 1) === 1;
        const angle = base + (across ? Math.PI / 2 : 0) + skew;
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        const nx = -uy;
        const ny = ux;

        const phase = hash01(i, j, seed ^ 0x5bd1e995) * spacing;
        const side = hash01(i, j, seed ^ 0x27d4eb2d) < 0.5 ? -1 : 1;
        const reach = Math.ceil(half / spacing) + 1;

        for (let line = -reach; line <= reach; line++) {
          const offset = line * spacing + phase + random.range(-jitter, jitter) * spacing * 0.3;
          // The block is a square in the grid frame, and the stroke runs along
          // one of its axes but for the skew, so the clip is done there.
          const localX = across ? offset : 0;
          const localY = across ? 0 : offset;
          const dirX = across ? -Math.sin(skew) : Math.cos(skew);
          const dirY = across ? Math.cos(skew) : Math.sin(skew);
          const span = clipToSquare(localX, localY, dirX, dirY, half);
          if (!span) continue;

          lay(cx + nx * offset, cy + ny * offset, ux, uy, span.from, span.to, side);
        }
      }
    }
  }

  /** Places one stroke's pieces on the page, each with the bounds a band needs. */
  private emit(
    out: Stroke[],
    sx: number,
    sy: number,
    ux: number,
    uy: number,
    length: number,
    side: number,
    pen: Pen,
    random: Random,
    pass: PassInfo,
  ): void {
    const intensity = random.range(0.55, 1);
    for (const path of shapeStroke(sx, sy, ux, uy, length, side, pen, random)) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < path.length; i += 3) {
        const reach = path[i + 2] / 2 + 1;
        if (path[i] - reach < minX) minX = path[i] - reach;
        if (path[i] + reach > maxX) maxX = path[i] + reach;
        if (path[i + 1] - reach < minY) minY = path[i + 1] - reach;
        if (path[i + 1] + reach > maxY) maxY = path[i + 1] + reach;
      }
      // Strokes are laid across the diagonal, so most of a rotated family falls
      // outside the canvas. Keeping the far ones so their wrapped copies could
      // come back is not open here: the scatter index reaches back by the
      // tallest element, not by how far away one sits, so which band finds a
      // distant stroke would depend on the band. This node does not claim to
      // wrap, and a band-dependent render would be the worse fault.
      if (maxX < 0 || minX > pass.outputWidth || maxY < 0 || minY > pass.outputHeight) continue;
      out.push({
        path,
        intensity,
        minY,
        maxY,
        wraps: wrapOffsets(pass.seamless, minX, maxX, minY, maxY, pass.outputWidth, pass.outputHeight),
      });
    }
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const scale = ctx.scale;
    // Mapped into tile space here rather than at build time, because the same
    // stroke is drawn at every wrap offset and at whatever scale is asked for.
    let placed = new Float32Array(0);
    forEachPlacement(this.index, ctx, (stroke, dx, dy) => {
      const path = stroke.path;
      if (placed.length !== path.length) placed = new Float32Array(path.length);
      for (let i = 0; i < path.length; i += 3) {
        placed[i] = (path[i] + dx) * scale - ctx.tile.x;
        placed[i + 1] = (path[i + 1] + dy) * scale - ctx.tile.y;
        placed[i + 2] = path[i + 2] * scale;
      }
      drawPath(buffer, placed, stroke.intensity);
    });
    return buffer;
  }
}

/**
 * One stroke's centreline, sampled: x, y, thickness triples.
 *
 * A ruled stroke needs two points; a bowed one whose weight varies needs enough
 * to resolve both, and no more — every sample is another segment to rasterise.
 * Where the pen leaves the paper the stroke comes back as separate pieces, so
 * each carries its own bounds and a band only pays for the ink that reaches it.
 *
 * Returned rather than drawn so the shape of a stroke can be examined without a
 * canvas: whether the bow peaks in the middle and the hook at the end is a
 * question about the geometry, not about the rasteriser.
 */
export function shapeStroke(
  sx: number,
  sy: number,
  ux: number,
  uy: number,
  length: number,
  side: number,
  pen: Pen,
  random: Random,
): Float32Array[] {
  const nx = -uy;
  const ny = ux;
  const bow = pen.curve * length * random.range(0.5, 1.25) * side;
  // The hook carries on the way the stroke was already bending, which is what a
  // wrist does; against it, the stroke reads as two unrelated gestures.
  const hook = pen.hook * length * 0.2 * random.range(0.45, 1.5) * side;
  const hookAtStart = random.next() < 0.5;
  const weightSeed = Math.floor(random.next() * 0x7fffffff);
  const phase = random.range(0, 64);
  const thickness = pen.thickness * random.range(0.7, 1.3);

  // The hook turns inside HOOK_SPAN of the stroke, so a sample count that
  // resolves the length as a whole still renders it as a corner. Sampling is
  // set by whichever of the two features is finer.
  const shaped = pen.curve > 0 || pen.hook > 0 || pen.weightAmount > 0 || pen.broken > 0;
  const step = shaped ? Math.max(2, Math.min(pen.weightScale / 3, length / 24)) : length;
  const segments = Math.max(1, Math.min(128, Math.round(length / step)));

  const pieces: Float32Array[] = [];
  let run: number[] = [];
  const flush = (): void => {
    if (run.length >= 6) pieces.push(Float32Array.from(run));
    run = [];
  };

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const field = shaped ? contact(phase + (t * length) / pen.weightScale, weightSeed) : 0;
    if (field < pen.broken * 2 - 1) {
      flush();
      continue;
    }

    let lateral = bow * Math.sin(Math.PI * t);
    const toEnd = hookAtStart ? 1 - t : t;
    if (toEnd > 1 - HOOK_SPAN) {
      const k = (toEnd - (1 - HOOK_SPAN)) / HOOK_SPAN;
      lateral += hook * k * k;
    }

    // Contact lightens where the pen lands and lifts, so a stroke tapers at
    // both ends. Tied to the same amount, so zero really is a ruled line.
    const ends = Math.min(1, Math.min(t, 1 - t) / TAPER_SPAN);
    const taper = 1 - 0.55 * pen.weightAmount * (1 - ends);
    const width = Math.max(0.15, thickness * (1 + pen.weightAmount * 0.75 * field) * taper);

    run.push(sx + ux * length * t + nx * lateral, sy + uy * length * t + ny * lateral, width);
  }
  flush();

  return pieces;
}

/**
 * The stretch of a line through (dx, dy) in direction (ux, uy) that lies inside
 * a square of half-size `half` centred on the origin, or null if it misses.
 */
function clipToSquare(
  dx: number,
  dy: number,
  ux: number,
  uy: number,
  half: number,
): { from: number; to: number } | null {
  let from = -Infinity;
  let to = Infinity;

  for (const [offset, direction] of [
    [dx, ux],
    [dy, uy],
  ] as const) {
    if (Math.abs(direction) < 1e-9) {
      if (Math.abs(offset) > half) return null;
      continue;
    }
    const a = (-half - offset) / direction;
    const b = (half - offset) / direction;
    from = Math.max(from, Math.min(a, b));
    to = Math.min(to, Math.max(a, b));
  }

  return to - from > 1 ? { from, to } : null;
}

registerNode({
  type: 'hatching',
  version: 2,
  label: 'Hatching',
  summary: 'Drawn strokes rather than ruled lines: bowed, of uneven weight, hooking where the hand lifts.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: false,
  params: [
    {
      kind: 'select',
      key: 'style',
      label: 'Style',
      options: [
        { value: 'single', label: 'Hatch' },
        { value: 'cross', label: 'Cross hatch' },
        { value: 'triple', label: 'Triple hatch' },
        { value: 'weave', label: 'Woven blocks' },
      ],
      default: 'cross',
    },
    { kind: 'number', key: 'spacing', label: 'Spacing', min: 3, max: 400, step: 1, unit: 'px', default: 26 },
    { kind: 'angle', key: 'angle', label: 'Angle', default: 35 },
    { kind: 'number', key: 'thickness', label: 'Thickness', min: 0.3, max: 40, step: 0.1, unit: 'px', default: 2.6 },
    { kind: 'number', key: 'strokeLength', label: 'Stroke length', min: 4, max: 3000, step: 1, unit: 'px', default: 260 },
    { kind: 'number', key: 'gap', label: 'Gap', min: 0, max: 800, step: 1, unit: 'px', default: 90 },
    { kind: 'number', key: 'jitter', label: 'Jitter', min: 0, max: 1, step: 0.01, default: 0.22 },
    { kind: 'number', key: 'curve', label: 'Curve', min: 0, max: 0.3, step: 0.005, default: 0.02 },
    { kind: 'number', key: 'hook', label: 'End hook', min: 0, max: 1, step: 0.01, default: 0.3 },
    { kind: 'number', key: 'weightScale', label: 'Weight scale', min: 2, max: 1200, step: 1, unit: 'px', default: 70 },
    { kind: 'number', key: 'weightAmount', label: 'Weight variation', min: 0, max: 1, step: 0.01, default: 0.45 },
    { kind: 'number', key: 'broken', label: 'Break up', min: 0, max: 0.9, step: 0.01, default: 0 },
    { kind: 'number', key: 'patchSize', label: 'Block size', min: 20, max: 2000, step: 1, unit: 'px', default: 240 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new HatchingNode(params, nodeId, pass),
});
