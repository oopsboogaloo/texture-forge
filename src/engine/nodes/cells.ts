import { edgeCoverage, SiteLattice } from '../field.ts';
import {
  numberParam,
  registerNode,
  seedParamValue,
  stringParam,
  type NodeInstance,
  type ParamMap,
  type PassInfo,
} from '../registry.ts';
import { createMaskBuffer, outputX, outputY, type PixelBuffer, type RenderContext } from '../types.ts';

/**
 * Cellular pattern from a jittered lattice of sites.
 *
 * Three readings of the same construction, and none of them can be built by
 * layering the other generators: `edges` gives cracked mud, crazed glaze and
 * stone joints; `cells` gives flat plates or scales; `distance` gives a soft
 * bubbled field useful as a mask.
 */
class CellsNode implements NodeInstance {
  private readonly lattice: SiteLattice;
  private readonly mode: string;
  private readonly thickness: number;
  private readonly spacing: number;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    this.spacing = Math.max(4, numberParam(params, 'cellSize'));
    this.lattice = new SiteLattice(
      pass.outputWidth,
      pass.outputHeight,
      this.spacing,
      numberParam(params, 'irregularity') * 0.5,
      seedParamValue(params, 'seed', nodeId),
    );
    this.mode = stringParam(params, 'mode');
    this.thickness = numberParam(params, 'lineThickness');
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const half = this.thickness / 2;

    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 / ctx.scale;
      for (let i = 0; i < ctx.tile.width; i++) {
        const x = outputX(ctx, i) + 0.5 / ctx.scale;
        const { first, second, cell } = this.lattice.nearest(x, y, ctx.outputWidth, ctx.outputHeight);

        let value: number;
        if (this.mode === 'cells') {
          value = (cell % 1024) / 1023;
        } else if (this.mode === 'distance') {
          value = Math.min(1, first / this.spacing);
        } else {
          value = edgeCoverage((second - first) / 2, half, ctx.scale);
        }
        buffer.data[j * ctx.tile.width + i] = value * 255;
      }
    }
    return buffer;
  }
}

registerNode({
  type: 'cells',
  version: 1,
  label: 'Cells',
  summary: 'Cracked stone, scales and crazing, from a wrapping lattice of sites.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  seamlessPeriod: () => ({ x: null, y: null }),
  params: [
    { kind: 'number', key: 'cellSize', label: 'Cell size', min: 8, max: 1200, step: 1, unit: 'px', default: 160 },
    {
      kind: 'select',
      key: 'mode',
      label: 'Reading',
      options: [
        { value: 'edges', label: 'Edges' },
        { value: 'cells', label: 'Flat cells' },
        { value: 'distance', label: 'Distance' },
      ],
      default: 'edges',
    },
    { kind: 'number', key: 'irregularity', label: 'Irregularity', min: 0, max: 1, step: 0.01, default: 0.8 },
    { kind: 'number', key: 'lineThickness', label: 'Edge thickness', min: 0.5, max: 80, step: 0.5, unit: 'px', default: 4 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new CellsNode(params, nodeId, pass),
});
