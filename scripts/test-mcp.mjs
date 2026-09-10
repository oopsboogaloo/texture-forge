/**
 * Drives the MCP server over a real stdio connection.
 *
 * Spawning the process and speaking the protocol to it is the only way to know
 * the thing works: a tool that throws, a schema the client rejects, or output
 * written to stdout instead of stderr would all pass a unit test and fail the
 * moment an assistant connected.
 *
 *   npm run test:mcp
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const failures = [];
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) return;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const textOf = (result) => result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');

const workspace = await mkdtemp(join(tmpdir(), 'texture-forge-mcp-'));
const client = new Client({ name: 'texture-forge-check', version: '1' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['--experimental-strip-types', 'src/mcp/server.ts'],
});

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  check(
    'the server offers the expected tools',
    ['get_recipe', 'list_nodes', 'list_presets', 'preview_texture', 'render_texture', 'validate_recipe'].every((name) =>
      names.includes(name),
    ),
    names.join(', '),
  );
  check('every tool is described', tools.every((tool) => (tool.description ?? '').length > 20));

  // Discoverability: this is what an assistant reads before composing anything.
  const nodes = JSON.parse(textOf(await client.callTool({ name: 'list_nodes', arguments: {} })));
  check('every node is listed', nodes.length >= 25, `${nodes.length}`);
  check('nodes carry their controls', nodes.every((node) => Array.isArray(node.params)));
  check('nodes carry a version', nodes.every((node) => typeof node.version === 'number'));
  const generators = JSON.parse(textOf(await client.callTool({ name: 'list_nodes', arguments: { category: 'generator' } })));
  check('generators can be listed alone', generators.length >= 20 && generators.length < nodes.length, `${generators.length}`);

  const presets = JSON.parse(textOf(await client.callTool({ name: 'list_presets', arguments: {} })));
  check('the presets are listed', presets.length === 3, `${presets.length}`);

  const recipeText = textOf(await client.callTool({ name: 'get_recipe', arguments: { id: 'paper' } }));
  const recipe = JSON.parse(recipeText);
  check('a preset comes back as a document', recipe.format === 'texture-forge/project' && recipe.nodes.length > 3);
  check('the document records how it was made', recipe.provenance.generation === 'procedural-algorithms');

  const valid = textOf(await client.callTool({ name: 'validate_recipe', arguments: { recipe: recipeText } }));
  check('a good recipe validates', valid.startsWith('Valid.'), valid.slice(0, 80));

  const brokenJson = await client.callTool({ name: 'validate_recipe', arguments: { recipe: '{not json' } });
  check('malformed JSON is refused', brokenJson.isError === true);

  const wrongPort = JSON.parse(recipeText);
  wrongPort.edges = [{ from: 'mottle', to: 'out', input: 'input' }];
  const mismatch = await client.callTool({ name: 'validate_recipe', arguments: { recipe: JSON.stringify(wrongPort) } });
  check('a mismatched connection is refused', mismatch.isError === true);
  check('the refusal explains itself', textOf(mismatch).toLowerCase().includes('cannot connect'), textOf(mismatch).slice(0, 90));

  const both = await client.callTool({ name: 'validate_recipe', arguments: { recipe: recipeText, preset: 'paper' } });
  check('recipe and preset together are refused', both.isError === true);

  // Looking at the result is the point of the preview.
  const preview = await client.callTool({ name: 'preview_texture', arguments: { preset: 'worn-print', size: 128 } });
  const image = preview.content.find((part) => part.type === 'image');
  check('a preview returns an image', Boolean(image) && image.mimeType === 'image/png');
  const previewBytes = Buffer.from(image?.data ?? '', 'base64');
  check('the preview is a PNG', previewBytes.subarray(1, 4).toString() === 'PNG', previewBytes.subarray(0, 8).toString('hex'));
  check('the preview has real content', previewBytes.length > 500, `${previewBytes.length} bytes`);

  const destination = join(workspace, 'texture.png');
  const rendered = textOf(
    await client.callTool({
      name: 'render_texture',
      arguments: { preset: 'square-grid', path: destination, width: 320, height: 200, format: 'rgba' },
    }),
  );
  check('rendering reports where it wrote', rendered.includes(destination), rendered.slice(0, 120));
  const written = await readFile(destination);
  check('the file is a PNG', written.subarray(1, 4).toString() === 'PNG');
  check('the file has the requested size', written.readUInt32BE(16) === 320 && written.readUInt32BE(20) === 200);

  const tooBig = await client.callTool({
    name: 'render_texture',
    arguments: { preset: 'paper', path: join(workspace, 'huge.png'), width: 30000, height: 30000 },
  });
  check('an unreasonable size is refused', tooBig.isError === true);

  // Validation has to mean the recipe renders. Parameters live in a plain
  // object the parser copies through untouched, so a missing or mistyped one
  // used to validate cleanly and then fail partway into a render.
  const noDensity = JSON.parse(recipeText);
  const fibres = noDensity.nodes.find((node) => node.type === 'paper-fibres');
  delete fibres.params.density;
  const missingParam = await client.callTool({ name: 'validate_recipe', arguments: { recipe: JSON.stringify(noDensity) } });
  check('a missing parameter is refused', missingParam.isError === true, textOf(missingParam).slice(0, 90));
  check('the refusal names the parameter', textOf(missingParam).includes('density'), textOf(missingParam).slice(0, 120));

  const wildDensity = JSON.parse(recipeText);
  wildDensity.nodes.find((node) => node.type === 'paper-fibres').params.density = 1e9;
  const outOfRange = await client.callTool({ name: 'preview_texture', arguments: { recipe: JSON.stringify(wildDensity), size: 64 } });
  check('a count far above its range is refused before rendering', outOfRange.isError === true, textOf(outOfRange).slice(0, 90));

  // Scaling a preview down does not make an oversized recipe cheap: counts are
  // given per megapixel of the stored size, so the guard has to run here too.
  const oversized = JSON.parse(recipeText);
  oversized.output.width = 30000;
  oversized.output.height = 30000;
  const hugePreview = await client.callTool({ name: 'preview_texture', arguments: { recipe: JSON.stringify(oversized), size: 64 } });
  check('an oversized recipe is refused a preview', hugePreview.isError === true, textOf(hugePreview).slice(0, 90));

  // A preview in a different format is a different picture, which defeats the
  // point of looking at it before committing to the render.
  const greyscale = JSON.parse(recipeText);
  greyscale.output.format = 'luminance';
  const greyPreview = await client.callTool({ name: 'preview_texture', arguments: { recipe: JSON.stringify(greyscale), size: 96 } });
  const greyImage = greyPreview.content.find((part) => part.type === 'image');
  const greyBytes = Buffer.from(greyImage?.data ?? '', 'base64');
  check('a greyscale recipe previews as greyscale', greyBytes[25] === 0, `colour type ${greyBytes[25]}`);
  check('the preview says which format it is showing', textOf(greyPreview).includes('luminance'), textOf(greyPreview).slice(0, 90));

  const previewDims = textOf(await client.callTool({ name: 'preview_texture', arguments: { preset: 'paper', size: 100 } }));
  const paperRecipe = JSON.parse(textOf(await client.callTool({ name: 'get_recipe', arguments: { id: 'paper' } })));
  const longest = Math.max(paperRecipe.output.width, paperRecipe.output.height);
  const expected = `${Math.max(1, Math.round((paperRecipe.output.width * 100) / longest))} x ${Math.max(1, Math.round((paperRecipe.output.height * 100) / longest))}`;
  check('the preview reports the size it really rendered', previewDims.includes(`shown at ${expected}`), previewDims.slice(0, 120));

  const unknownPreset = await client.callTool({ name: 'get_recipe', arguments: { id: 'not-a-preset' } });
  check('an unknown preset is refused', unknownPreset.isError === true);
} finally {
  await client.close().catch(() => {});
  await rm(workspace, { recursive: true, force: true });
}

console.log(`${checks - failures.length}/${checks} MCP checks passed`);
for (const failure of failures) console.error(`FAIL  ${failure}`);
if (failures.length > 0) process.exitCode = 1;
