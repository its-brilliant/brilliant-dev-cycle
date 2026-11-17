import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMachine, setup } from 'xstate';
import { RunHost } from '../../src/daemon/host.js';
import { projectPaths } from '../../src/daemon/paths.js';
import { RunStore } from '../../src/daemon/store.js';

/**
 * Seen with a real run on 17 Nov 2026: the PM's agent moved from `launching` to `running`, a change
 * inside a child only, and machine.json still said `launching` a minute later. A crash then would
 * have restored a stale tree.
 */
describe('RunHost persists changes inside child actors', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes machine.json when only a child changes state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-host-children-'));
    dirs.push(root);
    // The child moves on by itself after a moment and tells nobody.
    const child = createMachine({ id: 'child', initial: 'launching', states: { launching: { after: { 20: 'running' } }, running: {} } });
    const parent = setup({ actors: { child } }).createMachine({
      id: 'parent',
      initial: 'active',
      states: { active: { invoke: { id: 'agent', src: 'child' } } },
    });
    const store = new RunStore(projectPaths(root).run('r-test'), 1);
    const host = new RunHost({ machine: parent, machineVersion: 1, input: {}, store, project: () => ({}) });
    host.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const stored = store.readSnapshot() as { snapshot: { children: Record<string, { snapshot: { value: unknown } }> } };
    expect(stored.snapshot.children.agent?.snapshot.value).toBe('running');
    host.stop();
  });
});

/** 17 Nov 2026: a cancelled run left its PM's claude running; the daemon now cleans up on the final state. */
describe('RunHost onFinal', () => {
  it('is called once when the machine reaches a final state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-host-final-'));
    try {
      const machine = createMachine({ id: 'm', initial: 'running', states: { running: { on: { CANCEL: 'cancelled' } }, cancelled: { type: 'final' } } });
      let finals = 0;
      const host = new RunHost({ machine, machineVersion: 1, input: {}, store: new RunStore(projectPaths(root).run('r-final'), 1), project: () => ({}), onFinal: () => (finals += 1) });
      host.start();
      expect(finals).toBe(0);
      host.send({ type: 'CANCEL' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(finals).toBe(1);
      host.stop();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
