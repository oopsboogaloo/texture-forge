import { edgeCoverage, SiteLattice, stripeDistance } from '../field.ts';
import { drawEllipse } from '../raster.ts';
import { wrapOffsets } from './scatter.ts';
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
import { createRandom } from '../random.ts';

/**
 * Hexagonal grid.
 *
 * Drawn as the boundary diagram of a triangular lattice rather than by hex
 * arithmetic: the midpoint between the two nearest centres *is* the edge, which
 * gives clean joins at every vertex and wraps at the image edge for free.
 */
class HexGridNode implements NodeInstance {
  private readonly lattice: SiteLattice;
  private readonly thickness: number;

  constructor(params: ParamMap, _nodeId: string, pass: PassInfo) {
    this.lattice = new SiteLattice(pass.outputWidth, pass.outputHeight, numberParam(params, 'cellWidth'), 0, 1, true);
    this.thickness = numberParam(params, 'lineThickness');
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const half = this.thickness / 2;
    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 / ctx.scale;
      for (let i = 0; i < ctx.tile.width; i++) {
        const x = outputX(ctx, i) + 0.5 / ctx.scale;
        const { first, second } = this.lattice.nearest(x, y, ctx.outputWidth, ctx.outputHeight);
        // Half the gap between the two nearest centres is the distance to the
        // edge that separates them.
        buffer.data[j * ctx.tile.width + i] = edgeCoverage((second - first) / 2, half, ctx.scale) * 255;
      }
    }
    return buffer;
  }
}

/** Line families at fixed angles: the scaffolding of an isometric drawing. */
class IsometricGridNode implements NodeInstance {
  private readonly spacing: number;
  private readonly thickness: number;
  private readonly angles: number[];

  constructor(params: ParamMap) {
    this.spacing = Math.max(2, numberParam(params, 'spacing'));
    this.thickness = numberParam(params, 'lineThickness');
    const uprights = booleanParam(params, 'uprights');
    this.angles = uprights ? [30, -30, 90] : [30, -30];
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const half = this.thickness / 2;
    const families = this.angles.map((degrees) => {
      const radians = (degrees * Math.PI) / 180;
      return { cos: Math.cos(radians), sin: Math.sin(radians) };
    });

    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 / ctx.scale;
      for (let i = 0; i < ctx.tile.width; i++) {
        const x = outputX(ctx, i) + 0.5 / ctx.scale;
        let coverage = 0;
        for (const family of families) {
          const distance = stripeDistance(x, y, family.cos, family.sin, this.spacing, 0);
          const line = edgeCoverage(distance, half, ctx.scale);
          // Union, so crossings read as one line rather than stacking darker.
          coverage = coverage + line - coverage * line;
        }
        buffer.data[j * ctx.tile.width + i] = coverage * 255;
      }
    }
    return buffer;
  }
}

/** Courses of offset rectangles: brick, block, tile, stonework. */
class BrickNode implements NodeInstance {
  private readonly params: ParamMap;

  constructor(params: ParamMap) {
    this.params = params;
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const width = Math.max(4, numberParam(this.params, 'brickWidth'));
    const height = Math.max(4, numberParam(this.params, 'brickHeight'));
    const offset = numberParam(this.params, 'courseOffset');
    const half = numberParam(this.params, 'mortarThickness') / 2;

    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 / ctx.scale;
      const course = Math.floor(y / height);
      const withinY = y - course * height;
      const horizontal = edgeCoverage(Math.min(withinY, height - withinY), half, ctx.scale);
      // Alternate courses step sideways, which is what makes it read as bonded
      // brickwork rather than a plain grid.
      const shift = (((course % 2) + 2) % 2) * offset * width;

      for (let i = 0; i < ctx.tile.width; i++) {
        const x = outputX(ctx, i) + 0.5 / ctx.scale - shift;
        const withinX = x - Math.floor(x / width) * width;
        const vertical = edgeCoverage(Math.min(withinX, width - withinX), half, ctx.scale);
        const coverage = horizontal + vertical - horizontal * vertical;
        buffer.data[j * ctx.tile.width + i] = coverage * 255;
      }
    }
    return buffer;
  }
}

