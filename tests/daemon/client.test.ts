import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, ensureDaemon, newRequestId, pingSocket } from '../../src/daemon/client.js';
import { projectPaths, type ProjectPaths } from '../../src/daemon/paths.js';
import { startDaemon, type Daemon } from '../../src/daemon/server.js';

let root: string;
let paths: ProjectPaths;
let daemon: Daemon | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-client-'));
  paths = projectPaths(root);
  daemon = undefined;
});

afterEach(async () => {
  await daemon?.stopDaemon();
  daemon = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

/** A daemon with no runs: enough to answer ping, which is all `ensureDaemon` asks. */
function startBareDaemon(): Promise<Daemon> {
  return startDaemon({ root, hostFor: () => undefined, runs: () => [] });
}

describe('connect', () => {
  it('rejects when no daemon is listening', async () => {
    await expect(connect(root)).rejects.toThrow();
    expect(await pingSocket(paths.socket, 200)).toBe(false);
  });

  it('rejects a request the daemon never answers', async () => {
    fs.mkdirSync(paths.herd, { recursive: true });
    const accepted: net.Socket[] = [];
    const silent = net.createServer((socket) => accepted.push(socket));
    await new Promise<void>((resolve) => silent.listen(paths.socket, () => resolve()));
    try {
      const client = await connect(root);
      await expect(client.request({ id: newRequestId(), type: 'ping' }, 100)).rejects.toThrow(/did not answer ping within 100ms/);
      client.close();
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

describe('ensureDaemon', () => {
  it('does not spawn when a daemon already answers', async () => {
    daemon = await startBareDaemon();
    let spawned = false;

    await ensureDaemon(root, () => {
      spawned = true;
    });

    expect(spawned).toBe(false);
    expect(await pingSocket(paths.socket, 200)).toBe(true);
  });

  it('spawns the daemon and waits until it answers', async () => {
    const spawned: string[] = [];

    await ensureDaemon(
      root,
      async () => {
        spawned.push('spawn');
        daemon = await startBareDaemon();
      },
      { timeoutMs: 5_000 },
    );

    expect(spawned).toEqual(['spawn']);
    expect(await pingSocket(paths.socket, 200)).toBe(true);
  });

  it('gives up when the spawned daemon never answers', async () => {
    await expect(ensureDaemon(root, () => undefined, { timeoutMs: 300, intervalMs: 50, pingTimeoutMs: 50 })).rejects.toThrow(/did not answer/);
  });
});
