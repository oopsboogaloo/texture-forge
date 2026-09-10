# Procedural Texture Editor — V1 Specification

Version 1.8. Amends the original V1 spec with decisions taken during review and
during implementation; changes are listed under [Amendments](#amendments).

## Purpose

A web app for creating procedural textures for maps and design work, exporting
PNGs for use in Procreate. Textures are generated with mathematical algorithms
and drawing operations, without AI-generated imagery or stock assets.

## Platform targets

- **Primary:** Safari on iPadOS, M2 iPad Pro. Procreate on that hardware accepts
  canvases up to 11,585 × 11,585, so both 8,192 × 8,192 and 10,000 × 10,000
  exports import at full size.
- **Secondary:** desktop browsers.
- **Delivery:** a static site, deployed to GitHub Pages. No backend, no accounts.

## Architecture

Three consumers, one engine.

```
engine/          zero dependencies, no DOM, no build-time-only syntax
  ├── editor     browser UI; runs the engine inside a worker
  ├── cli        node --experimental-strip-types, renders a recipe to a PNG
  └── mcp        planned after V1; wraps the same entry points
```

The engine is a library over typed arrays, not a wrapper around a canvas. That
follows from the requirement that it operate independently of the editor: a
Canvas2D-based engine cannot run under Node without a native canvas dependency,
and its output would vary between rendering backends besides.

Consequences, all deliberate:

- **Own rasteriser.** The generators need three primitives — axis-aligned
  rectangles, thick line segments, filled ellipses — so the engine rasterises
  them directly. This is less work than carrying a native canvas dependency, and
  it makes output identical everywhere as a side effect.
- **Explicit PRNG.** No `Math.random`. Seeds run through an integer hash, and
  each node derives its stream from `hash(seed, nodeId)` so adding a node does
  not reshuffle the others.
- **Banded rendering.** Every generator can fill an arbitrary rectangle of the
  output at a given scale. Preview, tiled export and future MCP tile streaming
  are the same code path.
- **Declarative node registry.** Each node declares its controls, ranges,
  defaults, port types, version and seamless support in one place. The editor
  builds its panels from that registry, and MCP will serve the same descriptors
  as tool schemas, so the two cannot drift.

## User experience

Designed for touch use in iPad Safari, with desktop browser support. Essential
actions must not depend on hover, right-click or a keyboard.

The opening screen offers three presets: Square Grid, Paper and Worn Print.
Selecting one opens a preview and adjustable controls.

Composition in V1 is a **layer stack**: a reorderable vertical list of
generators, each with a blend mode, opacity and an optional mask input. The
recipe format underneath is a graph, so the node view can be added later without
a format change.

Include undo/redo, reset preset, preview zoom and a transparency checkerboard.

## Generators

All dimensions are in **output pixels**. The preview is a true downscale of the
export, so a 50 px cell in a 10,000 px export appears as a 5 px cell in a
1,000 px preview. Features below roughly one preview pixel — fine fibres, small
speckles — will not read accurately at preview scale; a 1:1 zoom inspector
covers that case rather than supersampling.

### Grid

- Square or rectangular cells.
- Cell dimensions and line thickness in pixels.
- Line colour and opacity.
- Transparent or solid-colour background.
- Horizontal and vertical offset.
- Optional heavier lines every configurable number of rows and columns,
  including five or ten.
- Separate colour and thickness for heavier lines.

### Fractal Noise

- Scale, detail, contrast and random seed.
- Provides mottling for paper and irregular patches for distress.
- Built on a lattice that wraps at the image edge, so it is tileable by
  construction.

### Paper Fibres

- Density, length, thickness, direction and random seed.
- Adds fine directional surface detail.

### Speckles

- Density, size range, irregularity and random seed.
- Produces paper flecks and missing-ink marks.

## Adjustments and composition

Ports carry one of two types, and the editor refuses mismatched connections:

- **Colour** — RGBA.
- **Mask** — single-channel greyscale.

Generators emit masks, with one exception: Grid emits colour, because the spec
gives it line, heavy-line and background colours of its own and splitting those
across three ramps would make the commonest texture the fiddliest to set up.
Everything else becomes visible by way of a Colour Ramp, which is what makes the
ramp worth having rather than an extra step.

Nodes:

- **Blend:** normal, multiply and screen, with opacity.
- **Mask:** use greyscale values to control transparency.
- **Levels:** adjust tonal range and contrast, with an invert toggle.
- **Colour Ramp:** map greyscale values to colours.
- **Output:** choose dimensions, background and PNG export.

## Presets

- **Square Grid:** clean grid overlay with optional major lines and transparent
  background.
- **Paper:** warm or neutral paper colour with adjustable mottling, fibres and
  flecks.
- **Worn Print:** irregular missing-ink flecks and patches. Exports as a
  greyscale mask or a coloured transparent texture, and can distress a grid
  within the editor.

Presets are recipe JSON files, not special-cased code.

## Rendering and export

- Custom pixel dimensions. Target exports include 8,192 × 8,192 and
  10,000 × 10,000.
- PNG with optional transparency. sRGB, 8 bits per channel.
- Three output formats: `rgba` for a colour PNG with transparency, and
  `luminance` or `alpha` for an 8-bit greyscale PNG — luminance where the
  texture's tone carries the information, alpha where its coverage does. Worn
  Print reads naturally either way, which is why the choice is explicit rather
  than inferred.
- Responsive lower-resolution preview while adjusting controls.
- Preview and final export preserve composition, seed and texture scale.
- Export progress, cancellation and useful failure messages.
- Export runs in a worker; the interface stays responsive throughout.
- Download the PNG to Files.

**Feasibility gate — passed.** Validated on the target M2 iPad Pro:
10,000 x 10,000 transparent PNGs export, save to Files and import into Procreate
at full size, with the interface responsive throughout. Safari caps a single
canvas at 16,777,216 pixels of area, so the engine renders in bands and streams
scanlines into the PNG without allocating a full-size surface. The
server-rendered fallback is not needed and is out of scope.

## Seamless mode

Optional seamless output for supported generators.

Grid exports must contain whole cells, and grids with heavier lines must also
align with the major-line interval. The editor offers compatible dimensions —
nearest valid sizes, defaulting to nearest-below — rather than silently changing
the pattern.

Paper and distress generators wrap at image boundaries when seamless mode is
enabled.

## Saving and provenance

A project is a single JSON document. It carries node connections, settings,
colours and seeds, plus an output block and a provenance header recording output
dimensions, application version, generator versions and the fact that generation
used procedural algorithms. There is no separate recipe file: the engine, the
CLI and later the MCP server all take exactly one input.

No external image imports in V1. The current project is kept in browser storage
for recovery where permitted.

The recipe records how a texture was produced; publisher acceptance depends on
the applicable agreement.

## Extensibility

New generators are added through code. Each declares its controls, defaults,
input/output types, generator version and seamless support. Saved projects
identify node versions.

Version policy is deliberately simple: recipes record the versions they were
made with, and the application warns when a recipe was made with a different
version of a node. It does not freeze old implementations, so a node change may
alter how an old recipe renders. Revisit if that proves painful.

## Scope boundaries

Not in V1:

- Node graph view. The layer stack covers all three presets; the recipe format
  is graph-shaped so this drops in later.
- MCP server. The engine is built to support it; the server itself is later.
- Accounts, cloud project library, offline/PWA operation, server-rendered
  export, external image imports.
- DPI-based sizing, Web Share sheet, supersampled preview.

Later additions may include hex and isometric grids, scratches, torn edges,
stone, burns, splatter and imported images.

## Amendments

Changes from V1.0, following review:

| Area | V1.0 | V1.1 |
| ---- | ---- | ---- |
| Assistant integration | not covered | engine operates independently of the editor, takes versioned JSON recipes, exposes discoverable node definitions, renders reproducibly; MCP itself out of V1 |
| Composition UI | node view in V1 | layer stack in V1, node view deferred; recipe format unchanged either way |
| Project files | project JSON plus companion recipe | one document |
| Invert | separate node | toggle on Levels |
| Hosting | unspecified | static site on GitHub Pages; no backend |
| Sharing | download or share sheet | download to Files |
| Reproducibility | unspecified | output must look the same across environments; identical output is a side effect of the engine owning its rasteriser |
| Node versions | implied freezing of old behaviour | recipes record versions and the app warns on mismatch; implementations are not frozen |
| CLI | not mentioned | in V1, as the proof the engine is editor-independent |

Further changes made while implementing V1.1:

| Area | Before | Now |
| ---- | ------ | --- |
| Greyscale export | one unspecified "greyscale mask" | explicit `luminance` and `alpha` formats, since Worn Print reads either way |
| Generator output types | unstated | generators emit masks; Grid alone emits colour |
| Paper Fibres | density, length, thickness, direction, seed | adds `spread`, without which every fibre is exactly parallel and the result reads as hatching |
| Presets | "recipe JSON files" | typed modules holding the same structure, so they are checked at build time; `presets <id>` prints one as JSON |
| Feasibility gate | to be validated | passed on an M2 iPad Pro; server-rendered fallback dropped |

Further changes made while implementing the editor:

| Area | Before | Now |
| ---- | ------ | --- |
| Preview zoom | "preview zoom" | Fit and 1:1, with drag-to-pan at 1:1 — the inspector for features finer than a preview pixel |
| Checkerboard | "transparency checkerboard" | light, low-contrast, and confined to the image, since these textures are dark marks on nothing and a checker that extends past the edge hides where the texture stops |
| Reset preset | listed | reopening a preset from the picker does this; there is no separate control |
| Mask | listed as an adjustment | a per-layer mask in the stack, with a generator and Levels of its own — the layer decides where it shows |
| Preview and format | preview preserves composition, seed and scale | it also follows the output format, since a greyscale export is a different picture rather than a different file type |

Further changes, after the first round of use:

| Area | Before | Now |
| ---- | ------ | --- |
| Generators | four | fifteen. Hex and isometric grids, brick, stripes, dots, cells, contours, marble, wood grain, scratches and splatter join the original four. Hex and isometric were listed as later additions; the rest follow from wanting generators that do something layering cannot. |
| Choosing a generator | a list of names | a gallery of samples, rendered by the engine when shown so they cannot fall out of step with what the generator makes |
| Presets | title and description | the same, with a sample of the result |
| Seamless advice | grid only, hard-coded | each node declares its own tiling period, so the advice covers every generator; a layer whose generator cannot wrap says so rather than letting a seam appear at export |

And again, on request:

| Area | Before | Now |
| ---- | ------ | --- |
| Generators | fifteen | twenty-two. Gravel, Torn Edges, Burns, Starfield, Nebula, Hatching and Maze. Scratches, torn edges, burns, stone and splatter were all listed as later additions; the rest follow the same principle of generators that do something layering cannot. |
| Noise | smooth only | optionally folded about the midline, which is what turns cloud into filament |

And again, after looking at hand-drawn hatching:

| Area | Before | Now |
| ---- | ------ | --- |
| Hatching strokes | straight, of one thickness | bowed across their length, swelling and thinning as contact varies, tapered where the hand lands and lifts, and hooked at the end where the wrist turns. Each is a sampled path rather than a segment. |
| Broken strokes | a gap between strokes | also within one: past a point the pen leaves the paper, driven by the same field that varies the weight, so a stroke thins before it skips |
| Hatching arrangements | one, two or three crossing families | a fourth: woven blocks, whose strokes turn a right angle from block to block |
| Rasteriser | line segments only | also paths, whose segments are combined by the greater coverage rather than composited in turn — without which a stroke beads at every joint, and a banded render disagrees with a whole one at every band boundary |
| Recipes missing a parameter | fail mid-render | filled from the descriptor's default, with a warning, so a recipe saved before a control existed still opens |

The assistant integration, which the original spec put after V1:

| Area | Before | Now |
| ---- | ------ | --- |
| MCP server | out of scope for V1, with the engine built to support it | built. Six tools over stdio: node discovery, presets, recipe validation, an image preview and a full-size render. Recipes composed through it open in the editor and render identically, since it is the same engine. |
| Dependencies | engine, CLI and web app have none | unchanged; the MCP server is the only part that takes any, so a recipe still renders anywhere |
