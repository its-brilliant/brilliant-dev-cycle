import { afterEach, describe, expect, it } from 'vitest';
import { createActor, createMachine, fromPromise, sendParent, setup } from 'xstate';
import type { Actor, InspectionEvent } from 'xstate';
import { blocks, phaseMachine } from '../../src/machines/phase.js';
import type { PhaseInput } from '../../src/machines/phase.js';
import type {
  AgentJob,
  CheckProofInput,
  CheckProofOutput,
  CommitsSinceInput,
  CommitsSinceOutput,
  EnsureWorktreeInput,
  EnsureWorktreeOutput,
  MergeBranchInput,
  MergeBranchOutput,
  RunVerificationInput,
  RunVerificationOutput,
} from '../../src/contracts/actors.js';
import type { AgentOutcome, AgentToParent, PhaseToRun, RunToPhase } from '../../src/contracts/events.js';

// ── stubs and harness ─────────────────────────────────────────────────────────────────
//
// The phase runs inside a small parent machine (invoked with id 'phase'), the way the run machine
// invokes it, so every event the phase sends its parent is captured and can be asserted. States are
// collected from XState's microstep inspection, so a state that is entered and left again inside one
// macrostep (`continuing` routes straight on) still counts as entered.

type StubAgentEvent =
  | { type: 'REPLY'; outcome: AgentOutcome }
  | { type: 'NEEDS_YOU'; prompt: string }
  | { type: 'FOLLOW_UP'; prompt: string }
  | { type: 'PROMPT_CHOICE'; choice: string }
  | { type: 'CLOSE' };

interface HarnessOptions {
  input?: Partial<PhaseInput>;
  merge?: (input: MergeBranchInput) => MergeBranchOutput;
  commits?: (input: CommitsSinceInput) => CommitsSinceOutput;
  verify?: (input: RunVerificationInput) => RunVerificationOutput;
  proof?: (input: CheckProofInput) => CheckProofOutput;
}

/** Every state any test entered, for the reachability test at the end of the file. */
const entered = new Set<string>();
/** Harnesses of the running test, stopped after it. */
let live: Array<() => void> = [];

afterEach(() => {
  for (const stop of live) stop();
  live = [];
});

