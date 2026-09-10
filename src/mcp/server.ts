/**
 * Texture Forge as an MCP server.
 *
 * The engine was built for this from the start: it runs without the editor,
 * takes versioned JSON recipes, and describes its own nodes. This exposes those
 * three things over stdio so an assistant can read what generators exist,
 * compose a recipe, look at the result, and render it at full size.
 *
 *   node --experimental-strip-types src/mcp/server.ts
 *
 * Everything it renders comes from the same code the editor uses, so a recipe
 * composed here opens in the editor and renders identically.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkParams, parseProject, stampProvenance, type Project } from '../engine/project.ts';
import { PRESETS, findPreset } from '../engine/presets.ts';
import { checkSeamless, renderToPng, scaledDimensions } from '../engine/render.ts';
import { describeNodes, listNodeDefinitions } from '../engine/registry.ts';
import { APPLICATION_NAME, APPLICATION_VERSION } from '../engine/version.ts';

/** Guards against a recipe that would exhaust memory before it finishes. */
const MAX_DIMENSION = 20000;
const MAX_PREVIEW = 1024;

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/**
 * A recipe from either an inline document or a preset name.
 *
 * Both are offered because the two uses differ: starting from a preset and
 * adjusting it is the common path, and passing a whole document back is what
 * happens once the assistant has composed one.
 */
function loadRecipe(input: { recipe?: string; preset?: string }): { project: Project; warnings: string[] } {
  if (input.recipe && input.preset) throw new Error('give either a recipe or a preset, not both');
  const loaded = parseRecipe(input);

  // Every tool reaches a recipe through here, so checking the parameters at
  // this one point means a recipe that gets past it renders, rather than
  // failing partway into a node — or, for a count far above its descriptor's
  // maximum, allocating far more than any control could ask for.
  const problems = checkParams(loaded.project);
  if (problems.length > 0) throw new Error(`the recipe cannot render:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  return loaded;
}

function parseRecipe(input: { recipe?: string; preset?: string }): { project: Project; warnings: string[] } {
  if (input.preset) return { project: findPreset(input.preset).project, warnings: [] };
  if (!input.recipe) throw new Error('give a recipe (JSON) or a preset id');

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.recipe);
  } catch (error) {
    throw new Error(`the recipe is not valid JSON: ${(error as Error).message}`);
  }
  return parseProject(parsed);
}

/**
 * The size ceiling, checked wherever a recipe is about to be rendered.
 *
 * Scaling a preview down does not make an oversized recipe cheap: sizes and
 * counts are given in output pixels, so a generator still builds its elements
 * from the stored dimensions however small the picture asked for is.
 */
function guardDimensions(width: number, height: number): void {
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`dimensions above ${MAX_DIMENSION} are refused; ask for a smaller size`);
  }
}

function withOutput(project: Project, overrides: { width?: number; height?: number; seamless?: boolean; format?: string }): Project {
  const width = overrides.width ?? project.output.width;
  const height = overrides.height ?? project.output.height;
  guardDimensions(width, height);
  return {
    ...project,
    output: {
      ...project.output,
      width,
      height,
      ...(overrides.seamless === undefined ? {} : { seamless: overrides.seamless }),
      ...(overrides.format === undefined ? {} : { format: overrides.format as Project['output']['format'] }),
    },
  };
}

const recipeInput = {
  recipe: z.string().optional().describe('A project document as JSON. Omit if using preset.'),
  preset: z.string().optional().describe('A preset id from list_presets. Omit if using recipe.'),
};

const server = new McpServer({ name: APPLICATION_NAME, version: APPLICATION_VERSION });

server.registerTool(
  'list_nodes',
  {
    title: 'List nodes',
    description:
      'Every node the engine offers, with its controls, ranges, defaults, port types, version and whether it can tile. ' +
      'Read this before composing a recipe: it is the authoritative description of what can be built.',
    inputSchema: {
      category: z.enum(['generator', 'adjustment', 'output']).optional().describe('Narrow to one kind of node.'),
    },
  },
  async ({ category }) => {
    const all = describeNodes() as { category: string }[];
    const chosen = category ? all.filter((node) => node.category === category) : all;
    return text(JSON.stringify(chosen, null, 2));
  },
);

server.registerTool(
  'list_presets',
  {
    title: 'List presets',
    description: 'The bundled starting points, each a complete recipe.',
    inputSchema: {},
  },
  async () => text(JSON.stringify(PRESETS.map(({ id, label, summary }) => ({ id, label, summary })), null, 2)),
);

server.registerTool(
  'get_recipe',
  {
    title: 'Get a preset recipe',
    description: 'The full project document for a preset, as a starting point to modify.',
    inputSchema: { id: z.string().describe('A preset id from list_presets.') },
  },
  async ({ id }) => {
    try {
      return text(JSON.stringify(stampProvenance(findPreset(id).project), null, 2));
    } catch (error) {
      return failure((error as Error).message);
    }
  },
);

server.registerTool(
  'validate_recipe',
  {
    title: 'Validate a recipe',
    description:
      'Checks a recipe against the engine without rendering it: unknown nodes, mismatched port types, missing or ' +
      'duplicated connections, cycles, parameters that are missing, of the wrong kind or outside their published ' +
      'range, and node versions that differ from this build. Also reports sizes a seamless render needs.',
    inputSchema: recipeInput,
  },
  async (input) => {
    try {
      const { project, warnings } = loadRecipe(input);
      const advice = checkSeamless(project);
      const lines = [`Valid. ${project.nodes.length} nodes, ${project.edges.length} connections.`];
      for (const warning of warnings) lines.push(`Warning: ${warning}`);
      for (const item of advice) {
        lines.push(
          `Seamless: ${item.axis} must be a multiple of ${item.period} for node ${item.nodeId}; ` +
            `${item.current} is not. Compatible: ${item.suggestions.join(', ')}.`,
        );
      }
      return text(lines.join('\n'));
    } catch (error) {
      return failure((error as Error).message);
    }
  },
);

server.registerTool(
  'preview_texture',
  {
    title: 'Preview a texture',
    description:
      'Renders a small image of a recipe and returns it, so the result can be looked at before committing to a ' +
      'full-size render. The preview is a true downscale of the export, not a different picture.',
    inputSchema: {
      ...recipeInput,
      size: z.number().int().min(32).max(MAX_PREVIEW).optional().describe(`Longest edge in pixels, up to ${MAX_PREVIEW}.`),
    },
  },
  async (input) => {
    try {
      const { project } = loadRecipe(input);
      guardDimensions(project.output.width, project.output.height);
      const size = input.size ?? 512;
      const scale = size / Math.max(project.output.width, project.output.height);
      const shown = scaledDimensions(project, scale);

      // Encoded through the same PNG writer the editor exports with, in the
      // format the recipe asks for: a preview in a different format is a
      // different picture, which defeats the point of looking at it first.
      const png = await renderToPng(project, { scale });
      const bytes = new Uint8Array(await png.blob.arrayBuffer());
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${project.output.width} x ${project.output.height} ${project.output.format} ` +
              `shown at ${shown.width} x ${shown.height}.`,
          },
          { type: 'image' as const, data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' },
        ],
      };
    } catch (error) {
      return failure((error as Error).message);
    }
  },
);

