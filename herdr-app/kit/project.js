// Which project and which run the bdc mods show (spec §9.2).
//
// The project is the active Herdr space's folder when that folder has a `bdc.yaml`; otherwise
// there is no project and the main area says how to make one. The run is the newest folder under
// `<root>/.herd/runs`, unless `shared("bdc.run")` pins a run id.
//
// The pure parts (which space, which run id, what the paths are) are exported on their own so a
// test can check them without Herdr (tests/herdr/kit.test.ts).
import { basename, join } from 'path';

/** A run id is a folder name under `.herd/runs` (src/daemon/paths.ts uses the same rule). */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The space the person is looking at, or null. */
export function activeSpace(spaces) {
  return spaces.find((space) => space.active) ?? null;
}

/** `<root>/.herd/runs`: where every run of the project lives (spec §10). */
export function runsDir(root) {
  return join(root, '.herd', 'runs');
}

/** `<root>/.herd/runs/<run>/view.json`: the projection the mods render (spec §7.2). */
export function viewFile(root, runId) {
  return join(runsDir(root), runId, 'view.json');
}

/** The lines of `ls -1t`: newest first, and only the names that can be run ids. */
export function parseRunIds(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => RUN_ID.test(line));
}

/** The newest run, or the one `shared("bdc.run")` pins when it still exists. */
export function pickRun(ids, pinned) {
  if (typeof pinned === 'string' && ids.includes(pinned)) return pinned;
  return ids[0] ?? null;
}

/** The project's name for the header: its folder's name. */
export function projectName(root) {
  return basename(root);
}

/**
 * The project the UI shows: `{ root, machine, space, name, runId }`, or null when the active
 * space has no `bdc.yaml` (the main area shows the setup screen then).
 */
export async function resolveProject(host) {
  const space = activeSpace(host.spaces());
  if (space === null || typeof space.folder !== 'string' || space.folder === '') return null;
  const machine = space.machine ?? null;
  const config = await host.readTextFile(join(space.folder, 'bdc.yaml'), { on: machine });
  if (config === null) return null;
  return {
    root: space.folder,
    machine,
    space: space.id,
    name: projectName(space.folder),
    runId: pickRun(await listRuns(host, space.folder, machine), host.shared('bdc.run')),
  };
}

/** The run folders, newest first. No `.herd/runs` yet is no runs, not an error. */
export async function listRuns(host, root, machine = null) {
  try {
    const result = await host.exec('ls', ['-1t', runsDir(root)], { on: machine });
    if (result.code !== 0) return [];
    return parseRunIds(result.stdout);
  } catch {
    return [];
  }
}

/** Two targets are the same project and run: what decides whether the view watch must move. */
export function sameTarget(left, right) {
  if (left === null || right === null) return left === right;
  return left.root === right.root && left.runId === right.runId && left.machine === right.machine;
}
