import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSocketPathRecord, latestRunId, projectPaths, recordSocketPath } from '../../src/daemon/paths.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-paths-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('projectPaths', () => {
  it('puts the socket and the run files where the spec says', () => {
    const paths = projectPaths(root);

    expect(paths.root).toBe(path.resolve(root));
    expect(paths.socket).toBe(path.join(root, '.herd', 'daemon.sock'));
    expect(paths.run('run-1')).toEqual({
      dir: path.join(root, '.herd', 'runs', 'run-1'),
      machine: path.join(root, '.herd', 'runs', 'run-1', 'machine.json'),
      events: path.join(root, '.herd', 'runs', 'run-1', 'events.jsonl'),
      view: path.join(root, '.herd', 'runs', 'run-1', 'view.json'),
    });
  });

  it('resolves a relative root to the same paths as the absolute one', () => {
    const relative = path.relative(process.cwd(), root);

    expect(projectPaths(relative).socket).toBe(projectPaths(root).socket);
  });

  it('refuses a run id that would escape .herd/runs', () => {
    expect(() => projectPaths(root).run('../escape')).toThrow(/invalid run id/);
    expect(() => projectPaths(root).run('')).toThrow(/invalid run id/);
  });

  it('moves a socket path that is too long for sun_path into the temp dir', () => {
    const deep = path.join(root, 'x'.repeat(60), 'y'.repeat(40));
    fs.mkdirSync(deep, { recursive: true });

    const paths = projectPaths(deep);

    expect(paths.defaultSocket.length).toBeGreaterThan(100);
    expect(paths.socket.startsWith(os.tmpdir())).toBe(true);
    expect(Buffer.byteLength(paths.socket)).toBeLessThanOrEqual(100);
    expect(paths.socket).toMatch(/bdc-[0-9a-f]{16}\.sock$/);
    // The same root always resolves to the same socket, so the client finds the server's.
    expect(projectPaths(deep).socket).toBe(paths.socket);
  });

  it('records and clears the socket path when it is not at the default', () => {
    const paths = projectPaths(root);

    recordSocketPath(paths);
    expect(fs.readFileSync(paths.socketPathFile, 'utf8')).toBe(`${paths.socket}\n`);

    clearSocketPathRecord(paths);
    expect(fs.existsSync(paths.socketPathFile)).toBe(false);
  });
});

describe('latestRunId', () => {
  it('is null before any run exists', () => {
    expect(latestRunId(root)).toBeNull();
  });

  it('is the run whose snapshot was written last', async () => {
    const paths = projectPaths(root);
    for (const runId of ['run-1', 'run-2']) {
      const files = paths.run(runId);
      fs.mkdirSync(files.dir, { recursive: true });
      fs.writeFileSync(files.machine, '{}');
      // Distinct mtimes, oldest first: the filesystem clock may be coarse, so step it explicitly.
      fs.utimesSync(files.machine, new Date(), new Date(Date.now() + 1_000 * Number(runId.slice(-1))));
    }

    expect(latestRunId(root)).toBe('run-2');
  });

  it('ignores a directory that is not a run id', () => {
    const paths = projectPaths(root);
    fs.mkdirSync(path.join(paths.runs, 'not a run'), { recursive: true });

    expect(latestRunId(root)).toBeNull();
  });
});
