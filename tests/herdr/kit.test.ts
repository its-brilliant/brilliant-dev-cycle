/**
 * The kit the bdc mods share, tested as plain JavaScript (spec §9, §12.5).
 *
 * The kit imports nothing from Herdr, so these tests drive it directly: the event a click sends,
 * which run the UI follows, what a `view.json` must look like to be rendered, and the stepper's
 * own labels. The Herdr side of the kit (the `herdr` functions) is `kit/host.js`, which a mod
 * hands in and a test replaces with a fake.
 */
import { describe, expect, it } from 'vitest';
import { bdcCommands, sendArgs, startArgs, statusArgs, type KitHost } from '../../herdr-app/kit/bdc.js';
import { activeSpace, parseRunIds, pickRun, projectName, resolveProject, sameTarget, viewFile, type ProjectHost } from '../../herdr-app/kit/project.js';
import { parseView } from '../../herdr-app/kit/view.js';
import { joinWords, plural, stepOf } from '../../herdr-app/kit/words.js';

const BDC = ['/usr/local/bin/node', '/repo/dist/cli/bin.js'];

describe('the bdc command a mod runs', () => {
  it('sends one person event with its payload and the run it belongs to', () => {
    expect(sendArgs('/work/app', { type: 'MESSAGE', text: 'hello' }, 'run-1')).toEqual([
      'send',
      '/work/app',
      'MESSAGE',
      '{"text":"hello"}',
      '--run',
      'run-1',
    ]);
  });

  it('leaves the run out when the UI does not know one, so bdc picks the latest', () => {
    expect(sendArgs('/work/app', { type: 'PAUSE' })).toEqual(['send', '/work/app', 'PAUSE', '{}']);
  });

  it('starts a run with the goal and reads a status with its run', () => {
    expect(startArgs('/work/app', 'ship the thing')).toEqual(['start', '/work/app', 'ship the thing']);
    expect(statusArgs('/work/app', 'run-2')).toEqual(['status', '/work/app', '--run', 'run-2']);
    expect(statusArgs('/work/app')).toEqual(['status', '/work/app']);
  });
});

