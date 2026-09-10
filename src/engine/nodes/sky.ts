import { FractalNoise } from '../noise.ts';
import { createRandom } from '../random.ts';
import { drawEllipse, drawLine } from '../raster.ts';
import {
  booleanParam,
  numberParam,
  registerNode,
  seedParamValue,
  type NodeInstance,
  type ParamMap,
  type PassInfo,
} from '../registry.ts';
import { createMaskBuffer, outputX, outputY, type PixelBuffer, type RenderContext } from '../types.ts';
import { ScatterIndex, forEachPlacement, scatterCount, wrapOffsets, type PlacedItem } from './scatter.ts';

interface Star extends PlacedItem {
  x: number;
  y: number;
  radius: number;
  brightness: number;
  spike: number;
}

/**
 * Stars: many faint, a few bright.
 *
 * The distribution is what separates this from Speckles. Brightness follows a
 * power law, so most stars sit near the threshold of visibility and a handful
 * dominate — an even scatter of equal dots reads as dirt on the lens instead.
 * The brightest get diffraction spikes, which is the cue the eye actually uses.
 */
class StarfieldNode implements NodeInstance {
  private readonly index: ScatterIndex<Star>;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    const random = createRandom(seedParamValue(params, 'seed', nodeId));
    const count = scatterCount(numberParam(params, 'density'), pass.outputWidth, pass.outputHeight);
    const size = numberParam(params, 'size');
    const falloff = Math.max(1, numberParam(params, 'falloff'));
    const spikes = booleanParam(params, 'spikes');
    const spikeAbove = numberParam(params, 'spikeThreshold');

    const stars: Star[] = [];
    for (let n = 0; n < count; n++) {
      const x = random.range(0, pass.outputWidth);
      const y = random.range(0, pass.outputHeight);
      // A power law: raising a uniform roll to a power crowds the result towards
      // nothing, leaving few bright stars.
      const brightness = random.next() ** falloff;
      const radius = size * (0.25 + brightness * 0.75);
      const spike = spikes && brightness > spikeAbove ? radius * (3 + brightness * 5) : 0;
      const reach = Math.max(radius, spike) + 1;
      stars.push({
        x,
        y,
        radius,
        brightness: 0.15 + brightness * 0.85,
        spike,
        minY: y - reach,
        maxY: y + reach,
        wraps: wrapOffsets(pass.seamless, x - reach, x + reach, y - reach, y + reach, pass.outputWidth, pass.outputHeight),
      });
    }
    this.index = new ScatterIndex(stars);
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const scale = ctx.scale;
    forEachPlacement(this.index, ctx, (star, dx, dy) => {
      const cx = (star.x + dx) * scale - ctx.tile.x;
      const cy = (star.y + dy) * scale - ctx.tile.y;
      if (star.spike > 0) {
        const reach = star.spike * scale;
        drawLine(buffer, cx - reach, cy, cx + reach, cy, Math.max(0.4, star.radius * scale * 0.35), star.brightness * 0.5);
        drawLine(buffer, cx, cy - reach, cx, cy + reach, Math.max(0.4, star.radius * scale * 0.35), star.brightness * 0.5);
      }
      drawEllipse(buffer, cx, cy, star.radius * scale, star.radius * scale, 0, star.brightness);
    });
    return buffer;
  }
}

/**
 * Billowing gas and dust.
 *
 * Folded noise gives the filaments, and warping the coordinates before sampling
 * pulls them into sheets and cavities. Plain fractal noise cannot do this: it
 * makes clouds of a single character everywhere, where a nebula is wispy in
 * places and dense in others.
 */
class NebulaNode implements NodeInstance {
  private readonly body: FractalNoise;
  private readonly warpX: FractalNoise;
  private readonly warpY: FractalNoise;
  private readonly params: ParamMap;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    this.params = params;
    const seed = seedParamValue(params, 'seed', nodeId);
    const scale = Math.max(24, numberParam(params, 'scale'));
    const shared = { outputWidth: pass.outputWidth, outputHeight: pass.outputHeight };
    this.body = new FractalNoise({
      ...shared,
      cellPx: scale,
      octaves: numberParam(params, 'detail'),
      seed,
      turbulent: true,
    });
    this.warpX = new FractalNoise({ ...shared, cellPx: scale * 2, octaves: 3, seed: seed + 1213 });
    this.warpY = new FractalNoise({ ...shared, cellPx: scale * 2, octaves: 3, seed: seed + 7717 });
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const amount = numberParam(this.params, 'warpAmount');
    const contrast = numberParam(this.params, 'contrast');
    const density = numberParam(this.params, 'density');

    const step = 1 / ctx.scale;
    const startX = outputX(ctx, 0) + 0.5 * step;
    const width = ctx.tile.width;
    const wx = new Float32Array(width);
    const wy = new Float32Array(width);

    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 * step;
      this.warpX.sampleRow(wx, y, startX, step);
      this.warpY.sampleRow(wy, y, startX, step);

      for (let i = 0; i < width; i++) {
        const x = startX + i * step;
        // Sampled per pixel rather than per row: the warp moves the row itself,
        // so a row of samples no longer lies on one line of the source field.
        const value = this.body.sample(x + (wx[i] - 0.5) * 2 * amount, y + (wy[i] - 0.5) * 2 * amount);
        const shaped = Math.max(0, 1 - value) ** contrast;
        buffer.data[j * width + i] = Math.min(1, shaped * density) * 255;
      }
    }
    return buffer;
  }
}

registerNode({
  type: 'starfield',
  version: 1,
  label: 'Starfield',
  summary: 'Many faint stars, a few bright ones, with diffraction spikes on the brightest.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  params: [
    { kind: 'number', key: 'density', label: 'Density', min: 1, max: 40000, step: 10, unit: '/MP', default: 2600 },
    { kind: 'number', key: 'size', label: 'Star size', min: 0.3, max: 60, step: 0.1, unit: 'px', default: 3.4 },
    { kind: 'number', key: 'falloff', label: 'Brightness falloff', min: 1, max: 12, step: 0.1, default: 4.5 },
    { kind: 'boolean', key: 'spikes', label: 'Diffraction spikes', default: true },
    { kind: 'number', key: 'spikeThreshold', label: 'Spikes above', min: 0.5, max: 0.999, step: 0.001, default: 0.94 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new StarfieldNode(params, nodeId, pass),
});

registerNode({
  type: 'nebula',
  version: 1,
  label: 'Nebula',
  summary: 'Billowing gas: folded noise pulled into sheets and cavities.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  seamlessPeriod: () => ({ x: null, y: null }),
  params: [
    { kind: 'number', key: 'scale', label: 'Scale', min: 24, max: 6000, step: 1, unit: 'px', default: 700 },
    { kind: 'number', key: 'detail', label: 'Detail', min: 1, max: 8, step: 1, unit: 'octaves', default: 6 },
    { kind: 'number', key: 'warpAmount', label: 'Warp amount', min: 0, max: 3000, step: 1, unit: 'px', default: 380 },
    { kind: 'number', key: 'contrast', label: 'Contrast', min: 0.2, max: 8, step: 0.05, default: 2.4 },
    { kind: 'number', key: 'density', label: 'Density', min: 0.2, max: 4, step: 0.05, default: 1.5 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new NebulaNode(params, nodeId, pass),
});
