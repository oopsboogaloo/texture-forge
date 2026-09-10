import type { ProbePattern } from '../engine/probe-patterns.ts';

export interface StartMessage {
  type: 'start';
  pattern: ProbePattern;
  width: number;
  height: number;
  bandRows: number;
  seed: number;
}

export interface CancelMessage {
  type: 'cancel';
}

export type ToWorker = StartMessage | CancelMessage;

export type FromWorker =
  | { type: 'progress'; rowsDone: number; height: number }
  | {
      type: 'done';
      blob: Blob;
      bytes: number;
      compressedBytes: number;
      generateMs: number;
      encodeMs: number;
      totalMs: number;
    }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };
