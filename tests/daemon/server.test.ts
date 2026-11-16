import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assign, setup, type AnyStateMachine, type SnapshotFrom } from 'xstate';
import { connect, newRequestId, pingSocket, type DaemonResponse } from '../../src/daemon/client.js';
import { RunHost } from '../../src/daemon/host.js';
import { projectPaths, type ProjectPaths } from '../../src/daemon/paths.js';
import { startDaemon, type Daemon } from '../../src/daemon/server.js';
import { RunStore, type JsonValue } from '../../src/daemon/store.js';

/** A toy run: a counter that keeps its state, so a view shows that an event arrived. */
const counterMachine: AnyStateMachine = setup({
  types: { context: {} as { count: number }, events: {} as { type: 'INC' } | { type: 'PAUSE' } },
  actions: { increment: assign({ count: ({ context }) => context.count + 1 }) },
}).createMachine({
  id: 'counter',
  initial: 'counting',
  context: () => ({ count: 0 }),
  states: { counting: { on: { INC: { actions: 'increment' }, PAUSE: {} } } },
});

const project = (snapshot: SnapshotFrom<AnyStateMachine>): JsonValue => ({
  stage: String(snapshot.value),
  count: (snapshot.context as { count: number }).count,
});

let root: string;
let paths: ProjectPaths;
let host: RunHost;
let daemon: Daemon;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-server-'));
  paths = projectPaths(root);
  host = new RunHost({ machine: counterMachine, machineVersion: 1, input: {}, store: new RunStore(paths.run('run-1'), 1), project });
  host.start();
  daemon = await startDaemon({ root, hostFor: (runId) => (runId === 'run-1' ? host : undefined), runs: () => ['run-1'] });
});

afterEach(async () => {
  await daemon.stopDaemon();
  host.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A connection that speaks raw lines, for the requests a well-behaved client never sends. */
async function rawConnection(socketPath: string): Promise<{ socket: net.Socket; lines: string[] }> {
  const socket = net.connect(socketPath);
  socket.setEncoding('utf8');
  const lines: string[] = [];
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      lines.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  return { socket, lines };
}

async function oneAnswer(lines: string[]): Promise<DaemonResponse> {
  await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
  return JSON.parse(lines[0] as string) as DaemonResponse;
}

describe('the daemon socket', () => {
  it('answers a ping', async () => {
    expect(await pingSocket(daemon.socket, 1_000)).toBe(true);
  });

  it('applies a sent event and answers with the run view', async () => {
    const client = await connect(root);
    try {
      expect(await client.request({ id: newRequestId(), type: 'send', runId: 'run-1', event: { type: 'INC' } })).toEqual({ id: expect.any(String), ok: true });
      const view = await client.request({ id: newRequestId(), type: 'view', runId: 'run-1' });

      expect(view).toMatchObject({ ok: true, view: { stage: 'counting', count: 1 } });
      expect(host.view).toEqual({ stage: 'counting', count: 1 });
    } finally {
      client.close();
    }
  });

  it('streams the current view and then every new one to a subscriber', async () => {
    const watcher = await connect(root);
    const sender = await connect(root);
    const views: JsonValue[] = [];
    try {
      await watcher.subscribe('run-1', (view) => views.push(view));
      await vi.waitFor(() => expect(views).toEqual([{ stage: 'counting', count: 0 }]));

      await sender.request({ id: newRequestId(), type: 'send', runId: 'run-1', event: { type: 'INC' } });

      await vi.waitFor(() => expect(views).toEqual([{ stage: 'counting', count: 0 }, { stage: 'counting', count: 1 }]));
    } finally {
      watcher.close();
      sender.close();
    }
  });

  it('lists the runs with the stage from each view', async () => {
    const client = await connect(root);
    try {
      const response = await client.request({ id: newRequestId(), type: 'runs' });
      expect(response).toEqual({ id: expect.any(String), ok: true, runs: [{ runId: 'run-1', stage: 'counting' }] });
    } finally {
      client.close();
    }
  });

  it('answers a malformed line with an error and keeps serving', async () => {
    const { socket, lines } = await rawConnection(daemon.socket);
    try {
      socket.write('this is not json\n');

      expect(await oneAnswer(lines)).toEqual({ id: null, ok: false, error: expect.stringContaining('malformed request') });
      expect(await pingSocket(daemon.socket, 1_000)).toBe(true);
    } finally {
      socket.destroy();
    }
  });

  it('answers an unknown run, an unknown request type and a request without an id', async () => {
    const { socket, lines } = await rawConnection(daemon.socket);
    try {
      socket.write(`${JSON.stringify({ id: 'a', type: 'view', runId: 'nope' })}\n`);
      socket.write(`${JSON.stringify({ id: 'b', type: 'dance' })}\n`);
      socket.write(`${JSON.stringify({ type: 'ping' })}\n`);

      await vi.waitFor(() => expect(lines).toHaveLength(3));
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { id: 'a', ok: false, error: 'unknown run: nope' },
        { id: 'b', ok: false, error: 'unknown request type: dance' },
        { id: null, ok: false, error: 'a request needs a string id and type' },
      ]);
    } finally {
      socket.destroy();
    }
  });

  it('refuses a second daemon on the same project', async () => {
    await expect(startDaemon({ root, hostFor: () => host, runs: () => ['run-1'] })).rejects.toThrow(/already running/);
  });

  it('removes a stale socket file and serves on it', async () => {
    await daemon.stopDaemon();
    expect(fs.existsSync(daemon.socket)).toBe(false);
    fs.writeFileSync(daemon.socket, '');

    daemon = await startDaemon({ root, hostFor: (runId) => (runId === 'run-1' ? host : undefined), runs: () => ['run-1'] });

    expect(await pingSocket(daemon.socket, 1_000)).toBe(true);
  });

  it('removes the socket file when it stops', async () => {
    expect(fs.existsSync(paths.socket)).toBe(true);

    await daemon.stopDaemon();

    expect(fs.existsSync(paths.socket)).toBe(false);
  });
});
