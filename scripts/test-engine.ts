/**
 * Engine tests. Run with:
 *   node --experimental-strip-types scripts/test-engine.ts
 *
 * These exist to pin the properties the rest of the app is built on: that a
 * tiled render equals an untiled one, that the same recipe always produces the
 * same picture, and that seamless output really wraps.
 */
import { inflateSync } from 'node:zlib';
import { FractalNoise } from '../src/engine/noise.ts';
import { parseProject } from '../src/engine/project.ts';
import { PRESETS, SQUARE_GRID } from '../src/engine/presets.ts';
import { checkSeamless, createRenderPass, greyscaleValue, previewScale, renderToPng } from '../src/engine/render.ts';
import { createMask, fromStack, toStack } from '../src/editor/stack.ts';
import { describeNodes, getNodeDefinition, listNodeDefinitions } from '../src/engine/registry.ts';
import { parseColour } from '../src/engine/colour.ts';
import { wrapOffsets } from '../src/engine/nodes/scatter.ts';
import { drawLine } from '../src/engine/raster.ts';
import { createColourBuffer, createMaskBuffer } from '../src/engine/types.ts';
import type { Project } from '../src/engine/project.ts';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ''): void {
  checks++;
  if (condition) return;
  failures++;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function expectThrows(name: string, run: () => unknown): void {
  try {
    run();
  } catch {
    check(name, true);
    return;
  }
  check(name, false, 'expected an error');
}

function renderWhole(project: Project, scale = 1): Uint8ClampedArray {
  const pass = createRenderPass(project, { scale });
  return pass.renderTile({ x: 0, y: 0, width: pass.width, height: pass.height }).data;
}

function renderInBands(project: Project, bandRows: number, scale = 1): Uint8ClampedArray {
  const pass = createRenderPass(project, { scale });
  const out = new Uint8ClampedArray(pass.width * pass.height * 4);
  for (let y = 0; y < pass.height; y += bandRows) {
    const rows = Math.min(bandRows, pass.height - y);
    const tile = pass.renderTile({ x: 0, y, width: pass.width, height: rows });
    out.set(tile.data, y * pass.width * 4);
  }
  return out;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sized(project: Project, size: number, patch: Partial<Project['output']> = {}): Project {
  return { ...project, output: { ...project.output, width: size, height: size, ...patch } };
}

function equalBytes(a: ArrayLike<number>, b: ArrayLike<number>): { equal: boolean; at: number } {
  if (a.length !== b.length) return { equal: false, at: -1 };
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return { equal: false, at: i };
  return { equal: true, at: -1 };
}

// A tiled render must equal an untiled one. Everything about large exports
// depends on this, and a band height that divides the image evenly would hide
// exactly the off-by-one errors worth catching.
for (const preset of PRESETS) {
  const project = sized(preset.project, 256);
  const whole = renderWhole(project);
  for (const bandRows of [1, 7, 64, 251]) {
    const banded = renderInBands(project, bandRows);
    const result = equalBytes(whole, banded);
    check(`${preset.id}: ${bandRows}-row bands match a single tile`, result.equal, `first difference at byte ${result.at}`);
  }
}

// The same, in seamless mode. This is where wrapped elements are drawn on the
// far side of the image, and where a tile can be reached by an element whose
// centre is a whole image away — so it needs its own coverage, not an
// assumption that the non-seamless case generalises.
for (const preset of PRESETS) {
  const project = sized(preset.project, 256, { seamless: true });
  const whole = renderWhole(project);
  for (const bandRows of [1, 17, 64, 251]) {
    const banded = renderInBands(project, bandRows);
    const result = equalBytes(whole, banded);
    check(
      `${preset.id}: seamless ${bandRows}-row bands match a single tile`,
      result.equal,
      `first difference at byte ${result.at}`,
    );
  }
}

// The same recipe must produce the same picture every time.
for (const preset of PRESETS) {
  const project = sized(preset.project, 128);
  check(`${preset.id}: render is deterministic`, equalBytes(renderWhole(project), renderWhole(project)).equal);
}

// A preview is a downscale of the export, not a differently composed image.
{
  const project = sized(PRESETS[0].project, 512);
  const pass = createRenderPass(project, { scale: 0.25 });
  check('preview scale sets destination size', pass.width === 128 && pass.height === 128, `${pass.width}x${pass.height}`);
  check('previewScale caps area', Math.abs(previewScale(sized(project, 1000), 250000) - 0.5) < 1e-9);
  check('previewScale leaves small outputs alone', previewScale(sized(project, 100), 250000) === 1);

  // Rounding width and height independently can round both up, so the cap has
  // to hold for the dimensions actually rendered.
  for (const [w, h, cap] of [
    [1024, 5000, 1_000_000],
    [999, 333, 50_000],
    [4096, 4096, 262_144],
    [10000, 10000, 1_000_000],
  ] as const) {
    const shaped: Project = { ...project, output: { ...project.output, width: w, height: h } };
    const scale = previewScale(shaped, cap);
    const rendered = Math.max(1, Math.round(w * scale)) * Math.max(1, Math.round(h * scale));
    check(`previewScale respects the cap after rounding for ${w}x${h}`, rendered <= cap, `${rendered} > ${cap}`);
  }
}

// Seamless noise wraps exactly at the image boundary.
{
  const noise = new FractalNoise({ outputWidth: 512, outputHeight: 512, cellPx: 64, octaves: 3, seed: 5 });
  check('noise wraps horizontally', noise.sample(0, 31) === noise.sample(512, 31));
  check('noise wraps vertically', noise.sample(31, 0) === noise.sample(31, 512));
  check('noise varies across the image', noise.sample(80, 80) !== noise.sample(300, 220));
}

// Scattered elements are redrawn on the far side only when they cross an edge.
{
  check('interior elements are drawn once', wrapOffsets(true, 10, 20, 10, 20, 100, 100).length === 1);
  check('edge-crossing elements wrap', wrapOffsets(true, -5, 5, 10, 20, 100, 100).length === 2);
  check('corner elements wrap twice over', wrapOffsets(true, -5, 5, -5, 5, 100, 100).length === 4);
  check('wrapping is off unless seamless', wrapOffsets(false, -5, 5, -5, 5, 100, 100).length === 1);
}

// Blending happens against translucent backdrops, not just opaque ones.
{
  const pass = { outputWidth: 4, outputHeight: 1, seamless: false };
  const ctx = {
    outputWidth: 4,
    outputHeight: 1,
    scale: 1,
    seamless: false,
    tile: { x: 0, y: 0, width: 1, height: 1 },
  };
  const colour = (r: number, g: number, b: number, a: number) => {
    const buffer = createColourBuffer(1, 1);
    buffer.data.set([r, g, b, a]);
    return buffer;
  };

  const node = getNodeDefinition('blend').create({ mode: 'multiply', opacity: 1 }, 'blend', pass);
  const result = node.render(ctx, [colour(255, 0, 0, 128), colour(0, 0, 255, 128)]);

  // Half-alpha blue multiplied over half-alpha red: through the transparent half
  // of the backdrop the blue is unblended, so it cannot vanish.
  const ba = 128 / 255;
  const la = 128 / 255;
  const outAlpha = la + ba * (1 - la);
  const expectedBlue = (la * (1 - ba) * 255) / outAlpha;
  check('blend keeps source colour over a translucent backdrop', result.data[2] > 0, `blue is ${result.data[2]}`);
  check(
    'blend matches the compositing formula',
    Math.abs(result.data[2] - expectedBlue) <= 1,
    `${result.data[2]} vs ${expectedBlue.toFixed(1)}`,
  );

  const over = getNodeDefinition('blend').create({ mode: 'normal', opacity: 1 }, 'blend', pass);
  const opaque = over.render(ctx, [colour(255, 0, 0, 255), colour(0, 0, 255, 255)]);
  check('normal blend at full alpha is the layer', opaque.data[2] === 255 && opaque.data[0] === 0);
}

// Band heights are whole scanlines or nothing.
{
  const project = sized(SQUARE_GRID, 32);
  for (const bandRows of [1.5, Number.NaN, 0, -4]) {
    let threw = false;
    try {
      await renderToPng(project, { bandRows });
    } catch {
      threw = true;
    }
    check(`bandRows ${String(bandRows)} is rejected`, threw);
  }
}

// Colours are hexadecimal or an error, never silently mangled.
{
  for (const bad of ['#gggggg', '#12345g', '#12', 'rebeccapurple', '']) {
    expectThrows(`parseColour rejects ${JSON.stringify(bad)}`, () => parseColour(bad));
  }
  check('parseColour reads six digits', parseColour('#ff8000').r === 255);
  check('parseColour reads alpha', parseColour('#ff800080').a === 128);
  check('parseColour expands shorthand', parseColour('#f80').g === 136);
}

// Row sampling and point sampling are the same function.
{
  const noise = new FractalNoise({ outputWidth: 256, outputHeight: 256, cellPx: 48, octaves: 3, seed: 9 });
  const row = new Float32Array(16);
  noise.sampleRow(row, 12.5, 4.5, 2);
  let worst = 0;
  for (let k = 0; k < row.length; k++) worst = Math.max(worst, Math.abs(row[k] - noise.sample(4.5 + k * 2, 12.5)));
  check('sampleRow and sample are the same function', worst === 0, `largest difference ${worst}`);
}

// The scanline bounds in drawLine are an optimisation over testing every pixel
// in the buffer, so they are checked against exactly that.
{
  const reference = (width: number, height: number, line: number[], thickness: number): Uint8ClampedArray => {
    const [x0, y0, x1, y1] = line;
    const out = new Uint8ClampedArray(width * height);
    const effective = Math.max(thickness, 1);
    const fade = thickness < 1 ? thickness : 1;
    const radius = effective / 2;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSq = dx * dx + dy * dy;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let t = lengthSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lengthSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ox = px - (x0 + t * dx);
        const oy = py - (y0 + t * dy);
        const coverage = 1 - (Math.sqrt(ox * ox + oy * oy) - (radius - 0.5));
        if (coverage <= 0) continue;
        out[y * width + x] = Math.min(1, coverage) * fade * 255;
      }
    }
    return out;
  };

  const lines: { line: number[]; thickness: number; label: string }[] = [
    { line: [4, 4, 44, 44], thickness: 10, label: 'thick 45 degrees' },
    { line: [4, 4, 44, 44], thickness: 1.4, label: 'thin 45 degrees' },
    { line: [8, 2, 12, 46], thickness: 9, label: 'thick and steep' },
    { line: [2, 20, 46, 24], thickness: 7, label: 'thick and shallow' },
    { line: [24, 4, 24, 44], thickness: 12, label: 'vertical' },
    { line: [4, 24, 44, 24], thickness: 12, label: 'horizontal' },
    { line: [10, 10, 10, 10], thickness: 6, label: 'zero length' },
    { line: [-6, -6, 20, 18], thickness: 8, label: 'starting off canvas' },
    { line: [30, 30, 60, 70], thickness: 8, label: 'running off canvas' },
    { line: [5, 40, 45, 8], thickness: 0.4, label: 'sub-pixel thickness' },
  ];

  for (const { line, thickness, label } of lines) {
    const mask = createMaskBuffer(48, 48);
    drawLine(mask, line[0], line[1], line[2], line[3], thickness, 1);
    const expected = reference(48, 48, line, thickness);
    const result = equalBytes(mask.data, expected);
    check(`drawLine matches a full-buffer scan: ${label}`, result.equal, `first difference at pixel ${result.at}`);
  }
}

