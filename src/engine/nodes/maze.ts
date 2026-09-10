import { edgeCoverage } from '../field.ts';
import { createRandom } from '../random.ts';
import { numberParam, registerNode, seedParamValue, type NodeInstance, type ParamMap, type PassInfo } from '../registry.ts';
import { createMaskBuffer, outputX, outputY, type PixelBuffer, type RenderContext } from '../types.ts';

/**
 * A perfect maze: exactly one path between any two cells, no loops.
 *
 * Carved by depth-first search, and carved *on a torus* — the cell past the
 * right-hand column is the left-hand one — so the passages run off one edge and
 * arrive at the other, and the maze tiles. A maze generated on a plain grid
 * would meet a wall of dead ends at every seam.
 *
 * The walls live on cell boundaries, so a pixel need only ask about the four
 * sides of the cell it is in.
 */
class MazeNode implements NodeInstance {
  private readonly columns: number;
  private readonly rows: number;
  private readonly cellWidth: number;
  private readonly cellHeight: number;
  /** Wall on the west side of each cell. */
  private readonly west: Uint8Array;
  /** Wall on the north side of each cell. */
  private readonly north: Uint8Array;
  private readonly thickness: number;

  constructor(params: ParamMap, nodeId: string, pass: PassInfo) {
    const requested = Math.max(8, numberParam(params, 'cellSize'));
    // Whole cells across and down, which is what lets the torus close up.
    this.columns = Math.max(2, Math.round(pass.outputWidth / requested));
    this.rows = Math.max(2, Math.round(pass.outputHeight / requested));
    this.cellWidth = pass.outputWidth / this.columns;
    this.cellHeight = pass.outputHeight / this.rows;
    this.thickness = numberParam(params, 'wallThickness');

    const cells = this.columns * this.rows;
    this.west = new Uint8Array(cells).fill(1);
    this.north = new Uint8Array(cells).fill(1);

    const random = createRandom(seedParamValue(params, 'seed', nodeId));
    const visited = new Uint8Array(cells);
    const stack: number[] = [0];
    visited[0] = 1;
    let remaining = cells - 1;

    // Iterative rather than recursive: a large canvas can hold hundreds of
    // thousands of cells, and the call stack would not survive it.
    while (stack.length > 0 && remaining > 0) {
      const current = stack[stack.length - 1];
      const cx = current % this.columns;
      const cy = (current / this.columns) | 0;

      const options: { index: number; direction: number }[] = [];
      for (let direction = 0; direction < 4; direction++) {
        const nx = (cx + (direction === 0 ? 1 : direction === 2 ? -1 : 0) + this.columns) % this.columns;
        const ny = (cy + (direction === 1 ? 1 : direction === 3 ? -1 : 0) + this.rows) % this.rows;
        const index = ny * this.columns + nx;
        if (!visited[index]) options.push({ index, direction });
      }

      if (options.length === 0) {
        stack.pop();
        continue;
      }

      const chosen = options[Math.min(options.length - 1, Math.floor(random.next() * options.length))];
      // Removing the wall between the two cells is what makes the passage.
      if (chosen.direction === 0) this.west[chosen.index] = 0;
      else if (chosen.direction === 2) this.west[current] = 0;
      else if (chosen.direction === 1) this.north[chosen.index] = 0;
      else this.north[current] = 0;

      visited[chosen.index] = 1;
      remaining--;
      stack.push(chosen.index);
    }
  }

  render(ctx: RenderContext): PixelBuffer {
    const buffer = createMaskBuffer(ctx.tile.width, ctx.tile.height);
    const half = this.thickness / 2;

    for (let j = 0; j < ctx.tile.height; j++) {
      const y = outputY(ctx, j) + 0.5 / ctx.scale;
      const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellHeight)));
      const withinY = y - cy * this.cellHeight;
      const southRow = (cy + 1) % this.rows;

      for (let i = 0; i < ctx.tile.width; i++) {
        const x = outputX(ctx, i) + 0.5 / ctx.scale;
        const cx = Math.min(this.columns - 1, Math.max(0, Math.floor(x / this.cellWidth)));
        const withinX = x - cx * this.cellWidth;
        const eastColumn = (cx + 1) % this.columns;
        const cell = cy * this.columns + cx;

        let coverage = 0;
        const sides = [
          { present: this.west[cell], distance: withinX },
          { present: this.west[cy * this.columns + eastColumn], distance: this.cellWidth - withinX },
          { present: this.north[cell], distance: withinY },
          { present: this.north[southRow * this.columns + cx], distance: this.cellHeight - withinY },
        ];

        for (const side of sides) {
          if (!side.present) continue;
          const line = edgeCoverage(side.distance, half, ctx.scale);
          coverage = coverage + line - coverage * line;
        }
        buffer.data[j * ctx.tile.width + i] = coverage * 255;
      }
    }
    return buffer;
  }
}

registerNode({
  type: 'maze',
  version: 1,
  label: 'Maze',
  summary: 'A perfect maze carved on a torus, so its passages continue across the edges.',
  category: 'generator',
  output: 'mask',
  inputs: [],
  seamless: true,
  seamlessPeriod: () => ({ x: null, y: null }),
  params: [
    { kind: 'number', key: 'cellSize', label: 'Cell size', min: 8, max: 600, step: 1, unit: 'px', default: 90 },
    { kind: 'number', key: 'wallThickness', label: 'Wall thickness', min: 0.5, max: 120, step: 0.5, unit: 'px', default: 8 },
    { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  create: (params, nodeId, pass) => new MazeNode(params, nodeId, pass),
});
