# Texture Forge

A browser-based procedural texture editor for maps and design work. Textures are
generated from mathematical algorithms and drawing operations, then exported as
PNGs for use in Procreate. No AI-generated imagery, no stock assets.

See [`docs/SPEC.md`](docs/SPEC.md) for the V1 specification and the decisions
behind it.

## Status

**Stage 1 — export feasibility probe: done.** Validated on an M2 iPad Pro:
10,000 x 10,000 transparent PNGs export, save to Files and import into Procreate
at full size, with the interface staying responsive throughout. The rendering
architecture is settled on the back of that.

**Stage 2 — the engine: done.** Four generators, five adjustments, three
presets, a project format, and a command-line renderer.

**Stage 3 — the editor: done.** Preset picker, layer stack, live preview with a
transparency checkerboard and 1:1 inspection, export with progress and cancel,
undo/redo, save and reopen, and local recovery.

## The probe

The probe renders a texture in horizontal bands and streams the scanlines
through the platform deflate implementation into a PNG. A full-size canvas is
never allocated — which matters, because Safari caps a single canvas at
16,777,216 pixels of area and a 10,000 × 10,000 image is six times that, quite
apart from the 400 MB an RGBA buffer that size would need.

Three patterns bracket the cost of real presets:

- **grid** — transparent background, thin lines. Cheapest, most compressible.
- **paper** — four octaves of tileable value noise. Representative.
- **static** — per-pixel white noise. The worst case deflate can be handed.

### Deployment

Pages has to be enabled once by hand: **Settings → Pages → Build and deployment
→ Source: GitHub Actions**. The workflow cannot do this itself — creating a
Pages site is not something the workflow token is allowed to do. After that,
every push to `main` deploys, and the probe is at
<https://oopsboogaloo.github.io/texture-forge/>.

### Running it on the iPad

Open the deployed page, pick a size and pattern, and tap **Start export**.
Everything is reported on the page itself, including failures, because Safari on
iPadOS offers no reachable console.

What to report back:

1. Whether 10,000 × 10,000 completes at all, for each pattern.
2. Wall-clock time and resulting file size (both are logged).
3. Whether the page survives — a tab reload mid-run means the memory ceiling was
   hit, and that is a result worth having.
4. Whether the download link actually saves to Files, and whether Procreate
   imports the result at full size.
5. Whether the interface stays responsive while a large export runs.

### Baseline

Measured under Node on an x86 container, same code path, band height 128:

| Pattern | Total | Generate | Encode | File | Peak RSS |
| ------- | ----- | -------- | ------ | ---- | -------- |
| grid    | 1.3 s | 0.3 s    | 1.0 s  | 2.1 MB  | 84 MB  |
| paper   | 8.5 s | 3.9 s    | 4.6 s  | 18.2 MB | 129 MB |

Safari will be slower and the Blob has to survive being handed to a download, so
these are a floor rather than a prediction.

## The editor

The opening screen offers the three presets. Choosing one opens a preview and a
stack of layers, each a generator with its own controls, a blend mode, an
opacity and an optional mask that decides where it shows. Layers can be added,
reordered and deleted; every control is built from the node registry, so a new
generator gets a working panel the moment it declares its parameters.

Composition in V1 is a stack rather than the node view the original spec called
for. The saved project is still a graph — the stack is a reading of it — so the
node view can be added later without a format change. The stack expresses all
three presets, and it is a great deal less to get wrong on a touch screen.

Two things the interface is careful about, both of which took a bug to learn:

- **Controls are not rebuilt while they are in use.** Replacing a slider mid-drag
  ends the drag, and replacing a text field discards what has been typed into it
  but not yet confirmed. Repaints wait for the gesture to finish.
- **No handler holds onto the project it was built from.** A captured copy goes
  stale as soon as anything else changes, and writing it back silently reverts
  that change — which is how editing the height used to reset the width.

## Generators

Twenty-two, chosen so that each does something the others cannot be layered into:

| | |
| --- | --- |
| **Grid** | Square or rectangular cells with optional heavier lines |
| **Hex Grid** | Hexagonal cells, as the boundaries of a triangular lattice |
| **Isometric Grid** | Thirty-degree line families, with optional uprights |
| **Brick** | Courses of offset rectangles |
| **Stripes** | Parallel lines at any angle, optionally crossed |
| **Dots** | A regular lattice of dots, with size variation and scatter |
| **Cells** | Cracked stone, scales and crazing, read as edges, flat cells or distance |
| **Contours** | Iso-lines through a noise field, with heavier lines at an interval |
| **Marble** | Bands folded by noise |
| **Wood Grain** | Hard thin rings drifting along the plank |
| **Fractal Noise** | Mottling and irregular patches |
| **Paper Fibres** | Fine directional surface detail |
| **Scratches** | Long curving marks |
| **Speckles** | Paper flecks and missing-ink marks |
| **Splatter** | Thrown ink: a body with droplets around it |
| **Gravel** | Packed stones with ground between them, each shaded separately |
| **Torn Edges** | A ragged edge eaten in from the border |
| **Burns** | Scorched holes with charred margins |
| **Starfield** | Many faint stars, a few bright, with diffraction spikes |
| **Nebula** | Billowing gas: folded noise pulled into sheets and cavities |
| **Hatching** | Drawn strokes rather than ruled lines: bowed, of uneven weight, hooking where the hand lifts |
| **Maze** | A perfect maze carved on a torus, so its passages cross the edges |

