# Texture Forge

A browser-based procedural texture editor for maps and design work. Textures are
generated from mathematical algorithms and drawing operations, then exported as
PNGs for use in Procreate. No AI-generated imagery, no stock assets.

See [`docs/SPEC.md`](docs/SPEC.md) for the V1 specification and the decisions
behind it.

## Status

**Stage 1: export feasibility probe.** The editor is not built yet.
The spec makes validating large exports on real hardware a precondition for
committing to the rendering architecture, so that is what this repository
currently contains.

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

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # typecheck, then production build
```

The engine deliberately contains no DOM dependencies, no build-time-only syntax
and no third-party packages, so it runs unchanged in a worker, in Node, and
under the MCP server planned after V1:

```sh
node --experimental-strip-types scripts/verify-png.ts ./out
```
