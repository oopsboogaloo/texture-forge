import './editor.css';
import { parseProject, stampProvenance, type Project } from '../engine/project.ts';
import { PRESETS } from '../engine/presets.ts';
import { checkSeamless, previewScale } from '../engine/render.ts';
import { getNodeDefinition, listNodeDefinitions, type ParamValue } from '../engine/registry.ts';
import { createControl } from './controls.ts';
import { RenderClient } from './render-client.ts';
import { EditorState, forgetRecovered, loadRecovered } from './state.ts';
import { createLayer, createMask, fromStack, toStack, type StackLayer } from './stack.ts';

/** Preview never renders more than this many pixels, whatever the output size. */
const PREVIEW_PIXEL_BUDGET = 640_000;
const EXPORT_BAND_ROWS = 128;

const root = document.getElementById('app') as HTMLElement;
const client = new RenderClient();

let state: EditorState | null = null;
let zoom: 'fit' | 'actual' = 'fit';
let pan = { x: 0, y: 0 };
let previewTimer: ReturnType<typeof setTimeout> | null = null;
/** One export at a time: two would share a single cancel and double the memory. */
let exportRunning = false;
let previewToken = 0;
let expanded = new Set<string>();

let paintQueued = false;

/**
 * Repaints on the next frame, and not at all while a field is being edited.
 *
 * A panel rebuild replaces the very control whose event is being handled, which
 * both drops text that has been typed but not confirmed and can re-enter the
 * rebuild through the blur it fires. Waiting until focus leaves every text field
 * sidesteps both: moving from one field to the next simply defers again, and the
 * panel catches up once editing stops. Buttons are not deferred on — they hold
 * no uncommitted state, and add, delete and reorder must take effect at once.
 */
function requestPaint(): void {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    if (!state) return;

    // The header holds no editable text, so it refreshes regardless — otherwise
    // undo stays greyed out for as long as a slider keeps focus after a drag.
    paintHeader();

    const active = document.activeElement;
    const editing =
      (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) && active.closest('.panels');
    if (editing) {
      active.addEventListener('blur', () => requestPaint(), { once: true });
      return;
    }

    paintLayers();
    paintOutput();
  });
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ------------------------------------------------------------------ picker */

function showPicker(): void {
  root.replaceChildren();
  const page = element('div', 'picker');
  page.append(element('h1', undefined, 'Texture Forge'));
  page.append(element('p', 'sub', 'Choose a starting point. Everything about it can be changed afterwards.'));

  const grid = element('div', 'preset-grid');
  for (const preset of PRESETS) {
    const card = element('button', 'preset-card');
    card.type = 'button';
    card.append(element('h2', undefined, preset.label));
    card.append(element('p', undefined, preset.summary));
    card.addEventListener('click', () => openProject(stampProvenance(clone(preset.project))));
    grid.append(card);
  }
  page.append(grid);

  const openRow = element('div', 'picker-actions');
  const file = element('input');
  file.type = 'file';
  file.accept = 'application/json,.json';
  file.hidden = true;
  file.addEventListener('change', () => {
    const chosen = file.files?.[0];
    if (chosen) void openFile(chosen);
  });
  openRow.append(button('Open a project file', 'secondary', () => file.click()), file);

  const recovered = loadRecovered();
  if (recovered) {
    openRow.append(
      button('Restore last session', 'secondary', () => {
        try {
          openProject(parseProject(recovered).project);
        } catch (error) {
          forgetRecovered();
          alert(`That saved project could not be opened: ${(error as Error).message}`);
        }
      }),
    );
  }
  page.append(openRow);
  root.append(page);
}

async function openFile(file: File): Promise<void> {
  try {
    const { project, warnings } = parseProject(JSON.parse(await file.text()));
    if (warnings.length > 0) alert(`Opened with warnings:\n\n${warnings.join('\n')}`);
    openProject(project);
  } catch (error) {
    alert(`That file could not be opened: ${(error as Error).message}`);
  }
}

function openProject(project: Project): void {
  state = new EditorState(project);
  expanded = new Set();
  zoom = 'fit';
  pan = { x: 0, y: 0 };
  showEditor();
  state.subscribe((_project, live) => {
    // A live update comes from a gesture in progress, so the controls stay put
    // and only the preview follows along.
    if (!live) requestPaint();
    schedulePreview();
  });
  schedulePreview();
}

