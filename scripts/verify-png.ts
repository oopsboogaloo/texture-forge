/**
 * Renders each probe pattern at a small size and writes the PNGs to disk so the
 * encoder can be checked outside a browser. Run with:
 *   node --experimental-strip-types scripts/verify-png.ts <outDir>
 */
import { writeFile } from 'node:fs/promises';
import { encodePng } from '../src/engine/png/encoder.ts';
import { createProbeRenderer, type ProbePattern } from '../src/engine/probe-patterns.ts';

const outDir = process.argv[2] ?? '.';
const size = 256;

for (const pattern of ['grid', 'paper', 'static'] as ProbePattern[]) {
  const result = await encodePng({
    width: size,
    height: size,
    colourType: 6,
    bandRows: 37, // deliberately not a divisor of the height
    renderBand: createProbeRenderer({ pattern, width: size, height: size, seed: 1 }),
  });
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  await writeFile(`${outDir}/${pattern}.png`, bytes);
  console.log(`${pattern}: ${bytes.length} bytes`);
}
