import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assign, createActor, setup } from 'xstate';
import type { PromiseActorLogic } from 'xstate';
import type {
  CommitsSinceInput,
  CommitsSinceOutput,
  EnsureWorktreeInput,
  EnsureWorktreeOutput,
  MergeBranchInput,
  MergeBranchOutput,
} from '../../src/contracts/actors.js';
import { gitEffects, worktreePathFor } from '../../src/effects/git.js';

// ── throwaway repositories ────────────────────────────────────────────────────────────────
// The real git, in a temp directory: these effects are git, so a fake would prove nothing. Each
// repo gets its own identity and no hooks, so the person's global config (signing, hooks) cannot
// reach the test.

const roots: string[] = [];

function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-git-')));
  roots.push(dir);
  gitIn(dir, ['init', '-q', '-b', 'main']);
  gitIn(dir, ['config', 'user.name', 'Test Person']);
  gitIn(dir, ['config', 'user.email', 'test@example.com']);
  gitIn(dir, ['config', 'commit.gpgsign', 'false']);
  gitIn(dir, ['config', 'core.hooksPath', path.join(dir, '.no-hooks')]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'first commit');
  return dir;
}

function commit(dir: string, message: string): string {
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', message]);
  return gitIn(dir, ['rev-parse', 'HEAD']).trim();
}

