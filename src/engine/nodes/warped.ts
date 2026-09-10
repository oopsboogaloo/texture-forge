import { FractalNoise } from '../noise.ts';
import { edgeCoverage } from '../field.ts';
import {
  numberParam,
  registerNode,
  seedParamValue,
  type NodeInstance,
  type ParamMap,
  type PassInfo,
} from '../registry.ts';
import { createMaskBuffer, outputX, outputY, type PixelBuffer, type RenderContext } from '../types.ts';

/**
 * Bands pushed sideways by noise — the shape of marble, wood and oil on water.
 *
 * Domain warping is the one thing layering cannot reproduce: the noise displaces
 * the coordinates the bands are evaluated at, rather than being mixed into the
 * result, so the bands bend and fold instead of merely getting dirtier.
 */
class WarpedBandsNode implements NodeInstance {
  private readonly warp: FractalNoise;
  private readonly detail: FractalNoise;
  private readonly params: ParamMap;
  private readonly cyclesX: number;
  private readonly cyclesY: number;
  private readonly warpToCycles: number;
  private readonly shape: 'veins' | 'rings';

  constructor(params: ParamMap, nodeId: string, pass: PassInfo, shape: 'veins' | 'rings') {
    const seed = seedParamValue(params, 'seed', nodeId);
    this.params = params;
    this.warp = new FractalNoise({
      outputWidth: pass.outputWidth,
      outputHeight: pass.outputHeight,
      cellPx: Math.max(8, numberParam(params, 'warpScale')),
      octaves: 4,
      seed,
    });
    this.detail = new FractalNoise({
      outputWidth: pass.outputWidth,
      outputHeight: pass.outputHeight,
      cellPx: Math.max(4, numberParam(params, 'warpScale') / 8),
      octaves: 3,
      seed: seed + 5171,
    });
    // The bands are carried by a wave with a whole number of cycles across the
    // image in each direction. A plain rotated ramp is not periodic — shifting
    // by the image width moves it by width * cos(angle), which is no particular
    // number of wavelengths — so the warping noise would wrap while the bands it
    // carries did not, and a texture advertised as seamless would show a seam
    // wherever the angle was not square. Rounding to whole cycles moves the
    // angle and spacing by a fraction of a band, which is invisible; a seam is
    // not.
    const requested = Math.max(4, numberParam(params, 'bandWidth'));
    const wavelength = requested * 2;
    const radians = (numberParam(params, 'angle') * Math.PI) / 180;
    let cyclesX = Math.round((pass.outputWidth * Math.cos(radians)) / wavelength);
    let cyclesY = Math.round((pass.outputHeight * Math.sin(radians)) / wavelength);
    if (cyclesX === 0 && cyclesY === 0) {
      if (Math.abs(Math.cos(radians)) >= Math.abs(Math.sin(radians))) cyclesX = 1;
      else cyclesY = 1;
    }
    this.cyclesX = cyclesX / pass.outputWidth;
    this.cyclesY = cyclesY / pass.outputHeight;
    // Warp displacements are along the band normal, so they are measured in the
    // same units the carrier counts in.
    this.warpToCycles = 1 / wavelength;
    this.shape = shape;
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const amount = numberParam(this.params, 'warpAmount');
    const grain = numberParam(this.params, 'grain');
    const contrast = numberParam(this.params, 'contrast');
    const warpRow = new Float32Array(ctx.tile.width);
    const detailRow = new Float32Array(ctx.tile.width);
    const step = 1 / ctx.scale;
    const startX = outputX(ctx, 0) + 0.5 * step;

    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 * step;
      this.warp.sampleRow(warpRow, y, startX, step);
      this.detail.sampleRow(detailRow, y, startX, step);

      for (let i = 0; i < ctx.tile.width; i++) {
        const x = startX + i * step;
        const cycles =
          x * this.cyclesX +
          y * this.cyclesY +
          ((warpRow[i] - 0.5) * 2 * amount + (detailRow[i] - 0.5) * 2 * grain) * this.warpToCycles;
        const wave = 0.5 + 0.5 * Math.sin(cycles * Math.PI * 2);
        // A plain sine spends half its cycle high, which reads as zebra rather
        // than as stone or timber: both are mostly plain surface with narrow
        // markings across it. Since 1 means "the mark" here, raising the wave to
        // a power narrows what gets marked — sharply for wood, whose rings are
        // thin and crisp, gently for marble, whose veins are broader.
        let value = wave ** (this.shape === 'rings' ? 9 : 3);
        value = (value - 0.5) * contrast + 0.5;
        buffer.data[j * ctx.tile.width + i] = value * 255;
      }
    }
    return buffer;
  }
}

/**
 * Iso-lines through a noise field: contours, as on a map.
 *
 * The lines follow levels of the field rather than being drawn on top of it, so
 * they nest and close the way real contours do. Their spacing reports the
 * steepness of the underlying surface, which is what makes the result read as
 * terrain rather than as decoration.
 */
