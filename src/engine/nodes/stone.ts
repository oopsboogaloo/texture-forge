import { SiteLattice } from '../field.ts';
import { hash01 } from '../random.ts';
import { numberParam, registerNode, seedParamValue, type NodeInstance, type ParamMap, type PassInfo } from '../registry.ts';
import { createMaskBuffer, outputX, outputY, type PixelBuffer, type RenderContext } from '../types.ts';

/**
 * Packed stones with gaps between them.
 *
 * Cells fills the plane completely, because every point belongs to some site.
 * Gravel gives each site a radius short of its cell, so the stones sit apart
 * with ground showing between — and shades each one separately, which is what
 * makes it read as loose material rather than as a cracked surface.
 */
class GravelNode implements NodeInstance {
  private readonly lattice: SiteLattice;
  private readonly params: ParamMap;
  private readonly seed: number;
  private readonly spacing: number;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    this.params = params;
    this.seed = seedParamValue(params, 'seed', nodeId);
    this.spacing = Math.max(6, numberParam(params, 'stoneSize'));
    this.lattice = new SiteLattice(
      pass.outputWidth,
      pass.outputHeight,
      this.spacing,
      numberParam(params, 'scatter') * 0.5,
      this.seed,
    );
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const sizeVariation = numberParam(this.params, 'sizeVariation');
    const roundness = numberParam(this.params, 'roundness');
    const shadeVariation = numberParam(this.params, 'shadeVariation');
    const packing = numberParam(this.params, 'packing');

    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 / ctx.scale;
      for (let i = 0; i < ctx.tile.width; i++) {
        const x = outputX(ctx, i) + 0.5 / ctx.scale;
        const { first, cell } = this.lattice.nearest(x, y, ctx.outputWidth, ctx.outputHeight);

        // Each stone's own size and shade, from its cell identity, so they stay
        // put as the texture is re-rendered at any scale.
        const sizeRoll = hash01(cell & 0xffff, cell >>> 16, this.seed + 31);
        const shadeRoll = hash01(cell & 0xffff, cell >>> 16, this.seed + 977);
        const radius = this.spacing * 0.5 * packing * (1 - sizeVariation * sizeRoll);
        if (first >= radius) continue;

        const across = first / radius;
        // A dome towards the middle of each stone, so it reads as rounded rather
        // than as a flat disc.
        const dome = Math.sqrt(Math.max(0, 1 - across * across));
        const shade = 1 - shadeVariation * shadeRoll;
        const lit = 1 - roundness + roundness * dome;
        const edge = Math.min(1, (1 - across) * radius * ctx.scale + 0.5);
        buffer.data[j * ctx.tile.width + i] = shade * lit * Math.max(0, edge) * 255;
      }
    }
    return buffer;
  }
}

registerNode({
  type: 'gravel',
  version: 1,
  label: 'Gravel',
  summary: 'Packed stones with ground showing between them, each shaded separately.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  seamlessPeriod: () => ({ x: null, y: null }),
  params: [
    { kind: 'number', key: 'stoneSize', label: 'Stone size', min: 6, max: 800, step: 1, unit: 'px', default: 70 },
    { kind: 'number', key: 'packing', label: 'Packing', min: 0.3, max: 1.6, step: 0.01, default: 1.25 },
    { kind: 'number', key: 'sizeVariation', label: 'Size variation', min: 0, max: 0.9, step: 0.01, default: 0.3 },
    { kind: 'number', key: 'roundness', label: 'Roundness', min: 0, max: 1, step: 0.01, default: 0.7 },
    { kind: 'number', key: 'shadeVariation', label: 'Shade variation', min: 0, max: 1, step: 0.01, default: 0.55 },
    { kind: 'number', key: 'scatter', label: 'Scatter', min: 0, max: 1, step: 0.01, default: 0.55 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new GravelNode(params, nodeId, pass),
});
