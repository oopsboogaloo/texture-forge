import { parseColour } from '../colour.ts';
import { stripeCoverage } from '../raster.ts';
import {
  booleanParam,
  numberParam,
  registerNode,
  stringParam,
  type NodeInstance,
  type ParamMap,
} from '../registry.ts';
import { createColourBuffer, outputX, outputY, type PixelBuffer, type RenderContext } from '../types.ts';

/**
 * Grid is the one generator that emits colour rather than a mask: the spec gives
 * it line, heavy-line and background colours of its own, and splitting those
 * across three ramps would make the commonest texture the fiddliest to set up.
 *
 * Lines are laid down by exact stripe coverage rather than by drawing, so they
 * survive any preview downscale and fractional widths behave at export scale.
 */
class GridNode implements NodeInstance {
  private readonly params: ParamMap;

  constructor(params: ParamMap) {
    this.params = params;
  }

  render(ctx: RenderContext): PixelBuffer {
    const p = this.params;
    const buffer = createColourBuffer(ctx.tile.width, ctx.tile.height);
    const cellWidth = Math.max(1, numberParam(p, 'cellWidth'));
    const cellHeight = Math.max(1, numberParam(p, 'cellHeight'));
    const thickness = Math.max(0, numberParam(p, 'lineThickness'));
    const offsetX = numberParam(p, 'offsetX');
    const offsetY = numberParam(p, 'offsetY');
    const line = parseColour(stringParam(p, 'lineColour'));
    const lineOpacity = numberParam(p, 'lineOpacity');

    const major = booleanParam(p, 'majorEnabled');
    const majorEveryX = Math.max(2, Math.round(numberParam(p, 'majorEveryX')));
    const majorEveryY = Math.max(2, Math.round(numberParam(p, 'majorEveryY')));
    const majorThickness = Math.max(0, numberParam(p, 'majorThickness'));
    const majorColour = parseColour(stringParam(p, 'majorColour'));
    const majorOpacity = numberParam(p, 'majorOpacity');

    const solidBackground = booleanParam(p, 'backgroundEnabled');
    const background = parseColour(stringParam(p, 'backgroundColour'));

    // Column coverage depends only on x, so it is computed once for the tile.
    const minorX = new Float32Array(ctx.tile.width);
    const majorX = new Float32Array(ctx.tile.width);
    for (let i = 0; i < ctx.tile.width; i++) {
      const a = outputX(ctx, i);
      const b = outputX(ctx, i + 1);
      minorX[i] = stripeCoverage(a, b, cellWidth, thickness, offsetX);
      majorX[i] = major ? stripeCoverage(a, b, cellWidth * majorEveryX, majorThickness, offsetX) : 0;
    }

    const data = buffer.data;
    for (let j = 0; j < ctx.tile.height; j++) {
      const a = outputY(ctx, j);
      const b = outputY(ctx, j + 1);
      const minorY = stripeCoverage(a, b, cellHeight, thickness, offsetY);
      const majorY = major ? stripeCoverage(a, b, cellHeight * majorEveryY, majorThickness, offsetY) : 0;

      for (let i = 0; i < ctx.tile.width; i++) {
        let r = 0;
        let g = 0;
        let bl = 0;
        let alpha = 0;
        if (solidBackground) {
          r = background.r;
          g = background.g;
          bl = background.b;
          alpha = (background.a / 255);
        }

        // Union of the two axes: a crossing is one line, not two stacked.
        const minorCoverage = minorX[i] + minorY - minorX[i] * minorY;
        const majorCoverage = majorX[i] + majorY - majorX[i] * majorY;

        for (const stroke of [
          { coverage: minorCoverage, colour: line, opacity: lineOpacity },
          { coverage: majorCoverage, colour: majorColour, opacity: majorOpacity },
        ]) {
          const sa = stroke.coverage * stroke.opacity * (stroke.colour.a / 255);
          if (sa <= 0) continue;
          const out = sa + alpha * (1 - sa);
          if (out <= 0) continue;
          r = (stroke.colour.r * sa + r * alpha * (1 - sa)) / out;
          g = (stroke.colour.g * sa + g * alpha * (1 - sa)) / out;
          bl = (stroke.colour.b * sa + bl * alpha * (1 - sa)) / out;
          alpha = out;
        }

        const index = (j * ctx.tile.width + i) * 4;
        data[index] = r;
        data[index + 1] = g;
        data[index + 2] = bl;
        data[index + 3] = alpha * 255;
      }
    }
    return buffer;
  }
}

registerNode({
  type: 'grid',
  version: 1,
  label: 'Grid',
  summary: 'Square or rectangular cells, with optional heavier lines at a set interval.',
  category: 'generator',
  output: 'colour',
  inputs: [],
  seamless: true,
  seamlessPeriod: (params) => ({
    x: Number(params.cellWidth) * (params.majorEnabled === true ? Number(params.majorEveryX) : 1),
    y: Number(params.cellHeight) * (params.majorEnabled === true ? Number(params.majorEveryY) : 1),
  }),
  params: [
    { kind: 'number', key: 'cellWidth', label: 'Cell width', min: 2, max: 2000, step: 1, unit: 'px', default: 64 },
    { kind: 'number', key: 'cellHeight', label: 'Cell height', min: 2, max: 2000, step: 1, unit: 'px', default: 64 },
    { kind: 'number', key: 'lineThickness', label: 'Line thickness', min: 0, max: 100, step: 0.5, unit: 'px', default: 2 },
    { kind: 'colour', key: 'lineColour', label: 'Line colour', default: '#3c3c3c' },
    { kind: 'number', key: 'lineOpacity', label: 'Line opacity', min: 0, max: 1, step: 0.01, default: 1 },
    { kind: 'number', key: 'offsetX', label: 'Horizontal offset', min: -2000, max: 2000, step: 1, unit: 'px', default: 0 },
    { kind: 'number', key: 'offsetY', label: 'Vertical offset', min: -2000, max: 2000, step: 1, unit: 'px', default: 0 },
    { kind: 'boolean', key: 'majorEnabled', label: 'Heavier lines', default: true },
    { kind: 'number', key: 'majorEveryX', label: 'Heavier every (columns)', min: 2, max: 50, step: 1, default: 10 },
    { kind: 'number', key: 'majorEveryY', label: 'Heavier every (rows)', min: 2, max: 50, step: 1, default: 10 },
    { kind: 'number', key: 'majorThickness', label: 'Heavier thickness', min: 0, max: 200, step: 0.5, unit: 'px', default: 4 },
    { kind: 'colour', key: 'majorColour', label: 'Heavier colour', default: '#1e1e1e' },
    { kind: 'number', key: 'majorOpacity', label: 'Heavier opacity', min: 0, max: 1, step: 0.01, default: 1 },
    { kind: 'boolean', key: 'backgroundEnabled', label: 'Solid background', default: false },
    { kind: 'colour', key: 'backgroundColour', label: 'Background colour', default: '#ffffff' },
  ],
  create: (params) => new GridNode(params),
});
