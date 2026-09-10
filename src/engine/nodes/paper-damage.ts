import { FractalNoise } from '../noise.ts';
import {
  booleanParam,
  numberParam,
  registerNode,
  seedParamValue,
  stringParam,
  type NodeInstance,
  type ParamMap,
  type PassInfo,
} from '../registry.ts';
import { createMaskBuffer, outputX, outputY, type PixelBuffer, type RenderContext } from '../types.ts';

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * A ragged edge eaten in from the border of the image.
 *
 * The tear depth at any point along an edge is set by noise, so the boundary
 * wanders the way a fibre-pulled edge does rather than following a drawn line.
 * One means paper, zero means gone — put a Colour Ramp after it and the paper
 * takes whatever colour it should be.
 *
 * This cannot tile: an edge treatment is a statement about where the image
 * stops, and a texture that repeats has no edges.
 */
class TornEdgesNode implements NodeInstance {
  private readonly noise: FractalNoise;
  private readonly params: ParamMap;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    this.params = params;
    this.noise = new FractalNoise({
      outputWidth: pass.outputWidth,
      outputHeight: pass.outputHeight,
      cellPx: Math.max(8, numberParam(params, 'raggedness')),
      octaves: 4,
      seed: seedParamValue(params, 'seed', nodeId),
    });
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const depth = Math.max(1, numberParam(this.params, 'depth'));
    const variation = numberParam(this.params, 'variation');
    const softness = Math.max(0.5, numberParam(this.params, 'softness'));
    const edges = stringParam(this.params, 'edges');
    const useTop = edges === 'all' || edges === 'horizontal' || edges === 'top';
    const useBottom = edges === 'all' || edges === 'horizontal' || edges === 'bottom';
    const useLeft = edges === 'all' || edges === 'vertical' || edges === 'left';
    const useRight = edges === 'all' || edges === 'vertical' || edges === 'right';

    const step = 1 / ctx.scale;
    const startX = outputX(ctx, 0) + 0.5 * step;
    const row = new Float32Array(ctx.tile.width);

    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 * step;
      this.noise.sampleRow(row, y, startX, step);

      for (let i = 0; i < ctx.tile.width; i++) {
        const x = startX + i * step;
        let distance = Infinity;
        if (useLeft) distance = Math.min(distance, x);
        if (useRight) distance = Math.min(distance, ctx.outputWidth - x);
        if (useTop) distance = Math.min(distance, y);
        if (useBottom) distance = Math.min(distance, ctx.outputHeight - y);
        if (distance === Infinity) {
          buffer.data[j * ctx.tile.width + i] = 255;
          continue;
        }

        const tear = depth * (1 + (row[i] - 0.5) * 2 * variation);
        buffer.data[j * ctx.tile.width + i] = clamp01((distance - tear) / softness + 0.5) * 255;
      }
    }
    return buffer;
  }
}

/**
 * Scorching: holes eaten through the sheet with charred margins.
 *
 * The output is a single field — nothing at the centre of a burn, rising
 * through the char to untouched paper — because a Colour Ramp reads it far
 * better than three separate outputs would. Stops near zero become the hole,
 * stops just above it the blackened rim, and the rest the sheet.
 */
class BurnsNode implements NodeInstance {
  private readonly noise: FractalNoise;
  private readonly params: ParamMap;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    this.params = params;
    this.noise = new FractalNoise({
      outputWidth: pass.outputWidth,
      outputHeight: pass.outputHeight,
      cellPx: Math.max(16, numberParam(params, 'size')),
      octaves: 5,
      seed: seedParamValue(params, 'seed', nodeId),
    });
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const coverage = numberParam(this.params, 'coverage');
    const char = Math.max(0.01, numberParam(this.params, 'charSpread'));
    const fromEdges = booleanParam(this.params, 'fromEdges');
    const reach = Math.max(1, numberParam(this.params, 'edgeReach'));

    const step = 1 / ctx.scale;
    const startX = outputX(ctx, 0) + 0.5 * step;
    const row = new Float32Array(ctx.tile.width);

    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 * step;
      this.noise.sampleRow(row, y, startX, step);

      for (let i = 0; i < ctx.tile.width; i++) {
        let field = row[i];
        if (fromEdges) {
          // Fire takes the edges first: the closer to the border, the less
          // noise is needed to burn through.
          const x = startX + i * step;
          const distance = Math.min(x, ctx.outputWidth - x, y, ctx.outputHeight - y);
          field += clamp01(distance / reach) * 0.6;
        }
        buffer.data[j * ctx.tile.width + i] = clamp01((field - (1 - coverage)) / char) * 255;
      }
    }
    return buffer;
  }
}

registerNode({
  type: 'torn-edges',
  version: 1,
  label: 'Torn Edges',
  summary: 'A ragged edge eaten in from the border. One means paper, zero means gone.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: false,
  params: [
    {
      kind: 'select',
      key: 'edges',
      label: 'Edges',
      options: [
        { value: 'all', label: 'All four' },
        { value: 'horizontal', label: 'Top and bottom' },
        { value: 'vertical', label: 'Left and right' },
        { value: 'top', label: 'Top' },
        { value: 'bottom', label: 'Bottom' },
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
      ],
      default: 'all',
    },
    { kind: 'number', key: 'depth', label: 'Depth', min: 2, max: 2000, step: 1, unit: 'px', default: 90 },
    { kind: 'number', key: 'variation', label: 'Variation', min: 0, max: 1, step: 0.01, default: 0.7 },
    { kind: 'number', key: 'raggedness', label: 'Raggedness', min: 8, max: 2000, step: 1, unit: 'px', default: 130 },
    { kind: 'number', key: 'softness', label: 'Softness', min: 0.5, max: 200, step: 0.5, unit: 'px', default: 3 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new TornEdgesNode(params, nodeId, pass),
});

registerNode({
  type: 'burns',
  version: 1,
  label: 'Burns',
  summary: 'Scorched holes with charred margins. Read it with a ramp: hole, char, then paper.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  seamlessPeriod: () => ({ x: null, y: null }),
  params: [
    { kind: 'number', key: 'coverage', label: 'Coverage', min: 0, max: 1, step: 0.01, default: 0.42 },
    { kind: 'number', key: 'size', label: 'Burn size', min: 16, max: 4000, step: 1, unit: 'px', default: 700 },
    { kind: 'number', key: 'charSpread', label: 'Char spread', min: 0.01, max: 0.6, step: 0.01, default: 0.12 },
    { kind: 'boolean', key: 'fromEdges', label: 'Start at the edges', default: true },
    { kind: 'number', key: 'edgeReach', label: 'Edge reach', min: 1, max: 4000, step: 1, unit: 'px', default: 700 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new BurnsNode(params, nodeId, pass),
});