/* ------------------------------------------------------------------ editor */

let exportButton: HTMLButtonElement | null = null;
let previewCanvas: HTMLCanvasElement;
let previewStatus: HTMLElement;
let layerPanel: HTMLElement;
let outputPanel: HTMLElement;
let headerBar: HTMLElement;
let exportBar: HTMLElement;

function showEditor(): void {
  root.replaceChildren();
  const shell = element('div', 'editor');

  headerBar = element('header', 'bar');
  shell.append(headerBar);

  const stage = element('div', 'stage');
  const frame = element('div', 'preview-frame');
  previewCanvas = element('canvas', 'preview');
  frame.append(previewCanvas);
  stage.append(frame);

  previewStatus = element('p', 'preview-status', 'Rendering…');
  stage.append(previewStatus);

  const zoomRow = element('div', 'zoom-row');
  zoomRow.append(
    button('Fit', 'chip', () => {
      zoom = 'fit';
      paintHeader();
      schedulePreview(true);
    }),
    button('1:1', 'chip', () => {
      zoom = 'actual';
      paintHeader();
      schedulePreview(true);
    }),
  );
  stage.append(zoomRow);
  shell.append(stage);

  exportBar = element('div', 'export-bar');
  exportBar.hidden = true;
  shell.append(exportBar);

  const panels = element('div', 'panels');
  layerPanel = element('section', 'panel');
  outputPanel = element('section', 'panel');
  panels.append(layerPanel, outputPanel);
  shell.append(panels);

  root.append(shell);
  enablePanning();
  paintHeader();
  paintLayers();
  paintOutput();
}

function paintHeader(): void {
  if (!state) return;
  headerBar.replaceChildren();
  headerBar.append(button('‹ Presets', 'small', () => showPicker()));

  const undo = button('Undo', 'small', () => state?.undo());
  undo.disabled = !state.canUndo;
  const redo = button('Redo', 'small', () => state?.redo());
  redo.disabled = !state.canRedo;
  headerBar.append(undo, redo);

  headerBar.append(button('Save', 'small', saveProject));
  exportButton = button('Export PNG', 'primary small', () => void startExport());
  exportButton.disabled = exportRunning;
  headerBar.append(exportButton);
}

/* ------------------------------------------------------------------ layers */

function currentStack(): ReturnType<typeof toStack> {
  return state ? toStack(state.project) : null;
}

/**
 * Applies a change to the stack as it is *now*.
 *
 * Handlers must never close over the project they were built from: the panel no
 * longer rebuilds after every commit, so a captured copy goes stale the moment
 * anything else changes, and writing it back silently reverts that change.
 * Layers are found by id rather than position for the same reason.
 */
function mutateStack(change: (layers: StackLayer[]) => StackLayer[] | void, coalesce = false): void {
  if (!state) return;
  const stack = currentStack();
  if (!stack) return;
  const layers = clone(stack.layers);
  const next = change(layers) ?? layers;
  state.commit(fromStack({ layers: next, output: stack.output }, state.project.output, state.project), coalesce);
}

/** Applies a change to the output settings as they are now, for the same reason. */
function mutateOutput(change: (output: Project['output']) => void, coalesce = false): void {
  if (!state) return;
  const next = clone(state.project);
  change(next.output);
  state.commit(next, coalesce);
}

function updateNodeParam(nodeId: string, key: string, value: ParamValue, live: boolean): void {
  if (!state) return;
  const next = clone(state.project);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  node.params[key] = value;
  state.commit(next, live);
}

function layerTitle(layer: StackLayer): string {
  return getNodeDefinition(layer.generator.type).label;
}