function write(dir: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

/**
 * Runs one effect the way a machine does, and answers its output — or throws what it threw. A
 * promise actor with nobody above it to catch the failure throws it out of `start()`, so the
 * harness takes the error in `onError` and hands it to the test like any other rejection.
 */
async function run<TInput, TOutput>(logic: PromiseActorLogic<TOutput, TInput>, input: TInput): Promise<TOutput> {
  const harness = setup({
    types: {
      input: {} as unknown,
      context: {} as { input: unknown; output?: unknown; error?: unknown; failed: boolean },
    },
    actors: { effect: logic as unknown as PromiseActorLogic<unknown, unknown> },
    actions: {
      keepOutput: assign({ output: ({ event }) => (event as unknown as { output: unknown }).output, failed: false }),
      keepError: assign({ error: ({ event }) => (event as unknown as { error: unknown }).error, failed: true }),
    },
  }).createMachine({
    context: ({ input: machineInput }) => ({ input: machineInput, failed: false }),
    initial: 'running',
    states: {
      running: {
        invoke: {
          src: 'effect',
          input: ({ context }: { context: { input: unknown } }) => context.input,
          onDone: { target: 'finished', actions: 'keepOutput' },
          onError: { target: 'finished', actions: 'keepError' },
        },
      },
      finished: { type: 'final' },
    },
  });
  const actor = createActor(harness, { input });
  const settled = new Promise<{ output?: unknown; error?: unknown; failed: boolean }>((resolve) => {
    actor.subscribe((snapshot) => {
      if (snapshot.status === 'done') resolve(snapshot.context);
    });
  });
  actor.start();
  const context = await settled;
  if (context.failed) throw context.error;
  return context.output as TOutput;
}

const effects = gitEffects();

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── branch names ────────────────────────────────────────────────────────────────────────

describe('branch names (§7.3)', () => {
  it('lets the run, phase and task branches exist at once: they are siblings, not nested', () => {
    const root = repo();
    for (const branch of ['bdc/r-1', 'bdc/r-1.p1', 'bdc/r-1.p1.t1']) expect(() => gitIn(root, ['branch', branch, 'main'])).not.toThrow();
    // A nested name is not a ref git can create next to the run branch, which is why bdc does not use them.
    expect(() => gitIn(root, ['branch', 'bdc/r-1/p1', 'main'])).toThrow();
  });
});

// ── ensureWorktree ───────────────────────────────────────────────────────────────────────

describe('ensureWorktree', () => {
  const ensure = (input: EnsureWorktreeInput): Promise<EnsureWorktreeOutput> => run(effects.ensureWorktree, input);

  it('creates the branch from its base and a worktree for it, and answers the head', async () => {
    const root = repo();
    const base = gitIn(root, ['rev-parse', 'HEAD']).trim();

    const output = await ensure({ root, branch: 'bdc/r-1', base: 'main' });

    expect(output.path).toBe(worktreePathFor(root, 'bdc/r-1'));
    expect(output.path).toBe(path.join(root, '.worktrees', 'bdc-r-1'));
    expect(fs.existsSync(path.join(output.path, 'a.txt'))).toBe(true);
    expect(gitIn(root, ['rev-parse', 'bdc/r-1']).trim()).toBe(base);
    expect(output.head).toBe(base);
    expect(gitIn(root, ['worktree', 'list', '--porcelain'])).toContain(output.path);
  });

  it('is idempotent: the second call reuses the branch and the worktree', async () => {
    const root = repo();
    const first = await ensure({ root, branch: 'bdc/r-1.p1', base: 'main' });
    // A commit the branch got in the meantime must survive the second call: no branch is recreated.
    write(first.path, 'work.txt', 'work\n');
    const head = commit(first.path, 'work on the phase branch');

    const second = await ensure({ root, branch: 'bdc/r-1.p1', base: 'main' });

    expect(second).toEqual({ path: first.path, head });
    expect(gitIn(root, ['rev-parse', 'bdc/r-1.p1']).trim()).toBe(head);
    expect(gitIn(root, ['worktree', 'list', '--porcelain']).split('worktree ').length - 1).toBe(2);
  });

  it('ignores .worktrees/ in the clone, once, and leaves the repo .gitignore alone', async () => {
    const root = repo();
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
    gitIn(root, ['add', '-A']);
    gitIn(root, ['commit', '-q', '-m', 'a gitignore']);

    await ensure({ root, branch: 'bdc/r-1', base: 'main' });
    await ensure({ root, branch: 'bdc/r-1.p1', base: 'bdc/r-1' });

    const exclude = fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === '.worktrees/')).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect(gitIn(root, ['status', '--porcelain'])).toBe('');
  });

  it('never moves the root checkout', async () => {
    const root = repo();
    const before = gitIn(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const beforeHead = gitIn(root, ['rev-parse', 'HEAD']).trim();

    await ensure({ root, branch: 'bdc/r-1', base: 'main' });
    await ensure({ root, branch: 'bdc/r-1.p1', base: 'bdc/r-1' });

    expect(gitIn(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(before);
    expect(gitIn(root, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
    expect(fs.existsSync(path.join(root, 'work.txt'))).toBe(false);
  });

  it('refuses a worktree that has another branch checked out', async () => {
    const root = repo();
    gitIn(root, ['branch', 'elsewhere', 'main']);
    const at = worktreePathFor(root, 'bdc/r-1.other');
    gitIn(root, ['worktree', 'add', at, 'elsewhere']);

    await expect(ensure({ root, branch: 'bdc/r-1.other', base: 'main' })).rejects.toThrow(
      new RegExp(`has elsewhere checked out, not ${'bdc/r-1.other'}`),
    );
  });

  it('refuses a directory at the worktree path that git does not know', async () => {
    const root = repo();
    const at = worktreePathFor(root, 'bdc/r-1');
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, 'someone-elses.txt'), 'keep me\n');

    await expect(ensure({ root, branch: 'bdc/r-1', base: 'main' })).rejects.toThrow(/already exists and is not a worktree/);
    expect(fs.readFileSync(path.join(at, 'someone-elses.txt'), 'utf8')).toBe('keep me\n');
  });
});

// ── mergeBranch ─────────────────────────────────────────────────────────────────────────

/** The phase branch and one task branch of it, in their own worktrees: what the phase machine makes. */
async function phaseWithTask(): Promise<{ root: string; phase: string; task: string }> {
  const root = repo();
  const phase = (await run(effects.ensureWorktree, { root, branch: 'bdc/r-1.p1', base: 'main' })).path;
  const task = (await run(effects.ensureWorktree, { root, branch: 'bdc/r-1.p1.t1', base: 'bdc/r-1.p1' })).path;
  return { root, phase, task };
}

describe('mergeBranch', () => {
  const merge = (input: MergeBranchInput): Promise<MergeBranchOutput> => run(effects.mergeBranch, input);

  it('fast-forwards when the phase branch has not moved', async () => {
    const { phase, task } = await phaseWithTask();
    write(task, 'task.txt', 'from the task\n');
    const head = commit(task, 'the task');

    const output = await merge({ into: phase, from: 'bdc/r-1.p1.t1' });

    expect(output).toEqual({ merged: true, head });
    expect(gitIn(phase, ['rev-parse', 'HEAD']).trim()).toBe(head);
    // A fast-forward leaves no merge commit behind.
    expect(gitIn(phase, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ')).toHaveLength(2);
    expect(fs.readFileSync(path.join(phase, 'task.txt'), 'utf8')).toBe('from the task\n');
  });

  it('makes a merge commit when both branches moved', async () => {
    const { phase, task } = await phaseWithTask();
    write(phase, 'phase.txt', 'from the phase\n');
    commit(phase, 'phase work');
    write(task, 'task.txt', 'from the task\n');
    commit(task, 'task work');

    const output = await merge({ into: phase, from: 'bdc/r-1.p1.t1' });

    expect(output.merged).toBe(true);
    if (!output.merged) throw new Error('unreachable');
    expect(gitIn(phase, ['rev-parse', 'HEAD']).trim()).toBe(output.head);
    expect(gitIn(phase, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ')).toHaveLength(3);
    expect(gitIn(phase, ['log', '-1', '--format=%s']).trim()).toBe('bdc: merge bdc/r-1.p1.t1');
    expect(fs.readFileSync(path.join(phase, 'task.txt'), 'utf8')).toBe('from the task\n');
  });

  it('answers the current head when the branch is already merged', async () => {
    const { phase, task } = await phaseWithTask();
    write(task, 'task.txt', 'from the task\n');
    const head = commit(task, 'the task');
    await merge({ into: phase, from: 'bdc/r-1.p1.t1' });

    const again = await merge({ into: phase, from: 'bdc/r-1.p1.t1' });

    expect(again).toEqual({ merged: true, head });
    expect(gitIn(phase, ['rev-parse', 'HEAD']).trim()).toBe(head);
  });

  it('aborts a conflict, names the files, and leaves the worktree clean', async () => {
    const { phase, task } = await phaseWithTask();
    write(phase, 'a.txt', 'the phase wrote this\n');
    commit(phase, 'phase edits a.txt');
    write(task, 'a.txt', 'the task wrote this\n');
    commit(task, 'task edits a.txt');

    const output = await merge({ into: phase, from: 'bdc/r-1.p1.t1' });

    expect(output).toEqual({ merged: false, conflicts: ['a.txt'] });
    // No merge in progress: the next attempt starts from a clean worktree.
    expect(() => gitIn(phase, ['rev-parse', '--verify', 'MERGE_HEAD'])).toThrow();
    expect(gitIn(phase, ['status', '--porcelain'])).toBe('');
    expect(fs.readFileSync(path.join(phase, 'a.txt'), 'utf8')).toBe('the phase wrote this\n');
  });

  it('refuses to overwrite changes left in the worktree, fast-forward or merge commit', async () => {
    // A fast-forward that would overwrite the file somebody is editing.
    const { phase, task } = await phaseWithTask();
    write(task, 'a.txt', 'the task wrote this\n');
    commit(task, 'task edits a.txt');
    write(phase, 'a.txt', 'somebody is still working here\n');

    await expect(merge({ into: phase, from: 'bdc/r-1.p1.t1' })).rejects.toThrow(/does not throw away changes in a worktree/);
    expect(fs.readFileSync(path.join(phase, 'a.txt'), 'utf8')).toBe('somebody is still working here\n');

    // And a merge commit that would: the phase branch moved on, so the merge cannot fast-forward.
    const other = await phaseWithTask();
    write(other.phase, 'phase.txt', 'from the phase\n');
    commit(other.phase, 'phase work');
    write(other.task, 'a.txt', 'the task wrote this\n');
    commit(other.task, 'task edits a.txt');
    write(other.phase, 'a.txt', 'still working here\n');

    await expect(merge({ into: other.phase, from: 'bdc/r-1.p1.t1' })).rejects.toThrow(
      /does not throw away changes in a worktree/,
    );
    expect(fs.readFileSync(path.join(other.phase, 'a.txt'), 'utf8')).toBe('still working here\n');
    expect(() => gitIn(other.phase, ['rev-parse', '--verify', 'MERGE_HEAD'])).toThrow();
  });

  it('makes its merge commit with the repo identity', async () => {
    const { phase, task } = await phaseWithTask();
    write(phase, 'phase.txt', 'from the phase\n');
    commit(phase, 'phase work');
    write(task, 'task.txt', 'from the task\n');
    commit(task, 'task work');
    gitIn(phase, ['config', 'user.name', 'A Person']);
    gitIn(phase, ['config', 'user.email', 'person@example.com']);

    await merge({ into: phase, from: 'bdc/r-1.p1.t1' });

    expect(gitIn(phase, ['log', '-1', '--format=%an <%ae>']).trim()).toBe('A Person <person@example.com>');
  });

  it('falls back to the bdc identity when the repo has none', async () => {
    // The person's own config is out of reach, so only the repo itself could name the committer.
    const global = process.env.GIT_CONFIG_GLOBAL;
    const system = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    try {
      const root = repo();
      gitIn(root, ['config', '--unset', 'user.name']);
      gitIn(root, ['config', '--unset', 'user.email']);
      const phase = (await run(effects.ensureWorktree, { root, branch: 'bdc/r-1.p1', base: 'main' })).path;
      const task = (await run(effects.ensureWorktree, { root, branch: 'bdc/r-1.p1.t1', base: 'bdc/r-1.p1' })).path;
      write(phase, 'phase.txt', 'from the phase\n');
      gitIn(phase, ['add', '-A']);
      execFileSync('git', ['-C', phase, '-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-q', '-m', 'phase work']);
      write(task, 'task.txt', 'from the task\n');
      gitIn(task, ['add', '-A']);
      execFileSync('git', ['-C', task, '-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-q', '-m', 'task work']);

      await merge({ into: phase, from: 'bdc/r-1.p1.t1' });

      expect(gitIn(phase, ['log', '-1', '--format=%an <%ae>']).trim()).toBe('bdc <bdc@localhost>');
    } finally {
      if (global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = global;
      if (system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = system;
    }
  });
});

// ── commitsSince ─────────────────────────────────────────────────────────────────────────

describe('commitsSince', () => {
  const commits = (input: CommitsSinceInput): Promise<CommitsSinceOutput> => run(effects.commitsSince, input);

  it('lists the commits on the branch after the base, with the files each touched', async () => {
    const { root, phase, task } = await phaseWithTask();
    write(task, 'src/one.ts', 'one\n');
    const first = commit(task, 'one');
    write(task, 'src/two.ts', 'two\n');
    write(task, 'docs/two.md', 'two\n');
    const second = commit(task, 'two');

    const output = await commits({ root, branch: 'bdc/r-1.p1.t1', base: 'bdc/r-1.p1' });

    expect(output.commits).toEqual([
      { sha: second, files: ['docs/two.md', 'src/two.ts'] },
      { sha: first, files: ['src/one.ts'] },
    ]);
    // The phase branch has nothing of its own yet.
    expect(await commits({ root, branch: 'bdc/r-1.p1', base: 'bdc/r-1.p1' })).toEqual({ commits: [] });
    expect(gitIn(phase, ['rev-parse', 'HEAD']).trim()).toBe(gitIn(root, ['rev-parse', 'bdc/r-1.p1']).trim());
  });
});