function harness(options: HarnessOptions = {}) {
  const calls = {
    ensureWorktree: [] as EnsureWorktreeInput[],
    mergeBranch: [] as MergeBranchInput[],
    commitsSince: [] as CommitsSinceInput[],
    runVerification: [] as RunVerificationInput[],
    checkProof: [] as CheckProofInput[],
  };
  const received: PhaseToRun[] = [];
  const spawned: AgentJob[] = [];
  const followUps: Array<{ key: string; prompt: string }> = [];
  const choices: Array<{ key: string; choice: string }> = [];
  const closed: string[] = [];
  const seen = new Set<string>();

  const input = phaseInput(options.input);

  const agent = setup({
    types: { context: {} as { job: AgentJob }, events: {} as StubAgentEvent, input: {} as AgentJob },
  }).createMachine({
    id: 'agent',
    initial: 'running',
    context: ({ input: job }) => {
      spawned.push(job);
      return { job };
    },
    states: {
      running: {
        on: {
          REPLY: {
            actions: sendParent(({ context, event }) => ({
              type: 'AGENT_RESULT',
              key: context.job.key,
              outcome: event.outcome,
            })),
          },
          NEEDS_YOU: {
            actions: sendParent(({ context, event }) => ({
              type: 'AGENT_NEEDS_YOU',
              key: context.job.key,
              prompt: event.prompt,
              choices: ['Trust this folder', "Don't"],
            })),
          },
          FOLLOW_UP: { actions: ({ context, event }) => followUps.push({ key: context.job.key, prompt: event.prompt }) },
          PROMPT_CHOICE: { actions: ({ context, event }) => choices.push({ key: context.job.key, choice: event.choice }) },
          CLOSE: { actions: ({ context }) => closed.push(context.job.key) },
        },
      },
    },
  });

  const provided = phaseMachine.provide({
    actors: {
      agent,
      ensureWorktree: fromPromise<EnsureWorktreeOutput, EnsureWorktreeInput>(async ({ input: ensure }) => {
        calls.ensureWorktree.push(ensure);
        return { path: `${ensure.root}/.worktrees/${ensure.branch}`, head: 'head' };
      }),
      mergeBranch: fromPromise<MergeBranchOutput, MergeBranchInput>(async ({ input: merge }) => {
        calls.mergeBranch.push(merge);
        return options.merge ? options.merge(merge) : { merged: true, head: 'head' };
      }),
      commitsSince: fromPromise<CommitsSinceOutput, CommitsSinceInput>(async ({ input: since }) => {
        calls.commitsSince.push(since);
        return options.commits ? options.commits(since) : { commits: [] };
      }),
      runVerification: fromPromise<RunVerificationOutput, RunVerificationInput>(async ({ input: verify }) => {
        calls.runVerification.push(verify);
        return options.verify
          ? options.verify(verify)
          : {
              passed: true,
              steps: [{ phase: 'check', name: 'unit', command: 'npm test', exitCode: 0, durationMs: 3, outputTail: 'ok' }],
              proofFiles: ['report.json'],
            };
      }),
      checkProof: fromPromise<CheckProofOutput, CheckProofInput>(async ({ input: proof }) => {
        calls.checkProof.push(proof);
        return options.proof ? options.proof(proof) : { complete: true, missing: [], invalid: [] };
      }),
    },
  });

  const parent = createMachine({
    id: 'run',
    initial: 'running',
    states: {
      running: {
        invoke: { id: 'phase', src: provided, input: () => input },
        on: {
          '*': { actions: ({ event }) => received.push(event as PhaseToRun) },
        },
      },
    },
  });

  // SAFETY: `parent` invokes the provided phase machine with id 'phase', so this child is that
  // machine's actor; the cast only restores the type the invoke config already guarantees.
  const phaseChild = (run: Actor<typeof parent>): Actor<typeof provided> => {
    const child = run.getSnapshot().children['phase'];
    if (child === undefined) throw new Error('the phase actor is not running');
    return child as Actor<typeof provided>;
  };

  const inspect = (event: InspectionEvent) => {
    if (event.type !== '@xstate.microstep') return;
    if (!('id' in event.actorRef) || event.actorRef.id !== 'phase') return;
    if (!('value' in event.snapshot)) return;
    const state = String(event.snapshot.value);
    seen.add(state);
    entered.add(state);
  };

  let run = createActor(parent, { inspect }).start();
  let phase = phaseChild(run);
  seen.add(String(phase.getSnapshot().value));
  entered.add(String(phase.getSnapshot().value));

  const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (check: () => boolean, what: string) => {
    const deadline = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await tick(2);
    }
  };

  const harness = {
    input,
    calls,
    received,
    spawned,
    followUps,
    choices,
    closed,
    tick,
    until,
    send: (event: RunToPhase | AgentToParent) => phase.send(event),
    state: () => String(phase.getSnapshot().value),
    context: () => phase.getSnapshot().context,
    children: () => phase.getSnapshot().children,
    /** The agent children the phase spawned (the snapshot's children also hold its invokes). */
    agentIds: () => phase.getSnapshot().context.children.map((child) => child.id),
    /** Wait until the phase has entered `state` (it may have moved on since). */
    at: async (state: string) => until(() => seen.has(state), `state ${state}`),
    /** What a child agent does when its submit tool has accepted a result. */
    report: (childId: string, outcome: AgentOutcome) => {
      const child = harness.children()[childId];
      if (child === undefined) throw new Error(`no child ${childId}`);
      child.send({ type: 'REPLY', outcome });
    },
    done: (childId: string, submission?: unknown) =>
      harness.report(childId, { status: 'done', submission: submission ?? {} }),
    failed: (childId: string, detail = 'the terminal exited') =>
      harness.report(childId, { status: 'crashed', detail }),
    sent: (type: PhaseToRun['type']) => received.filter((event) => event.type === type),
    needsPm: () => received.flatMap((event) => (event.type === 'PHASE_NEEDS_PM' ? [event] : [])),
    followUpsTo: (key: string) => followUps.filter((followUp) => followUp.key === key),
    /** Persist, drop the run, restore it from JSON — what the daemon does after a crash (§5.7). */
    restore: () => {
      const snapshot = JSON.parse(JSON.stringify(run.getPersistedSnapshot()));
      run.stop();
      run = createActor(parent, { snapshot, inspect }).start();
      phase = phaseChild(run);
      seen.add(String(phase.getSnapshot().value));
      entered.add(String(phase.getSnapshot().value));
    },
    stop: () => run.stop(),
  };
  live.push(harness.stop);
  return harness;
}

