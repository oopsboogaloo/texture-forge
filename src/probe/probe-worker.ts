/// <reference lib="webworker" />
import { encodePng } from '../engine/png/encoder.ts';
import { createProbeRenderer } from '../engine/probe-patterns.ts';
import type { FromWorker, ToWorker } from './messages.ts';

let controller: AbortController | null = null;

function post(message: FromWorker): void {
  self.postMessage(message);
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;

  if (msg.type === 'cancel') {
    controller?.abort();
    return;
  }

  controller = new AbortController();
  const startedAt = performance.now();

  try {
    const renderBand = createProbeRenderer({
      pattern: msg.pattern,
      width: msg.width,
      height: msg.height,
      seed: msg.seed,
    });

    let lastReport = 0;
    const result = await encodePng({
      width: msg.width,
      height: msg.height,
      colourType: 6,
      bandRows: msg.bandRows,
      renderBand,
      signal: controller.signal,
      onProgress: (rowsDone, height) => {
        const now = performance.now();
        if (now - lastReport < 100 && rowsDone < height) return;
        lastReport = now;
        post({ type: 'progress', rowsDone, height });
      },
    });

    post({
      type: 'done',
      blob: result.blob,
      bytes: result.blob.size,
      compressedBytes: result.compressedBytes,
      generateMs: result.generateMs,
      encodeMs: result.encodeMs,
      totalMs: performance.now() - startedAt,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      post({ type: 'cancelled' });
    } else {
      post({ type: 'error', message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
  } finally {
    controller = null;
  }
};
