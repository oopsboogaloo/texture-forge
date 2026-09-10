import { FractalNoise } from '../noise.ts';
import { numberParam, registerNode, seedParamValue, type NodeInstance, type ParamMap, type PassInfo } from '../registry.ts';
import { createMaskBuffer, outputX, outputY, type PixelBuffer, type RenderContext } from '../types.ts';

class FractalNoiseNode implements NodeInstance {
  private readonly noise: FractalNoise;
  private readonly contrast: number;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    this.noise = new FractalNoise({
      outputWidth: pass.outputWidth,
      outputHeight: pass.outputHeight,
      cellPx: Math.max(4, numberParam(params, 'scale')),
      octaves: numberParam(params, 'detail'),
      seed: seedParamValue(params, 'seed', nodeId),
    });
    this.contrast = numberParam(params, 'contrast');
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const contrast = this.contrast;
    const step = 1 / ctx.scale;
    const startX = outputX(ctx, 0) + 0.5 * step;
    const row = new Float32Array(ctx.tile.width);
    for (let j = 0; j < ctx.tile.height; j++) {
      this.noise.sampleRow(row, outputY(ctx, j) + 0.5 * step, startX, step);
      const base = j * ctx.tile.width;
      for (let i = 0; i < ctx.tile.width; i++) {
        buffer.data[base + i] = ((row[i] - 0.5) * contrast + 0.5) * 255;
      }
    }
    return buffer;
  }
}

registerNode({
  type: 'fractal-noise',
  version: 2,
  label: 'Fractal Noise',
  summary: 'Mottling for paper and irregular patches for distress. Tileable at any size.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  params: [
    { kind: 'number', key: 'scale', label: 'Scale', min: 8, max: 4000, step: 1, unit: 'px', default: 320 },
    { kind: 'number', key: 'detail', label: 'Detail', min: 1, max: 8, step: 1, unit: 'octaves', default: 4 },
    { kind: 'number', key: 'contrast', label: 'Contrast', min: 0, max: 4, step: 0.05, default: 1 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new FractalNoiseNode(params, nodeId, pass),
});
