export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa`. Throws on anything else. */
export function parseColour(hex: string): Rgba {
  const text = hex.trim().replace(/^#/, '');
  // Without this, '#gggggg' parses to NaN channels that a clamped buffer turns
  // into black, quietly altering a texture instead of reporting the bad value.
  if (!/^[0-9a-fA-F]+$/.test(text)) throw new Error(`not a colour: ${hex}`);
  const expand = (c: string): number => parseInt(c + c, 16);
  if (text.length === 3) {
    return { r: expand(text[0]), g: expand(text[1]), b: expand(text[2]), a: 255 };
  }
  if (text.length === 6 || text.length === 8) {
    return {
      r: parseInt(text.slice(0, 2), 16),
      g: parseInt(text.slice(2, 4), 16),
      b: parseInt(text.slice(4, 6), 16),
      a: text.length === 8 ? parseInt(text.slice(6, 8), 16) : 255,
    };
  }
  throw new Error(`not a colour: ${hex}`);
}

export function formatColour(colour: Rgba): string {
  const hex = (v: number): string => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  const rgb = `#${hex(colour.r)}${hex(colour.g)}${hex(colour.b)}`;
  return colour.a >= 255 ? rgb : `${rgb}${hex(colour.a)}`;
}

export function mixColour(a: Rgba, b: Rgba, t: number): Rgba {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  };
}
