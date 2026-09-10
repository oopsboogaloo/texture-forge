import { parseColour } from '../colour.ts';
import { booleanParam, registerNode, stringParam, type NodeInstance, type ParamMap } from '../registry.ts';
import { createColourBuffer, type PixelBuffer, type RenderContext } from '../types.ts';

/** Terminal node: composites the graph over the chosen background. */
class OutputNode implements NodeInstance {
  private readonly params: ParamMap;

  constructor(params: ParamMap) {
    this.params = params;
  }

  render(ctx: RenderContext, inputs: (PixelBuffer | null)[]): PixelBuffer {
    const source = inputs[0];
    if (!source || source.kind !== 'colour') throw new Error('output input must be a colour');
    if (!booleanParam(this.params, 'backgroundEnabled')) return source;

    const background = parseColour(stringParam(this.params, 'backgroundColour'));
    const out = createColourBuffer(ctx.tile.width, ctx.tile.height);
    const ba = background.a / 255;
    for (let i = 0; i < out.data.length; i += 4) {
      const sa = source.data[i + 3] / 255;
      const outAlpha = sa + ba * (1 - sa);
      if (outAlpha <= 0) continue;
      out.data[i] = (source.data[i] * sa + background.r * ba * (1 - sa)) / outAlpha;
      out.data[i + 1] = (source.data[i + 1] * sa + background.g * ba * (1 - sa)) / outAlpha;
      out.data[i + 2] = (source.data[i + 2] * sa + background.b * ba * (1 - sa)) / outAlpha;
      out.data[i + 3] = outAlpha * 255;
    }
    return out;
  }
}

registerNode({
  type: 'output',
  version: 1,
  label: 'Output',
  summary: 'Chooses the background and terminates the graph.',
  category: 'output',
  output: 'colour',
  inputs: [{ name: 'input', type: 'colour', label: 'Input' }],
  seamless: true,
  params: [
    { kind: 'boolean', key: 'backgroundEnabled', label: 'Solid background', default: false },
    { kind: 'colour', key: 'backgroundColour', label: 'Background colour', default: '#ffffff' },
  ],
  create: (params) => new OutputNode(params),
});
