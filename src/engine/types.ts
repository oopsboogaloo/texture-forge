/** Ports carry one of two types, and the editor refuses mismatched connections. */
export type PortType = 'colour' | 'mask';

/** Straight (non-premultiplied) 8-bit RGBA. */
export interface ColourBuffer {
  readonly kind: 'colour';
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** Single-channel 8-bit greyscale. */
export interface MaskBuffer {
  readonly kind: 'mask';
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export type PixelBuffer = ColourBuffer | MaskBuffer;

export function createColourBuffer(width: number, height: number): ColourBuffer {
  return { kind: 'colour', width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function createMaskBuffer(width: number, height: number, fill = 0): MaskBuffer {
  const data = new Uint8ClampedArray(width * height);
  if (fill !== 0) data.fill(fill);
  return { kind: 'mask', width, height, data };
}

/** A rectangle of the destination image, in destination pixels. */
export interface Tile {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Everything a node needs to fill one tile.
 *
 * All node parameters are expressed in *output* pixels, and `scale` is the
 * number of destination pixels per output pixel — 1 for an export, 0.1 for a
 * tenth-size preview. This is what makes a preview a true downscale of the
 * export rather than a differently-composed image: the same recipe at a
 * different scale is the same picture, larger or smaller.
 */
export interface RenderContext {
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly scale: number;
  readonly tile: Tile;
  readonly seamless: boolean;
}

/** Output-space coordinate of the leading edge of destination column `i`. */
export function outputX(ctx: RenderContext, i: number): number {
  return (ctx.tile.x + i) / ctx.scale;
}

/** Output-space coordinate of the leading edge of destination row `j`. */
export function outputY(ctx: RenderContext, j: number): number {
  return (ctx.tile.y + j) / ctx.scale;
}
