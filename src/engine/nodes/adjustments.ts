import { mixColour, parseColour, type Rgba } from '../colour.ts';
import {
  booleanParam,
  numberParam,
  rampParam,
  registerNode,
  stringParam,
  type NodeInstance,
  type ParamMap,
} from '../registry.ts';
import {
  createColourBuffer,
  createMaskBuffer,
  type ColourBuffer,
  type MaskBuffer,
  type PixelBuffer,
  type RenderContext,
} from '../types.ts';

function expectMask(buffer: PixelBuffer | null, port: string): MaskBuffer {
  if (!buffer || buffer.kind !== 'mask') throw new Error(`input ${port} must be a mask`);
  return buffer;
}

function expectColour(buffer: PixelBuffer | null, port: string): ColourBuffer {
  if (!buffer || buffer.kind !== 'colour') throw new Error(`input ${port} must be a colour`);
  return buffer;
}

/** Levels carries the invert toggle rather than there being a separate node for it. */
class LevelsNode implements NodeInstance {
  private readonly params: ParamMap;

  constructor(params: ParamMap) {
    this.params = params;
  }

  render(ctx: RenderContext, inputs: (PixelBuffer | null)[]): PixelBuffer {
    const source = expectMask(inputs[0], 'input');
    const black = numberParam(this.params, 'blackPoint');
    const white = numberParam(this.params, 'whitePoint');
    const gamma = Math.max(0.01, numberParam(this.params, 'gamma'));
    const invert = booleanParam(this.params, 'invert');
    const span = white - black;

    const out = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    for (let i = 0; i < out.data.length; i++) {
      let v = source.data[i] / 255;
      v = span === 0 ? (v >= white ? 1 : 0) : (v - black) / span;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      if (gamma !== 1) v = v ** (1 / gamma);
      out.data[i] = (invert ? 1 - v : v) * 255;
    }
    return out;
  }
}

/** Maps greyscale values to colours, and is how a mask becomes something visible. */
class ColourRampNode implements NodeInstance {
  private readonly lookup: Rgba[];

  constructor(params: ParamMap) {
    const stops = rampParam(params, 'stops');
    const parsed = stops.map((stop) => {
      const colour = parseColour(stop.colour);
      return { position: stop.position, colour: { ...colour, a: colour.a * stop.alpha } };
    });
    this.lookup = new Array(256);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let lower = parsed[0];
      let upper = parsed[parsed.length - 1];
      for (let s = 0; s < parsed.length - 1; s++) {
        if (t >= parsed[s].position && t <= parsed[s + 1].position) {
          lower = parsed[s];
          upper = parsed[s + 1];
          break;
        }
      }
      const range = upper.position - lower.position;
      const local = range <= 0 ? 0 : (t - lower.position) / range;
      this.lookup[i] = mixColour(lower.colour, upper.colour, Math.max(0, Math.min(1, local)));
    }
  }

  render(ctx: RenderContext, inputs: (PixelBuffer | null)[]): PixelBuffer {
    const source = expectMask(inputs[0], 'input');
    const out = createColourBuffer(ctx.tile.width, ctx.tile.height);
    for (let i = 0; i < source.data.length; i++) {
      const colour = this.lookup[source.data[i]];
      const index = i * 4;
      out.data[index] = colour.r;
      out.data[index + 1] = colour.g;
      out.data[index + 2] = colour.b;
      out.data[index + 3] = colour.a;
    }
    return out;
  }
}

type BlendFn = (base: number, layer: number) => number;

const BLEND_MODES: Record<string, BlendFn> = {
  normal: (_base, layer) => layer,
  multiply: (base, layer) => (base * layer) / 255,
  screen: (base, layer) => 255 - ((255 - base) * (255 - layer)) / 255,
};

class BlendNode implements NodeInstance {
  private readonly params: ParamMap;

  constructor(params: ParamMap) {
    this.params = params;
  }

