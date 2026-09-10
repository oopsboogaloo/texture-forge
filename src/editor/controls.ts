import { formatColour, parseColour } from '../engine/colour.ts';
import type { ParamDefinition, ParamValue, RampStop } from '../engine/registry.ts';

/**
 * Controls are built from the node registry's descriptors rather than written
 * per node, so a new generator gets a working panel the moment it declares its
 * parameters — and the panel cannot disagree with what the engine accepts.
 *
 * Everything here is sized for a fingertip: 44px minimum targets, no hover, no
 * right-click, no keyboard requirement.
 */
export interface ControlHandlers {
  /** `live` is true during a drag, when the change should not start a new undo step. */
  onChange: (value: ParamValue, live: boolean) => void;
}

function field(label: string, ...children: (Node | string)[]): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'control';
  const heading = document.createElement('div');
  heading.className = 'control-label';
  heading.textContent = label;
  wrapper.append(heading, ...children);
  return wrapper;
}

function formatNumber(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return value.toFixed(decimals);
}

function numberControl(
  definition: Extract<ParamDefinition, { kind: 'number' }>,
  value: number,
  handlers: ControlHandlers,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'slider-row';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(definition.min);
  slider.max = String(definition.max);
  slider.step = String(definition.step);
  slider.value = String(value);

  const readout = document.createElement('output');
  readout.className = 'readout';
  const show = (v: number): void => {
    readout.textContent = definition.unit ? `${formatNumber(v, definition.step)} ${definition.unit}` : formatNumber(v, definition.step);
  };
  show(value);

  slider.addEventListener('input', () => {
    const next = Number(slider.value);
    show(next);
    handlers.onChange(next, true);
  });
  // The pointer lifting is what ends the undo step, so a drag is one entry.
  slider.addEventListener('change', () => handlers.onChange(Number(slider.value), false));

  row.append(slider, readout);
  return field(definition.label, row);
}

function angleControl(
  definition: Extract<ParamDefinition, { kind: 'angle' }>,
  value: number,
  handlers: ControlHandlers,
): HTMLElement {
  return numberControl(
    { kind: 'number', key: definition.key, label: definition.label, min: -180, max: 180, step: 1, unit: '°', default: definition.default },
    value,
    handlers,
  );
}

function colourInput(value: string, onChange: (next: string, live: boolean) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'color';
  const parsed = parseColour(value);
  input.value = formatColour({ ...parsed, a: 255 });
  input.addEventListener('input', () => onChange(input.value, true));
  input.addEventListener('change', () => onChange(input.value, false));
  return input;
}

function booleanControl(
  definition: Extract<ParamDefinition, { kind: 'boolean' }>,
  value: boolean,
  handlers: ControlHandlers,
): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toggle';
  const paint = (on: boolean): void => {
    button.textContent = on ? 'On' : 'Off';
    button.dataset.on = String(on);
    button.setAttribute('aria-pressed', String(on));
  };
  paint(value);
  button.addEventListener('click', () => {
    const next = button.dataset.on !== 'true';
    paint(next);
    handlers.onChange(next, false);
  });
  return field(definition.label, button);
}

function selectControl(
  definition: Extract<ParamDefinition, { kind: 'select' }>,
  value: string,
  handlers: ControlHandlers,
): HTMLElement {
  const select = document.createElement('select');
  for (const option of definition.options) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    select.append(element);
  }
  select.value = value;
  select.addEventListener('change', () => handlers.onChange(select.value, false));
  return field(definition.label, select);
}

function seedControl(
  definition: Extract<ParamDefinition, { kind: 'seed' }>,
  value: number,
  handlers: ControlHandlers,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'slider-row';

  const input = document.createElement('input');
  input.type = 'number';
  input.inputMode = 'numeric';
  input.min = '0';
  input.value = String(value);
  input.addEventListener('change', () => handlers.onChange(Math.max(0, Math.round(Number(input.value) || 0)), false));

  const shuffle = document.createElement('button');
  shuffle.type = 'button';
  shuffle.className = 'small';
  shuffle.textContent = 'Shuffle';
  shuffle.addEventListener('click', () => {
    // Picking a seed is the one place a random number is wanted: it chooses
    // which deterministic texture to look at, and is recorded in the recipe.
    const next = Math.floor(Math.random() * 10000);
    input.value = String(next);
    handlers.onChange(next, false);
  });

  row.append(input, shuffle);
  return field(definition.label, row);
}

function rampControl(
  definition: Extract<ParamDefinition, { kind: 'ramp' }>,
  value: RampStop[],
  handlers: ControlHandlers,
): HTMLElement {
  const stops = value.map((stop) => ({ ...stop }));
  const list = document.createElement('div');
  list.className = 'ramp';

  const emit = (live: boolean): void => handlers.onChange(stops.map((stop) => ({ ...stop })), live);

  const rebuild = (): void => {
    list.replaceChildren();
    stops.forEach((stop, index) => {
      const row = document.createElement('div');
      row.className = 'ramp-stop';

      row.append(
        colourInput(stop.colour, (next, live) => {
          stop.colour = next;
          emit(live);
        }),
      );

      const alpha = document.createElement('input');
      alpha.type = 'range';
      alpha.min = '0';
      alpha.max = '1';
      alpha.step = '0.01';
      alpha.value = String(stop.alpha);
      alpha.title = 'Opacity';
      alpha.addEventListener('input', () => {
        stop.alpha = Number(alpha.value);
        emit(true);
      });
      alpha.addEventListener('change', () => emit(false));
      row.append(alpha);

      const position = document.createElement('input');
      position.type = 'range';
      position.min = '0';
      position.max = '1';
      position.step = '0.01';
      position.value = String(stop.position);
      position.title = 'Position';
      position.addEventListener('input', () => {
        stop.position = Number(position.value);
        emit(true);
      });
      position.addEventListener('change', () => emit(false));
      row.append(position);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'small';
      remove.textContent = '−';
      remove.setAttribute('aria-label', `Remove stop ${index + 1}`);
      // A ramp with fewer than two stops has nothing to interpolate.
      remove.disabled = stops.length <= 2;
      remove.addEventListener('click', () => {
        stops.splice(index, 1);
        rebuild();
        emit(false);
      });
      row.append(remove);

      list.append(row);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'small';
    add.textContent = 'Add stop';
    add.addEventListener('click', () => {
      const last = stops[stops.length - 1];
      stops.push({ position: 1, colour: last.colour, alpha: last.alpha });
      rebuild();
      emit(false);
    });
    list.append(add);
  };

  rebuild();
  return field(definition.label, list);
}

export function createControl(definition: ParamDefinition, value: ParamValue, handlers: ControlHandlers): HTMLElement {
  switch (definition.kind) {
    case 'number':
      return numberControl(definition, Number(value), handlers);
    case 'angle':
      return angleControl(definition, Number(value), handlers);
    case 'colour':
      return field(
        definition.label,
        colourInput(String(value), (next, live) => handlers.onChange(next, live)),
      );
    case 'boolean':
      return booleanControl(definition, value === true, handlers);
    case 'select':
      return selectControl(definition, String(value), handlers);
    case 'seed':
      return seedControl(definition, Number(value), handlers);
    case 'ramp':
      return rampControl(definition, value as RampStop[], handlers);
  }
}