// Seamless advice offers compatible sizes rather than changing the pattern.
{
  const project = sized(SQUARE_GRID, 1000, { seamless: true });
  const advice = checkSeamless(project);
  check('an incompatible size is reported', advice.length === 2, JSON.stringify(advice));
  check('the period covers the major interval', advice[0].period === 640, String(advice[0]?.period));
  check('nearest-below comes first', advice[0].suggestions[0] === 640, JSON.stringify(advice[0]?.suggestions));
  check('a compatible size is silent', checkSeamless(sized(SQUARE_GRID, 1280, { seamless: true })).length === 0);
  check('advice only applies to seamless output', checkSeamless(sized(SQUARE_GRID, 1000)).length === 0);
}

// Project validation.
{
  const valid = JSON.parse(JSON.stringify(SQUARE_GRID));
  check('a preset round-trips through the parser', parseProject(valid).project.nodes.length === 2);
  check('a matching node version is quiet', parseProject(valid).warnings.length === 0);

  const drifted = JSON.parse(JSON.stringify(SQUARE_GRID));
  drifted.nodes[0].version = 0;
  check('a stale node version warns', parseProject(drifted).warnings.length === 1);

  expectThrows('an unknown node type is rejected', () => {
    const broken = JSON.parse(JSON.stringify(SQUARE_GRID));
    broken.nodes[0].type = 'not-a-node';
    return parseProject(broken);
  });

  expectThrows('a mismatched port type is rejected', () => {
    const broken = JSON.parse(JSON.stringify(SQUARE_GRID));
    broken.nodes.push({ id: 'noise', type: 'fractal-noise', version: 1, params: { scale: 100, detail: 3, contrast: 1, seed: 1 } });
    broken.edges = [{ from: 'noise', to: 'out', input: 'input' }];
    return parseProject(broken);
  });

  expectThrows('a missing required input is rejected', () => {
    const broken = JSON.parse(JSON.stringify(SQUARE_GRID));
    broken.edges = [];
    return parseProject(broken);
  });

  expectThrows('a cycle is rejected', () => {
    const broken = JSON.parse(JSON.stringify(SQUARE_GRID));
    broken.nodes.push({ id: 'a', type: 'levels', version: 1, params: { blackPoint: 0, whitePoint: 1, gamma: 1, invert: false } });
    broken.nodes.push({ id: 'b', type: 'levels', version: 1, params: { blackPoint: 0, whitePoint: 1, gamma: 1, invert: false } });
    broken.edges.push({ from: 'a', to: 'b', input: 'input' }, { from: 'b', to: 'a', input: 'input' });
    return parseProject(broken);
  });

  expectThrows('an unsupported format version is rejected', () => parseProject({ ...valid, formatVersion: 99 }));

  expectThrows('two edges into one input are rejected', () => {
    const broken = JSON.parse(JSON.stringify(SQUARE_GRID));
    broken.nodes.push({ id: 'grid2', type: 'grid', version: 1, params: { ...broken.nodes[0].params } });
    broken.edges.push({ from: 'grid2', to: 'out', input: 'input' });
    return parseProject(broken);
  });
}

