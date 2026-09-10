/// <reference lib="webworker" />
import { parseProject, type Project } from '../engine/project.ts';
import { createRenderPass, renderToPng } from '../engine/render.ts';
import type { Tile } from '../engine/types.ts';

export interface PreviewRequest {
  type: 'preview';
  id: number;
  project: unknown;
  scale: number;
  tile: Tile;
}

export interface ExportRequest {
  type: 'export';
  id: number;
  project: unknown;
  bandRows: number;
}

export type ToRenderWorker = PreviewRequest | ExportRequest | { type: 'cancel' };

export type FromRenderWorker =
  | { type: 'preview'; id: number; width: number; height: number; pixels: ArrayBuffer }
  | { type: 'progress'; id: number; rowsDone: number; height: number }
  | { type: 'exported'; id: number; blob: Blob; bytes: number; seconds: number }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string };

let exporting: AbortController | null = null;

function post(message: FromRenderWorker, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function load(input: unknown): Project {
  return parseProject(input).project;
}

self.onmessage = async (event: MessageEvent<ToRenderWorker>) => {
  const message = event.data;

  if (message.type === 'cancel') {
    exporting?.abort();
    return;
  }

  if (message.type === 'preview') {
    try {
      const pass = createRenderPass(load(message.project), { scale: message.scale });
      const tile = pass.renderTile(message.tile);
      // The pixels are freshly allocated per tile, so handing the buffer over
      // rather than copying it is safe.
      const pixels = tile.data.buffer as ArrayBuffer;
      post({ type: 'preview', id: message.id, width: tile.width, height: tile.height, pixels }, [pixels]);
    } catch (error) {
      post({ type: 'error', id: message.id, message: describe(error) });
    }
    return;
  }

  exporting = new AbortController();
  const startedAt = performance.now();
  try {
    const result = await renderToPng(load(message.project), {
      bandRows: message.bandRows,
      signal: exporting.signal,
      onProgress: (rowsDone, height) => post({ type: 'progress', id: message.id, rowsDone, height }),
    });
    post({
      type: 'exported',
      id: message.id,
      blob: result.blob,
      bytes: result.blob.size,
      seconds: (performance.now() - startedAt) / 1000,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') post({ type: 'cancelled', id: message.id });
    else post({ type: 'error', id: message.id, message: describe(error) });
  } finally {
    exporting = null;
  }
};
