import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assign, createActor, setup } from 'xstate';
import type { PromiseActorLogic } from 'xstate';
import type { OpenPullRequestInput, OpenPullRequestOutput } from '../../src/machines/run.js';
import { RunView } from '../../src/contracts/view.js';
import { githubRepoFrom, prEffect, pullRequestBody, pullRequestTitle, type PrEffects } from '../../src/effects/pr.js';
import type { CommandOptions, CommandResult, RunCommand } from '../../src/effects/git.js';

// ── a run's view, as the daemon writes it ────────────────────────────────────────────────

const RUN_ID = 'r-1';
const GOAL = 'Add a health check endpoint';

/** One finished run: two phases, a failed check, a finding that went on anyway, proof both ways. */
function view(): RunView {
  return RunView.parse({
    runId: RUN_ID,
    goal: GOAL,
    stage: 'shipping',
    stageWords: 'Waiting for you to open the pull request',
    paused: false,
    needsYou: true,
    error: null,
    asking: null,
    agentPrompts: [],
    chat: [],
    proposals: [],
    brief: {
      brief: 'A health check endpoint the load balancer can call.',
      decisions: [{ question: 'How far should this go?', answer: 'The smallest change that works' }],
      assumptions: ['The app already has an HTTP server'],
    },
    spec: { version: 3, markdown: '# Spec\n', comments: [] },
    plan: null,
    phases: [
      {
        id: 'p1',
        title: 'First phase',
        deps: [],
        state: 'done',
        words: 'done',
        needsYou: false,
        attemptsUsed: 0,
        findings: [
          {
            id: 'SEC-1',
            severity: 'high',
            summary: 'The endpoint leaks the build number',
            file: 'src/health.ts',
            line: 12,
            lens: 'security',
            status: 'overridden',
            note: 'you: the build number is public anyway',
          },
          {
            id: 'UX-1',
            severity: 'low',
            summary: 'The status line is terse',
            lens: 'ux',
            status: 'fixed',
            note: '',
          },
        ],
        verification: {
          passed: false,
          steps: [
            { name: 'typecheck', command: 'npx tsc --noEmit', exitCode: 0, durationMs: 1200, outputTail: '' },
            { name: 'tests', command: 'npm test', exitCode: 1, durationMs: 3000, outputTail: 'one test failed' },
          ],
        },
        proof: [
          { kind: 'tests', shows: 'the repo checks pass', file: 'verify.log', by: 'bdc' },
          {
            kind: 'screenshot',
            shows: 'the new health screen',
            file: '.herd/runs/r-1/phases/p1/proof/health.png',
            by: 'verifier',
          },
        ],
      },
      {
        id: 'p2',
        title: 'Second phase',
        deps: ['p1'],
        state: 'queuedForVerify',
        words: 'waiting for a verification slot',
        needsYou: false,
        attemptsUsed: 1,
        findings: [],
        verification: null,
        proof: [{ kind: 'manual', shows: 'the endpoint answers on the real cluster', by: 'person' }],
      },
    ],
    finalFindings: [
      {
        id: 'ARCH-1',
        severity: 'medium',
        summary: 'The handler belongs in its own module',
        lens: 'architecture',
        status: 'continued',
        note: 'the PM: it is the smallest change that works',
      },
    ],
    pullRequest: null,
  });
}

const roots: string[] = [];

/** A checkout with the run's files on disk, the way the daemon leaves them (§10). */
function checkout(runView: RunView = view(), base = 'main'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-pr-'));
  roots.push(root);
  const dir = path.join(root, '.herd', 'runs', RUN_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'view.json'), `${JSON.stringify(runView)}\n`);
  fs.writeFileSync(path.join(dir, 'input.json'), `${JSON.stringify({ runId: RUN_ID, root, goal: runView.goal, config: { base } })}\n`);
  const proofDir = path.join(dir, 'phases', 'p1', 'proof');
  fs.mkdirSync(proofDir, { recursive: true });
  fs.writeFileSync(path.join(proofDir, 'health.png'), 'not really a png');
  return root;
}