/** Evenly spaced parallel lines at any angle, optionally crossed. */
class StripesNode implements NodeInstance {
  private readonly params: ParamMap;

  constructor(params: ParamMap) {
    this.params = params;
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const spacing = Math.max(2, numberParam(this.params, 'spacing'));
    const half = numberParam(this.params, 'thickness') / 2;
    const radians = (numberParam(this.params, 'angle') * Math.PI) / 180;
    const cross = booleanParam(this.params, 'crossHatch');
    const families = [{ cos: Math.cos(radians), sin: Math.sin(radians) }];
    if (cross) families.push({ cos: Math.cos(radians + Math.PI / 2), sin: Math.sin(radians + Math.PI / 2) });

    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 / ctx.scale;
      for (let i = 0; i < ctx.tile.width; i++) {
        const x = outputX(ctx, i) + 0.5 / ctx.scale;
        let coverage = 0;
        for (const family of families) {
          const line = edgeCoverage(stripeDistance(x, y, family.cos, family.sin, spacing, 0), half, ctx.scale);
          coverage = coverage + line - coverage * line;
        }
        buffer.data[j * ctx.tile.width + i] = coverage * 255;
      }
    }
    return buffer;
  }
}

/** A regular lattice of dots — dotted grid paper, stipple, punched card. */
class DotsNode implements NodeInstance {
  private readonly params: ParamMap;
  private readonly seed: number;

  constructor(params: ParamMap, nodeId: string) {
    this.params = params;
    this.seed = seedParamValue(params, 'seed', nodeId);
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const spacingX = Math.max(2, numberParam(this.params, 'spacingX'));
    const spacingY = Math.max(2, numberParam(this.params, 'spacingY'));
    const radius = numberParam(this.params, 'radius');
    const variation = numberParam(this.params, 'sizeVariation');
    const scatter = numberParam(this.params, 'scatter');
    const random = createRandom(this.seed);

    // Columns and rows are whole numbers so the lattice meets itself when it
    // wraps; the requested spacing is honoured to within a fraction of a pixel.
    const columns = Math.max(1, Math.round(ctx.outputWidth / spacingX));
    const rows = Math.max(1, Math.round(ctx.outputHeight / spacingY));
    const stepX = ctx.outputWidth / columns;
    const stepY = ctx.outputHeight / rows;

    const top = ctx.tile.y / ctx.scale;
    const bottom = (ctx.tile.y + ctx.tile.height) / ctx.scale;
    const reach = radius * (1 + variation) + scatter * Math.max(stepX, stepY) + 1;

    for (let row = 0; row < rows; row++) {
      const cy = (row + 0.5) * stepY;
      const wrapReach = ctx.seamless ? ctx.outputHeight : 0;
      if (cy + reach + wrapReach < top || cy - reach - wrapReach > bottom) {
        // Still advance the stream so the pattern does not depend on the tile.
        for (let column = 0; column < columns; column++) {
          random.next();
          random.next();
          random.next();
        }
        continue;
      }
      for (let column = 0; column < columns; column++) {
        const jitterX = (random.next() - 0.5) * 2 * scatter * stepX;
        const jitterY = (random.next() - 0.5) * 2 * scatter * stepY;
        const size = radius * (1 + (random.next() - 0.5) * 2 * variation);
        const x = (column + 0.5) * stepX + jitterX;
        const y = cy + jitterY;
        const dotRadius = Math.max(0.1, size);
        // Size variation and scatter can push a dot over an edge; without the
        // opposite-edge copy the first and last rows come from different dots
        // and the texture does not meet itself.
        const offsets = wrapOffsets(
          ctx.seamless,
          x - dotRadius,
          x + dotRadius,
          y - dotRadius,
          y + dotRadius,
          ctx.outputWidth,
          ctx.outputHeight,
        );
        for (const offset of offsets) {
          drawEllipse(
            buffer,
            (x + offset.dx) * ctx.scale - ctx.tile.x,
            (y + offset.dy) * ctx.scale - ctx.tile.y,
            dotRadius * ctx.scale,
            dotRadius * ctx.scale,
            0,
            1,
          );
        }
      }
    }
    return buffer;
  }
}