function phaseInput(overrides: Partial<PhaseInput> = {}): PhaseInput {
  return {
    runId: 'r1',
    root: '/repo',
    runBranch: 'bdc/r1',
    runWorktree: '/repo/.worktrees/run',
    phase: {
      id: 'p1',
      title: 'One',
      deps: [],
      tasks: [
        { id: 't1', title: 'First task', paths: ['src/a.ts'] },
        { id: 't2', title: 'Second task', paths: ['src/b.ts'] },
      ],
      checks: [],
      proof: [{ kind: 'tests', shows: 'the unit tests pass' }],
    },
    lenses: {
      security: { block_on: 'high', runs: 'every-phase', scope: [], prompt: 'Look for security problems.' },
    },
    agents: {
      builder: { cli: 'pi', model: '' },
      reviewer: { cli: 'claude', model: '' },
      verifier: { cli: 'claude', model: '' },
    },
    verification: null,
    maxAttempts: 3,
    doneDeps: [],
    ...overrides,
  };
}

type Harness = ReturnType<typeof harness>;

/** Every builder has committed and the task branches are merging. */
async function toMerging(h: Harness) {
  await h.at('building');
  await h.until(() => h.agentIds().length === 2, 'one builder per task');
  h.done('builder-t1');
  h.done('builder-t2');
  await h.at('merging');
}

/** The first review round is running. */
async function toReviewing(h: Harness) {
  await toMerging(h);
  await h.at('reviewing');
  await h.until(() => h.agentIds().length === 3, 'the reviewer');
}

/** Build, merge, review clean and verify: the shortest way to `queuedForVerify`. */
async function toQueuedForVerify(h: Harness) {
  await toReviewing(h);
  h.done('reviewer-security-1', { findings: [] });
  await h.at('queuedForVerify');
}

// ── the diagram ───────────────────────────────────────────────────────────────────────