  render(ctx: RenderContext, inputs: (PixelBuffer | null)[]): PixelBuffer {
    const base = expectColour(inputs[0], 'base');
    const layer = expectColour(inputs[1], 'layer');
    const mode = BLEND_MODES[stringParam(this.params, 'mode')];
    if (!mode) throw new Error(`unknown blend mode: ${stringParam(this.params, 'mode')}`);
    const opacity = numberParam(this.params, 'opacity');

    const out = createColourBuffer(ctx.tile.width, ctx.tile.height);
    for (let i = 0; i < out.data.length; i += 4) {
      const ba = base.data[i + 3] / 255;
      const la = (layer.data[i + 3] / 255) * opacity;
      const outAlpha = la + ba * (1 - la);
      if (outAlpha <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const source = layer.data[i + c];
        const backdrop = base.data[i + c];
        // The compositing formula proper: the source shows through unblended
        // wherever the backdrop is transparent, is blended where they overlap,
        // and the backdrop shows through where the source is not. Weighting the
        // blended colour by the full source alpha instead would drop the first
        // term, so multiplying a translucent layer over a translucent base lost
        // the source colour entirely.
        const mixed =
          la * (1 - ba) * source + la * ba * mode(backdrop, source) + (1 - la) * ba * backdrop;
        out.data[i + c] = mixed / outAlpha;
      }
      out.data[i + 3] = outAlpha * 255;
    }
    return out;
  }
}

/** Uses greyscale values to control transparency. */
class MaskNode implements NodeInstance {
  render(ctx: RenderContext, inputs: (PixelBuffer | null)[]): PixelBuffer {
    const source = expectColour(inputs[0], 'source');
    const mask = expectMask(inputs[1], 'mask');
    const out = createColourBuffer(ctx.tile.width, ctx.tile.height);
    out.data.set(source.data);
    for (let i = 0; i < mask.data.length; i++) {
      out.data[i * 4 + 3] = (source.data[i * 4 + 3] * mask.data[i]) / 255;
    }
    return out;
  }
}

registerNode({
  type: 'levels',
  version: 1,
  label: 'Levels',
  summary: 'Adjusts tonal range and contrast, and can invert.',
  category: 'adjustment',
  output: 'mask',
  inputs: [{ name: 'input', type: 'mask', label: 'Input' }],
  seamless: true,
  params: [
    { kind: 'number', key: 'blackPoint', label: 'Black point', min: 0, max: 1, step: 0.01, default: 0 },
    { kind: 'number', key: 'whitePoint', label: 'White point', min: 0, max: 1, step: 0.01, default: 1 },
    { kind: 'number', key: 'gamma', label: 'Gamma', min: 0.1, max: 4, step: 0.05, default: 1 },
    { kind: 'boolean', key: 'invert', label: 'Invert', default: false },
  ],
  create: (params) => new LevelsNode(params),
});

registerNode({
  type: 'colour-ramp',
  version: 1,
  label: 'Colour Ramp',
  summary: 'Maps greyscale values to colours.',
  category: 'adjustment',
  output: 'colour',
  inputs: [{ name: 'input', type: 'mask', label: 'Input' }],
  seamless: true,
  params: [
    {
      kind: 'ramp',
      key: 'stops',
      label: 'Stops',
      default: [
        { position: 0, colour: '#000000', alpha: 1 },
        { position: 1, colour: '#ffffff', alpha: 1 },
      ],
    },
  ],
  create: (params) => new ColourRampNode(params),
});

registerNode({
  type: 'blend',
  version: 1,
  label: 'Blend',
  summary: 'Composites one colour layer over another.',
  category: 'adjustment',
  output: 'colour',
  inputs: [
    { name: 'base', type: 'colour', label: 'Base' },
    { name: 'layer', type: 'colour', label: 'Layer' },
  ],
  seamless: true,
  params: [
    {
      kind: 'select',
      key: 'mode',
      label: 'Mode',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'multiply', label: 'Multiply' },
        { value: 'screen', label: 'Screen' },
      ],
      default: 'normal',
    },
    { kind: 'number', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, default: 1 },
  ],
  create: (params) => new BlendNode(params),
});

registerNode({
  type: 'mask',
  version: 1,
  label: 'Mask',
  summary: 'Uses greyscale values to control transparency.',
  category: 'adjustment',
  output: 'colour',
  inputs: [
    { name: 'source', type: 'colour', label: 'Source' },
    { name: 'mask', type: 'mask', label: 'Mask' },
  ],
  seamless: true,
  params: [],
  create: () => new MaskNode(),
});
