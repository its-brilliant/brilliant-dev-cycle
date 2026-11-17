/**
 * The real verification effect (spec §7.4), run in a throwaway git repo: order of the stages, the
 * environment bdc gives every step, the ready retry, the timeout, the logs and the git exclusion.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import type { PromiseActorLogic } from 'xstate';
import type { RunVerificationInput, RunVerificationOutput } from '../../src/contracts/actors.js';
import type { VerificationSetup } from '../../src/contracts/domain.js';
import { verifyEffect, type VerifyOptions } from '../../src/effects/verify.js';

/** Runs the effect the way a machine does and answers its output. */
function verify(input: RunVerificationInput, options: VerifyOptions = {}): Promise<RunVerificationOutput> {
  const logic: PromiseActorLogic<RunVerificationOutput, RunVerificationInput> = verifyEffect(options);
  const actor = createActor(logic, { input });
  const done = new Promise<RunVerificationOutput>((resolve, reject) => {
    actor.subscribe((snapshot) => {
      if (snapshot.status === 'done') resolve(snapshot.output as RunVerificationOutput);
      if (snapshot.status === 'error') reject(snapshot.error);
    });
  });
  actor.start();
  return done;
}

function setup(overrides: Partial<VerificationSetup> = {}): VerificationSetup {
  return { env: {}, setup: [], checks: [], teardown: [], parallel: 1, timeout: 30, ...overrides };
}

function input(worktree: string, overrides: Partial<RunVerificationInput> = {}): RunVerificationInput {
  return { runId: 'r1', phaseId: 'p1', worktree, slot: 0, setup: null, extraChecks: [], ...overrides };
}

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-verify-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