function paintLayers(): void {
  if (!state) return;
  layerPanel.replaceChildren();
  layerPanel.append(element('h2', undefined, 'Layers'));

  const stack = currentStack();
  if (!stack) {
    layerPanel.append(
      element(
        'p',
        'notice',
        'This project uses a graph the layer view cannot show. Its controls will appear once the node view lands.',
      ),
    );
    return;
  }

  // Top of the stack reads first, matching what sits in front in the image.
  const ordered = [...stack.layers].reverse();
  for (const layer of ordered) {
    const index = stack.layers.indexOf(layer);
    const card = element('div', 'layer');

    const head = element('div', 'layer-head');
    const toggle = button(
      `${expanded.has(layer.id) ? '▾' : '▸'} ${layerTitle(layer)}`,
      'layer-name',
      () => {
        if (expanded.has(layer.id)) expanded.delete(layer.id);
        else expanded.add(layer.id);
        requestPaint();
      },
    );
    head.append(toggle);

    const up = button('↑', 'small', () =>
      mutateStack((layers) => {
        const at = layers.findIndex((candidate) => candidate.id === layer.id);
        if (at < 0 || at >= layers.length - 1) return;
        [layers[at], layers[at + 1]] = [layers[at + 1], layers[at]];
      }),
    );
    up.disabled = index >= stack.layers.length - 1;
    const down = button('↓', 'small', () =>
      mutateStack((layers) => {
        const at = layers.findIndex((candidate) => candidate.id === layer.id);
        if (at <= 0) return;
        [layers[at], layers[at - 1]] = [layers[at - 1], layers[at]];
      }),
    );
    down.disabled = index <= 0;
    const remove = button('Delete', 'small', () =>
      mutateStack((layers) => layers.filter((candidate) => candidate.id !== layer.id)),
    );
    remove.disabled = stack.layers.length <= 1;
    head.append(up, down, remove);
    card.append(head);

    if (expanded.has(layer.id)) {
      const body = element('div', 'layer-body');

      if (index > 0) {
        const definition = getNodeDefinition('blend');
        for (const param of definition.params) {
          const value = param.key === 'mode' ? layer.blendMode : layer.blendOpacity;
          body.append(
            createControl(param, value, {
              onChange: (next, live) =>
                mutateStack((layers) => {
                  const at = layers.findIndex((candidate) => candidate.id === layer.id);
                  if (at <= 0) return;
                  if (param.key === 'mode') layers[at].blendMode = String(next);
                  else layers[at].blendOpacity = Number(next);
                }, live),
            }),
          );
        }
      }

      for (const node of [layer.generator, layer.levels, layer.ramp]) {
        if (!node) continue;
        const definition = getNodeDefinition(node.type);
        if (node !== layer.generator) body.append(element('h3', undefined, definition.label));
        for (const param of definition.params) {
          body.append(
            createControl(param, node.params[param.key], {
              onChange: (value, live) => updateNodeParam(node.id, param.key, value, live),
            }),
          );
        }
      }

      // A mask decides where the layer shows, using greyscale values from a
      // generator of its own.
      if (layer.mask) {
        const heading = element('div', 'mask-head');
        heading.append(element('h3', undefined, 'Mask'));
        heading.append(
          button('Remove mask', 'small', () =>
            mutateStack((layers) => {
              const at = layers.findIndex((candidate) => candidate.id === layer.id);
              if (at < 0) return;
              layers[at].mask = null;
            }),
          ),
        );
        body.append(heading);

        for (const node of [layer.mask.generator, layer.mask.levels]) {
          if (!node) continue;
          const definition = getNodeDefinition(node.type);
          if (node !== layer.mask.generator) body.append(element('h3', undefined, definition.label));
          for (const param of definition.params) {
            body.append(
              createControl(param, node.params[param.key], {
                onChange: (value, live) => updateNodeParam(node.id, param.key, value, live),
              }),
            );
          }
        }
      } else {
        body.append(
          button('Add mask', 'secondary', () =>
            mutateStack((layers) => {
              const at = layers.findIndex((candidate) => candidate.id === layer.id);
              if (at < 0) return;
              layers[at].mask = createMask(layer.id, Date.now() % 100000);
            }),
          ),
        );
      }
      card.append(body);
    }

    layerPanel.append(card);
  }

  const add = element('div', 'add-layer');
  const chooser = element('select');
  for (const definition of listNodeDefinitions()) {
    if (definition.category !== 'generator') continue;
    const option = element('option');
    option.value = definition.type;
    option.textContent = definition.label;
    chooser.append(option);
  }
  add.append(chooser);
  add.append(
    button('Add layer', 'secondary', () =>
      mutateStack((layers) => {
        const layer = createLayer(chooser.value, Date.now() % 100000);
        expanded.add(layer.id);
        layers.push(layer);
      }),
    ),
  );
  layerPanel.append(add);
}