server.registerTool(
  'render_texture',
  {
    title: 'Render a texture to a file',
    description:
      'Renders a recipe at full size and writes a PNG to the given path. Rendering is banded, so a very large ' +
      'texture does not need to fit in memory all at once.',
    inputSchema: {
      ...recipeInput,
      path: z.string().describe('Where to write the PNG. Written exactly here; nothing else is touched.'),
      width: z.number().int().min(1).max(MAX_DIMENSION).optional(),
      height: z.number().int().min(1).max(MAX_DIMENSION).optional(),
      seamless: z.boolean().optional(),
      format: z.enum(['rgba', 'luminance', 'alpha']).optional().describe('Colour with transparency, or greyscale from tone or coverage.'),
    },
  },
  async (input) => {
    try {
      const { project, warnings } = loadRecipe(input);
      const shaped = withOutput(stampProvenance(project), input);
      const started = Date.now();
      const result = await renderToPng(shaped, { bandRows: 128 });
      const destination = resolve(input.path);
      await writeFile(destination, new Uint8Array(await result.blob.arrayBuffer()));

      const lines = [
        `Wrote ${destination}`,
        `${shaped.output.width} x ${shaped.output.height}, ${shaped.output.format}, ` +
          `${(result.blob.size / 1048576).toFixed(2)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
      ];
      for (const warning of warnings) lines.push(`Warning: ${warning}`);
      for (const item of checkSeamless(shaped)) {
        lines.push(`Seamless: ${item.axis} ${item.current} is not a multiple of ${item.period} (node ${item.nodeId}).`);
      }
      return text(lines.join('\n'));
    } catch (error) {
      return failure((error as Error).message);
    }
  },
);

// stdout carries the protocol, so anything said here must go to stderr.
process.stderr.write(`${APPLICATION_NAME} ${APPLICATION_VERSION}: ${listNodeDefinitions().length} nodes ready\n`);
await server.connect(new StdioServerTransport());