// Node descriptors are what the editor and the future MCP server both read.
{
  const described = describeNodes() as { type: string; params: { key: string; default: unknown }[] }[];
  check('every node is described', described.length === listNodeDefinitions().length);
  check('descriptors survive JSON', JSON.parse(JSON.stringify(described)).length === described.length);
  for (const definition of listNodeDefinitions()) {
    const keys = definition.params.map((param) => param.key);
    check(`${definition.type}: param keys are unique`, new Set(keys).size === keys.length);
    for (const port of definition.inputs) {
      check(`${definition.type}: input ${port.name} has a known type`, port.type === 'colour' || port.type === 'mask');
    }
  }
  check('grid is a colour generator', getNodeDefinition('grid').output === 'colour');
  check('fractal noise is a mask generator', getNodeDefinition('fractal-noise').output === 'mask');
}

// The editor's layer model is DOM-free, so its reading of the graph is testable
// here rather than only through a browser.
{
  const base = toStack(SQUARE_GRID);
  check('a preset reads as a stack', base !== null);

  if (base) {
    // A layer with a mask must still read back as one layer, not fall out of the
    // stack view — and the graph it builds has to satisfy the engine.
    const masked = clone(base.layers);
    masked[0].mask = createMask(masked[0].id, 42);
    const project = fromStack({ layers: masked, output: base.output }, SQUARE_GRID.output, SQUARE_GRID);

    const parsed = parseProject(JSON.parse(JSON.stringify(project)));
    check('a masked layer builds a valid project', parsed.warnings.length === 0);
    check('the mask node is in the graph', project.nodes.some((node) => node.type === 'mask'));

    const reread = toStack(parsed.project);
    check('a masked layer reads back as one layer', reread !== null && reread.layers.length === 1);
    check('the mask survives the round trip', reread?.layers[0].mask?.generator.type === 'fractal-noise');
    check('the masked layer keeps its generator', reread?.layers[0].generator.type === 'grid');

    // And it renders: a mask that produced nothing would be worse than an error.
    const rendered = renderWhole(sized(parsed.project, 96));
    let opaque = 0;
    for (let i = 3; i < rendered.length; i += 4) if (rendered[i] > 0) opaque++;
    check('a masked layer renders something', opaque > 0);

    // Removing the mask returns to the original graph shape.
    const unmasked = clone(reread?.layers ?? []);
    unmasked[0].mask = null;
    const plain = fromStack({ layers: unmasked, output: base.output }, SQUARE_GRID.output, SQUARE_GRID);
    check('removing a mask removes its nodes', !plain.nodes.some((node) => node.type === 'mask'));
  }
}