registerNode({
  type: 'hex-grid',
  version: 1,
  label: 'Hex Grid',
  summary: 'Hexagonal cells, drawn as the boundaries of a triangular lattice.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  seamlessPeriod: (params) => ({ x: Number(params.cellWidth), y: null }),
  params: [
    { kind: 'number', key: 'cellWidth', label: 'Cell width', min: 8, max: 1000, step: 1, unit: 'px', default: 96 },
    { kind: 'number', key: 'lineThickness', label: 'Line thickness', min: 0.5, max: 60, step: 0.5, unit: 'px', default: 3 },
  ],
  create: (params, nodeId, pass) => new HexGridNode(params, nodeId, pass),
});

registerNode({
  type: 'isometric-grid',
  version: 1,
  label: 'Isometric Grid',
  summary: 'Thirty-degree line families, with optional uprights.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: false,
  params: [
    { kind: 'number', key: 'spacing', label: 'Spacing', min: 4, max: 800, step: 1, unit: 'px', default: 72 },
    { kind: 'number', key: 'lineThickness', label: 'Line thickness', min: 0.5, max: 60, step: 0.5, unit: 'px', default: 2 },
    { kind: 'boolean', key: 'uprights', label: 'Vertical lines', default: true },
  ],
  create: (params) => new IsometricGridNode(params),
});

registerNode({
  type: 'brick',
  version: 1,
  label: 'Brick',
  summary: 'Courses of offset rectangles: brick, block or tile.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  seamlessPeriod: (params) => ({ x: Number(params.brickWidth), y: Number(params.brickHeight) * 2 }),
  params: [
    { kind: 'number', key: 'brickWidth', label: 'Brick width', min: 8, max: 2000, step: 1, unit: 'px', default: 240 },
    { kind: 'number', key: 'brickHeight', label: 'Brick height', min: 8, max: 2000, step: 1, unit: 'px', default: 80 },
    { kind: 'number', key: 'courseOffset', label: 'Course offset', min: 0, max: 1, step: 0.01, default: 0.5 },
    { kind: 'number', key: 'mortarThickness', label: 'Mortar thickness', min: 0.5, max: 80, step: 0.5, unit: 'px', default: 6 },
  ],
  create: (params) => new BrickNode(params),
});

registerNode({
  type: 'stripes',
  version: 1,
  label: 'Stripes',
  summary: 'Parallel lines at any angle, optionally crossed into hatching.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: false,
  params: [
    { kind: 'number', key: 'spacing', label: 'Spacing', min: 2, max: 800, step: 1, unit: 'px', default: 40 },
    { kind: 'number', key: 'thickness', label: 'Thickness', min: 0.2, max: 400, step: 0.2, unit: 'px', default: 8 },
    { kind: 'angle', key: 'angle', label: 'Angle', default: 45 },
    { kind: 'boolean', key: 'crossHatch', label: 'Cross hatch', default: false },
  ],
  create: (params) => new StripesNode(params),
});

registerNode({
  type: 'dots',
  version: 1,
  label: 'Dots',
  summary: 'A regular lattice of dots, with optional size variation and scatter.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  seamlessPeriod: () => ({ x: null, y: null }),
  params: [
    { kind: 'number', key: 'spacingX', label: 'Spacing across', min: 4, max: 800, step: 1, unit: 'px', default: 64 },
    { kind: 'number', key: 'spacingY', label: 'Spacing down', min: 4, max: 800, step: 1, unit: 'px', default: 64 },
    { kind: 'number', key: 'radius', label: 'Dot radius', min: 0.5, max: 200, step: 0.5, unit: 'px', default: 6 },
    { kind: 'number', key: 'sizeVariation', label: 'Size variation', min: 0, max: 1, step: 0.01, default: 0 },
    { kind: 'number', key: 'scatter', label: 'Scatter', min: 0, max: 0.5, step: 0.01, default: 0 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId) => new DotsNode(params, nodeId),
});
