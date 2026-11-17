// Following one run's `view.json` (spec §7.2): the only data the UI renders.
//
// A watch on the run folder is the fast path; a 3-second read is the fallback for a watch event
// that was missed, and the only path for a project on another machine (a remote folder cannot be
// watched from here). The mod stops the watcher when the project or run changes and on close.
import { join } from 'path';
import { viewFile } from './project.js';

/** The view in `view.json`, or null while the file is absent, half-written or not a view. */
export function parseView(text) {
  if (typeof text !== 'string' || text === '') return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  if (typeof raw.runId !== 'string' || typeof raw.stage !== 'string') return null;
  return raw;
}

/**
 * Watch a run and call `onView(view)` on every change, then redraw the owning view.
 * `target` is `{ root, runId, machine }` from `project.js`. Answers `{ stop() }`.
 */
export function watchRun(host, cx, target, onView) {
  let stopped = false;
  let watch = null;
  const folder = join(target.root, '.herd', 'runs', String(target.runId));

  const read = async (asyncCx) => {
    if (stopped) return;
    const text = await host.readTextFile(viewFile(target.root, target.runId), { on: target.machine ?? null });
    if (stopped) return;
    const view = parseView(text);
    if (view === null) return;
    onView(view);
    asyncCx.notify();
  };

  cx.spawn(async (asyncCx) => {
    await read(asyncCx);
    if (target.machine !== null && target.machine !== undefined) return;
    for (;;) {
      if (stopped) return;
      try {
        watch = host.watchFolder(folder);
        await watch;
      } catch {
        // A missing folder or too large a tree: keep the poll, try the watch again later.
        await asyncCx.sleep(3000);
        continue;
      }
      if (stopped) return;
      await read(asyncCx);
    }
  });

  const poll = cx.timer.every(3000, (asyncCx) => {
    void read(asyncCx);
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        watch?.cancel?.();
      } catch {
        // The watch already settled; nothing to release.
      }
      try {
        poll.cancel();
      } catch {
        // Already cancelled with the view's build.
      }
    },
  };
}
