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
presets, a project format, and a command-line renderer. No editor UI yet.

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

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # typecheck, then production build
npm test         # engine tests
```

The tests pin the properties the rest of the app is built on: that a tiled
render is byte-identical to an untiled one at any band height, that the same
recipe always produces the same picture, that seamless output really wraps, that
an encoded PNG decodes back to exactly what the graph produced, and that
`drawLine`'s scanline bounds agree with a full-buffer scan.

