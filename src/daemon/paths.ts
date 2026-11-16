/**
 * Every path the daemon and the CLI share (spec §10, §7.2). One resolver, so the process that
 * creates the socket and the process that connects to it cannot disagree about where it is.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `sun_path` is 104 bytes on macOS and 108 on Linux, including the terminating NUL. Longer
 * socket paths fail at `listen` with ENAMETOOLONG, so anything above this moves to os.tmpdir().
 */
const MAX_SOCKET_PATH_BYTES = 100;

/** A run id is a directory name, so it may not walk out of `.herd/runs`. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface RunFiles {
  /** `.herd/runs/<run>` */
  dir: string;
  /** Persisted XState snapshot; written only by the daemon. */
  machine: string;
  /** Append-only audit log, one JSON object per line. */
  events: string;
  /** UI projection; written only by the daemon. */
  view: string;
}

export interface ProjectPaths {
  /** Absolute project root. */
  root: string;
  /** `<root>/.herd` */
  herd: string;
  /** `<root>/.herd/runs` */
  runs: string;
  /** Where the daemon listens and the client connects. Not always `<herd>/daemon.sock`. */
  socket: string;
  /** `<herd>/daemon.sock`, the socket path the layout asks for. */
  defaultSocket: string;
  /** `<herd>/daemon.sock.path`: records `socket` when it had to move out of the project. */
  socketPathFile: string;
  run(runId: string): RunFiles;
}

export function assertRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  return runId;
}

export function projectPaths(root: string): ProjectPaths {
  const absolute = path.resolve(root);
  const herd = path.join(absolute, '.herd');
  const runs = path.join(herd, 'runs');
  const defaultSocket = path.join(herd, 'daemon.sock');
  const socket =
    Buffer.byteLength(defaultSocket) <= MAX_SOCKET_PATH_BYTES
      ? defaultSocket
      : path.join(os.tmpdir(), `bdc-${createHash('sha256').update(absolute).digest('hex').slice(0, 16)}.sock`);
  return {
    root: absolute,
    herd,
    runs,
    socket,
    defaultSocket,
    socketPathFile: path.join(herd, 'daemon.sock.path'),
    run(runId: string): RunFiles {
      const dir = path.join(runs, assertRunId(runId));
      return { dir, machine: path.join(dir, 'machine.json'), events: path.join(dir, 'events.jsonl'), view: path.join(dir, 'view.json') };
    },
  };
}

/** Record the real socket path so people and tools can find it when it is not at the default. */
export function recordSocketPath(paths: ProjectPaths): void {
  fs.mkdirSync(paths.herd, { recursive: true });
  fs.writeFileSync(paths.socketPathFile, `${paths.socket}\n`);
}

export function clearSocketPathRecord(paths: ProjectPaths): void {
  fs.rmSync(paths.socketPathFile, { force: true });
}

/**
 * The run `bdc send`/`status`/`watch` mean when no `--run` is given: the one whose snapshot was
 * written last. Ties go to the greater id so the answer never depends on filesystem luck.
 */
export function latestRunId(root: string): string | null {
  const { runs } = projectPaths(root);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runs, { withFileTypes: true });
  } catch {
    return null;
  }
  let latest: { runId: string; at: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    const dir = path.join(runs, entry.name);
    const at = mtimeMs(path.join(dir, 'machine.json')) ?? mtimeMs(dir) ?? 0;
    if (!latest || at > latest.at || (at === latest.at && entry.name > latest.runId)) latest = { runId: entry.name, at };
  }
  return latest?.runId ?? null;
}

function mtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}