/** A file the steps appended to, one line per step. */
function lines(name: string): string[] {
  return fs
    .readFileSync(path.join(repo, name), 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

const marker = (): string => path.join(repo, '.bdc-proof', 'p1', 'running');

describe('runVerification', () => {
  it('passes with no steps when the repo has no setup and the phase has no checks', async () => {
    const output = await verify(input(repo));

    expect(output).toEqual({ passed: true, steps: [], proofFiles: [] });
    // Nothing ran, so there is nothing to keep and nothing to exclude.
    expect(fs.existsSync(path.join(repo, '.bdc-proof'))).toBe(false);
  });

  it('runs setup, then the repo checks, then the phase checks, then teardown, with bdc in the env', async () => {
    const output = await verify(
      input(repo, {
        setup: setup({
          env: { GREETING: 'phase ${BDC_PHASE}', DATABASE_URL: 'postgres://localhost:${BDC_PORT_BASE}/app' },
          setup: [
            {
              name: 'up',
              run: 'echo "setup $BDC_RUN $BDC_PHASE $BDC_SLOT $BDC_PORT_BASE $BDC_WORKTREE $GREETING $DATABASE_URL" >> order.txt',
            },
          ],
          checks: [{ name: 'types', run: 'echo check >> order.txt' }],
          teardown: [{ name: 'down', run: 'echo teardown >> order.txt' }],
        }),
        extraChecks: [{ name: 'phase check', run: 'echo extra >> order.txt' }],
      }),
    );

    expect(output.passed).toBe(true);
    expect(output.failedAt).toBeUndefined();
    expect(output.steps.map((step) => step.phase)).toEqual(['setup', 'check', 'check', 'teardown']);
    expect(output.steps.map((step) => step.name)).toEqual(['up', 'types', 'phase check', 'down']);
    expect(lines('order.txt')).toEqual([
      `setup r1 p1 0 20000 ${repo} phase p1 postgres://localhost:20000/app`,
      'check',
      'extra',
      'teardown',
    ]);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('gives slot n the port range at 20000 + n * 100, and lets the caller move the range', async () => {
    const step = setup({ setup: [{ name: 'ports', run: 'echo "$BDC_SLOT $BDC_PORT_BASE" > ports.txt' }] });

    await verify(input(repo, { slot: 2, setup: step }));
    expect(fs.readFileSync(path.join(repo, 'ports.txt'), 'utf8').trim()).toBe('2 20200');

    await verify(input(repo, { slot: 1, setup: step }), { portBase: 31000 });
    expect(fs.readFileSync(path.join(repo, 'ports.txt'), 'utf8').trim()).toBe('1 31100');
  });

  it('tears down after a failing setup and marks the setup as the stage that failed', async () => {
    const output = await verify(
      input(repo, {
        setup: setup({
          setup: [{ name: 'up', run: 'echo setup >> order.txt; exit 3' }],
          checks: [{ name: 'types', run: 'echo check >> order.txt' }],
          teardown: [{ name: 'down', run: 'echo teardown >> order.txt' }],
        }),
      }),
    );

    expect(output.passed).toBe(false);
    expect(output.failedAt).toBe('setup');
    expect(output.steps.map((step) => step.phase)).toEqual(['setup', 'teardown']);
    expect(output.steps[0]?.exitCode).toBe(3);
    // Checks against an environment that never came up would say nothing, so they do not run.
    expect(lines('order.txt')).toEqual(['setup', 'teardown']);
  });

  it('retries the ready check until it passes', async () => {
    const output = await verify(
      input(repo, {
        setup: setup({
          ready: { run: 'test -f ready-ok && exit 0; touch ready-ok; exit 1', timeout: 2 },
          teardown: [{ name: 'down', run: 'echo teardown >> order.txt' }],
        }),
      }),
    );

    const ready = output.steps.filter((step) => step.phase === 'ready');
    expect(ready.map((step) => step.exitCode)).toEqual([1, 0]);
    expect(output.passed).toBe(true);
    expect(lines('order.txt')).toEqual(['teardown']);
  });

  it('gives up on a ready check that never passes, and still tears down', async () => {
    const output = await verify(
      input(repo, {
        setup: setup({
          ready: { run: 'echo not ready yet; exit 1', timeout: 1 },
          teardown: [{ name: 'down', run: 'echo teardown >> order.txt' }],
        }),
      }),
    );

    expect(output.passed).toBe(false);
    expect(output.failedAt).toBe('ready');
    expect(output.steps.filter((step) => step.phase === 'ready').length).toBeGreaterThanOrEqual(1);
    expect(lines('order.txt')).toEqual(['teardown']);
  });

  it('runs every check even after one fails', async () => {
    const output = await verify(
      input(repo, {
        setup: setup({
          checks: [
            { name: 'types', run: 'exit 1' },
            { name: 'unit', run: 'echo unit >> order.txt' },
          ],
          teardown: [{ name: 'down', run: 'echo teardown >> order.txt' }],
        }),
        extraChecks: [{ name: 'phase check', run: 'echo extra >> order.txt' }],
      }),
    );

    expect(output.passed).toBe(false);
    expect(output.failedAt).toBe('check');
    expect(output.steps.map((step) => step.name)).toEqual(['types', 'unit', 'phase check', 'down']);
    expect(lines('order.txt')).toEqual(['unit', 'extra', 'teardown']);
  });

  it('kills a step that outlives the verification timeout and records it as failed', async () => {
    const startedAt = Date.now();
    const output = await verify(
      input(repo, {
        setup: setup({
          timeout: 1,
          setup: [{ name: 'long', run: 'sleep 30' }],
          teardown: [{ name: 'down', run: 'echo teardown >> order.txt' }],
        }),
      }),
    );

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(output.passed).toBe(false);
    expect(output.failedAt).toBe('setup');
    expect(output.steps[0]?.exitCode).toBeNull();
    expect(output.steps[0]?.outputTail).toContain('timed out');
    // Teardown still ran, with a fresh budget of its own.
    expect(output.steps[1]?.phase).toBe('teardown');
    expect(lines('order.txt')).toEqual(['teardown']);
  });

  it('writes one full log per step and returns their paths, checks first', async () => {
    const output = await verify(
      input(repo, {
        setup: setup({
          setup: [{ name: 'up', run: 'echo hello' }],
          checks: [{ name: 'types', run: 'echo checked' }],
          teardown: [{ name: 'down', run: 'echo bye' }],
        }),
      }),
    );

    expect(output.proofFiles).toEqual([
      path.join('.bdc-proof', 'p1', 'verify-2-types.log'),
      path.join('.bdc-proof', 'p1', 'verify-1-up.log'),
      path.join('.bdc-proof', 'p1', 'verify-3-down.log'),
    ]);
    for (const file of output.proofFiles) {
      expect(path.isAbsolute(file)).toBe(false);
      expect(fs.existsSync(path.join(repo, file))).toBe(true);
    }
    expect(fs.readFileSync(path.join(repo, output.proofFiles[0] ?? ''), 'utf8')).toBe('$ echo checked\n\nchecked\n');
  });

  it('keeps only the last 4000 characters in the step result', async () => {
    const output = await verify(
      input(repo, {
        extraChecks: [{ name: 'loud', run: `node -e "process.stdout.write('x'.repeat(5000))"` }],
      }),
    );

    expect(output.steps[0]?.outputTail).toBe('x'.repeat(4000));
    const log = fs.readFileSync(path.join(repo, output.proofFiles[0] ?? ''), 'utf8');
    expect(log.length).toBeGreaterThan(5000);
  });

  it('excludes .bdc-proof from git so a phase worktree can never commit its logs', async () => {
    await verify(input(repo, { extraChecks: [{ name: 'unit', run: 'echo ok' }] }));

    expect(execFileSync('git', ['-C', repo, 'check-ignore', '.bdc-proof'], { encoding: 'utf8' }).trim()).toBe(
      '.bdc-proof',
    );
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).not.toContain('.bdc-proof');
  });

  it('tears down a previous attempt before starting again when it left its marker', async () => {
    fs.mkdirSync(path.dirname(marker()), { recursive: true });
    fs.writeFileSync(marker(), 'stale\n');

    const output = await verify(
      input(repo, {
        setup: setup({
          setup: [{ name: 'up', run: 'echo setup >> order.txt' }],
          teardown: [{ name: 'down', run: 'echo teardown >> order.txt' }],
        }),
      }),
    );

    expect(output.passed).toBe(true);
    expect(lines('order.txt')).toEqual(['teardown', 'setup', 'teardown']);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('runs a phase check without a repo setup', async () => {
    const output = await verify(input(repo, { extraChecks: [{ name: 'phase check', run: 'echo ok' }] }));

    expect(output.passed).toBe(true);
    expect(output.steps.map((step) => step.phase)).toEqual(['check']);
    expect(output.proofFiles).toHaveLength(1);
  });

  it('answers a failed setup instead of throwing when the worktree cannot be used', async () => {
    const notADirectory = path.join(repo, 'not-a-directory');
    fs.writeFileSync(notADirectory, '');

    const output = await verify(input(path.join(notADirectory, 'worktree'), { extraChecks: [{ run: 'echo ok' }] }));

    expect(output.passed).toBe(false);
    expect(output.failedAt).toBe('setup');
    expect(output.steps).toHaveLength(1);
    expect(output.steps[0]?.outputTail).toMatch(/^bdc: /);
    expect(output.proofFiles).toEqual([]);
  });
});
