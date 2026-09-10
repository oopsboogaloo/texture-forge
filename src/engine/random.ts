/**
 * Deterministic integer hashing and streams. No Math.random anywhere in the
 * engine: the same recipe must produce the same picture in a browser worker,
 * under Node, and behind the MCP server planned after V1.
 */

export function hashInt(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash of a 2D lattice point, in [0,1). */
export function hash01(x: number, y: number, seed: number): number {
  return hashInt(x, y, seed) / 4294967296;
}

export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A node's stream is derived from its own id as well as the seed, so adding or
 * removing a node does not reshuffle the others.
 */
export function seedFor(seed: number, nodeId: string): number {
  return hashInt(seed, hashString(nodeId), 0x5bf03635);
}

export interface Random {
  /** Uniform in [0,1). */
  next(): number;
  /** Uniform in [min,max). */
  range(min: number, max: number): number;
}

export function createRandom(seed: number): Random {
  let state = (seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, range: (min, max) => min + next() * (max - min) };
}
