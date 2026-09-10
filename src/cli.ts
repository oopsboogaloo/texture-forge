/**
 * Headless entry point for the texture engine.
 *
 * The engine has to work without the editor, so this is the proof: same code,
 * same output, no browser. It is also the shape the MCP server planned after V1
 * will wrap.
 *
 *   node --experimental-strip-types src/cli.ts nodes
 *   node --experimental-strip-types src/cli.ts presets
 *   node --experimental-strip-types src/cli.ts render <preset|file.json> -o out.png [--size N] [--scale S]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { describeNodes } from './engine/registry.ts';
import { parseProject, stampProvenance, type Project } from './engine/project.ts';
import { PRESETS, findPreset } from './engine/presets.ts';
import { checkSeamless, renderToPng } from './engine/render.ts';

interface Options {
  out: string;
  size?: number;
  scale?: number;
  bandRows?: number;
  seamless?: boolean;
}

function parseOptions(args: string[]): Options {
  const options: Options = { out: 'out.png' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    switch (flag) {
      case '-o':
      case '--out':
        options.out = value;
        i++;
        break;
      case '--size':
        options.size = Number(value);
        i++;
        break;
      case '--scale':
        options.scale = Number(value);
        i++;
        break;
      case '--band-rows':
        options.bandRows = Number(value);
        i++;
        break;
      case '--seamless':
        options.seamless = true;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  return options;
}

async function loadProject(source: string): Promise<Project> {
  const preset = PRESETS.find((candidate) => candidate.id === source);
  if (preset) return findPreset(source).project;
  const text = await readFile(source, 'utf8');
  const { project, warnings } = parseProject(JSON.parse(text));
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  return project;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'nodes') {
    console.log(JSON.stringify(describeNodes(), null, 2));
    return;
  }

  if (command === 'presets') {
    const [id] = rest;
    if (id) {
      console.log(JSON.stringify(stampProvenance(findPreset(id).project), null, 2));
      return;
    }
    for (const preset of PRESETS) console.log(`${preset.id.padEnd(14)} ${preset.summary}`);
    return;
  }

  if (command === 'render') {
    const [source, ...flags] = rest;
    if (!source) throw new Error('render needs a preset id or a project file');
    const options = parseOptions(flags);
    const loaded = await loadProject(source);
    const project: Project = {
      ...loaded,
      output: {
        ...loaded.output,
        ...(options.size ? { width: options.size, height: options.size } : {}),
        ...(options.seamless ? { seamless: true } : {}),
      },
    };

    for (const advice of checkSeamless(project)) {
      console.warn(
        `warning: seamless ${advice.axis} ${advice.current} is not a multiple of ${advice.period} ` +
          `(node ${advice.nodeId}); compatible sizes: ${advice.suggestions.join(', ')}`,
      );
    }

    const started = Date.now();
    const result = await renderToPng(project, { scale: options.scale, bandRows: options.bandRows });
    await writeFile(options.out, new Uint8Array(await result.blob.arrayBuffer()));
    const seconds = (Date.now() - started) / 1000;
    console.log(
      `${options.out}: ${(result.blob.size / 1048576).toFixed(2)} MB in ${seconds.toFixed(1)}s ` +
        `(generate ${(result.generateMs / 1000).toFixed(1)}s, encode ${(result.encodeMs / 1000).toFixed(1)}s)`,
    );
    return;
  }

  console.error('usage: cli.ts <nodes|presets|render> [...]');
  process.exitCode = 1;
}

await main();