/* ------------------------------------------------------------------ output */

function paintOutput(): void {
  if (!state) return;
  const project = state.project;
  outputPanel.replaceChildren();
  outputPanel.append(element('h2', undefined, 'Output'));

  const size = element('div', 'size-row');
  for (const axis of ['width', 'height'] as const) {
    const wrapper = element('div', 'control');
    wrapper.append(element('div', 'control-label', axis === 'width' ? 'Width' : 'Height'));
    const input = element('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '1';
    input.max = '20000';
    input.value = String(project.output[axis]);
    input.addEventListener('change', () => {
      const value = Math.max(1, Math.min(20000, Math.round(Number(input.value) || 1)));
      mutateOutput((output) => {
        output[axis] = value;
      });
    });
    wrapper.append(input);
    size.append(wrapper);
  }
  outputPanel.append(size);

  const formats: { value: Project['output']['format']; label: string }[] = [
    { value: 'rgba', label: 'Colour with transparency' },
    { value: 'luminance', label: 'Greyscale from tone' },
    { value: 'alpha', label: 'Greyscale from coverage' },
  ];
  const formatField = element('div', 'control');
  formatField.append(element('div', 'control-label', 'Format'));
  const formatSelect = element('select');
  for (const format of formats) {
    const option = element('option');
    option.value = format.value;
    option.textContent = format.label;
    formatSelect.append(option);
  }
  formatSelect.value = project.output.format;
  formatSelect.addEventListener('change', () =>
    mutateOutput((output) => {
      output.format = formatSelect.value as Project['output']['format'];
    }),
  );
  formatField.append(formatSelect);
  outputPanel.append(formatField);

  const seamlessField = element('div', 'control');
  seamlessField.append(element('div', 'control-label', 'Seamless'));
  const seamless = button(project.output.seamless ? 'On' : 'Off', 'toggle', () =>
    mutateOutput((output) => {
      output.seamless = !output.seamless;
    }),
  );
  seamless.dataset.on = String(project.output.seamless);
  seamlessField.append(seamless);
  outputPanel.append(seamlessField);

  // Rather than quietly resizing the pattern to fit the canvas, offer sizes the
  // pattern fits.
  for (const advice of checkSeamless(project)) {
    const notice = element('div', 'notice');
    notice.append(
      element(
        'p',
        undefined,
        `Seamless ${advice.axis} must be a multiple of ${advice.period}px for whole cells. ${advice.current} is not.`,
      ),
    );
    const chips = element('div', 'chips');
    for (const suggestion of advice.suggestions) {
      chips.append(
        button(`${suggestion}px`, 'chip', () =>
          mutateOutput((output) => {
            output[advice.axis] = suggestion;
          }),
        ),
      );
    }
    notice.append(chips);
    outputPanel.append(notice);
  }

  const output = project.nodes.find((node) => node.id === project.outputNode);
  if (output) {
    for (const param of getNodeDefinition(output.type).params) {
      outputPanel.append(
        createControl(param, output.params[param.key], {
          onChange: (value, live) => updateNodeParam(output.id, param.key, value, live),
        }),
      );
    }
  }
}

/* ----------------------------------------------------------------- preview */

function previewGeometry(project: Project): { scale: number; tile: { x: number; y: number; width: number; height: number } } {
  const frame = previewCanvas.parentElement as HTMLElement;
  const viewport = Math.max(160, Math.floor(Math.min(frame.clientWidth || 320, 900)));

  if (zoom === 'actual') {
    // A 1:1 window into the full-size image, which is the only honest way to
    // judge features finer than a preview pixel.
    const width = Math.min(project.output.width, viewport);
    const height = Math.min(project.output.height, viewport);
    const x = Math.max(0, Math.min(project.output.width - width, Math.round(pan.x)));
    const y = Math.max(0, Math.min(project.output.height - height, Math.round(pan.y)));
    return { scale: 1, tile: { x, y, width, height } };
  }

  const budget = Math.min(PREVIEW_PIXEL_BUDGET, viewport * viewport * 4);
  const scale = previewScale(project, budget);
  return {
    scale,
    tile: {
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(project.output.width * scale)),
      height: Math.max(1, Math.round(project.output.height * scale)),
    },
  };
}

