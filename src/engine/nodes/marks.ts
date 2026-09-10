import { createRandom } from '../random.ts';
import { drawEllipse, drawLine } from '../raster.ts';
import { numberParam, registerNode, seedParamValue, type NodeInstance, type ParamMap, type PassInfo } from '../registry.ts';
import { createMaskBuffer, type PixelBuffer, type RenderContext } from '../types.ts';
import { ScatterIndex, forEachPlacement, scatterCount, wrapOffsets, type PlacedItem } from './scatter.ts';

interface Scratch extends PlacedItem {
  points: { x: number; y: number }[];
  thickness: number;
  intensity: number;
}

/**
 * Long, curving marks: scratches, hairline cracks, wear.
 *
 * Distinct from Paper Fibres, which are short and straight. A scratch wanders —
 * its direction turns a little at each step — so it reads as something dragged
 * across the surface rather than something lying on it.
 */
class ScratchesNode implements NodeInstance {
  private readonly index: ScatterIndex<Scratch>;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    const random = createRandom(seedParamValue(params, 'seed', nodeId));
    const count = scatterCount(numberParam(params, 'density'), pass.outputWidth, pass.outputHeight);
    const length = numberParam(params, 'length');
    const thickness = numberParam(params, 'thickness');
    const direction = (numberParam(params, 'direction') * Math.PI) / 180;
    const spread = (numberParam(params, 'spread') * Math.PI) / 180;
    const curvature = numberParam(params, 'curvature');
    const segments = 10;

    const scratches: Scratch[] = [];
    for (let n = 0; n < count; n++) {
      let x = random.range(0, pass.outputWidth);
      let y = random.range(0, pass.outputHeight);
      let angle = direction + random.range(-spread, spread);
      const total = length * random.range(0.4, 1.6);
      const stepLength = total / segments;

      const points = [{ x, y }];
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      for (let s = 0; s < segments; s++) {
        angle += random.range(-curvature, curvature);
        x += Math.cos(angle) * stepLength;
        y += Math.sin(angle) * stepLength;
        points.push({ x, y });
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }

      const pad = Math.max(thickness, 1) / 2 + 1;
      scratches.push({
        points,
        thickness,
        intensity: random.range(0.3, 1),
        minY: minY - pad,
        maxY: maxY + pad,
        wraps: wrapOffsets(pass.seamless, minX - pad, maxX + pad, minY - pad, maxY + pad, pass.outputWidth, pass.outputHeight),
      });
    }
    this.index = new ScatterIndex(scratches);
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const scale = ctx.scale;
    forEachPlacement(this.index, ctx, (scratch, dx, dy) => {
      for (let s = 0; s < scratch.points.length - 1; s++) {
        const a = scratch.points[s];
        const b = scratch.points[s + 1];
        drawLine(
          buffer,
          (a.x + dx) * scale - ctx.tile.x,
          (a.y + dy) * scale - ctx.tile.y,
          (b.x + dx) * scale - ctx.tile.x,
          (b.y + dy) * scale - ctx.tile.y,
          scratch.thickness * scale,
          scratch.intensity,
        );
      }
    });
    return buffer;
  }
}

interface Splat extends PlacedItem {
  blobs: { x: number; y: number; rx: number; ry: number; rotation: number }[];
  intensity: number;
}

/**
 * Ink or paint thrown at the surface: a body with satellites around it.
 *
 * Distinct from Speckles, which scatters independent marks. A splat is a
 * cluster — a large blob with smaller droplets thrown outward from it — so the
 * marks group the way liquid does.
 */
class SplatterNode implements NodeInstance {
  private readonly index: ScatterIndex<Splat>;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    const random = createRandom(seedParamValue(params, 'seed', nodeId));
    const count = scatterCount(numberParam(params, 'density'), pass.outputWidth, pass.outputHeight);
    const size = numberParam(params, 'size');
    const spread = numberParam(params, 'spread');
    const satellites = Math.round(numberParam(params, 'satellites'));