class ContoursNode implements NodeInstance {
  private readonly noise: FractalNoise;
  private readonly params: ParamMap;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    this.params = params;
    this.noise = new FractalNoise({
      outputWidth: pass.outputWidth,
      outputHeight: pass.outputHeight,
      cellPx: Math.max(16, numberParam(params, 'scale')),
      octaves: numberParam(params, 'detail'),
      seed: seedParamValue(params, 'seed', nodeId),
    });
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const interval = Math.max(0.01, numberParam(this.params, 'interval'));
    const half = numberParam(this.params, 'lineThickness') / 2;
    const majorEvery = Math.max(1, Math.round(numberParam(this.params, 'majorEvery')));
    const majorHalf = numberParam(this.params, 'majorThickness') / 2;

    const step = 1 / ctx.scale;
    const startX = outputX(ctx, 0) + 0.5 * step;
    const width = ctx.tile.width;
    const here = new Float32Array(width);
    const below = new Float32Array(width);
    // One output pixel apart, so the gradient is in the same units as the
    // line widths.
    const probe = 1;

    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 * step;
      this.noise.sampleRow(here, y, startX, step);
      this.noise.sampleRow(below, y + probe, startX, step);

      for (let i = 0; i < width; i++) {
        const value = here[i];
        const right = i + 1 < width ? here[i + 1] : here[i];
        // Gradient magnitude turns "distance in value" into "distance in pixels",
        // which is what keeps every contour the same width however steep the
        // surface is beneath it.
        const dx = (right - value) / (i + 1 < width ? step : 1);
        const dy = (below[i] - value) / probe;
        const slope = Math.max(1e-6, Math.hypot(dx, dy));

        const level = Math.round(value / interval);
        const distance = Math.abs(value - level * interval) / slope;
        const isMajor = ((level % majorEvery) + majorEvery) % majorEvery === 0;
        const coverage = edgeCoverage(distance, isMajor ? majorHalf : half, ctx.scale);
        buffer.data[j * width + i] = coverage * 255;
      }
    }
    return buffer;
  }
}

registerNode({
  type: 'marble',
  version: 1,
  label: 'Marble',
  summary: 'Bands folded by noise: marble, oil, watered silk.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  seamlessPeriod: () => ({ x: null, y: null }),
  params: [
    { kind: 'number', key: 'bandWidth', label: 'Vein spacing', min: 8, max: 2000, step: 1, unit: 'px', default: 150 },
    { kind: 'number', key: 'warpScale', label: 'Warp scale', min: 16, max: 4000, step: 1, unit: 'px', default: 600 },
    { kind: 'number', key: 'warpAmount', label: 'Warp amount', min: 0, max: 2000, step: 1, unit: 'px', default: 300 },
    { kind: 'number', key: 'grain', label: 'Grain', min: 0, max: 400, step: 1, unit: 'px', default: 55 },
    { kind: 'number', key: 'contrast', label: 'Contrast', min: 0, max: 4, step: 0.05, default: 1 },
    { kind: 'angle', key: 'angle', label: 'Angle', default: 20 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new WarpedBandsNode(params, nodeId, pass, 'veins'),
});

registerNode({
  type: 'wood-grain',
  version: 1,
  label: 'Wood Grain',
  summary: 'Hard rings with soft gaps, drifting along the plank.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  seamlessPeriod: () => ({ x: null, y: null }),
  params: [
    { kind: 'number', key: 'bandWidth', label: 'Ring spacing', min: 8, max: 2000, step: 1, unit: 'px', default: 42 },
    { kind: 'number', key: 'warpScale', label: 'Warp scale', min: 16, max: 4000, step: 1, unit: 'px', default: 1400 },
    { kind: 'number', key: 'warpAmount', label: 'Warp amount', min: 0, max: 2000, step: 1, unit: 'px', default: 180 },
    { kind: 'number', key: 'grain', label: 'Grain', min: 0, max: 400, step: 1, unit: 'px', default: 14 },
    { kind: 'number', key: 'contrast', label: 'Contrast', min: 0, max: 4, step: 0.05, default: 1.5 },
    { kind: 'angle', key: 'angle', label: 'Angle', default: 0 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 4 },
  ],
  create: (params, nodeId, pass) => new WarpedBandsNode(params, nodeId, pass, 'rings'),
});

registerNode({
  type: 'contours',
  version: 1,
  label: 'Contours',
  summary: 'Iso-lines through a noise field, with heavier lines at an interval.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  seamlessPeriod: () => ({ x: null, y: null }),
  params: [
    { kind: 'number', key: 'scale', label: 'Landform scale', min: 32, max: 6000, step: 1, unit: 'px', default: 900 },
    { kind: 'number', key: 'detail', label: 'Detail', min: 1, max: 8, step: 1, unit: 'octaves', default: 4 },
    { kind: 'number', key: 'interval', label: 'Contour interval', min: 0.01, max: 0.5, step: 0.005, default: 0.06 },
    { kind: 'number', key: 'lineThickness', label: 'Line thickness', min: 0.5, max: 40, step: 0.5, unit: 'px', default: 2.5 },
    { kind: 'number', key: 'majorEvery', label: 'Heavier every', min: 1, max: 20, step: 1, default: 5 },
    { kind: 'number', key: 'majorThickness', label: 'Heavier thickness', min: 0.5, max: 80, step: 0.5, unit: 'px', default: 6 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new ContoursNode(params, nodeId, pass),
});