function input(root: string, prTargets: OpenPullRequestInput['prTargets'], draft = true): OpenPullRequestInput {
  return { runId: RUN_ID, root, runBranch: `bdc/${RUN_ID}`, draft, prTargets };
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── running the effect the way the run machine does ─────────────────────────────────────

/** A promise actor with nobody above it throws its failure out of `start()`; this harness catches it. */
async function open(effects: PrEffects, openInput: OpenPullRequestInput): Promise<OpenPullRequestOutput> {
  const harness = setup({
    types: { input: {} as unknown, context: {} as { input: unknown; output?: unknown; error?: unknown; failed: boolean } },
    actors: { effect: effects.openPullRequest as unknown as PromiseActorLogic<unknown, unknown> },
    actions: {
      keepOutput: assign({ output: ({ event }) => (event as unknown as { output: unknown }).output, failed: false }),
      keepError: assign({ error: ({ event }) => (event as unknown as { error: unknown }).error, failed: true }),
    },
  }).createMachine({
    context: ({ input: machineInput }) => ({ input: machineInput, failed: false }),
    initial: 'opening',
    states: {
      opening: {
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
  const actor = createActor(harness, { input: openInput });
  const settled = new Promise<{ output?: unknown; error?: unknown; failed: boolean }>((resolve) => {
    actor.subscribe((snapshot) => {
      if (snapshot.status === 'done') resolve(snapshot.context);
    });
  });
  actor.start();
  const context = await settled;
  if (context.failed) throw context.error;
  return context.output as OpenPullRequestOutput;
}

// ── a runner that answers instead of reaching GitHub ────────────────────────────────────

interface Call {
  command: string;
  args: string[];
  options?: CommandOptions;
  /** What the `--body-file` held when the call was made. */
  body?: string;
}

function fakeRun(answer: (command: string, args: string[]) => CommandResult | undefined): { run: RunCommand; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunCommand = async (command, args, options) => {
    const call: Call = { command, args, ...(options === undefined ? {} : { options }) };
    const at = args.indexOf('--body-file');
    if (at >= 0) call.body = fs.readFileSync(args[at + 1] as string, 'utf8');
    calls.push(call);
    return answer(command, args) ?? { code: 1, stdout: '', stderr: `nothing answers ${command} ${args.join(' ')}` };
  };
  return { run, calls };
}

/** The argv of a git call, without the `-C <dir>` every one of them starts with. */
function gitArgs(call: Call): string[] {
  return call.args.slice(2);
}

// ── the body ────────────────────────────────────────────────────────────────────────────

describe('pullRequestBody', () => {
  it('has every section a person reads, in the run’s own words', () => {
    const body = pullRequestBody(view(), { base: 'main', runBranch: 'bdc/r-1', draft: true });

    expect(body.startsWith(`# ${GOAL}`)).toBe(true);
    for (const heading of ['## Summary', '## Spec', '## Phases', '## Review', '## Overrides', '## Proof']) {
      expect(body).toContain(heading);
    }
    // Summary: the brief, the decisions and the assumptions.
    expect(body).toContain('A health check endpoint the load balancer can call.');
    expect(body).toContain('How far should this go? → The smallest change that works');
    expect(body).toContain('The app already has an HTTP server');
    // Spec: a link to the file and its version.
    expect(body).toContain('[`.herd/runs/r-1/spec.v3.md`](.herd/runs/r-1/spec.v3.md)');
    expect(body).toContain('version 3');
    // Phases: titles, status words, the checks with pass/fail and the command, findings, proof.
    expect(body).toContain('### First phase');
    expect(body).toContain('Status: done.');
    expect(body).toContain('`npx tsc --noEmit` — passed');
    expect(body).toContain('`npm test` — failed (exit 1)');
    expect(body).toContain('**high** The endpoint leaks the build number — overridden by you (src/health.ts:12)');
    expect(body).toContain('**low** The status line is terse — fixed');
    expect(body).toContain('- tests: the repo checks pass (from bdc itself)');
    expect(body).toContain('### Second phase');
    expect(body).toContain('Status: waiting for a verification slot.');
    // Review: the whole-run findings.
    expect(body).toContain('**medium** The handler belongs in its own module');
    // Overrides: who let it go, and why.
    expect(body).toContain('SEC-1 (high, First phase)');
    expect(body).toContain('overridden by you; you: the build number is public anyway');
    expect(body).toContain('ARCH-1 (medium, the whole run)');
    expect(body).toContain('continued by the PM; the PM: it is the smallest change that works');
    // Proof: what each item shows, and who made it.
    expect(body).toContain('- screenshot: the new health screen (from the verifier)');
    expect(body).toContain('- manual: the endpoint answers on the real cluster (from you)');
  });

  it('says nothing in state ids', () => {
    const body = pullRequestBody(view(), { base: 'main', runBranch: 'bdc/r-1', draft: false });

    for (const id of ['queuedForVerify', 'awaitingYou', 'proving', 'finalReview', 'specDrafting', 'planReview']) {
      expect(body).not.toContain(id);
    }
    expect(body).not.toContain('stageWords');
    expect(body).not.toContain('waiting for you to open the pull request');
  });

  it('links a proof file only when it is given a way to', () => {
    const options = { base: 'main', runBranch: 'bdc/r-1', draft: false };
    const plain = pullRequestBody(view(), options);
    expect(plain).toContain('- screenshot: the new health screen (from the verifier)');
    expect(plain).not.toContain('](runs/r-1/phases/p1/proof/health.png)');

    const linked = pullRequestBody(view(), {
      ...options,
      proofHref: (file) => (file.endsWith('.png') ? `runs/r-1/phases/p1/proof/health.png` : null),
    });
    expect(linked).toContain('[health.png](runs/r-1/phases/p1/proof/health.png)');
    expect(linked).not.toContain('[verify.log]');
  });

  it('takes the title from the goal, and falls back to the run', () => {
    expect(pullRequestTitle(view())).toBe(GOAL);
    expect(pullRequestTitle({ ...view(), goal: '  \n' })).toBe('bdc run r-1');
  });
});

// ── the file target ─────────────────────────────────────────────────────────────────────

describe('the file target', () => {
  it('writes the body and the list of proof files next to it', async () => {
    const root = checkout();
    const effects = prEffect();

    const output = await open(effects, input(root, [{ provider: 'file', path: '.herd/pull-request.md' }]));

    expect(output).toEqual({ path: '.herd/pull-request.md' });
    const body = fs.readFileSync(path.join(root, '.herd/pull-request.md'), 'utf8');
    expect(body.startsWith(`# ${GOAL}`)).toBe(true);
    // The proof file is in the checkout, so the body points at it relatively (§4.4.1).
    expect(body).toContain('[health.png](runs/r-1/phases/p1/proof/health.png)');
    // The log bdc never wrote is listed, but not linked.
    expect(body).toContain('- tests: the repo checks pass (from bdc itself)');
    expect(body).not.toContain('[verify.log]');

    const list = JSON.parse(fs.readFileSync(path.join(root, '.herd/pull-request.proof.json'), 'utf8')) as {
      runId: string;
      proof: Array<{ phase: string; kind: string; shows: string; by: string; file: string | null; path: string | null }>;
    };
    expect(list.runId).toBe(RUN_ID);
    expect(list.proof).toHaveLength(3);
    expect(list.proof[0]).toEqual({
      phase: 'First phase',
      kind: 'tests',
      shows: 'the repo checks pass',
      by: 'bdc',
      file: 'verify.log',
      path: null,
    });
    expect(list.proof[1]?.path).toBe(path.join(root, '.herd', 'runs', RUN_ID, 'phases', 'p1', 'proof', 'health.png'));
  });

  it('says so when the run has no view to read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-pr-'));
    roots.push(root);

    await expect(open(prEffect(), input(root, [{ provider: 'file', path: '.herd/pull-request.md' }]))).rejects.toThrow(
      /cannot read the run's view/,
    );
  });
});

// ── the GitHub target ──────────────────────────────────────────────────────────────────

describe('the GitHub target', () => {
  const PR_URL = 'https://github.com/its-brilliant/brilliant-dev-cycle/pull/7';

  /** What gh and git answer for a first ship: no PR yet, no proof branch yet. */
  function firstShip(): { run: RunCommand; calls: Call[] } {
    return fakeRun((command, args) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return { code: 1, stdout: '', stderr: 'no pull requests found' };
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return { code: 0, stdout: `${PR_URL}\n`, stderr: '' };
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'comment') return { code: 0, stdout: '', stderr: '' };
      if (command === 'git') {
        const sub = gitArgs({ command, args });
        if (sub[0] === 'push') return { code: 0, stdout: '', stderr: '' };
        if (sub[0] === 'hash-object') return { code: 0, stdout: 'a'.repeat(40), stderr: '' };
        if (sub[0] === 'update-index') return { code: 0, stdout: '', stderr: '' };
        if (sub[0] === 'write-tree') return { code: 0, stdout: 'b'.repeat(40), stderr: '' };
        if (sub[0] === 'commit-tree') return { code: 0, stdout: 'c'.repeat(40), stderr: '' };
        if (sub[0] === 'update-ref') return { code: 0, stdout: '', stderr: '' };
      }
      return undefined;
    });
  }

  it('pushes the run branch, opens one PR, publishes the proof and comments once per phase', async () => {
    const root = checkout();
    const { run, calls } = firstShip();
    const effects = prEffect({ run });

    const output = await open(effects, input(root, [{ provider: 'github', repo: 'its-brilliant/brilliant-dev-cycle', draft: true }]));

    expect(output).toEqual({ url: PR_URL });
    const git = calls.filter((call) => call.command === 'git').map(gitArgs);
    const gh = calls.filter((call) => call.command === 'gh').map((call) => call.args);

    // The run branch first, never forced, and the proof branch after it.
    expect(git[0]).toEqual(['push', '-u', 'origin', 'bdc/r-1']);
    expect(git).toContainEqual(['push', 'origin', 'bdc/proof/r-1']);
    expect(calls.some((call) => call.args.includes('--force') || call.args.includes('-f'))).toBe(false);

    // One pull request, from the run branch into the base branch, as a draft, with a body file.
    const create = gh.find((args) => args[1] === 'create');
    expect(create?.slice(0, 2)).toEqual(['pr', 'create']);
    expect(create).toContain('--base');
    expect(create?.[create.indexOf('--base') + 1]).toBe('main');
    expect(create?.[create.indexOf('--head') + 1]).toBe('bdc/r-1');
    expect(create?.[create.indexOf('--title') + 1]).toBe(GOAL);
    expect(create).toContain('--draft');
    expect(create?.[create.indexOf('--repo') + 1]).toBe('its-brilliant/brilliant-dev-cycle');
    expect(gh.filter((args) => args[1] === 'create')).toHaveLength(1);
    // In order: is there a PR already, create it, then one comment.
    expect(gh.map((args) => args[1])).toEqual(['view', 'create', 'comment']);

    // One comment, for the phase with a picture, linking the proof branch.
    const comments = calls.filter((call) => call.command === 'gh' && call.args[1] === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0]?.args).toEqual(['pr', 'comment', PR_URL, '--body-file', comments[0]?.args[4]]);
    expect(comments[0]?.body).toContain('## Proof: First phase');
    expect(comments[0]?.body).toContain('the new health screen');
    expect(comments[0]?.body).toContain(
      'https://github.com/its-brilliant/brilliant-dev-cycle/blob/bdc/proof/r-1/p1/health.png?raw=true',
    );

    // The proof branch holds the proof file under its phase, and nothing else.
    const indexed = calls.filter((call) => call.command === 'git' && gitArgs(call)[0] === 'update-index');
    expect(indexed.map(gitArgs)).toEqual([
      ['update-index', '--add', '--cacheinfo', `100644,${'a'.repeat(40)},p1/health.png`],
    ]);
    expect(indexed[0]?.options?.env?.GIT_INDEX_FILE).toBeDefined();
  });

  it('reuses the pull request that is already open for the branch', async () => {
    const root = checkout();
    const { run, calls } = fakeRun((command, args) => {
      if (command === 'gh' && args[1] === 'view') return { code: 0, stdout: `${JSON.stringify({ url: PR_URL })}\n`, stderr: '' };
      if (command === 'gh' && args[1] === 'comment') return { code: 0, stdout: '', stderr: '' };
      if (command === 'git') {
        const sub = gitArgs({ command, args });
        if (sub[0] === 'push') return { code: 0, stdout: '', stderr: '' };
        if (sub[0] === 'rev-parse') return { code: 0, stdout: `${'d'.repeat(40)}\n`, stderr: '' };
        if (sub[0] === 'hash-object') return { code: 0, stdout: 'a'.repeat(40), stderr: '' };
        if (sub[0] === 'update-index') return { code: 0, stdout: '', stderr: '' };
        if (sub[0] === 'write-tree') return { code: 0, stdout: 'b'.repeat(40), stderr: '' };
        if (sub[0] === 'commit-tree') return { code: 0, stdout: 'c'.repeat(40), stderr: '' };
        if (sub[0] === 'update-ref') return { code: 0, stdout: '', stderr: '' };
      }
      return undefined;
    });

    const output = await open(prEffect({ run }), input(root, [{ provider: 'github', repo: 'its-brilliant/bdc', draft: true }]));

    expect(output).toEqual({ url: PR_URL });
    expect(calls.filter((call) => call.command === 'gh' && call.args[1] === 'create')).toHaveLength(0);
    expect(calls.filter((call) => call.command === 'gh' && call.args[1] === 'comment')).toHaveLength(1);
    // The proof branch gets a parent, so a second ship fast-forwards instead of failing.
    expect(calls.filter((call) => call.command === 'git').map(gitArgs)).toContainEqual([
      'commit-tree',
      'b'.repeat(40),
      '-m',
      'bdc: proof for r-1',
      '-p',
      'd'.repeat(40),
    ]);
  });

  it('opens a ready pull request when the person did not ask for a draft', async () => {
    const root = checkout();
    const { run, calls } = firstShip();

    await open(prEffect({ run }), input(root, [{ provider: 'github', repo: 'its-brilliant/bdc', draft: false }], false));

    const create = calls.find((call) => call.command === 'gh' && call.args[1] === 'create');
    expect(create?.args).not.toContain('--draft');
  });

  it('takes the repository from the origin remote when the target does not name one', async () => {
    const root = checkout();
    const { run, calls } = fakeRun((command, args) => {
      if (command === 'git') {
        const sub = gitArgs({ command, args });
        if (sub[0] === 'remote') return { code: 0, stdout: 'git@github.com:its-brilliant/bdc.git\n', stderr: '' };
        if (sub[0] === 'push') return { code: 0, stdout: '', stderr: '' };
        if (sub[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' };
        if (sub[0] === 'fetch') return { code: 1, stdout: '', stderr: '' };
        if (sub[0] === 'hash-object') return { code: 0, stdout: 'a'.repeat(40), stderr: '' };
        if (sub[0] === 'update-index') return { code: 0, stdout: '', stderr: '' };
        if (sub[0] === 'write-tree') return { code: 0, stdout: 'b'.repeat(40), stderr: '' };
        if (sub[0] === 'commit-tree') return { code: 0, stdout: 'c'.repeat(40), stderr: '' };
        if (sub[0] === 'update-ref') return { code: 0, stdout: '', stderr: '' };
      }
      if (command === 'gh' && args[1] === 'view') return { code: 1, stdout: '', stderr: '' };
      if (command === 'gh' && args[1] === 'create') return { code: 0, stdout: `${PR_URL}\n`, stderr: '' };
      if (command === 'gh' && args[1] === 'comment') return { code: 0, stdout: '', stderr: '' };
      return undefined;
    });

    await open(prEffect({ run }), input(root, [{ provider: 'github', draft: true }]));

    const create = calls.find((call) => call.command === 'gh' && call.args[1] === 'create');
    expect(create?.args[create.args.indexOf('--repo') + 1]).toBe('its-brilliant/bdc');
    const comment = calls.find((call) => call.command === 'gh' && call.args[1] === 'comment');
    expect(comment?.body).toContain('https://github.com/its-brilliant/bdc/blob/bdc/proof/r-1/p1/health.png?raw=true');
  });

  it('fails with gh’s own words when the pull request cannot be created', async () => {
    const root = checkout();
    const { run } = fakeRun((command, args) => {
      if (command === 'git') return { code: 0, stdout: '', stderr: '' };
      if (command === 'gh' && args[1] === 'view') return { code: 1, stdout: '', stderr: '' };
      if (command === 'gh' && args[1] === 'create') return { code: 1, stdout: '', stderr: 'a pull request already exists' };
      return undefined;
    });

    await expect(
      open(prEffect({ run }), input(root, [{ provider: 'github', repo: 'its-brilliant/bdc', draft: true }])),
    ).rejects.toThrow(/gh pr create .* failed \(exit 1\): a pull request already exists/);
  });

  it('reads owner/name out of the remote URLs people have', () => {
    expect(githubRepoFrom('git@github.com:its-brilliant/brilliant-dev-cycle.git')).toBe('its-brilliant/brilliant-dev-cycle');
    expect(githubRepoFrom('https://github.com/its-brilliant/bdc')).toBe('its-brilliant/bdc');
    expect(githubRepoFrom('https://github.com/its-brilliant/bdc.git')).toBe('its-brilliant/bdc');
    expect(githubRepoFrom('https://gitlab.com/its-brilliant/bdc.git')).toBeNull();
  });
});