    const splats: Splat[] = [];
    for (let n = 0; n < count; n++) {
      const cx = random.range(0, pass.outputWidth);
      const cy = random.range(0, pass.outputHeight);
      const bodyRadius = size * random.range(0.5, 1.2);
      const blobs = [
        { x: cx, y: cy, rx: bodyRadius, ry: bodyRadius * random.range(0.7, 1.3), rotation: random.range(0, Math.PI) },
      ];

      let minX = cx - bodyRadius;
      let maxX = cx + bodyRadius;
      let minY = cy - bodyRadius;
      let maxY = cy + bodyRadius;

      for (let s = 0; s < satellites; s++) {
        const angle = random.range(0, Math.PI * 2);
        // Satellites thin out with distance, as thrown droplets do.
        const distance = bodyRadius + random.next() ** 2 * spread;
        const radius = bodyRadius * random.range(0.06, 0.35);
        const x = cx + Math.cos(angle) * distance;
        const y = cy + Math.sin(angle) * distance;
        blobs.push({ x, y, rx: radius, ry: radius * random.range(0.6, 1.4), rotation: angle });
        minX = Math.min(minX, x - radius);
        maxX = Math.max(maxX, x + radius);
        minY = Math.min(minY, y - radius);
        maxY = Math.max(maxY, y + radius);
      }

      splats.push({
        blobs,
        intensity: random.range(0.7, 1),
        minY: minY - 1,
        maxY: maxY + 1,
        wraps: wrapOffsets(pass.seamless, minX - 1, maxX + 1, minY - 1, maxY + 1, pass.outputWidth, pass.outputHeight),
      });
    }
    this.index = new ScatterIndex(splats);
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const scale = ctx.scale;
    forEachPlacement(this.index, ctx, (splat, dx, dy) => {
      for (const blob of splat.blobs) {
        drawEllipse(
          buffer,
          (blob.x + dx) * scale - ctx.tile.x,
          (blob.y + dy) * scale - ctx.tile.y,
          blob.rx * scale,
          blob.ry * scale,
          blob.rotation,
          splat.intensity,
        );
      }
    });
    return buffer;
  }
}

registerNode({
  type: 'scratches',
  version: 1,
  label: 'Scratches',
  summary: 'Long curving marks: wear, hairline cracks, drag.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  params: [
    { kind: 'number', key: 'density', label: 'Density', min: 0, max: 2000, step: 1, unit: '/MP', default: 40 },
    { kind: 'number', key: 'length', label: 'Length', min: 10, max: 6000, step: 10, unit: 'px', default: 900 },
    { kind: 'number', key: 'thickness', label: 'Thickness', min: 0.2, max: 30, step: 0.1, unit: 'px', default: 1.6 },
    { kind: 'angle', key: 'direction', label: 'Direction', default: 0 },
    { kind: 'angle', key: 'spread', label: 'Spread', default: 90 },
    { kind: 'number', key: 'curvature', label: 'Curvature', min: 0, max: 1, step: 0.01, default: 0.18 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new ScratchesNode(params, nodeId, pass),
});

registerNode({
  type: 'splatter',
  version: 1,
  label: 'Splatter',
  summary: 'Thrown ink: a body with droplets scattered around it.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  params: [
    { kind: 'number', key: 'density', label: 'Density', min: 0, max: 500, step: 1, unit: '/MP', default: 18 },
    { kind: 'number', key: 'size', label: 'Blob size', min: 2, max: 600, step: 1, unit: 'px', default: 70 },
    { kind: 'number', key: 'spread', label: 'Throw distance', min: 0, max: 3000, step: 10, unit: 'px', default: 500 },
    { kind: 'number', key: 'satellites', label: 'Droplets', min: 0, max: 80, step: 1, default: 26 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new SplatterNode(params, nodeId, pass),
});
