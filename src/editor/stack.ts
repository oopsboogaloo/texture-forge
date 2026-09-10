import type { Project, ProjectEdge, ProjectNode } from '../engine/project.ts';
import { defaultParams, getNodeDefinition, type ParamMap } from '../engine/registry.ts';

/**
 * The editor presents the graph as a stack of layers.
 *
 * A layer is a generator plus the chain that makes it visible — Levels and a
 * Colour Ramp for a mask generator, nothing for Grid, which emits colour — and
 * the blend that composites it onto everything below. The saved project stays a
 * graph, so the node view deferred out of V1 can be added later without a format
 * change, and so a recipe means the same thing to the engine and to MCP.
 */
export interface StackLayer {
  /** Stable identity: the generator node's id. */
  id: string;
  generator: ProjectNode;
  levels: ProjectNode | null;
  ramp: ProjectNode | null;
  blendMode: string;
  blendOpacity: number;
  /** Preserved so ids survive a round trip and edits stay minimal. */
  blendNodeId: string | null;
}

export interface Stack {
  /** Bottom layer first, matching the order they composite in. */
  layers: StackLayer[];
  output: ProjectNode;
}

function sourceOf(project: Project, nodeId: string, input: string): ProjectNode | null {
  const edge = project.edges.find((candidate) => candidate.to === nodeId && candidate.input === input);
  if (!edge) return null;
  return project.nodes.find((node) => node.id === edge.from) ?? null;
}

function readChain(project: Project, terminal: ProjectNode): Omit<StackLayer, 'blendMode' | 'blendOpacity' | 'blendNodeId'> | null {
  let ramp: ProjectNode | null = null;
  let levels: ProjectNode | null = null;
  let node: ProjectNode | null = terminal;

  if (node && node.type === 'colour-ramp') {
    ramp = node;
    node = sourceOf(project, node.id, 'input');
  }
  if (node && node.type === 'levels') {
    levels = node;
    node = sourceOf(project, node.id, 'input');
  }
  if (!node || getNodeDefinition(node.type).category !== 'generator') return null;
  return { id: node.id, generator: node, levels, ramp };
}

/**
 * Reads a project as a stack, or returns null if its graph is a shape the stack
 * view cannot represent. Every V1 project comes from a preset or from this
 * editor, so null means a hand-edited file rather than an ordinary case.
 */
export function toStack(project: Project): Stack | null {
  const output = project.nodes.find((node) => node.id === project.outputNode);
  if (!output) return null;

  const blends: ProjectNode[] = [];
  let node = sourceOf(project, output.id, 'input');
  while (node && node.type === 'blend') {
    blends.push(node);
    node = sourceOf(project, node.id, 'base');
  }
  if (!node) return null;

  const bottom = readChain(project, node);
  if (!bottom) return null;

  // Collected from the top down, so reverse into compositing order.
  blends.reverse();

  const layers: StackLayer[] = [{ ...bottom, blendMode: 'normal', blendOpacity: 1, blendNodeId: null }];
  for (const blend of blends) {
    const source = sourceOf(project, blend.id, 'layer');
    if (!source) return null;
    const chain = readChain(project, source);
    if (!chain) return null;
    layers.push({
      ...chain,
      blendMode: String(blend.params.mode ?? 'normal'),
      blendOpacity: Number(blend.params.opacity ?? 1),
      blendNodeId: blend.id,
    });
  }

  return { layers, output };
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** Rebuilds a project from a stack, keeping node ids stable wherever they exist. */
export function fromStack(stack: Stack, output: Project['output'], template: Project): Project {
  const nodes: ProjectNode[] = [];
  const edges: ProjectEdge[] = [];
  const taken = new Set<string>();

  let base: string | null = null;
  stack.layers.forEach((layer, index) => {
    const generatorId = uniqueId(layer.generator.id, taken);
    nodes.push({ ...layer.generator, id: generatorId });
    let tail = generatorId;

    if (layer.levels) {
      const id = uniqueId(layer.levels.id, taken);
      nodes.push({ ...layer.levels, id });
      edges.push({ from: tail, to: id, input: 'input' });
      tail = id;
    }
    if (layer.ramp) {
      const id = uniqueId(layer.ramp.id, taken);
      nodes.push({ ...layer.ramp, id });
      edges.push({ from: tail, to: id, input: 'input' });
      tail = id;
    }

    if (index === 0) {
      base = tail;
      return;
    }

    const blendId = uniqueId(layer.blendNodeId ?? `${generatorId}-blend`, taken);
    nodes.push({
      id: blendId,
      type: 'blend',
      version: getNodeDefinition('blend').version,
      params: { mode: layer.blendMode, opacity: layer.blendOpacity },
    });
    edges.push({ from: base as string, to: blendId, input: 'base' });
    edges.push({ from: tail, to: blendId, input: 'layer' });
    base = blendId;
  });

  const outputId = uniqueId(stack.output.id, taken);
  nodes.push({ ...stack.output, id: outputId });
  if (base) edges.push({ from: base, to: outputId, input: 'input' });

  return { ...template, output, nodes, edges, outputNode: outputId };
}

function node(type: string, id: string, params?: ParamMap): ProjectNode {
  const definition = getNodeDefinition(type);
  return { id, type, version: definition.version, params: { ...defaultParams(definition), ...params } };
}

/** A new layer, with the chain its generator's output type requires. */
export function createLayer(generatorType: string, seed: number): StackLayer {
  const definition = getNodeDefinition(generatorType);
  const id = `${generatorType}-${seed.toString(36)}`;
  const generator = node(generatorType, id);
  if (definition.params.some((param) => param.kind === 'seed')) generator.params.seed = seed % 10000;

  if (definition.output === 'colour') {
    return { id, generator, levels: null, ramp: null, blendMode: 'normal', blendOpacity: 1, blendNodeId: null };
  }

  return {
    id,
    generator,
    levels: node('levels', `${id}-levels`),
    ramp: node('colour-ramp', `${id}-ramp`, {
      stops: [
        { position: 0, colour: '#2b2b2b', alpha: 0 },
        { position: 1, colour: '#2b2b2b', alpha: 1 },
      ],
    }),
    blendMode: 'normal',
    blendOpacity: 1,
    blendNodeId: null,
  };
}