function schedulePreview(immediate = false): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewStatus.textContent = 'Rendering…';
  previewTimer = setTimeout(() => void runPreview(), immediate ? 0 : 140);
}

async function runPreview(): Promise<void> {
  if (!state) return;
  const project = state.project;
  const token = ++previewToken;
  const { scale, tile } = previewGeometry(project);

  try {
    const result = await client.preview(project, scale, tile);
    if (token !== previewToken) return;

    previewCanvas.width = result.width;
    previewCanvas.height = result.height;
    const context = previewCanvas.getContext('2d');
    if (!context) return;
    context.putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);

    const percent = zoom === 'actual' ? '100' : (scale * 100).toFixed(scale < 0.1 ? 1 : 0);
    previewStatus.textContent =
      `${project.output.width} × ${project.output.height} at ${percent}%` +
      (zoom === 'actual' ? ' — drag to pan' : '');
  } catch (error) {
    if (token !== previewToken) return;
    if (error instanceof DOMException && error.name === 'AbortError') return;
    previewStatus.textContent = `Preview failed: ${(error as Error).message}`;
  }
}

function enablePanning(): void {
  let dragging = false;
  let originX = 0;
  let originY = 0;
  let startPan = { x: 0, y: 0 };

  previewCanvas.addEventListener('pointerdown', (event) => {
    if (zoom !== 'actual') return;
    dragging = true;
    originX = event.clientX;
    originY = event.clientY;
    startPan = { ...pan };
    previewCanvas.setPointerCapture(event.pointerId);
  });
  previewCanvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const rect = previewCanvas.getBoundingClientRect();
    const ratio = previewCanvas.width / Math.max(1, rect.width);
    pan = {
      x: startPan.x - (event.clientX - originX) * ratio,
      y: startPan.y - (event.clientY - originY) * ratio,
    };
    schedulePreview();
  });
  const release = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (previewCanvas.hasPointerCapture(event.pointerId)) previewCanvas.releasePointerCapture(event.pointerId);
  };
  previewCanvas.addEventListener('pointerup', release);
  previewCanvas.addEventListener('pointercancel', release);
}

/* ------------------------------------------------------------ save, export */

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function saveProject(): void {
  if (!state) return;
  const stamped = stampProvenance(state.project);
  download(new Blob([JSON.stringify(stamped, null, 2)], { type: 'application/json' }), 'texture.json');
}

async function startExport(): Promise<void> {
  if (!state || exportRunning) return;
  exportRunning = true;
  // Disabled here and not through a repaint: a repaint happens a frame later at
  // the earliest, and waits entirely while a field has focus, which would leave
  // a live button starting a second export.
  if (exportButton) exportButton.disabled = true;
  const project = stampProvenance(state.project);

  exportBar.hidden = false;
  exportBar.replaceChildren();
  const label = element('p', undefined, 'Preparing…');
  const track = element('div', 'progress');
  const bar = element('div', 'progress-bar');
  track.append(bar);
  const cancel = button('Cancel', 'small', () => client.cancelExport());
  exportBar.append(label, track, cancel);

  try {
    const result = await client.exportPng(project, EXPORT_BAND_ROWS, (rowsDone, height) => {
      const percent = (rowsDone / height) * 100;
      bar.style.width = `${percent}%`;
      label.textContent = `Rendering ${percent.toFixed(0)}%`;
    });
    bar.style.width = '100%';
    const megabytes = (result.bytes / 1048576).toFixed(1);
    label.textContent = `Done in ${result.seconds.toFixed(1)}s — ${megabytes} MB`;
    cancel.remove();
    exportBar.append(
      button('Save PNG', 'primary', () =>
        download(result.blob, `texture-${project.output.width}x${project.output.height}.png`),
      ),
      button('Close', 'small', () => {
        exportBar.hidden = true;
      }),
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      exportBar.hidden = true;
    } else {
      label.textContent = `Export failed: ${(error as Error).message}`;
      cancel.textContent = 'Close';
      cancel.addEventListener('click', () => {
        exportBar.hidden = true;
      });
    }
  } finally {
    exportRunning = false;
    if (exportButton) exportButton.disabled = false;
  }
}

window.addEventListener('error', (event) => {
  if (previewStatus) previewStatus.textContent = `Error: ${event.message}`;
});

showPicker();
