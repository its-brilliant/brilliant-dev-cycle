import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPaths, type ProjectPaths, type RunFiles } from '../../src/daemon/paths.js';
import { RunStore } from '../../src/daemon/store.js';

let root: string;
let paths: ProjectPaths;
let files: RunFiles;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-store-'));
  paths = projectPaths(root);
  files = paths.run('run-1');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('RunStore', () => {
  it('reads back the snapshot it wrote, with the machine version', () => {
    const store = new RunStore(files, 3);
    expect(store.readSnapshot()).toBeNull();

    store.writeSnapshot({ value: 'working', context: { count: 2 } });

    expect(store.readSnapshot()).toEqual({ machineVersion: 3, snapshot: { value: 'working', context: { count: 2 } } });
  });

  it('reads a snapshot from another machine version as incompatible', () => {
    new RunStore(files, 2).writeSnapshot({ value: 'working' });

    expect(new RunStore(files, 3).readSnapshot()).toEqual({ incompatible: true });
  });

  it('reads a torn or missing machine.json as no snapshot rather than throwing', () => {
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.machine, '{"machineVersion":1,"snap');

    expect(new RunStore(files, 1).readSnapshot()).toBeNull();
  });

  it('leaves no temp files behind when it writes', () => {
    const store = new RunStore(files, 1);
    for (let count = 0; count < 5; count += 1) {
      store.writeSnapshot({ context: { count } });
      store.writeView({ stage: 'working', count });
    }

    expect(fs.readdirSync(files.dir).sort()).toEqual(['machine.json', 'view.json']);
  });

  it('replaces view.json atomically instead of growing it', () => {
    const store = new RunStore(files, 1);
    store.writeView({ stage: 'working' });
    store.writeView({ stage: 'done', count: 1 });

    expect(store.readView()).toEqual({ stage: 'done', count: 1 });
    expect(fs.readFileSync(files.view, 'utf8')).toBe('{"stage":"done","count":1}');
  });

  it('appends one JSON line per event with an ISO timestamp', () => {
    const store = new RunStore(files, 1);
    const first = store.appendEvent({ type: 'INC', count: 1 });
    const second = store.appendEvent({ type: 'FINISH' });

    expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(store.readEvents()).toEqual([first, second]);
    expect(fs.readFileSync(files.events, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(store.readEvents()[0]).toMatchObject({ type: 'INC', count: 1 });
  });

  it('has no events and no view before anything is written', () => {
    const store = new RunStore(files, 1);
    expect(store.readEvents()).toEqual([]);
    expect(store.readView()).toBeUndefined();
  });
});
