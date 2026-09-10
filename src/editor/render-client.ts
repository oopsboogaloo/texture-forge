import type { Project } from '../engine/project.ts';
import type { FromRenderWorker, ToRenderWorker } from '../workers/render-worker.ts';
import type { Tile } from '../engine/types.ts';

export interface PreviewResult {
  width: number;
  height: number;
  /** Backed by a plain ArrayBuffer, so it can go straight into an ImageData. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

export interface ExportResult {
  blob: Blob;
  bytes: number;
  seconds: number;
}

/**
 * Owns the render worker. Everything heavy happens there, which is what keeps
 * the interface alive during a full-size export.
 */
export class RenderClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  private progressFor = new Map<number, (rowsDone: number, height: number) => void>();

  constructor() {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const worker = new Worker(new URL('../workers/render-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<FromRenderWorker>) => this.receive(event.data);
    worker.onerror = (event) => {
      for (const [, handlers] of this.pending) handlers.reject(new Error(event.message || 'render worker failed'));
      this.pending.clear();
    };
    return worker;
  }

  private receive(message: FromRenderWorker): void {
    if (message.type === 'progress') {
      this.progressFor.get(message.id)?.(message.rowsDone, message.height);
      return;
    }
    const handlers = this.pending.get(message.id);
    if (!handlers) return;
    this.pending.delete(message.id);
    this.progressFor.delete(message.id);

    switch (message.type) {
      case 'preview':
        handlers.resolve({
          width: message.width,
          height: message.height,
          pixels: new Uint8ClampedArray(message.pixels),
        } as never);
        break;
      case 'exported':
        handlers.resolve({ blob: message.blob, bytes: message.bytes, seconds: message.seconds } as never);
        break;
      case 'cancelled':
        handlers.reject(new DOMException('Export cancelled', 'AbortError'));
        break;
      case 'error':
        handlers.reject(new Error(message.message));
        break;
    }
  }

  private send<T>(message: ToRenderWorker & { id: number }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, { resolve: resolve as (value: never) => void, reject });
      this.worker.postMessage(message);
    });
  }

  preview(project: Project, scale: number, tile: Tile): Promise<PreviewResult> {
    return this.send<PreviewResult>({ type: 'preview', id: this.nextId++, project, scale, tile });
  }

  exportPng(
    project: Project,
    bandRows: number,
    onProgress: (rowsDone: number, height: number) => void,
  ): Promise<ExportResult> {
    const id = this.nextId++;
    this.progressFor.set(id, onProgress);
    return this.send<ExportResult>({ type: 'export', id, project, bandRows });
  }

  cancelExport(): void {
    this.worker.postMessage({ type: 'cancel' } satisfies ToRenderWorker);
  }

  /**
   * Abandons the worker mid-render and starts a fresh one.
   *
   * A preview render is synchronous inside the worker, so a superseded one
   * cannot be asked to stop — dropping the whole worker is the only way to stop
   * paying for it, and matters most on the slowest device.
   */
  restart(): void {
    this.worker.terminate();
    for (const [, handlers] of this.pending) handlers.reject(new DOMException('Superseded', 'AbortError'));
    this.pending.clear();
    this.progressFor.clear();
    this.worker = this.spawn();
  }
}
