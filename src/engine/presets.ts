import type { Project } from './project.ts';
import { APPLICATION_NAME, APPLICATION_VERSION, PROJECT_FORMAT, PROJECT_FORMAT_VERSION } from './version.ts';

/**
 * Presets are ordinary recipes, not special-cased code: everything here can be
 * expressed by hand in the editor, saved, and reloaded.
 */
function project(output: Project['output'], nodes: Project['nodes'], edges: Project['edges'], outputNode: string): Project {
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    application: { name: APPLICATION_NAME, version: APPLICATION_VERSION },
    provenance: { generation: 'procedural-algorithms' },
    output,
    nodes,
    edges,
    outputNode,
  };
}

export const SQUARE_GRID: Project = project(
  { width: 4096, height: 4096, seamless: false, format: 'rgba' },
  [
    {
      id: 'grid',
      type: 'grid',
      version: 1,
      params: {
        cellWidth: 64,
        cellHeight: 64,
        lineThickness: 2,
        lineColour: '#3c3c3c',
        lineOpacity: 0.85,
        offsetX: 0,
        offsetY: 0,
        majorEnabled: true,
        majorEveryX: 10,
        majorEveryY: 10,
        majorThickness: 4,
        majorColour: '#1e1e1e',
        majorOpacity: 1,
        backgroundEnabled: false,
        backgroundColour: '#ffffff',
      },
    },
    { id: 'out', type: 'output', version: 1, params: { backgroundEnabled: false, backgroundColour: '#ffffff' } },
  ],
  [{ from: 'grid', to: 'out', input: 'input' }],
  'out',
);

export const PAPER: Project = project(
  { width: 4096, height: 4096, seamless: false, format: 'rgba' },
  [
    { id: 'mottle', type: 'fractal-noise', version: 1, params: { scale: 520, detail: 5, contrast: 1.3, seed: 7 } },
    { id: 'mottle-levels', type: 'levels', version: 1, params: { blackPoint: 0.18, whitePoint: 0.86, gamma: 1, invert: false } },
    {
      id: 'paper-colour',
      type: 'colour-ramp',
      version: 1,
      params: {
        stops: [
          { position: 0, colour: '#d9cdb2', alpha: 1 },
          { position: 1, colour: '#f6efdd', alpha: 1 },
        ],
      },
    },
    { id: 'fibres', type: 'paper-fibres', version: 1, params: { density: 2600, length: 110, thickness: 1.4, direction: 0, spread: 30, seed: 3 } },
    {
      id: 'fibre-colour',
      type: 'colour-ramp',
      version: 1,
      params: {
        stops: [
          { position: 0, colour: '#a8967a', alpha: 0 },
          { position: 1, colour: '#a8967a', alpha: 0.55 },
        ],
      },
    },
    { id: 'fibre-blend', type: 'blend', version: 1, params: { mode: 'multiply', opacity: 0.5 } },
    { id: 'flecks', type: 'speckles', version: 1, params: { density: 420, sizeMin: 1.5, sizeMax: 7, irregularity: 0.6, seed: 11 } },
    {
      id: 'fleck-colour',
      type: 'colour-ramp',
      version: 1,
      params: {
        stops: [
          { position: 0, colour: '#7d6b4e', alpha: 0 },
          { position: 1, colour: '#7d6b4e', alpha: 0.4 },
        ],
      },
    },
    { id: 'fleck-blend', type: 'blend', version: 1, params: { mode: 'multiply', opacity: 0.65 } },
    { id: 'out', type: 'output', version: 1, params: { backgroundEnabled: false, backgroundColour: '#ffffff' } },
  ],
  [
    { from: 'mottle', to: 'mottle-levels', input: 'input' },
    { from: 'mottle-levels', to: 'paper-colour', input: 'input' },
    { from: 'paper-colour', to: 'fibre-blend', input: 'base' },
    { from: 'fibres', to: 'fibre-colour', input: 'input' },
    { from: 'fibre-colour', to: 'fibre-blend', input: 'layer' },
    { from: 'fibre-blend', to: 'fleck-blend', input: 'base' },
    { from: 'flecks', to: 'fleck-colour', input: 'input' },
    { from: 'fleck-colour', to: 'fleck-blend', input: 'layer' },
    { from: 'fleck-blend', to: 'out', input: 'input' },
  ],
  'out',
);

export const WORN_PRINT: Project = project(
  { width: 4096, height: 4096, seamless: false, format: 'rgba' },
  [
    { id: 'patches', type: 'fractal-noise', version: 1, params: { scale: 260, detail: 5, contrast: 1.4, seed: 23 } },
    { id: 'patch-levels', type: 'levels', version: 1, params: { blackPoint: 0.62, whitePoint: 0.8, gamma: 1, invert: false } },
    {
      id: 'patch-colour',
      type: 'colour-ramp',
      version: 1,
      params: {
        stops: [
          { position: 0, colour: '#141414', alpha: 0 },
          { position: 1, colour: '#141414', alpha: 0.9 },
        ],
      },
    },
    { id: 'flecks', type: 'speckles', version: 1, params: { density: 1400, sizeMin: 1.5, sizeMax: 11, irregularity: 0.85, seed: 29 } },
    {
      id: 'fleck-colour',
      type: 'colour-ramp',
      version: 1,
      params: {
        stops: [
          { position: 0, colour: '#141414', alpha: 0 },
          { position: 1, colour: '#141414', alpha: 1 },
        ],
      },
    },
    { id: 'combine', type: 'blend', version: 1, params: { mode: 'normal', opacity: 1 } },
    { id: 'out', type: 'output', version: 1, params: { backgroundEnabled: false, backgroundColour: '#ffffff' } },
  ],
  [
    { from: 'patches', to: 'patch-levels', input: 'input' },
    { from: 'patch-levels', to: 'patch-colour', input: 'input' },
    { from: 'patch-colour', to: 'combine', input: 'base' },
    { from: 'flecks', to: 'fleck-colour', input: 'input' },
    { from: 'fleck-colour', to: 'combine', input: 'layer' },
    { from: 'combine', to: 'out', input: 'input' },
  ],
  'out',
);

export interface PresetEntry {
  id: string;
  label: string;
  summary: string;
  project: Project;
}

export const PRESETS: PresetEntry[] = [
  {
    id: 'square-grid',
    label: 'Square Grid',
    summary: 'Clean grid overlay with heavier lines every ten cells and a transparent background.',
    project: SQUARE_GRID,
  },
  {
    id: 'paper',
    label: 'Paper',
    summary: 'Warm paper colour with mottling, fibres and flecks.',
    project: PAPER,
  },
  {
    id: 'worn-print',
    label: 'Worn Print',
    summary: 'Irregular missing-ink flecks and patches on a transparent ground.',
    project: WORN_PRINT,
  },
];

export function findPreset(id: string): PresetEntry {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`unknown preset: ${id}`);
  return preset;
}
