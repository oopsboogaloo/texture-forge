import { createRandom } from '../random.ts';
import { drawLine } from '../raster.ts';
import { numberParam, registerNode, seedParamValue, stringParam, type NodeInstance, type ParamMap, type PassInfo } from '../registry.ts';
import { createMaskBuffer, type PixelBuffer, type RenderContext } from '../types.ts';
import { ScatterIndex, forEachPlacement, wrapOffsets, type PlacedItem } from './scatter.ts';

interface Stroke extends PlacedItem {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  thickness: number;
  intensity: number;
}

/**
 * Drawn hatching, as a pen lays it down.
 *
 * Stripes gives perfect ruled lines; this gives strokes — broken, of uneven
 * length and weight, each starting and stopping where a hand would lift. That
 * irregularity is the whole point, and it is what no arrangement of ruled lines
 * can imitate. Crossing families build tone the way an engraver builds it.
 */
class HatchingNode implements NodeInstance {
  private readonly index: ScatterIndex<Stroke>;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    const random = createRandom(seedParamValue(params, 'seed', nodeId));
    const spacing = Math.max(3, numberParam(params, 'spacing'));
    const thickness = numberParam(params, 'thickness');
    const strokeLength = Math.max(4, numberParam(params, 'strokeLength'));
    const gap = Math.max(0, numberParam(params, 'gap'));
    const jitter = numberParam(params, 'jitter');
    const base = (numberParam(params, 'angle') * Math.PI) / 180;

    const style = stringParam(params, 'style');
    const angles =
      style === 'cross'
        ? [base, base + Math.PI / 2]
        : style === 'triple'
          ? [base, base + Math.PI / 2, base + Math.PI / 4]
          : [base];

    const diagonal = Math.hypot(pass.outputWidth, pass.outputHeight);
    const centreX = pass.outputWidth / 2;
    const centreY = pass.outputHeight / 2;
    const strokes: Stroke[] = [];

    for (const angle of angles) {
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const nx = -dy;
      const ny = dx;
      const lines = Math.ceil(diagonal / spacing) + 2;

      for (let line = -lines; line <= lines; line++) {
        const offset = line * spacing + random.range(-jitter, jitter) * spacing;
        let along = -diagonal / 2 - random.next() * strokeLength;

        while (along < diagonal / 2) {
          const length = strokeLength * random.range(0.45, 1.35);
          const wobble = random.range(-jitter, jitter) * spacing * 0.5;
          const sx = centreX + dx * along + nx * (offset + wobble);
          const sy = centreY + dy * along + ny * (offset + wobble);
          const ex = sx + dx * length;
          const ey = sy + dy * length;
          along += length + gap * random.range(0.4, 1.8);

          const pad = Math.max(thickness, 1) / 2 + 1;
          const minX = Math.min(sx, ex) - pad;
          const maxX = Math.max(sx, ex) + pad;
          const minY = Math.min(sy, ey) - pad;
          const maxY = Math.max(sy, ey) + pad;
          if (maxX < 0 || minX > pass.outputWidth || maxY < 0 || minY > pass.outputHeight) continue;

          strokes.push({
            x0: sx,
            y0: sy,
            x1: ex,
            y1: ey,
            thickness: thickness * random.range(0.7, 1.3),
            intensity: random.range(0.55, 1),
            minY,
            maxY,
            wraps: wrapOffsets(pass.seamless, minX, maxX, minY, maxY, pass.outputWidth, pass.outputHeight),
          });
        }
      }
    }
    this.index = new ScatterIndex(strokes);
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const scale = ctx.scale;
    forEachPlacement(this.index, ctx, (stroke, dx, dy) => {
      drawLine(
        buffer,
        (stroke.x0 + dx) * scale - ctx.tile.x,
        (stroke.y0 + dy) * scale - ctx.tile.y,
        (stroke.x1 + dx) * scale - ctx.tile.x,
        (stroke.y1 + dy) * scale - ctx.tile.y,
        stroke.thickness * scale,
        stroke.intensity,
      );
    });
    return buffer;
  }
}

registerNode({
  type: 'hatching',
  version: 1,
  label: 'Hatching',
  summary: 'Drawn strokes rather than ruled lines, in one, two or three crossing families.',
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
      ],
      default: 'cross',
    },
    { kind: 'number', key: 'spacing', label: 'Spacing', min: 3, max: 400, step: 1, unit: 'px', default: 26 },
    { kind: 'angle', key: 'angle', label: 'Angle', default: 35 },
    { kind: 'number', key: 'thickness', label: 'Thickness', min: 0.3, max: 40, step: 0.1, unit: 'px', default: 2.6 },
    { kind: 'number', key: 'strokeLength', label: 'Stroke length', min: 4, max: 3000, step: 1, unit: 'px', default: 260 },
    { kind: 'number', key: 'gap', label: 'Gap', min: 0, max: 800, step: 1, unit: 'px', default: 90 },
    { kind: 'number', key: 'jitter', label: 'Jitter', min: 0, max: 1, step: 0.01, default: 0.22 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new HatchingNode(params, nodeId, pass),
});