Several are structurally distinct from the rest and worth calling out.
**Cells** builds a wrapping lattice of sites and reads the boundary between the
two nearest — which is also how Hex Grid is drawn, since a hex grid is the
boundary diagram of a triangular lattice. **Contours** follows levels of a noise
field rather than drawing on top of it, so the lines nest and close and their
spacing reports the steepness beneath them. **Marble** and **Wood Grain** warp
the coordinates the bands are evaluated at, which is the one thing layering
cannot reproduce: the bands bend and fold rather than merely getting dirtier.
**Nebula** folds its noise about the midline before summing, leaving creases
that read as filaments, then warps the result. **Maze** carves a perfect maze by
depth-first search *on a torus*, so its passages run off one edge and arrive at
the other — a maze generated on a plain grid meets a wall of dead ends at every
seam.

**Hatching** models the pen rather than the line. A stroke bows slightly across
its length, swells and thins as contact varies, tapers where the hand lands and
lifts, and hooks at the end where the wrist turns — and past a point the pen
leaves the paper altogether, which is what a dry nib does and what a random gap
does not. One field drives both the swelling and the breaking, because they are
one phenomenon: a stroke thins before it skips and comes back thin.

| Control | What it does |
| ------- | ------------ |
| Curve | How far the stroke bows across its length |
| End hook | The extra turn where the hand lifts |
| Weight scale | How far along the stroke its weight varies |
| Weight variation | How much of the line's weight that accounts for |
| Break up | How readily the pen leaves the paper |

Four arrangements: one family of strokes, two crossing, three crossing, and
**woven blocks** — square blocks whose strokes turn a right angle from one to
the next, so they read as strips passing over and under one another. The grid
turns with the angle, so the strokes always run along the block edges; a grid
left square to the canvas while the strokes ran diagonally would read as a
pinwheel instead.

Two are edge treatments rather than fills. **Torn Edges** and **Burns** describe
where the sheet stops, so a tear cannot tile — it says so, and the editor warns
when a layer that cannot wrap is used in a seamless texture.

The picker shows a sample of each, rendered by the engine at the moment it is
displayed rather than shipped as an image — so a change to a generator's
defaults changes its thumbnail with it.

## The engine

The engine is a plain TypeScript library over typed arrays. It has no DOM
dependencies, no third-party packages and no build-time-only syntax, so the same
source runs in a browser worker, under Node, and later behind the MCP server
planned after V1.

It rasterises its own shapes rather than calling into a canvas. That is not
purism: a canvas-based engine cannot run under Node without a native dependency,
and its antialiasing differs between backends, so identical recipes would render
differently depending on where they ran.

```sh
npm run render nodes                 # every node's controls, ranges and versions as JSON
npm run render presets               # list presets
npm run render presets paper         # a preset as a project file
npm run render render paper -o p.png --size 4096
npm run render render project.json -o out.png --size 10000 --band-rows 128
npm run render render paper -o preview.png --scale 0.125
```

`nodes` is the discoverability surface: the editor builds its controls from it,
and MCP will serve the same descriptors as tool schemas, so the two cannot drift.

### Rendering at full size

Measured under Node at 10,000 x 10,000 (100 megapixels) with 128-row bands:

| Preset      | Total  | Generate | Encode | File     |
| ----------- | ------ | -------- | ------ | -------- |
| Square Grid | 5.3 s  | 3.8 s    | 1.5 s  | 2.2 MB   |
| Worn Print  | 14.5 s | 9.7 s    | 4.6 s  | 18.7 MB  |
| Paper       | 32.7 s | 15.9 s   | 15.5 s | 92.0 MB  |

Paper is the expensive case: a quarter of a million fibres and fine mottling
leave almost no two adjacent pixels alike, which is as hard as PNG compression
gets short of white noise.

## As an MCP server

The engine runs headless, takes versioned JSON recipes and describes its own
nodes, which is what an assistant needs to use it directly.

```sh
npm run mcp     # speaks MCP over stdio
```

To connect it from Claude Code, from this directory:

```sh
claude mcp add texture-forge -- node --experimental-strip-types src/mcp/server.ts
```

Six tools: `list_nodes` (every node with its controls, ranges, defaults, port
types and version — the authoritative description of what can be built),
`list_presets`, `get_recipe`, `validate_recipe`, `preview_texture` and
`render_texture`.

`preview_texture` returns the image itself, so a texture can be looked at and
adjusted before committing to a full-size render — in the recipe's own output
format, because a preview in a different format is a different picture.
`render_texture` writes a PNG to a path you give it and nothing else. Recipes
composed this way open in the editor and render identically, because it is the
same engine either way.

`validate_recipe` passing means the recipe renders: it checks parameters
against the descriptors `list_nodes` publishes — missing, wrong kind, or
outside the published range — as well as the shape of the graph. The range
check is not fussiness: counts are given per megapixel and multiplied by the
output area, so a value far above a control's maximum allocates far more than
the editor could ever ask for.

The MCP server is the only part with third-party dependencies — the engine, the
CLI and the web app have none, so a recipe still renders anywhere.

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # typecheck, then production build
npm test         # engine tests
npm run test:mcp # drives the MCP server over a real stdio connection
```

The tests pin the properties the rest of the app is built on: that a tiled
render is byte-identical to an untiled one at any band height, that the same
recipe always produces the same picture, that seamless output really wraps, that
an encoded PNG decodes back to exactly what the graph produced, and that
`drawLine`'s scanline bounds agree with a full-buffer scan.

