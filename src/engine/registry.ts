import { seedFor } from './random.ts';
import type { PixelBuffer, PortType, RenderContext } from './types.ts';

export interface RampStop {
  position: number;
  colour: string;
  alpha: number;
}

export type ParamValue = number | string | boolean | RampStop[];

export type ParamDefinition =
  | { kind: 'number'; key: string; label: string; min: number; max: number; step: number; unit?: string; default: number }
  | { kind: 'angle'; key: string; label: string; default: number }
  | { kind: 'colour'; key: string; label: string; default: string }
  | { kind: 'boolean'; key: string; label: string; default: boolean }
  | { kind: 'select'; key: string; label: string; options: { value: string; label: string }[]; default: string }
  | { kind: 'seed'; key: string; label: string; default: number }
  | { kind: 'ramp'; key: string; label: string; default: RampStop[] };

export interface InputDefinition {
  name: string;
  type: PortType;
  label: string;
  optional?: boolean;
}

export type ParamMap = Record<string, ParamValue>;

/** What a node needs to know once per render pass, before any tile is asked for. */
export interface PassInfo {
  outputWidth: number;
  outputHeight: number;
  seamless: boolean;
}

export interface NodeInstance {
  /** Inputs arrive in the order the definition declares them. */
  render(ctx: RenderContext, inputs: (PixelBuffer | null)[]): PixelBuffer;
}

export interface NodeDefinition {
  type: string;
  /** Bumped when a change alters what existing recipes render. */
  version: number;
  label: string;
  summary: string;
  category: 'generator' | 'adjustment' | 'output';
  output: PortType;
  inputs: InputDefinition[];
  params: ParamDefinition[];
  /** Whether this node can wrap at the image boundary. */
  seamless: boolean;
  /**
   * Output dimensions a seamless render must be a multiple of, per axis, or
   * null on an axis with no constraint. This is what lets the editor offer
   * compatible sizes for any generator rather than only for the grid.
   */
  seamlessPeriod?: (params: ParamMap) => { x: number | null; y: number | null };
  create(params: ParamMap, nodeId: string, pass: PassInfo): NodeInstance;
}

const registry = new Map<string, NodeDefinition>();

export function registerNode(definition: NodeDefinition): void {
  if (registry.has(definition.type)) throw new Error(`duplicate node type: ${definition.type}`);
  registry.set(definition.type, definition);
}

export function getNodeDefinition(type: string): NodeDefinition {
  const definition = registry.get(type);
  if (!definition) throw new Error(`unknown node type: ${type}`);
  return definition;
}

export function listNodeDefinitions(): NodeDefinition[] {
  return [...registry.values()].sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * Machine-readable descriptors for every node.
 *
 * The editor builds its control panels from this, and the MCP server planned
 * after V1 will serve the same data as tool schemas — one source, so the two
 * cannot drift apart.
 */
export function describeNodes(): unknown {
  return listNodeDefinitions().map((d) => ({
    type: d.type,
    version: d.version,
    label: d.label,
    summary: d.summary,
    category: d.category,
    output: d.output,
    seamless: d.seamless,
    inputs: d.inputs,
    params: d.params,
  }));
}

export function defaultParams(definition: NodeDefinition): ParamMap {
  const params: ParamMap = {};
  for (const param of definition.params) {
    params[param.key] = param.kind === 'ramp' ? param.default.map((s) => ({ ...s })) : param.default;
  }
  return params;
}

export function numberParam(params: ParamMap, key: string): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`param ${key} must be a number`);
  return value;
}

export function stringParam(params: ParamMap, key: string): string {
  const value = params[key];
  if (typeof value !== 'string') throw new Error(`param ${key} must be a string`);
  return value;
}

export function booleanParam(params: ParamMap, key: string): boolean {
  return params[key] === true;
}

export function rampParam(params: ParamMap, key: string): RampStop[] {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`param ${key} must be a non-empty ramp`);
  return [...(value as RampStop[])].sort((a, b) => a.position - b.position);
}

/** A node's random stream: its own seed param, mixed with its id. */
export function seedParamValue(params: ParamMap, key: string, nodeId: string): number {
  return seedFor(numberParam(params, key), nodeId);
}
