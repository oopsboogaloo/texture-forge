import './nodes/index.ts';
import { getNodeDefinition, type ParamMap, type ParamValue } from './registry.ts';
import { APPLICATION_NAME, APPLICATION_VERSION, PROJECT_FORMAT, PROJECT_FORMAT_VERSION } from './version.ts';

export type OutputFormat = 'rgba' | 'luminance' | 'alpha';

export interface ProjectNode {
  id: string;
  type: string;
  /** The node version this recipe was made with. */
  version: number;
  params: ParamMap;
}

export interface ProjectEdge {
  from: string;
  to: string;
  input: string;
}

export interface ProjectOutput {
  width: number;
  height: number;
  seamless: boolean;
  /**
   * `rgba` is a colour PNG with transparency. `luminance` and `alpha` each
   * collapse the result to an 8-bit greyscale PNG — luminance for a texture
   * whose tone carries the information, alpha for one whose coverage does.
   */
  format: OutputFormat;
}

export interface Project {
  format: string;
  formatVersion: number;
  application: { name: string; version: string };
  provenance: { generation: string; createdAt?: string };
  output: ProjectOutput;
  nodes: ProjectNode[];
  edges: ProjectEdge[];
  outputNode: string;
}

export interface LoadedProject {
  project: Project;
  /** Non-fatal notes, chiefly node versions that differ from this build's. */
  warnings: string[];
}

function fail(message: string): never {
  throw new Error(`invalid project: ${message}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}

/**
 * Validates a project and reports version drift.
 *
 * Node versions are recorded and warned about rather than pinned to frozen
 * implementations: a recipe made with an older build may render slightly
 * differently, and the warning is how that surfaces.
 */
export function parseProject(input: unknown): LoadedProject {
  const raw = asRecord(input, 'project');
  const warnings: string[] = [];

  if (raw.format !== PROJECT_FORMAT) fail(`format must be ${PROJECT_FORMAT}`);
  if (raw.formatVersion !== PROJECT_FORMAT_VERSION) {
    fail(`unsupported formatVersion ${String(raw.formatVersion)}; this build reads ${PROJECT_FORMAT_VERSION}`);
  }

  const output = asRecord(raw.output, 'output');
  const width = Number(output.width);
  const height = Number(output.height);
  if (!Number.isInteger(width) || width < 1) fail('output.width must be a positive integer');
  if (!Number.isInteger(height) || height < 1) fail('output.height must be a positive integer');
  const format = String(output.format ?? 'rgba');
  if (format !== 'rgba' && format !== 'luminance' && format !== 'alpha') fail(`unknown output.format ${format}`);

  if (!Array.isArray(raw.nodes)) fail('nodes must be an array');
  const nodes: ProjectNode[] = raw.nodes.map((entry, i) => {
    const node = asRecord(entry, `nodes[${i}]`);
    const id = String(node.id ?? '');
    if (!id) fail(`nodes[${i}].id is required`);
    const type = String(node.type ?? '');
    const definition = getNodeDefinition(type);
    const version = Number(node.version ?? definition.version);
    if (version !== definition.version) {
      warnings.push(
        `node ${id} (${type}) was saved at version ${version}; this build has version ${definition.version}, ` +
          'so it may render differently',
      );
    }
    const params = { ...(asRecord(node.params ?? {}, `nodes[${i}].params`) as ParamMap) };

    // A recipe saved before a control existed has no value for it. Filling it
    // from the descriptor's default and saying so keeps that recipe openable,
    // which a hard refusal would not; it is the same trade the version warning
    // above already makes, and the alternative is a node failing mid-render on
    // a parameter its author never had the chance to set.
    for (const param of definition.params) {
      if (params[param.key] !== undefined) continue;
      params[param.key] = param.kind === 'ramp' ? param.default.map((stop) => ({ ...stop })) : param.default;
      warnings.push(`node ${id} (${type}) has no ${param.key}; using this build's default`);
    }

    return { id, type, version, params };
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) fail('node ids must be unique');

  if (!Array.isArray(raw.edges)) fail('edges must be an array');
  const edges: ProjectEdge[] = raw.edges.map((entry, i) => {
    const edge = asRecord(entry, `edges[${i}]`);
    const from = String(edge.from ?? '');
    const to = String(edge.to ?? '');
    const input = String(edge.input ?? '');
    const source = byId.get(from) ?? fail(`edges[${i}] refers to unknown node ${from}`);
    const target = byId.get(to) ?? fail(`edges[${i}] refers to unknown node ${to}`);
    const targetDefinition = getNodeDefinition(target.type);
    const port = targetDefinition.inputs.find((candidate) => candidate.name === input);
    if (!port) fail(`node ${to} has no input named ${input}`);
    const sourceType = getNodeDefinition(source.type).output;
    if (sourceType !== port.type) {
      fail(`cannot connect ${from} (${sourceType}) to ${to}.${input} (${port.type})`);
    }
    return { from, to, input };
  });

  const connected = new Set<string>();
  for (const edge of edges) {
    const port = `${edge.to}.${edge.input}`;
    // Two edges into one port would leave the renderer picking whichever came
    // first in the file, so reordering otherwise identical JSON would change
    // the picture.
    if (connected.has(port)) fail(`input ${port} has more than one connection`);
    connected.add(port);
  }

  const outputNode = String(raw.outputNode ?? '');
  const terminal = byId.get(outputNode) ?? fail(`outputNode ${outputNode} does not exist`);
  if (getNodeDefinition(terminal.type).category !== 'output') fail(`outputNode ${outputNode} is not an output node`);

  for (const node of nodes) {
    for (const port of getNodeDefinition(node.type).inputs) {
      if (port.optional) continue;
      const connected = edges.some((edge) => edge.to === node.id && edge.input === port.name);
      if (!connected) fail(`node ${node.id} has no connection to required input ${port.name}`);
    }
  }

  const provenance = asRecord(raw.provenance ?? {}, 'provenance');
  const application = asRecord(raw.application ?? {}, 'application');

  const project: Project = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    application: {
      name: String(application.name ?? APPLICATION_NAME),
      version: String(application.version ?? APPLICATION_VERSION),
    },
    provenance: {
      generation: String(provenance.generation ?? 'procedural-algorithms'),
      ...(provenance.createdAt ? { createdAt: String(provenance.createdAt) } : {}),
    },
    output: { width, height, seamless: output.seamless === true, format: format as OutputFormat },
    nodes,
    edges,
    outputNode,
  };

  assertAcyclic(project);
  return { project, warnings };
}