describe('bdcCommands', () => {
  it('runs the command with this checkout first, then the bdc arguments', async () => {
    const calls: string[][] = [];
    const host: KitHost = {
      exec: (command, args = []) => {
        calls.push([command, ...args]);
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    };

    await expect(bdcCommands(host, BDC).send('/work/app', { type: 'RESUME' }, 'run-1')).resolves.toEqual({ ok: true, error: '' });
    expect(calls).toEqual([['/usr/local/bin/node', '/repo/dist/cli/bin.js', 'send', '/work/app', 'RESUME', '{}', '--run', 'run-1']]);
  });

  it("reports the CLI's own refusal instead of throwing it", async () => {
    const host: KitHost = { exec: () => Promise.resolve({ code: 1, stdout: '', stderr: 'no bdc daemon is running for /work/app' }) };

    await expect(bdcCommands(host, BDC).send('/work/app', { type: 'PAUSE' })).resolves.toEqual({
      ok: false,
      error: 'no bdc daemon is running for /work/app',
    });
  });

  it('says the build is missing when bdc cannot start at all', async () => {
    const host: KitHost = { exec: () => Promise.reject(new Error('spawn /repo/dist/cli/bin.js ENOENT')) };

    await expect(bdcCommands(host, BDC).send('/work/app', { type: 'PAUSE' })).resolves.toEqual({
      ok: false,
      error: 'spawn /repo/dist/cli/bin.js ENOENT',
    });
  });

  it('reads the new run id that `bdc start` prints', async () => {
    const host: KitHost = { exec: () => Promise.resolve({ code: 0, stdout: 'run-7\n', stderr: '' }) };

    await expect(bdcCommands(host, BDC).start('/work/app', 'ship it')).resolves.toEqual({ ok: true, runId: 'run-7', error: '' });
  });

  it('reads the run view that `bdc status` prints', async () => {
    const view = { runId: 'run-7', stage: 'building' };
    const host: KitHost = { exec: () => Promise.resolve({ code: 0, stdout: JSON.stringify(view), stderr: '' }) };

    await expect(bdcCommands(host, BDC).status('/work/app', 'run-7')).resolves.toEqual({ ok: true, view, error: '' });
  });
});

describe('which project and run the UI shows', () => {
  it('takes the space the person is looking at', () => {
    const spaces = [
      { id: 's1', active: false, folder: '/one' },
      { id: 's2', active: true, folder: '/two', machine: null },
    ];

    expect(activeSpace(spaces)).toEqual(spaces[1]);
    expect(activeSpace([{ id: 's1', active: false, folder: '/one' }])).toBeNull();
  });

  it('takes the newest run folder, and only names that can be run ids', () => {
    expect(parseRunIds('run-3\nrun-2\n\n..\n.hidden\nrun-1\n')).toEqual(['run-3', 'run-2', 'run-1']);
    expect(pickRun(['run-3', 'run-2'], null)).toBe('run-3');
    expect(pickRun([], null)).toBeNull();
  });

  it('follows a pinned run while it exists, and the newest one when it does not', () => {
    expect(pickRun(['run-3', 'run-2'], 'run-2')).toBe('run-2');
    expect(pickRun(['run-3'], 'run-gone')).toBe('run-3');
    expect(pickRun(['run-3'], 42)).toBe('run-3');
  });

  it('names the project after its folder and puts the view under .herd/runs', () => {
    expect(projectName('/Users/someone/code/app')).toBe('app');
    expect(viewFile('/work/app', 'run-1')).toBe('/work/app/.herd/runs/run-1/view.json');
  });

  it('finds the project of the active space, with its newest run, on that machine', async () => {
    const read: Array<{ file: string; on: string | null | undefined }> = [];
    const ran: string[][] = [];
    const host: ProjectHost = {
      spaces: () => [{ id: 's2', active: true, folder: '/work/app', machine: 'laptop' }],
      shared: () => null,
      readTextFile: (file, options) => {
        read.push({ file, on: options?.on });
        return Promise.resolve(file.endsWith('bdc.yaml') ? 'agents: {}' : null);
      },
      exec: (command, args = [], options) => {
        ran.push([command, ...args, options?.on ?? 'local']);
        return Promise.resolve({ code: 0, stdout: 'run-9\nrun-8\n', stderr: '' });
      },
    };

    await expect(resolveProject(host)).resolves.toEqual({
      root: '/work/app',
      machine: 'laptop',
      space: 's2',
      name: 'app',
      runId: 'run-9',
    });
    expect(read).toEqual([{ file: '/work/app/bdc.yaml', on: 'laptop' }]);
    expect(ran).toEqual([['ls', '-1t', '/work/app/.herd/runs', 'laptop']]);
  });

  it('is no project when the active space has no bdc.yaml', async () => {
    const host: ProjectHost = {
      spaces: () => [{ id: 's1', active: true, folder: '/work/app' }],
      shared: () => null,
      readTextFile: () => Promise.resolve(null),
      exec: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    };

    await expect(resolveProject(host)).resolves.toBeNull();
  });

  it('is no run yet when the project has no runs folder', async () => {
    const host: ProjectHost = {
      spaces: () => [{ id: 's1', active: true, folder: '/work/app' }],
      shared: () => null,
      readTextFile: () => Promise.resolve('agents: {}'),
      exec: () => Promise.reject(new Error('ls: /work/app/.herd/runs: No such file or directory')),
    };

    await expect(resolveProject(host)).resolves.toEqual({ root: '/work/app', machine: null, space: 's1', name: 'app', runId: null });
  });

  it('knows when the target did not change', () => {
    const target = { root: '/work/app', machine: null, space: 's1', name: 'app', runId: 'run-1' };

    expect(sameTarget(target, { ...target })).toBe(true);
    expect(sameTarget(target, { ...target, runId: 'run-2' })).toBe(false);
    expect(sameTarget(target, null)).toBe(false);
    expect(sameTarget(null, null)).toBe(true);
  });
});

describe('the view the mods render', () => {
  it('reads a run view', () => {
    expect(parseView('{"runId":"run-1","stage":"intake"}')).toEqual({ runId: 'run-1', stage: 'intake' });
  });

  it('ignores a missing, half-written or foreign file', () => {
    expect(parseView(null)).toBeNull();
    expect(parseView('')).toBeNull();
    expect(parseView('{"runId":"run-1"')).toBeNull();
    expect(parseView('{"stage":"intake"}')).toBeNull();
    expect(parseView('[]')).toBeNull();
  });
});

describe('the words that are the app\'s own chrome', () => {
  it('puts each stage on its stepper step', () => {
    expect(stepOf('intake')).toBe(0);
    expect(stepOf('specDrafting')).toBe(1);
    expect(stepOf('specReview')).toBe(1);
    expect(stepOf('planReview')).toBe(2);
    expect(stepOf('building')).toBe(3);
    expect(stepOf('finalReview')).toBe(4);
    expect(stepOf('shipping')).toBe(5);
    expect(stepOf('failed')).toBe(-1);
  });

  it('counts and lists in words a person reads', () => {
    expect(plural(1, 'phase')).toBe('1 phase');
    expect(plural(3, 'phase')).toBe('3 phases');
    expect(joinWords(['a'])).toBe('a');
    expect(joinWords(['a', 'b'])).toBe('a and b');
    expect(joinWords(['a', 'b', 'c'])).toBe('a, b and c');
    expect(joinWords([])).toBe('');
  });
});
