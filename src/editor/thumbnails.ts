import type { Project } from '../engine/project.ts';
import { defaultParams, getNodeDefinition } from '../engine/registry.ts';
import { createRenderPass } from '../engine/render.ts';
import { PROJECT_FORMAT, PROJECT_FORMAT_VERSION } from '../engine/version.ts';

/**
 * Thumbnails are rendered by the engine rather than shipped as images.
 *
 * They cannot then fall out of step with what a generator actually produces —
 * change a default and the picture changes with it — and there are no assets to
 * keep. They are small enough to render on the main thread, and cached, because
 * a picker that redraws its own icons on every repaint is worse than no icons.
 */
const cache = new Map<string, string>();

/** The size a generator is composed at, so its defaults show a representative area. */
const GENERATOR_SOURCE = 1400;
/** Presets are cut down before rendering: scattered elements scale with area. */
const PROJECT_SOURCE = 512;

function toDataUrl(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return '';
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas.toDataURL('image/png');
}

function render(project: Project, size: number): string {
  const source = Math.max(project.output.width, project.output.height);
  const pass = createRenderPass(project, { scale: size / source });
  const tile = pass.renderTile({ x: 0, y: 0, width: pass.width, height: pass.height });
  return toDataUrl(tile.data as Uint8ClampedArray<ArrayBuffer>, tile.width, tile.height);
}

/** A generator shown on its own, as black marks on white. */
export function generatorThumbnail(type: string, size = 96): string {
  const key = `generator:${type}:${size}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const definition = getNodeDefinition(type);
  const nodes: Project['nodes'] = [{ id: 'g', type, version: definition.version, params: defaultParams(definition) }];
  const edges: Project['edges'] = [];
  let tail = 'g';

  if (definition.output === 'mask') {
    nodes.push({
      id: 'ramp',
      type: 'colour-ramp',
      version: getNodeDefinition('colour-ramp').version,
      params: {
        stops: [
          { position: 0, colour: '#ffffff', alpha: 1 },
          { position: 1, colour: '#141414', alpha: 1 },
        ],
      },
    });
    edges.push({ from: 'g', to: 'ramp', input: 'input' });
    tail = 'ramp';
  }

  nodes.push({
    id: 'out',
    type: 'output',
    version: getNodeDefinition('output').version,
    params: { backgroundEnabled: true, backgroundColour: '#ffffff' },
  });
  edges.push({ from: tail, to: 'out', input: 'input' });

  const url = render(
    {
      format: PROJECT_FORMAT,
      formatVersion: PROJECT_FORMAT_VERSION,
      application: { name: 'texture-forge', version: '0' },
      provenance: { generation: 'procedural-algorithms' },
      output: { width: GENERATOR_SOURCE, height: GENERATOR_SOURCE, seamless: false, format: 'rgba' },
      nodes,
      edges,
      outputNode: 'out',
    },
    size,
  );
  cache.set(key, url);
  return url;
}

/** A whole recipe, for the preset cards. */
export function projectThumbnail(key: string, project: Project, size = 128): string {
  const cacheKey = `project:${key}:${size}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;

  const aspect = project.output.height / project.output.width;
  const url = render(
    {
      ...project,
      output: {
        ...project.output,
        width: PROJECT_SOURCE,
        height: Math.max(1, Math.round(PROJECT_SOURCE * aspect)),
      },
    },
    size,
  );
  cache.set(cacheKey, url);
  return url;
}