/**
 * Rejects a cycle anywhere in the graph, including in a branch the output node
 * cannot reach — an unreachable cycle is still a malformed recipe, and saying so
 * on load beats discovering it when the branch is later connected.
 */
export function assertAcyclic(project: Project): void {
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string, trail: string[]): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') fail(`cycle through ${[...trail, id].join(' -> ')}`);
    state.set(id, 'visiting');
    for (const edge of project.edges) {
      if (edge.to === id) visit(edge.from, [...trail, id]);
    }
    state.set(id, 'done');
  };

  for (const node of project.nodes) visit(node.id, []);
}

/** Nodes in an order where every input is produced before it is consumed. */
export function topologicalOrder(project: Project): ProjectNode[] {
  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const state = new Map<string, 'visiting' | 'done'>();
  const order: ProjectNode[] = [];

  const visit = (id: string, trail: string[]): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') fail(`cycle through ${[...trail, id].join(' -> ')}`);
    state.set(id, 'visiting');
    for (const edge of project.edges) {
      if (edge.to === id) visit(edge.from, [...trail, id]);
    }
    state.set(id, 'done');
    const node = byId.get(id);
    if (node) order.push(node);
  };

  visit(project.outputNode, []);
  return order;
}

/** Records how the texture was produced, alongside the recipe that produced it. */
export function stampProvenance(project: Project): Project {
  return {
    ...project,
    application: { name: APPLICATION_NAME, version: APPLICATION_VERSION },
    provenance: { generation: 'procedural-algorithms', createdAt: new Date().toISOString() },
  };
}

/**
 * Parameter problems that would stop a recipe rendering.
 *
 * `parseProject` checks the shape of the graph but copies parameters straight
 * through, so a missing or mistyped value only surfaces deep inside a node
 * partway through a render. Checking them against the descriptors the registry
 * already publishes means a recipe that validates is a recipe that renders.
 *
 * The range check earns its place twice over: counts are given per megapixel
 * and multiplied by the output area, so a value far above the descriptor's
 * maximum allocates far more than any control could ask for.
 *
 * Unknown keys are left alone. A parameter dropped in a later node version is
 * exactly the kind of drift the version warning is for, and refusing to render
 * over a leftover key would break old recipes for nothing.
 */
export function checkParams(project: Project): string[] {
  const problems: string[] = [];

  for (const node of project.nodes) {
    const definition = getNodeDefinition(node.type);
    for (const param of definition.params) {
      const value = node.params[param.key];
      const where = `node ${node.id} (${node.type}) param ${param.key}`;

      if (value === undefined) {
        problems.push(`${where} is missing`);
        continue;
      }

      switch (param.kind) {
        case 'number':
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            problems.push(`${where} must be a number, got ${describeValue(value)}`);
          } else if (value < param.min || value > param.max) {
            problems.push(`${where} is ${value}, outside ${param.min} to ${param.max}`);
          }
          break;
        case 'angle':
        case 'seed':
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            problems.push(`${where} must be a number, got ${describeValue(value)}`);
          }
          break;
        case 'colour':
          if (typeof value !== 'string') problems.push(`${where} must be a colour string, got ${describeValue(value)}`);
          break;
        case 'boolean':
          if (typeof value !== 'boolean') problems.push(`${where} must be true or false, got ${describeValue(value)}`);
          break;
        case 'select': {
          const allowed = param.options.map((option) => option.value);
          if (typeof value !== 'string' || !allowed.includes(value)) {
            problems.push(`${where} must be one of ${allowed.join(', ')}, got ${describeValue(value)}`);
          }
          break;
        }
        case 'ramp':
          problems.push(...rampProblems(value, where));
          break;
      }
    }
  }

  return problems;
}

function rampProblems(value: ParamValue, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) return [`${where} must be a non-empty ramp`];
  const problems: string[] = [];
  value.forEach((entry, i) => {
    const stop = entry as unknown as Record<string, unknown>;
    if (!stop || typeof stop !== 'object') {
      problems.push(`${where} stop ${i} must be an object`);
      return;
    }
    if (typeof stop.position !== 'number' || !Number.isFinite(stop.position)) {
      problems.push(`${where} stop ${i} needs a numeric position`);
    }
    if (typeof stop.colour !== 'string') problems.push(`${where} stop ${i} needs a colour string`);
    if (typeof stop.alpha !== 'number' || !Number.isFinite(stop.alpha)) {
      problems.push(`${where} stop ${i} needs a numeric alpha`);
    }
  });
  return problems;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}
