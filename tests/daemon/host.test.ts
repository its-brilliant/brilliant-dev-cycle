import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assign, fromPromise, setup, type AnyStateMachine, type SnapshotFrom } from 'xstate';
import { RunHost } from '../../src/daemon/host.js';
import { projectPaths, type RunFiles } from '../../src/daemon/paths.js';
import { RunStore, type JsonValue } from '../../src/daemon/store.js';

/**
 * A toy run machine: a counter, an invoked job that never finishes (like a live agent, so a restore
 * has something to restart), a final state, and an event whose action throws.
 */
const toyMachine = setup({
  types: {
    context: {} as { count: number },
    events: {} as { type: 'INC' } | { type: 'FINISH' } | { type: 'BOOM' },
    input: {} as { count?: number },
  },
  actors: {
    job: fromPromise<string>(async () => {
      throw new Error('job not provided');
    }),
  },
  actions: {
    increment: assign({ count: ({ context }) => context.count + 1 }),
    boom: () => {
      throw new Error('boom');
    },
  },
}).createMachine({
  id: 'toy',
  initial: 'working',
  context: ({ input }) => ({ count: input?.count ?? 0 }),
  states: {
    working: {
      invoke: { id: 'job', src: 'job' },
      on: { INC: { actions: 'increment' }, BOOM: { actions: 'boom' }, FINISH: 'done' },
    },
    done: { type: 'final' },
  },
});

/** Counts how often the invoked job started, so a restore that relaunches twice would show. */
function countingMachine(starts: { count: number }): AnyStateMachine {
  return toyMachine.provide({
    actors: {
      job: fromPromise<string>(() => {
        starts.count += 1;
        return new Promise<string>(() => undefined);
      }),
    },
  });
}

const project = (snapshot: SnapshotFrom<AnyStateMachine>): JsonValue => ({
  stage: String(snapshot.value),
  count: (snapshot.context as { count: number }).count,
});

let root: string;
let files: RunFiles;
let store: RunStore;
let starts: { count: number };
let host: RunHost;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-host-'));
  files = projectPaths(root).run('run-1');
  store = new RunStore(files, 1);
  starts = { count: 0 };
  host = makeHost();
});

afterEach(() => {
  host.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The persisted XState snapshot, unwrapped from the version record. */
function storedSnapshot(): unknown {
  const persisted = store.readSnapshot();
  return persisted && 'snapshot' in persisted ? persisted.snapshot : null;
}

function makeHost(overrides: { input?: unknown; store?: RunStore; validate?: (event: unknown) => unknown | Error } = {}): RunHost {
  return new RunHost({
    machine: countingMachine(starts),
    machineVersion: 1,
    input: overrides.input ?? {},
    store: overrides.store ?? store,
    project,
    validate: overrides.validate,
  });
}

describe('RunHost', () => {
  it('writes the snapshot and the view for the starting state and after every transition', () => {
    host.start();
    expect(store.readSnapshot()).toMatchObject({ machineVersion: 1 });
    expect(store.readView()).toEqual({ stage: 'working', count: 0 });

    expect(host.send({ type: 'INC' })).toEqual({ ok: true });
    expect(host.send({ type: 'INC' })).toEqual({ ok: true });

    expect(store.readView()).toEqual({ stage: 'working', count: 2 });
    expect(storedSnapshot()).toMatchObject({ value: 'working', context: { count: 2 } });
  });

  it('takes the machine input when there is nothing to restore', () => {
    host.stop();
    host = makeHost({ input: { count: 7 } });
    host.start();

    expect(host.view).toEqual({ stage: 'working', count: 7 });
  });

  it('restores after a crash into the same state and restarts the invoked job exactly once', () => {
    host.start();
    host.send({ type: 'INC' });
    expect(starts.count).toBe(1);
    expect(host.view).toEqual({ stage: 'working', count: 1 });

    // A crash: the process is gone, the files are not. A new host on the same store picks it up.
    host.stop();
    host = makeHost();
    host.start();

    expect(host.view).toEqual({ stage: 'working', count: 1 });
    expect(starts.count).toBe(2);
    expect(store.readEvents().map((event) => event.type)).toEqual(['INC']);
  });

  it('keeps every sent event in events.jsonl, including ones the machine ignores', () => {
    host.start();
    host.send({ type: 'INC' });
    host.send({ type: 'FINISH' });
    host.send({ type: 'INC' });

    expect(store.readEvents().map((event) => event.type)).toEqual(['INC', 'FINISH', 'INC']);
    expect(store.readView()).toEqual({ stage: 'done', count: 1 });
  });

  it('rejects an event the validator refuses without logging or applying it', () => {
    host.stop();
    host = makeHost({
      // Stands in for `PersonEvent.parse` at the socket: only INC is a known event here.
      validate: (event) => {
        const type = (event as { type?: string }).type;
        return type === 'INC' ? (event as Record<string, unknown>) : new Error(`bad event: ${String(type)}`);
      },
    });
    host.start();

    expect(host.send({ type: 'DROP_TABLES' })).toEqual({ ok: false, error: 'bad event: DROP_TABLES' });
    expect(host.send({ type: 'INC' })).toEqual({ ok: true });

    expect(store.readEvents().map((event) => event.type)).toEqual(['INC']);
    expect(host.view).toEqual({ stage: 'working', count: 1 });
  });

  it('rejects an event that is not a JSON object', () => {
    host.start();
    expect(host.send('INC')).toEqual({ ok: false, error: 'an event must be a JSON object' });
    expect(store.readEvents()).toEqual([]);
  });

  it('saves an actor error and shows it in the view', () => {
    host.start();

    expect(host.send({ type: 'BOOM' })).toEqual({ ok: true });

    expect(host.view).toEqual({ stage: 'working', count: 0, error: 'boom' });
    expect(store.readView()).toEqual({ stage: 'working', count: 0, error: 'boom' });
    expect(host.send({ type: 'INC' })).toEqual({ ok: false, error: 'this run stopped on an error' });
    expect(store.readEvents().map((event) => event.type)).toEqual(['BOOM']);
  });

  it('starts fresh when the stored snapshot is from another machine version', () => {
    store.writeSnapshot({ value: 'working', context: { count: 9 } });

    host = makeHost({ store: new RunStore(files, 2) });
    host.start();

    expect(host.view).toEqual({ stage: 'working', count: 0 });
    expect(store.readSnapshot()).toEqual({ incompatible: true });
  });

  it('gives every view to its subscribers, the current one first', () => {
    const seen: unknown[] = [];
    host.start();
    const unsubscribe = host.onView((view) => seen.push(view));

    host.send({ type: 'INC' });
    unsubscribe();
    host.send({ type: 'INC' });

    expect(seen).toEqual([
      { stage: 'working', count: 0 },
      { stage: 'working', count: 1 },
    ]);
  });

  it('stops sending once stopped', () => {
    host.start();
    host.stop();

    expect(host.send({ type: 'INC' })).toEqual({ ok: false, error: 'this run is not running' });
  });
});