// Greyscale export formats read tone or coverage, and the preview uses the same
// mapping so it cannot show something the export will not produce.
{
  check('alpha format reads coverage', greyscaleValue('alpha', 10, 20, 30, 128) === 128);
  check('luminance of opaque white is white', Math.round(greyscaleValue('luminance', 255, 255, 255, 255)) === 255);
  check('luminance of opaque black is black', Math.round(greyscaleValue('luminance', 0, 0, 0, 255)) === 0);
  check('luminance of nothing is white', Math.round(greyscaleValue('luminance', 0, 0, 0, 0)) === 255);
}

// The encoded PNG must decode back to exactly what the graph produced.
{
  const project = sized(PRESETS[1].project, 96);
  const result = await renderToPng(project, { bandRows: 13 });
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  check('PNG signature', [...bytes.subarray(0, 8)].join(',') === '137,80,78,71,13,10,26,10');

  const view = new DataView(bytes.buffer);
  let offset = 8;
  let idat = new Uint8Array(0);
  let width = 0;
  let height = 0;
  let colourType = -1;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      colourType = payload[9];
    }
    if (type === 'IDAT') {
      const merged = new Uint8Array(idat.length + payload.length);
      merged.set(idat);
      merged.set(payload, idat.length);
      idat = merged;
    }
    offset += 12 + length;
  }
  check('PNG dimensions', width === 96 && height === 96, `${width}x${height}`);
  check('PNG colour type is RGBA', colourType === 6, String(colourType));

  const raw = inflateSync(idat);
  const stride = 1 + width * 4;
  check('scanline count', raw.length === stride * height, `${raw.length} vs ${stride * height}`);

  const expected = renderWhole(project);
  let mismatches = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 4; x++) {
      if (raw[y * stride + 1 + x] !== expected[y * width * 4 + x]) mismatches++;
    }
  }
  check('encoded pixels match the rendered graph', mismatches === 0, `${mismatches} differing bytes`);
}

// Greyscale exports collapse to one channel.
{
  const project = sized(PRESETS[2].project, 64, { format: 'alpha' });
  const result = await renderToPng(project, { bandRows: 9 });
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  check('greyscale colour type', bytes[8 + 8 + 9 + 4 + 4] === 0, String(bytes[25]));
  check('greyscale IHDR width', view.getUint32(16) === 64);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
