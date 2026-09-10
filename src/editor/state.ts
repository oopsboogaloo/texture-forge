import type { Project } from '../engine/project.ts';

const STORAGE_KEY = 'texture-forge/current-project';
const HISTORY_LIMIT = 60;

/**
 * Undo history over whole project snapshots.
 *
 * A recipe is small — a few kilobytes of JSON — so snapshots cost nothing worth
 * optimising away, and they cannot drift out of step with the document the way
 * a command log can.
 */
export class EditorState {
  private current: Project;
  private past: string[] = [];
  private future: string[] = [];
  private listeners = new Set<(project: Project, live: boolean) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private gesture = false;

  constructor(project: Project) {
    this.current = project;
  }

  get project(): Project {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * `live` marks an update mid-gesture — a slider still under a finger. The
   * editor uses it to refresh the preview without rebuilding the controls,
   * because replacing a slider while it is being dragged ends the drag.
   */
  subscribe(listener: (project: Project, live: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Records a change. `live` marks an update from a gesture still in progress.
   *
   * History is written once per gesture, at its *start*, so undoing a slider
   * drag returns to where the drag began rather than to its second-to-last
   * value — and the intermediate positions never reach the undo stack.
   */
  commit(project: Project, live = false): void {
    if (live) {
      if (!this.gesture) {
        this.pushHistory();
        this.gesture = true;
      }
    } else {
      if (!this.gesture) this.pushHistory();
      this.gesture = false;
    }
    this.current = project;
    this.announce(live);
  }

  private pushHistory(): void {
    this.past.push(JSON.stringify(this.current));
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  /** Replaces the document outright, clearing history: a new project, not an edit. */
  reset(project: Project): void {
    this.past = [];
    this.future = [];
    this.gesture = false;
    this.current = project;
    this.announce();
  }

  undo(): void {
    this.gesture = false;
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(JSON.stringify(this.current));
    this.current = JSON.parse(previous) as Project;
    this.announce();
  }

  redo(): void {
    this.gesture = false;
    const next = this.future.pop();
    if (!next) return;
    this.past.push(JSON.stringify(this.current));
    this.current = JSON.parse(next) as Project;
    this.announce();
  }

  private announce(live = false): void {
    for (const listener of this.listeners) listener(this.current, live);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      // Best effort: private browsing and full quotas both throw here, and
      // neither is a reason to interrupt what someone is doing.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
      } catch {
        /* recovery is a convenience, not a guarantee */
      }
    }, 400);
  }
}

/** The project left behind by the last session, if the browser kept it. */
export function loadRecovered(): unknown | null {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function forgetRecovered(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