describe('phaseMachine', () => {
  it('blocks() compares a severity with a lens block level, and none never blocks', () => {
    expect(blocks('high', 'high')).toBe(true);
    expect(blocks('critical', 'high')).toBe(true);
    expect(blocks('medium', 'high')).toBe(false);
    expect(blocks('critical', 'none')).toBe(false);
  });

  it('waits for its deps and builds straight away when it has none', async () => {
    const h = harness({ input: { phase: { ...phaseInput().phase, deps: ['p0'] } } });
    expect(h.state()).toBe('waiting');
    await h.tick();
    expect(h.state()).toBe('waiting');

    h.send({ type: 'DEP_DONE', phaseId: 'p9' });
    await h.tick();
    expect(h.state()).toBe('waiting');

    h.send({ type: 'DEP_DONE', phaseId: 'p0' });
    await h.at('building');

    // A phase with no deps starts building as soon as it is created.
    const free = harness();
    expect(free.state()).toBe('building');
  });

  it('builds every task in its own worktree and merges the task branches in order', async () => {
    const h = harness();
    await toMerging(h);

    expect(h.calls.ensureWorktree.map((ensure) => [ensure.branch, ensure.base])).toEqual([
      ['bdc/r1/p1', 'bdc/r1'],
      ['bdc/r1/p1/t1', 'bdc/r1/p1'],
      ['bdc/r1/p1/t2', 'bdc/r1/p1'],
    ]);
    expect(h.spawned.filter((job) => job.role === 'builder').map((job) => [job.key, job.keepAlive, job.submit, job.cwd])).toEqual([
      ['r1/p1/t1/builder', true, 'task', '/repo/.worktrees/bdc/r1/p1/t1'],
      ['r1/p1/t2/builder', true, 'task', '/repo/.worktrees/bdc/r1/p1/t2'],
    ]);

    await h.at('reviewing');
    expect(h.calls.mergeBranch).toEqual([
      { into: '/repo/.worktrees/bdc/r1/p1', from: 'bdc/r1/p1/t1' },
      { into: '/repo/.worktrees/bdc/r1/p1', from: 'bdc/r1/p1/t2' },
    ]);
  });

  it('the happy path runs from waiting to done and reports PHASE_DONE', async () => {
    const h = harness({
      input: {
        phase: { ...phaseInput().phase, checks: [{ name: 'types', run: 'npm run typecheck' }, { agent: 'click through' }] },
      },
    });
    await toQueuedForVerify(h);
    expect(h.sent('PHASE_VERIFY_SLOT_REQUEST')).toHaveLength(1);

    h.send({ type: 'VERIFY_SLOT_GRANTED', slot: 0 });
    await h.at('verifying');
    expect(h.calls.runVerification[0]).toEqual({
      runId: 'r1',
      phaseId: 'p1',
      worktree: '/repo/.worktrees/bdc/r1/p1',
      slot: 0,
      setup: null,
      extraChecks: [{ name: 'types', run: 'npm run typecheck' }],
    });

    await h.at('proving');
    // bdc's own proof (the test report) is an item, made from what verification captured.
    expect(h.calls.checkProof[0]?.items).toEqual([
      { kind: 'tests', shows: 'the unit tests pass', file: 'report.json', by: 'bdc' },
    ]);

    await h.at('passed');
    await h.at('done');
    expect(h.sent('PHASE_DONE')).toEqual([{ type: 'PHASE_DONE', phaseId: 'p1' }]);
    expect(h.calls.mergeBranch.at(-1)).toEqual({ into: '/repo/.worktrees/run', from: 'bdc/r1/p1' });
    expect(h.closed.sort()).toEqual(['r1/p1/review-security-1', 'r1/p1/t1/builder', 'r1/p1/t2/builder']);
  });

  it('a builder that does not finish sends the phase to the PM with a build blocker', async () => {
    const h = harness();
    await h.at('building');
    await h.until(() => h.agentIds().length === 2, 'builders');
    h.failed('builder-t1', 'the terminal exited');
    await h.at('deciding');
    expect(h.needsPm()[0]?.blocker).toEqual({
      kind: 'build',
      summary: 'the t1 builder did not finish (crashed)',
      evidence: ['the terminal exited'],
    });
  });

  it('a phase branch that cannot merge into the run branch goes to the PM as a conflict', async () => {
    const h = harness({
      merge: (merge) =>
        merge.into === '/repo/.worktrees/run' ? { merged: false, conflicts: ['src/a.ts'] } : { merged: true, head: 'head' },
    });
    await toQueuedForVerify(h);
    h.send({ type: 'VERIFY_SLOT_GRANTED', slot: 0 });
    await h.at('deciding');
    const needs = h.needsPm().at(-1);
    expect(needs?.blocker).toEqual({
      kind: 'conflict',
      summary: 'merging bdc/r1/p1 into bdc/r1 conflicts',
      evidence: ['src/a.ts'],
    });
    expect(h.sent('PHASE_DONE')).toHaveLength(0);
  });

  it('a merge conflict goes to the conflicting builder and merges again when it resolves', async () => {
    let conflicted = false;
    const h = harness({
      merge: (merge) => {
        if (!conflicted && merge.from === 'bdc/r1/p1/t2') {
          conflicted = true;
          return { merged: false, conflicts: ['src/b.ts'] };
        }
        return { merged: true, head: 'head' };
      },
    });
    await toMerging(h);
    await h.at('resolving');

    expect(h.followUpsTo('r1/p1/t2/builder')).toHaveLength(1);
    expect(h.followUpsTo('r1/p1/t2/builder')[0]?.prompt).toContain('src/b.ts');

    h.done('builder-t2');
    await h.at('reviewing');
    expect(h.calls.mergeBranch.filter((merge) => merge.from === 'bdc/r1/p1/t2')).toHaveLength(2);
    // t1 was already merged; only the conflicted branch is merged again.
    expect(h.calls.mergeBranch.filter((merge) => merge.from === 'bdc/r1/p1/t1')).toHaveLength(1);
  });

  it('a blocking review goes to the PM, whose fix goes to the builder that touched the file', async () => {
    const h = harness({
      commits: (since) =>
        since.branch === 'bdc/r1/p1/t1'
          ? { commits: [{ sha: 'a1', files: ['src/a.ts'] }] }
          : { commits: [{ sha: 'b1', files: ['src/b.ts'] }] },
    });
    await toReviewing(h);
    h.done('reviewer-security-1', {
      findings: [{ id: 'SEC-1', severity: 'high', summary: 'SQL injection in src/a.ts' }],
    });
    await h.at('deciding');
    const needs = h.needsPm();
    expect(needs).toHaveLength(1);
    expect(needs[0]?.blocker).toEqual({
      kind: 'review',
      summary: 'findings block the phase from security',
      evidence: ['security: high SQL injection in src/a.ts'],
    });
    expect(needs[0]?.attemptsUsed).toBe(0);
    expect(needs[0]?.attemptsMax).toBe(3);
    expect(h.sent('PHASE_FINDINGS')).toEqual([
      {
        type: 'PHASE_FINDINGS',
        phaseId: 'p1',
        lens: 'security',
        findings: [{ id: 'SEC-1', severity: 'high', summary: 'SQL injection in src/a.ts' }],
      },
    ]);

    h.send({ type: 'PM_DECISION', decision: { action: 'fix', reason: 'must fix', instructions: 'parameterise the query' } });
    await h.at('fixing');
    await h.until(() => h.followUps.length === 1, 'the fix follow-up');
    // Routing read the task branches: t1 touched the file the finding names.
    expect(h.followUps[0]).toEqual({ key: 'r1/p1/t1/builder', prompt: 'parameterise the query' });

    h.done('builder-t1');
    await h.at('merging');
    expect(h.calls.mergeBranch.filter((merge) => merge.from === 'bdc/r1/p1/t1')).toHaveLength(2);
    expect(h.calls.mergeBranch.filter((merge) => merge.from === 'bdc/r1/p1/t2')).toHaveLength(1);
    expect(h.context().attemptsUsed).toBe(1);

    await h.at('reviewing');
    await h.until(() => h.children()['reviewer-security-2'] !== undefined, 'the second review round');
    h.done('reviewer-security-2', { findings: [] });
    await h.at('queuedForVerify');
    h.send({ type: 'VERIFY_SLOT_GRANTED', slot: 1 });
    await h.at('done');
    expect(h.sent('PHASE_DONE')).toHaveLength(1);
  });

  it('one reviewer per lens, and none for a final-only lens', async () => {
    const h = harness({
      input: {
        lenses: {
          security: { block_on: 'high', runs: 'every-phase', scope: [], prompt: 'security' },
          perf: { block_on: 'critical', runs: 'every-phase', scope: [], prompt: 'perf' },
          docs: { block_on: 'low', runs: 'final-only', scope: [], prompt: 'docs' },
        },
      },
    });
    await toMerging(h);
    await h.at('reviewing');
    await h.until(() => h.agentIds().filter((id) => id.startsWith('reviewer-')).length === 2, 'two reviewers');
    expect(h.agentIds().filter((id) => id.startsWith('reviewer-')).sort()).toEqual([
      'reviewer-perf-1',
      'reviewer-security-1',
    ]);
    expect(h.spawned.filter((job) => job.role === 'reviewer').map((job) => [job.key, job.keepAlive, job.submit])).toEqual([
      ['r1/p1/review-security-1', false, 'findings'],
      ['r1/p1/review-perf-1', false, 'findings'],
    ]);
  });

  it('a person overriding the lens unblocks it', async () => {
    const h = harness();
    await toReviewing(h);
    h.send({ type: 'OVERRIDE', lens: 'security', reason: 'we accept this risk', who: 'person' });
    h.done('reviewer-security-1', { findings: [{ id: 'SEC-1', severity: 'critical', summary: 'we know' }] });
    await h.at('queuedForVerify');
    expect(h.sent('PHASE_NEEDS_PM')).toHaveLength(0);
  });

  it('continuing after a review blocker skips the review and verifies', async () => {
    const h = harness();
    await toReviewing(h);
    h.done('reviewer-security-1', { findings: [{ id: 'SEC-1', severity: 'high', summary: 'meh' }] });
    await h.at('deciding');
    h.send({ type: 'PM_DECISION', decision: { action: 'continue', reason: 'the risk is accepted' } });
    await h.at('continuing');
    await h.at('queuedForVerify');
    expect(h.context().overrides).toEqual([{ who: 'pm', reason: 'the risk is accepted' }]);
    // No second review round: the reviewer of round 1 is still the only one.
    expect(h.spawned.filter((job) => job.role === 'reviewer')).toHaveLength(1);
    h.send({ type: 'VERIFY_SLOT_GRANTED', slot: 0 });
    await h.at('done');
  });

  it('a failing verify goes to the PM, and continuing passes the phase', async () => {
    const h = harness({
      verify: () => ({
        passed: false,
        failedAt: 'check',
        steps: [{ phase: 'check', name: 'unit', command: 'npm test', exitCode: 1, durationMs: 9, outputTail: '1 failing' }],
        proofFiles: [],
      }),
    });
    await toQueuedForVerify(h);
    h.send({ type: 'VERIFY_SLOT_GRANTED', slot: 0 });
    await h.at('deciding');
    const needs = h.needsPm();
    expect(needs).toHaveLength(1);
    expect(needs[0]?.blocker.kind).toBe('verify');
    expect(needs[0]?.blocker.evidence[0]).toContain('1 failing');

    h.send({ type: 'PM_DECISION', decision: { action: 'continue', reason: 'the flake is known' } });
    await h.at('passed');
    await h.at('done');
    expect(h.sent('PHASE_DONE')).toHaveLength(1);
  });

  it('a setup failure is a verify-setup blocker', async () => {
    const h = harness({
      verify: () => ({
        passed: false,
        failedAt: 'setup',
        steps: [{ phase: 'setup', name: 'npm ci', command: 'npm ci', exitCode: 1, durationMs: 9, outputTail: 'no lockfile' }],
        proofFiles: [],
      }),
    });
    await toQueuedForVerify(h);
    h.send({ type: 'VERIFY_SLOT_GRANTED', slot: 0 });
    await h.at('deciding');
    expect(h.needsPm()[0]?.blocker.kind).toBe('verify-setup');
  });

  it('releases the verification slot on the way out, pass or fail', async () => {
    const passing = harness();
    await toQueuedForVerify(passing);
    passing.send({ type: 'VERIFY_SLOT_GRANTED', slot: 0 });
    await passing.at('proving');
    expect(passing.sent('PHASE_VERIFY_SLOT_RELEASE')).toEqual([{ type: 'PHASE_VERIFY_SLOT_RELEASE', phaseId: 'p1' }]);

    const failing = harness({ verify: () => ({ passed: false, failedAt: 'check', steps: [], proofFiles: [] }) });
    await toQueuedForVerify(failing);
    failing.send({ type: 'VERIFY_SLOT_GRANTED', slot: 0 });
    await failing.at('deciding');
    expect(failing.sent('PHASE_VERIFY_SLOT_RELEASE')).toEqual([{ type: 'PHASE_VERIFY_SLOT_RELEASE', phaseId: 'p1' }]);
  });

  it('proof the verifier has to make is asked of one verifier session', async () => {
    const h = harness({
      input: {
        phase: {
          ...phaseInput().phase,
          proof: [
            { kind: 'tests', shows: 'the unit tests pass' },
            { kind: 'screenshot', shows: 'the new sign-in screen' },
          ],
        },
      },
      proof: (proof) => ({ complete: proof.items.some((item) => item.by === 'verifier'), missing: [], invalid: [] }),
    });
    await toQueuedForVerify(h);
    h.send({ type: 'VERIFY_SLOT_GRANTED', slot: 0 });
    await h.at('proving');
    await h.until(() => h.children()['verifier'] !== undefined, 'the verifier');
    const job = h.spawned.find((candidate) => candidate.role === 'verifier');
    expect(job && [job.key, job.keepAlive, job.submit, job.cwd]).toEqual([
      'r1/p1/verifier',
      true,
      'proof',
      '/repo/.worktrees/bdc/r1/p1',
    ]);

    h.done('verifier', { items: [{ kind: 'screenshot', shows: 'the new sign-in screen', file: 'sign-in.png', by: 'verifier' }] });
    await h.at('passed');
    expect(h.calls.checkProof.at(-1)?.items).toEqual([
      { kind: 'tests', shows: 'the unit tests pass', file: 'report.json', by: 'bdc' },
      { kind: 'screenshot', shows: 'the new sign-in screen', file: 'sign-in.png', by: 'verifier' },
    ]);
  });

  it('missing proof goes to the PM, and a manual proof asks the person through the PM', async () => {
    const h = harness({
      input: {
        phase: { ...phaseInput().phase, proof: [{ kind: 'manual', shows: 'the migration ran on a copy of prod' }] },
      },
      proof: () => ({
        complete: false,
        missing: [{ kind: 'manual', shows: 'the migration ran on a copy of prod' }],
        invalid: [],
      }),
    });
    await toQueuedForVerify(h);
    h.send({ type: 'VERIFY_SLOT_GRANTED', slot: 0 });
    await h.at('deciding');
    const needs = h.needsPm();
    // The person is asked right away (only the PM asks people), and checkProof then blocks the phase.
    expect(needs).toHaveLength(2);
    expect(needs[0]?.blocker.summary).toContain('the migration ran on a copy of prod');
    expect(needs[1]?.blocker.kind).toBe('proof');
    expect(needs[1]?.blocker.evidence).toEqual(['manual missing: the migration ran on a copy of prod']);
  });

  it('a stopped phase is final and reports why', async () => {
    const h = harness();
    await toReviewing(h);
    h.done('reviewer-security-1', { findings: [{ id: 'SEC-1', severity: 'high', summary: 'nope' }] });
    await h.at('deciding');
    h.send({ type: 'PM_DECISION', decision: { action: 'stop', reason: 'the plan is wrong' } });
    await h.at('stopped');
    expect(h.sent('PHASE_STOPPED')).toEqual([{ type: 'PHASE_STOPPED', phaseId: 'p1', reason: 'the plan is wrong' }]);
    // Final: RETRY is the run's business (§5.3), and nothing else moves the phase.
    h.send({ type: 'RETRY' });
    h.send({ type: 'RESUME' });
    await h.tick(10);
    expect(h.state()).toBe('stopped');
    expect(h.closed.sort()).toEqual(['r1/p1/review-security-1', 'r1/p1/t1/builder', 'r1/p1/t2/builder']);
  });

  it('fixes are bounded: with no attempt left the PM is asked again and no builder is touched', async () => {
    const h = harness({ input: { maxAttempts: 2 } });
    await toReviewing(h);
    h.done('reviewer-security-1', { findings: [{ id: 'SEC-1', severity: 'high', summary: 'bad' }] });
    await h.at('deciding');

    h.send({ type: 'PM_DECISION', decision: { action: 'fix', reason: 'fix it', instructions: 'do it', builder: 't2' } });
    await h.at('fixing');
    await h.until(() => h.followUps.length === 1, 'the fix');
    expect(h.followUps[0]?.key).toBe('r1/p1/t2/builder');
    h.done('builder-t2');
    await h.at('reviewing');
    await h.until(() => h.children()['reviewer-security-2'] !== undefined, 'the second review round');
    h.done('reviewer-security-2', { findings: [{ id: 'SEC-2', severity: 'high', summary: 'still bad' }] });
    await h.until(() => h.needsPm().length === 2, 'the second question to the PM');
    expect(h.context().attemptsUsed).toBe(1);

    // maxAttempts 2 means one fix; a second fix decision cannot start.
    h.send({ type: 'PM_DECISION', decision: { action: 'fix', reason: 'again', instructions: 'do it again' } });
    await h.until(() => h.needsPm().length === 3, 'the "no attempts left" question');
    expect(h.state()).toBe('deciding');
    expect(h.followUps).toHaveLength(1);
    expect(h.needsPm().at(-1)?.blocker.summary).toContain('no fix attempts left');
  });

  it('pause starts no new agent and resume carries on', async () => {
    const h = harness({ input: { phase: { ...phaseInput().phase, deps: ['p0'] } } });
    expect(h.state()).toBe('waiting');
    h.send({ type: 'PAUSE' });
    h.send({ type: 'DEP_DONE', phaseId: 'p0' });
    await h.at('building');
    await h.until(() => h.context().ensures.length === 0, 'the worktrees');
    await h.tick(10);
    expect(h.state()).toBe('building');
    expect(h.agentIds()).toEqual([]);

    h.send({ type: 'RESUME' });
    await h.until(() => h.agentIds().length === 2, 'the builders after resume');
    h.done('builder-t1');
    h.done('builder-t2');
    await h.at('reviewing');
  });

  it('cancel closes every child and is final', async () => {
    const h = harness();
    await toReviewing(h);

    h.send({ type: 'CANCEL' });
    await h.at('cancelled');
    await h.until(() => h.closed.length === 3, 'every child to be closed');
    expect(h.closed.sort()).toEqual(['r1/p1/review-security-1', 'r1/p1/t1/builder', 'r1/p1/t2/builder']);
    expect(h.sent('PHASE_DONE')).toHaveLength(0);
  });

  it('a prompt choice from the run reaches the agent with that job key', async () => {
    const h = harness();
    await h.at('building');
    await h.until(() => h.agentIds().length === 2, 'builders');
    h.send({ type: 'PROMPT_CHOICE', agentKey: 'r1/p1/t2/builder', choice: 'Trust this folder' });
    h.send({ type: 'PROMPT_CHOICE', agentKey: 'nobody', choice: 'ignored' });
    await h.until(() => h.choices.length === 1, 'the prompt choice');
    expect(h.choices).toEqual([{ key: 'r1/p1/t2/builder', choice: 'Trust this folder' }]);
  });

  it('an agent that needs the person is forwarded to the run', async () => {
    const h = harness();
    await h.at('building');
    await h.until(() => h.children()['builder-t1'] !== undefined, 'a builder');
    h.children()['builder-t1']?.send({ type: 'NEEDS_YOU', prompt: 'Trust this folder?' });
    await h.until(() => h.sent('AGENT_NEEDS_YOU').length === 1, 'the forwarded prompt');
    expect(h.sent('AGENT_NEEDS_YOU')).toEqual([
      { type: 'AGENT_NEEDS_YOU', key: 'r1/p1/t1/builder', prompt: 'Trust this folder?', choices: ['Trust this folder', "Don't"] },
    ]);
  });

  it('events that belong to another state are ignored', async () => {
    const h = harness();
    await h.at('building');
    await h.until(() => h.agentIds().length === 2, 'builders');
    for (const event of [
      { type: 'VERIFY_SLOT_GRANTED', slot: 0 },
      { type: 'PM_ASKING' },
      { type: 'PM_DECISION', decision: { action: 'stop', reason: 'not now' } },
      { type: 'DEP_DONE', phaseId: 'p0' },
      { type: 'RETRY' },
    ] as RunToPhase[]) {
      h.send(event);
    }
    await h.tick(10);
    expect(h.state()).toBe('building');
    expect(h.needsPm()).toHaveLength(0);
  });
});

