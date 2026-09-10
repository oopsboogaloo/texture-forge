import { createRandom } from '../random.ts';
import { drawLine } from '../raster.ts';
import { numberParam, registerNode, seedParamValue, type NodeInstance, type ParamMap, type PassInfo } from '../registry.ts';
import { createMaskBuffer, type PixelBuffer, type RenderContext } from '../types.ts';
import { ScatterIndex, forEachPlacement, scatterCount, wrapOffsets, type PlacedItem } from './scatter.ts';

interface Fibre extends PlacedItem {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  thickness: number;
  intensity: number;
}

class PaperFibresNode implements NodeInstance {
  private readonly index: ScatterIndex<Fibre>;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    const random = createRandom(seedParamValue(params, 'seed', nodeId));
    const count = scatterCount(numberParam(params, 'density'), pass.outputWidth, pass.outputHeight);
    const length = numberParam(params, 'length');
    const thickness = numberParam(params, 'thickness');
    const direction = (numberParam(params, 'direction') * Math.PI) / 180;
    const spread = (numberParam(params, 'spread') * Math.PI) / 180;

    const fibres: Fibre[] = [];
    for (let i = 0; i < count; i++) {
      const x0 = random.range(0, pass.outputWidth);
      const y0 = random.range(0, pass.outputHeight);
      const angle = direction + random.range(-spread, spread);
      const len = length * random.range(0.5, 1.5);
      const x1 = x0 + Math.cos(angle) * len;
      const y1 = y0 + Math.sin(angle) * len;
      const halfWidth = Math.max(thickness, 1) / 2 + 1;
      const minY = Math.min(y0, y1) - halfWidth;
      const maxY = Math.max(y0, y1) + halfWidth;
      fibres.push({
        x0,
        y0,
        x1,
        y1,
        thickness,
        intensity: random.range(0.35, 1),
        minY,
        maxY,
        wraps: wrapOffsets(
          pass.seamless,
          Math.min(x0, x1) - halfWidth,
          Math.max(x0, x1) + halfWidth,
          minY,
          maxY,
          pass.outputWidth,
          pass.outputHeight,
        ),
      });
    }
    this.index = new ScatterIndex(fibres);
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const scale = ctx.scale;
    forEachPlacement(this.index, ctx, (fibre, dx, dy) => {
      drawLine(
        buffer,
        (fibre.x0 + dx) * scale - ctx.tile.x,
        (fibre.y0 + dy) * scale - ctx.tile.y,
        (fibre.x1 + dx) * scale - ctx.tile.x,
        (fibre.y1 + dy) * scale - ctx.tile.y,
        fibre.thickness * scale,
        fibre.intensity,
      );
    });
    return buffer;
  }
}

registerNode({
  type: 'paper-fibres',
  version: 1,
  label: 'Paper Fibres',
  summary: 'Fine directional surface detail.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  params: [
    { kind: 'number', key: 'density', label: 'Density', min: 0, max: 20000, step: 50, unit: '/MP', default: 2500 },
    { kind: 'number', key: 'length', label: 'Length', min: 2, max: 800, step: 1, unit: 'px', default: 90 },
    { kind: 'number', key: 'thickness', label: 'Thickness', min: 0.2, max: 20, step: 0.1, unit: 'px', default: 1.5 },
    { kind: 'angle', key: 'direction', label: 'Direction', default: 0 },
    { kind: 'angle', key: 'spread', label: 'Spread', default: 25 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new PaperFibresNode(params, nodeId, pass),
});
