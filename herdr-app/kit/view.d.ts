// Types for kit/view.js: following one run's view.json.

/** A run view as `view.json` carries it (src/contracts/view.ts is the full schema). */
export interface RunViewLike {
  runId: string;
  stage: string;
  [key: string]: unknown;
}

/** The parts of Herdr's Context the watcher uses. */
export interface WatchContext {
  spawn(body: (cx: WatchContext) => unknown): { cancel(): void };
  timer: { every(ms: number, handler: (cx: WatchContext) => void): { cancel(): void } };
  sleep(ms?: number): Promise<void>;
  notify(): void;
}

export interface WatchTarget {
  root: string;
  runId: string;
  machine?: string | null;
}

export interface WatchHost {
  readTextFile(path: string, options?: { on?: string | null }): Promise<string | null>;
  watchFolder(path: string): Promise<string[]> & { cancel(): void };
}

export function parseView(text: string | null): RunViewLike | null;
export function watchRun(host: WatchHost, cx: WatchContext, target: WatchTarget, onView: (view: RunViewLike) => void): { stop(): void };
