import { createRandom } from '../random.ts';
import { drawEllipse } from '../raster.ts';
import { numberParam, registerNode, seedParamValue, type NodeInstance, type ParamMap, type PassInfo } from '../registry.ts';
import { createMaskBuffer, type PixelBuffer, type RenderContext } from '../types.ts';
import { ScatterIndex, scatterCount, wrapOffsets, type ScatterItem } from './scatter.ts';

interface Speckle extends ScatterItem {
  x: number;
  y: number;
  rx: number;
  ry: number;
  rotation: number;
  intensity: number;
  wraps: { dx: number; dy: number }[];
}

class SpecklesNode implements NodeInstance {
  private readonly index: ScatterIndex<Speckle>;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    const random = createRandom(seedParamValue(params, 'seed', nodeId));
    const count = scatterCount(numberParam(params, 'density'), pass.outputWidth, pass.outputHeight);
    const sizeMin = numberParam(params, 'sizeMin');
    const sizeMax = Math.max(sizeMin, numberParam(params, 'sizeMax'));
    const irregularity = numberParam(params, 'irregularity');

    const speckles: Speckle[] = [];
    for (let i = 0; i < count; i++) {
      const size = random.range(sizeMin, sizeMax);
      // Irregularity stretches each fleck along a random axis, so marks read as
      // torn rather than punched.
      const stretch = 1 + random.range(0, irregularity * 2);
      const rx = (size / 2) * stretch;
      const ry = size / 2 / stretch;
      const x = random.range(0, pass.outputWidth);
      const y = random.range(0, pass.outputHeight);
      const reach = Math.max(rx, ry) + 1;
      speckles.push({
        x,
        y,
        rx,
        ry,
        rotation: random.range(0, Math.PI),
        intensity: random.range(1 - irregularity * 0.7, 1),
        minY: y - reach,
        maxY: y + reach,
        wraps: wrapOffsets(pass.seamless, x - reach, x + reach, y - reach, y + reach, pass.outputWidth, pass.outputHeight),
      });
    }
    this.index = new ScatterIndex(speckles);
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const scale = ctx.scale;
    const top = ctx.tile.y / scale;
    const bottom = (ctx.tile.y + ctx.tile.height) / scale;
    const windows = ctx.seamless
      ? [
          { top, bottom },
          { top: top + ctx.outputHeight, bottom: bottom + ctx.outputHeight },
          { top: top - ctx.outputHeight, bottom: bottom - ctx.outputHeight },
        ]
      : [{ top, bottom }];

    for (const window of windows) {
      this.index.forEachInRows(window.top, window.bottom, (speckle) => {
        for (const offset of speckle.wraps) {
          drawEllipse(
            buffer,
            (speckle.x + offset.dx) * scale - ctx.tile.x,
            (speckle.y + offset.dy) * scale - ctx.tile.y,
            speckle.rx * scale,
            speckle.ry * scale,
            speckle.rotation,
            speckle.intensity,
          );
        }
      });
    }
    return buffer;
  }
}

registerNode({
  type: 'speckles',
  version: 1,
  label: 'Speckles',
  summary: 'Paper flecks and missing-ink marks.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  params: [
    { kind: 'number', key: 'density', label: 'Density', min: 0, max: 20000, step: 25, unit: '/MP', default: 900 },
    { kind: 'number', key: 'sizeMin', label: 'Smallest size', min: 0.5, max: 200, step: 0.5, unit: 'px', default: 2 },
    { kind: 'number', key: 'sizeMax', label: 'Largest size', min: 0.5, max: 400, step: 0.5, unit: 'px', default: 14 },
    { kind: 'number', key: 'irregularity', label: 'Irregularity', min: 0, max: 1, step: 0.01, default: 0.5 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new SpecklesNode(params, nodeId, pass),
});