// ── persistence (§5.7) ────────────────────────────────────────────────────────────────

describe('phaseMachine persistence', () => {
  it('restores in building without launching a builder or merging twice', async () => {
    const h = harness();
    await h.at('building');
    await h.until(() => h.agentIds().length === 2, 'builders');
    h.done('builder-t1');
    await h.tick(10);

    h.restore();
    expect(h.state()).toBe('building');
    await h.tick(10);
    expect(h.agentIds().sort()).toEqual(['builder-t1', 'builder-t2']);
    expect(h.spawned.filter((job) => job.role === 'builder')).toHaveLength(2);
    expect(h.calls.mergeBranch).toHaveLength(0);

    h.done('builder-t2');
    await h.at('reviewing');
  });

  it('restores in reviewing without a second review round or a second merge', async () => {
    const h = harness();
    await toReviewing(h);
    const merges = h.calls.mergeBranch.length;

    h.restore();
    expect(h.state()).toBe('reviewing');
    await h.tick(10);
    expect(h.spawned.filter((job) => job.role === 'reviewer')).toHaveLength(1);
    expect(h.calls.mergeBranch).toHaveLength(merges);

    h.done('reviewer-security-1', { findings: [] });
    await h.at('queuedForVerify');
    expect(h.calls.mergeBranch).toHaveLength(merges);
  });

  it('restores in awaitingYou without asking the PM again', async () => {
    const h = harness();
    await toReviewing(h);
    h.done('reviewer-security-1', { findings: [{ id: 'SEC-1', severity: 'high', summary: 'hmm' }] });
    await h.at('deciding');
    h.send({ type: 'PM_ASKING' });
    await h.at('awaitingYou');
    expect(h.needsPm()).toHaveLength(1);

    h.restore();
    expect(h.state()).toBe('awaitingYou');
    await h.tick(10);
    expect(h.needsPm()).toHaveLength(1);

    h.send({ type: 'PM_DECISION', decision: { action: 'continue', reason: 'go on' } });
    await h.at('queuedForVerify');
    expect(h.needsPm()).toHaveLength(1);
  });
});

// ── reachability (§5.3) ───────────────────────────────────────────────────────────────

describe('phaseMachine reachability', () => {
  it('every state of the §5.3 diagram is entered by a test above', () => {
    expect([...entered].sort()).toEqual(
      [
        'awaitingYou',
        'building',
        'cancelled',
        'continuing',
        'deciding',
        'done',
        'fixing',
        'merging',
        'passed',
        'proving',
        'queuedForVerify',
        'resolving',
        'reviewing',
        'stopped',
        'verifying',
        'waiting',
      ].sort(),
    );
  });
});
