import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assign, setup, type AnyStateMachine, type SnapshotFrom } from 'xstate';
import { main, type CliIO } from '../../src/cli/main.js';
import { connect, newRequestId } from '../../src/daemon/client.js';
import { RunHost } from '../../src/daemon/host.js';
import { projectPaths, type ProjectPaths } from '../../src/daemon/paths.js';
import { startDaemon, type Daemon } from '../../src/daemon/server.js';
import { RunStore, type JsonValue } from '../../src/daemon/store.js';

/** A toy run: a counter, so a command's effect is visible in the view and in events.jsonl. */
const counterMachine: AnyStateMachine = setup({
  types: { context: {} as { count: number }, events: {} as { type: string } },
  actions: { increment: assign({ count: ({ context }) => context.count + 1 }) },
}).createMachine({
  id: 'counter',
  initial: 'counting',
  context: () => ({ count: 0 }),
  states: { counting: { on: { INC: { actions: 'increment' }, MESSAGE: {} } } },
});

const project = (snapshot: SnapshotFrom<AnyStateMachine>): JsonValue => ({
  stage: String(snapshot.value),
  count: (snapshot.context as { count: number }).count,
});

const RUNS = ['run-1', 'run-2'];

let root: string;
let paths: ProjectPaths;
let stores: Map<string, RunStore>;
let hosts: RunHost[];
let daemon: Daemon;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-cli-'));
  paths = projectPaths(root);
  stores = new Map();
  hosts = RUNS.map((runId) => {
    const store = new RunStore(paths.run(runId), 1);
    stores.set(runId, store);
    const host = new RunHost({ machine: counterMachine, machineVersion: 1, input: {}, store, project });
    host.start();
    return host;
  });
  daemon = await startDaemon({
    root,
    hostFor: (runId) => hosts[RUNS.indexOf(runId)],
    runs: () => RUNS,
  });
});

afterEach(async () => {
  await daemon.stopDaemon();
  for (const host of hosts) host.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

function captureIO(signal?: AbortSignal): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text), signal }, out, err };
}

function events(runId: string): unknown[] {
  return (stores.get(runId) as RunStore).readEvents();
}

describe('bdc send', () => {
  it('sends an event to the latest run', async () => {
    const { io, out, err } = captureIO();

    expect(await main(['send', root, 'INC'], io)).toBe(0);

    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(hosts[1]?.view).toEqual({ stage: 'counting', count: 1 });
    expect(hosts[0]?.view).toEqual({ stage: 'counting', count: 0 });
  });

  it('sends to the run named by --run', async () => {
    const { io } = captureIO();

    expect(await main(['send', root, 'INC', '--run', 'run-1'], io)).toBe(0);

    expect(hosts[0]?.view).toEqual({ stage: 'counting', count: 1 });
    expect(hosts[1]?.view).toEqual({ stage: 'counting', count: 0 });
  });

  it('merges a JSON payload into the event', async () => {
    const { io } = captureIO();

    expect(await main(['send', root, 'MESSAGE', '{"text":"looks good"}', '--run=run-2'], io)).toBe(0);

    expect(events('run-2')).toEqual([expect.objectContaining({ type: 'MESSAGE', text: 'looks good' })]);
  });

  it('answers exit code 1 when the daemon refuses the event', async () => {
    const { io, err } = captureIO();

    expect(await main(['send', root, 'INC', '--run', 'run-9'], io)).toBe(1);

    expect(err.join('')).toContain('unknown run: run-9');
  });
});

describe('bdc status', () => {
  it('prints the latest run view as JSON', async () => {
    const { io, out } = captureIO();
    await main(['send', root, 'INC'], io);

    expect(await main(['status', root], io)).toBe(0);

    expect(JSON.parse(out.join(''))).toEqual({ stage: 'counting', count: 1 });
  });

  it('prints the view of the run named by --run', async () => {
    const { io, out } = captureIO();

    expect(await main(['status', root, '--run', 'run-1'], io)).toBe(0);

    expect(JSON.parse(out.join(''))).toEqual({ stage: 'counting', count: 0 });
  });
});

describe('bdc runs', () => {
  it('prints one line per run with its stage', async () => {
    const { io, out } = captureIO();

    expect(await main(['runs', root], io)).toBe(0);

    expect(out.map((line) => JSON.parse(line))).toEqual([
      { runId: 'run-1', stage: 'counting' },
      { runId: 'run-2', stage: 'counting' },
    ]);
  });
});

describe('bdc watch', () => {
  it('prints one JSON line per view until it is stopped', async () => {
    const controller = new AbortController();
    const { io, out } = captureIO(controller.signal);

    const watching = main(['watch', root, '--run', 'run-1'], io);
    await vi.waitFor(() => expect(out).toHaveLength(1));

    const client = await connect(root);
    await client.request({ id: newRequestId(), type: 'send', runId: 'run-1', event: { type: 'INC' } });
    client.close();
    await vi.waitFor(() => expect(out).toHaveLength(2));

    controller.abort();
    expect(await watching).toBe(0);
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { stage: 'counting', count: 0 },
      { stage: 'counting', count: 1 },
    ]);
  });
});

describe('bdc command line', () => {
  it('answers an unknown command with the usage and exit code 2', async () => {
    const { io, out, err } = captureIO();

    expect(await main(['dance'], io)).toBe(2);

    expect(out).toEqual([]);
    expect(err.join('')).toContain('unknown command: dance');
    expect(err.join('')).toContain('usage:');
  });

  it('answers no command with the usage and exit code 2', async () => {
    const { io, err } = captureIO();

    expect(await main([], io)).toBe(2);

    expect(err.join('')).toContain('usage:');
  });

  it('answers help with the usage and exit code 0', async () => {
    const { io, out } = captureIO();

    expect(await main(['help'], io)).toBe(0);

    expect(out.join('')).toContain('bdc watch <dir>');
  });

  it('answers a missing argument with exit code 2', async () => {
    const { io, err } = captureIO();

    expect(await main(['send', root], io)).toBe(2);

    expect(err.join('')).toContain('send needs an event type');
  });

  it('answers an unknown option with exit code 2', async () => {
    const { io, err } = captureIO();

    expect(await main(['status', root, '--wat'], io)).toBe(2);

    expect(err.join('')).toContain('unknown option: --wat');
  });

  it('answers a payload that is not a JSON object with exit code 2', async () => {
    const { io, err } = captureIO();

    expect(await main(['send', root, 'MESSAGE', '[1,2]'], io)).toBe(2);
    expect(await main(['send', root, 'MESSAGE', '{oops'], io)).toBe(2);

    expect(err.join('')).toContain('the payload must be a JSON object');
    expect(err.join('')).toContain('the payload is not JSON');
    expect(events('run-2')).toEqual([]);
  });

  it('answers exit code 1 when no daemon is running for the project', async () => {
    const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-cli-lonely-'));
    const { io, err } = captureIO();
    try {
      expect(await main(['status', lonely, '--run', 'run-1'], io)).toBe(1);
      expect(err.join('')).toContain('no bdc daemon is running');
    } finally {
      fs.rmSync(lonely, { recursive: true, force: true });
    }
  });
});
