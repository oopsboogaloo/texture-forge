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
 * Builds the node instances once, then renders any rectangle of the result.
 *
 * Generators that scatter elements across the whole image do that work in their
 * constructor, so it happens once per pass rather than once per tile — and every
 * tile of a pass sees the same elements, which is what makes a banded export
 * identical to a single-shot render.
 */
export function createRenderPass(project: Project, options: RenderPassOptions = {}): RenderPass {
  const scale = options.scale ?? 1;
  if (!(scale > 0)) throw new Error('scale must be greater than zero');

  const width = Math.max(1, Math.round(project.output.width * scale));
  const height = Math.max(1, Math.round(project.output.height * scale));
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
  const bandRows = Math.max(1, Math.min(options.bandRows ?? 128, pass.height));

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
          } else if (format === 'alpha') {
            buf[target++] = tile.data[source + 3];
          } else {
            // Rec. 709 luminance of the colour composited over white, so an
            // unpainted area reads as white rather than as black.
            const a = tile.data[source + 3] / 255;
            const r = tile.data[source] * a + 255 * (1 - a);
            const g = tile.data[source + 1] * a + 255 * (1 - a);
            const b = tile.data[source + 2] * a + 255 * (1 - a);
            buf[target++] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          }
        }
      }
    },
  });
}

/** The largest scale whose rendered area stays within `maxPixels`. */
export function previewScale(project: Project, maxPixels: number): number {
  const area = project.output.width * project.output.height;
  return area <= maxPixels ? 1 : Math.sqrt(maxPixels / area);
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
 * Grid exports must contain whole cells, and grids with heavier lines must also
 * align with the major-line interval. Rather than quietly changing the pattern
 * to fit the canvas, the editor offers sizes that fit the pattern.
 */
export function checkSeamless(project: Project): SeamlessAdvice[] {
  if (!project.output.seamless) return [];
  const advice: SeamlessAdvice[] = [];

  for (const node of project.nodes) {
    if (node.type !== 'grid') continue;
    const cellWidth = Number(node.params.cellWidth);
    const cellHeight = Number(node.params.cellHeight);
    const major = node.params.majorEnabled === true;
    const axes: { axis: 'width' | 'height'; period: number; current: number }[] = [
      {
        axis: 'width',
        period: cellWidth * (major ? Number(node.params.majorEveryX) : 1),
        current: project.output.width,
      },
      {
        axis: 'height',
        period: cellHeight * (major ? Number(node.params.majorEveryY) : 1),
        current: project.output.height,
      },
    ];

    for (const { axis, period, current } of axes) {
      if (!Number.isFinite(period) || period <= 0) continue;
      if (Number.isInteger(current / period)) continue;
      const below = Math.floor(current / period) * period;
      const above = Math.ceil(current / period) * period;
      const suggestions = [below, above].filter((value) => value >= period);
      advice.push({ nodeId: node.id, axis, period, current, suggestions });
    }
  }
  return advice;
}
