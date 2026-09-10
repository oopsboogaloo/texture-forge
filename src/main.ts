import './style.css';
import type { FromWorker, StartMessage } from './probe/messages.ts';
import type { ProbePattern } from './engine/probe-patterns.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const logEl = $<HTMLPreElement>('log');
const statusEl = $<HTMLParagraphElement>('status');
const barEl = $<HTMLDivElement>('bar');
const startBtn = $<HTMLButtonElement>('start');
const cancelBtn = $<HTMLButtonElement>('cancel');
const downloadSlot = $<HTMLParagraphElement>('download-slot');

function log(line: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  logEl.textContent += `${stamp}  ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

// iPad Safari has no reachable console during normal use, so everything that
// could explain a failed run has to land on the page itself.
window.addEventListener('error', (e) => log(`window error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => log(`unhandled rejection: ${String(e.reason)}`));

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Safari caps a single canvas at 16,777,216 pixels of area, which is the whole
 * reason the encoder never touches one. Probing the real number here tells us
 * how large a preview surface we may allocate later.
 */
function probeMaxCanvasArea(): string {
  const candidates = [4096, 8192, 16384];
  const usable: number[] = [];
  for (const side of candidates) {
    const area = side * side;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.fillRect(0, 0, 1, 1);
      const ok = ctx.getImageData(0, 0, 1, 1).data[3] !== 0;
      canvas.width = 0;
      canvas.height = 0;
      if (ok) usable.push(area);
    } catch {
      break;
    }
  }
  const best = usable.at(-1);
  return best ? `${Math.sqrt(best)} × ${Math.sqrt(best)} ok (${(best / 1e6).toFixed(1)} MP)` : 'none of 4k/8k/16k';
}

function reportCapabilities(): void {
  const caps: Array<[string, string]> = [
    ['User agent', navigator.userAgent],
    ['Logical cores', String(navigator.hardwareConcurrency ?? 'unknown')],
    ['CompressionStream', 'CompressionStream' in globalThis ? 'yes' : 'NO — export cannot work'],
    ['OffscreenCanvas', 'OffscreenCanvas' in globalThis ? 'yes' : 'no'],
    ['createImageBitmap', 'createImageBitmap' in globalThis ? 'yes' : 'no'],
    ['Largest square canvas', probeMaxCanvasArea()],
  ];
  const list = $<HTMLDListElement>('caps-list');
  list.innerHTML = '';
  for (const [term, value] of caps) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  log(`capabilities: cores=${navigator.hardwareConcurrency}, canvas=${caps[5][1]}`);
}

let worker: Worker | null = null;
let objectUrl: string | null = null;

function setRunning(running: boolean): void {
  startBtn.disabled = running;
  cancelBtn.disabled = !running;
}

function offerDownload(blob: Blob, name: string): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = name;
  link.textContent = `Save ${name} (${formatBytes(blob.size)})`;
  downloadSlot.replaceChildren(link);
}

function start(): void {
  const size = Number($<HTMLSelectElement>('size').value);
  const pattern = $<HTMLSelectElement>('pattern').value as ProbePattern;
  const bandRows = Number($<HTMLSelectElement>('band').value);

  downloadSlot.replaceChildren();
  barEl.style.width = '0';
  setRunning(true);

  const megapixels = ((size * size) / 1e6).toFixed(1);
  const raw = size * size * 4;
  log(`start ${pattern} ${size}×${size} (${megapixels} MP, ${formatBytes(raw)} raw), band=${bandRows} rows (${formatBytes(bandRows * size * 4)})`);
  statusEl.textContent = 'Rendering…';

  worker = new Worker(new URL('./probe/probe-worker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    switch (msg.type) {
      case 'progress': {
        const pct = (msg.rowsDone / msg.height) * 100;
        barEl.style.width = `${pct}%`;
        statusEl.textContent = `Rendering… ${pct.toFixed(0)}% (${msg.rowsDone.toLocaleString()} of ${msg.height.toLocaleString()} rows)`;
        break;
      }
      case 'done': {
        barEl.style.width = '100%';
        const seconds = msg.totalMs / 1000;
        log(
          `done in ${seconds.toFixed(1)}s — generate ${(msg.generateMs / 1000).toFixed(1)}s, ` +
            `encode ${(msg.encodeMs / 1000).toFixed(1)}s, file ${formatBytes(msg.bytes)} ` +
            `(${((size * size * 4) / msg.bytes).toFixed(1)}:1 vs raw)`,
        );
        statusEl.textContent = `Complete in ${seconds.toFixed(1)}s.`;
        offerDownload(msg.blob, `probe-${pattern}-${size}.png`);
        finish();
        break;
      }
      case 'cancelled':
        log('cancelled by user');
        statusEl.textContent = 'Cancelled.';
        barEl.style.width = '0';
        finish();
        break;
      case 'error':
        log(`FAILED: ${msg.message}`);
        statusEl.textContent = `Failed: ${msg.message}`;
        finish();
        break;
    }
  };

  worker.onerror = (event) => {
    log(`worker error: ${event.message}`);
    statusEl.textContent = 'Worker error — see log.';
    finish();
  };

  const message: StartMessage = { type: 'start', pattern, width: size, height: size, bandRows, seed: 1 };
  worker.postMessage(message);
}

function finish(): void {
  worker?.terminate();
  worker = null;
  setRunning(false);
}

startBtn.addEventListener('click', start);
cancelBtn.addEventListener('click', () => {
  worker?.postMessage({ type: 'cancel' });
  statusEl.textContent = 'Cancelling…';
});

reportCapabilities();
log('ready');
