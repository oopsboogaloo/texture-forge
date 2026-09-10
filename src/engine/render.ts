import { encodePng, type ColourType, type EncodeResult } from './png/encoder.ts';
import { getNodeDefinition, type NodeInstance } from './registry.ts';
import { topologicalOrder, type Project } from './project.ts';
import type { ColourBuffer, PixelBuffer, RenderContext, Tile } from './types.ts';

export interface RenderPassOptions {
  /** Destination pixels per output pixel. 1 renders at full size. */
  scale?: number;
}

export interface RenderPass {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  renderTile(tile: Tile): ColourBuffer;
}

/**
 * The pixel dimensions a pass renders at a given scale.
 *
 * Separate from the pass itself so a caller can say how big a preview will be
 * without paying for the node construction that building one costs.
 */
export function scaledDimensions(project: Project, scale: number): { width: number; height: number } {
  if (!(scale > 0)) throw new Error('scale must be greater than zero');
  return {
    width: Math.max(1, Math.round(project.output.width * scale)),
    height: Math.max(1, Math.round(project.output.height * scale)),
  };
}

/**
 * Builds the node instances once, then renders any rectangle of the result.
 *
 * Generators that scatter elements across the whole image do that work in their
 * constructor, so it happens once per pass rather than once per tile — and every
 * tile of a pass sees the same elements, which is what makes a banded export
 * identical to a single-shot render.
 */
export function createRenderPass(project: Project, options: RenderPassOptions = {}): RenderPass {
  const scale = options.scale ?? 1;
  const { width, height } = scaledDimensions(project, scale);
  const order = topologicalOrder(project);
  const pass = {
    outputWidth: project.output.width,
    outputHeight: project.output.height,
    seamless: project.output.seamless,
  };

  const instances = new Map<string, NodeInstance>();
  for (const node of order) {
    instances.set(node.id, getNodeDefinition(node.type).create(node.params, node.id, pass));
  }

  return {
    width,
    height,
    scale,
    renderTile(tile: Tile): ColourBuffer {
      const ctx: RenderContext = {
        outputWidth: project.output.width,
        outputHeight: project.output.height,
        scale,
        tile,
        seamless: project.output.seamless,
      };
      const results = new Map<string, PixelBuffer>();
      for (const node of order) {
        const definition = getNodeDefinition(node.type);
        const inputs = definition.inputs.map((port) => {
          const edge = project.edges.find((candidate) => candidate.to === node.id && candidate.input === port.name);
          return edge ? results.get(edge.from) ?? null : null;
        });
        results.set(node.id, instances.get(node.id)!.render(ctx, inputs));
      }
      const output = results.get(project.outputNode);
      if (!output || output.kind !== 'colour') throw new Error('graph did not produce a colour output');
      return output;
    },
  };
}

/**
 * The single-channel value a pixel takes under a greyscale output format.
 *
 * Shared so the preview cannot show something the export will not produce:
 * `luminance` reads tone, `alpha` reads coverage.
 */
export function greyscaleValue(format: 'luminance' | 'alpha', r: number, g: number, b: number, a: number): number {
  if (format === 'alpha') return a;
  // Rec. 709 luminance of the colour composited over white, so an unpainted
  // area reads as white rather than as black.
  const alpha = a / 255;
  return (
    0.2126 * (r * alpha + 255 * (1 - alpha)) +
    0.7152 * (g * alpha + 255 * (1 - alpha)) +
    0.0722 * (b * alpha + 255 * (1 - alpha))
  );
}

export interface ExportOptions extends RenderPassOptions {
  /** Scanlines rendered and compressed per step. Bounds peak memory. */
  bandRows?: number;
  onProgress?: (rowsDone: number, height: number) => void;
  signal?: AbortSignal;
}

/**
 * Renders straight into the PNG encoder, band by band.
 *
 * Nothing the size of the finished image is ever allocated, which is what makes
 * a 10,000 x 10,000 export possible in a browser tab.
 */
export function renderToPng(project: Project, options: ExportOptions = {}): Promise<EncodeResult> {
  const pass = createRenderPass(project, options);
  const format = project.output.format;
  const colourType: ColourType = format === 'rgba' ? 6 : 0;
  const bandRows = Math.min(options.bandRows ?? 128, pass.height);

  return encodePng({
    width: pass.width,
    height: pass.height,
    colourType,
    bandRows,
    signal: options.signal,
    onProgress: options.onProgress,
    renderBand: (buf, y0, rows, rowStride, pixelOffset) => {
      const tile = pass.renderTile({ x: 0, y: y0, width: pass.width, height: rows });
      for (let j = 0; j < rows; j++) {
        let target = j * rowStride + pixelOffset;
        let source = j * pass.width * 4;
        for (let i = 0; i < pass.width; i++, source += 4) {
          if (format === 'rgba') {
            buf[target++] = tile.data[source];
            buf[target++] = tile.data[source + 1];
            buf[target++] = tile.data[source + 2];
            buf[target++] = tile.data[source + 3];
          } else {
            buf[target++] = greyscaleValue(
              format,
              tile.data[source],
              tile.data[source + 1],
              tile.data[source + 2],
              tile.data[source + 3],
            );
          }
        }
      }
    },
  });
}

/**
 * The largest scale whose rendered area stays within `maxPixels`.
 *
 * The continuous limit is not enough on its own: width and height are rounded
 * independently, and two round-ups can push the result past a cap that stands
 * for a real memory or canvas ceiling. The scale is eased down until the
 * dimensions actually rendered fit.
 */
export function previewScale(project: Project, maxPixels: number): number {
  const { width, height } = project.output;
  if (width * height <= maxPixels) return 1;

  let scale = Math.sqrt(maxPixels / (width * height));
  for (let i = 0; i < 64; i++) {
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (w * h <= maxPixels) return scale;
    scale *= 0.999;
  }
  return scale;
}

export interface SeamlessAdvice {
  nodeId: string;
  axis: 'width' | 'height';
  /** The interval the output size must be a multiple of. */
  period: number;
  current: number;
  /** Compatible sizes, nearest-below first. */
  suggestions: number[];
}

/**
 * Sizes a seamless render must use for the pattern to meet itself.
 *
 * Each node declares its own period, so this covers every generator rather than
 * special-casing the grid — and the answer is a list of compatible sizes to
 * offer, never a silent change to the pattern to make it fit the canvas.
 */
export function checkSeamless(project: Project): SeamlessAdvice[] {
  if (!project.output.seamless) return [];
  const advice: SeamlessAdvice[] = [];

  for (const node of project.nodes) {
    const definition = getNodeDefinition(node.type);
    if (!definition.seamlessPeriod) continue;
    const periods = definition.seamlessPeriod(node.params);
    const axes: { axis: 'width' | 'height'; period: number | null; current: number }[] = [
      { axis: 'width', period: periods.x, current: project.output.width },
      { axis: 'height', period: periods.y, current: project.output.height },
    ];

    for (const { axis, period, current } of axes) {
      if (period === null || !Number.isFinite(period) || period <= 0) continue;
      if (Number.isInteger(current / period)) continue;
      const below = Math.round(Math.floor(current / period) * period);
      const above = Math.round(Math.ceil(current / period) * period);
      const suggestions = [below, above].filter((value) => value >= period);
      advice.push({ nodeId: node.id, axis, period, current, suggestions });
    }
  }
  return advice;
}
