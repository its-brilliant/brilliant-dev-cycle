import { createActor, enqueueActions, fromPromise, setup, type AnyActorRef, type StateValue } from 'xstate';
import { describe, expect, it, vi } from 'vitest';
import { ProjectConfig, type AgentChoice, type Brief, type Plan } from '../../src/contracts/domain.js';
import type { AgentJob } from '../../src/contracts/actors.js';
import type {
  AgentOutcome,
  AgentToParent,
  ParentToAgent,
  PersonEvent,
  PhaseToRun,
  PmToRun,
  RunToPm,
  RunToPhase,
} from '../../src/contracts/events.js';
import type { PmInput } from '../../src/machines/pm.js';
import {
  blockingFindings,
  lensInputs,
  parsePlan,
  phaseChildId,
  planHashOf,
  planYamlIsValid,
  runMachine,
  type OpenPullRequestInput,
  type OpenPullRequestOutput,
  type RunInput,
  type RunPhaseInput,
} from '../../src/machines/run.js';

const AGENT: AgentChoice = { cli: 'pi', model: '' };
const AGENTS = { pm: AGENT, specWriter: AGENT, planner: AGENT, builder: AGENT, reviewer: AGENT, verifier: AGENT };

const BRIEF: Brief = { brief: 'A health check endpoint', decisions: [], assumptions: [] };

function phaseOf(id: string, deps: string[] = []): Plan['phases'][number] {
  return {
    id,
    title: `Phase ${id}`,
    deps,
    tasks: [{ id: `t-${id}`, title: `Do ${id}`, paths: [] }],
    checks: [],
    proof: [{ kind: 'tests', shows: '' }],
  };
}

const PLAN: Plan = { phases: [phaseOf('p1'), phaseOf('p2', ['p1'])] };
const WIDE_PLAN: Plan = { phases: [phaseOf('p1'), phaseOf('p2'), phaseOf('p3'), phaseOf('p4')] };

function configOf(overrides: Record<string, unknown> = {}): ProjectConfig {
  return ProjectConfig.parse({
    agents: AGENTS,
    lenses: {
      security: { block_on: 'high', runs: 'every-phase' },
      ux: { block_on: 'medium', runs: 'final-only' },
      perf: { block_on: 'low', runs: 'matching-scope' },
    },
    verification: { parallel: 1 },
    concurrency: 2,
    ...overrides,
  });
}

/** What the stub children did, for the assertions. */
interface Log {
  pms: PmInput[];
  pmReceived: RunToPm[];
  phases: string[];
  phaseReceived: Map<string, RunToPhase[]>;
  agents: AgentJob[];
  /** The prompt choices a stage agent was sent, by its job key (§3.3). */
  promptChoices: Array<{ key: string; choice: string }>;
  prInputs: OpenPullRequestInput[];
}

/** The pm machine's stub: it records what the run sends and emits what the test tells it to. */
function pmStub(log: Log) {
  return setup({
    types: { context: {} as PmInput, input: {} as PmInput, events: {} as RunToPm | { type: 'TEST_STEP'; event: PmToRun } },
    actions: {
      recordPm: ({ context }) => {
        log.pms.push(context);
      },
      record: ({ event }) => {
        if (event.type !== 'TEST_STEP') log.pmReceived.push(event);
      },
      step: enqueueActions(({ event, enqueue }) => {
        if (event.type === 'TEST_STEP') enqueue.sendParent(event.event);
      }),
    },
  }).createMachine({
    context: ({ input }) => input,
    entry: 'recordPm',
    initial: 'on',
    states: { on: { on: { TEST_STEP: { actions: 'step' }, '*': { actions: 'record' } } } },
  });
}

/** The phase machine's stub (§5.3 is another slice). */
function phaseStub(log: Log) {
  return setup({
    types: {
      context: {} as RunPhaseInput,
      input: {} as RunPhaseInput,
      events: {} as RunToPhase | { type: 'TEST_STEP'; event: PhaseToRun },
    },
    actions: {
      recordPhase: ({ context }) => {
        log.phases.push(context.phase.id);
        log.phaseReceived.set(context.phase.id, []);
      },
      record: ({ context, event }) => {
        if (event.type === 'TEST_STEP') return;
        log.phaseReceived.get(context.phase.id)?.push(event);
      },
      step: enqueueActions(({ event, enqueue }) => {
        if (event.type === 'TEST_STEP') enqueue.sendParent(event.event);
      }),
    },
  }).createMachine({
    context: ({ input }) => input,
    entry: 'recordPhase',
    initial: 'on',
    states: { on: { on: { TEST_STEP: { actions: 'step' }, '*': { actions: 'record' } } } },
  });
}

/** The agent machine's stub (§5.5 is another slice). */
function agentStub(log: Log) {
  return setup({
    types: { context: {} as AgentJob, input: {} as AgentJob, events: {} as ParentToAgent | { type: 'TEST_STEP'; outcome: AgentOutcome } },
    actions: {
      recordAgent: ({ context }) => {
        log.agents.push(context);
      },
      recordChoice: ({ context, event }) => {
        if (event.type === 'PROMPT_CHOICE') log.promptChoices.push({ key: context.key, choice: event.choice });
      },
      step: enqueueActions(({ context, event, enqueue }) => {
        if (event.type !== 'TEST_STEP') return;
        enqueue.sendParent({ type: 'AGENT_RESULT', key: context.key, outcome: event.outcome });
      }),
    },
  }).createMachine({
    context: ({ input }) => input,
    entry: 'recordAgent',
    initial: 'on',
    states: { on: { on: { TEST_STEP: { actions: 'step' }, PROMPT_CHOICE: { actions: 'recordChoice' } } } },
  });
}

function childOf(actor: AnyActorRef, id: string): AnyActorRef {
  const found = actor.getSnapshot().children[id];
  if (found === undefined) throw new Error(`no child ${id}`);
  return found;
}

function agentByKey(actor: AnyActorRef, key: string): AnyActorRef {
  const children: Record<string, AnyActorRef | undefined> = actor.getSnapshot().children;
  for (const candidate of Object.values(children)) {
    if (candidate === undefined) continue;
    const snapshot: { context?: { key?: string } } = candidate.getSnapshot();
    if (snapshot.context?.key === key) return candidate;
  }
  throw new Error(`no agent child for ${key}`);
}

/** The run's stage name, however deeply the state value nests it (`shipping` has `ready`/`opening`). */
/** Every top-level state any test entered (spec §5.2). Checked by the last test in this file. */
const REACHED = new Set<string>();

function stageName(value: StateValue): string {
  if (typeof value === 'string') return value;
  const [first] = Object.entries(value);
  if (first === undefined) return 'active';
  const [key, nested] = first;
  if (key !== 'active' || nested === undefined) return key;
  return stageName(nested);
}

function harness(options: { config?: ProjectConfig; pr?: 'ok' | 'fail' } = {}) {
  const log: Log = {
    pms: [],
    pmReceived: [],
    phases: [],
    phaseReceived: new Map(),
    agents: [],
    promptChoices: [],
    prInputs: [],
  };
  const input: RunInput = {
    runId: 'r1',
    root: '/repo',
    goal: 'Ship a health check',
    config: options.config ?? configOf(),
    lensPrompts: { security: 'Look for injection', ux: 'Look at the screens' },
  };
  const openPullRequest =
    options.pr === 'fail'
      ? fromPromise<OpenPullRequestOutput, OpenPullRequestInput>(async ({ input: prInput }) => {
          log.prInputs.push(prInput);
          throw new Error('gh is down');
        })
      : fromPromise<OpenPullRequestOutput, OpenPullRequestInput>(async ({ input: prInput }) => {
          log.prInputs.push(prInput);
          return { path: '.herd/pull-request.md' };
        });
  const machine = runMachine.provide({
    actors: { pm: pmStub(log), phase: phaseStub(log), agent: agentStub(log), openPullRequest },
  });
  let actor = createActor(machine, { input });
  actor.subscribe((snapshot) => REACHED.add(stageName(snapshot.value)));
  actor.start();
  const run = () => actor;
  return {
    log,
    run,
    stage: () => stageName(actor.getSnapshot().value),
    context: () => actor.getSnapshot().context,
    send: (event: PersonEvent | PhaseToRun | PmToRun | AgentToParent) => actor.send(event),
    pmEmit: (event: PmToRun) => childOf(actor, 'pm').send({ type: 'TEST_STEP', event }),
    phaseEmit: (phaseId: string, event: PhaseToRun) => childOf(actor, phaseChildId(phaseId)).send({ type: 'TEST_STEP', event }),
    agentEmit: (key: string, outcome: AgentOutcome) => agentByKey(actor, key).send({ type: 'TEST_STEP', outcome }),
    phaseSaw: (phaseId: string) => log.phaseReceived.get(phaseId) ?? [],
    restore: () => {
      const persisted = JSON.parse(JSON.stringify(actor.getPersistedSnapshot()));
      actor = createActor(machine, { snapshot: persisted, input });
      actor.subscribe((snapshot) => REACHED.add(stageName(snapshot.value)));
      actor.start();
    },
  };
}

type Harness = ReturnType<typeof harness>;

/** Intake done and a spec v1 written: the run is in spec review. */
function toSpecReview(test: Harness) {
  test.send({ type: 'UNDERSTANDING_CONFIRMED' });
  test.pmEmit({ type: 'PM_BRIEF', brief: BRIEF });
  test.agentEmit('r1/spec/1', { status: 'done', submission: { markdown: '# Spec v1', notes: [] } });
}

/** Spec approved and a plan accepted: the run is building. */
function toBuilding(test: Harness, plan: Plan = PLAN) {
  toSpecReview(test);
  test.send({ type: 'SPEC_APPROVED' });
  test.agentEmit('r1/plan/1', { status: 'done', submission: plan });
  test.send({ type: 'PLAN_APPROVED' });
}

describe('runMachine: pure helpers', () => {
  it('a plan edit is accepted only when the YAML is a valid plan', () => {
    expect(planYamlIsValid('phases:\n  - id: p1\n    title: One\n    tasks: [{ id: t1, title: Do it }]\n    proof: [{ kind: tests }]\n')).toBe(true);
    expect(planYamlIsValid('phases: []')).toBe(false);
    expect(planYamlIsValid('not: [valid')).toBe(false);
    expect(parsePlan(PLAN)).toEqual(PLAN);
    expect(planHashOf(PLAN)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('lens inputs carry the prompt, and only findings at or above block_on block', () => {
    const config = ProjectConfig.parse({
      agents: AGENTS,
      lenses: { security: { block_on: 'high' }, docs: { block_on: 'none' } },
    });
    const lenses = lensInputs(config, { security: 'Look for injection' });
    expect(lenses.security?.prompt).toBe('Look for injection');
    expect(lenses.docs?.prompt).toBe('');
    const blocking = blockingFindings(config.lenses, {
      security: [
        { id: 'S1', severity: 'high', summary: 'sql injection' },
        { id: 'S2', severity: 'low', summary: 'style' },
      ],
      docs: [{ id: 'D1', severity: 'critical', summary: 'a lens that does not block' }],
    });
    expect(blocking.map((entry) => entry.finding.id)).toEqual(['S1']);
  });
});

describe('runMachine', () => {
  it('goes from the goal to an opened pull request', async () => {
    const test = harness();
    expect(test.stage()).toBe('intake');
    // The PM session is up and has the goal.
    expect(test.log.pms).toHaveLength(1);
    expect(test.log.pmReceived[0]).toEqual({ type: 'INTAKE', goal: 'Ship a health check' });

    // A grilling round: the question reaches the run, the answer goes back to the PM.
    const grilling = [{ id: 'q1', title: 'Which provider?', body: '', kind: 'single' as const, options: [], allowOther: true }];
    test.pmEmit({ type: 'PM_ASKING', scope: null, askId: 'ask-1', questions: grilling });
    // The questions are kept, not only the ask id, so the view can show the card (§3.4, §7.2).
    expect(test.context().asking).toEqual({ scope: null, askId: 'ask-1', questions: grilling });
    test.send({ type: 'ROUND_ANSWERED', answers: [{ questionId: 'q1', picked: ['google'], text: '', skipped: false }] });
    expect(test.log.pmReceived[1]).toMatchObject({ type: 'ANSWER', askId: 'ask-1' });
    test.pmEmit({ type: 'PM_ASK_DONE', askId: 'ask-1' });
    expect(test.context().asking).toBeNull();

    // The brief: the spec writer starts with it.
    test.send({ type: 'UNDERSTANDING_CONFIRMED' });
    expect(test.log.pmReceived[2]).toMatchObject({ type: 'MESSAGE' });
    test.pmEmit({ type: 'PM_BRIEF', brief: BRIEF });
    expect(test.stage()).toBe('specDrafting');
    expect(test.context().brief).toEqual(BRIEF);
    const specJob = test.log.agents[0];
    expect(specJob?.key).toBe('r1/spec/1');
    expect(specJob?.submit).toBe('spec');
    expect(specJob?.keepAlive).toBe(false);
    expect(specJob?.prompt).toContain('A health check endpoint');

    test.agentEmit('r1/spec/1', { status: 'done', submission: { markdown: '# Spec v1', notes: ['tightened the API'] } });
    expect(test.stage()).toBe('specReview');
    expect(test.context().specVersion).toBe(1);
    expect(test.context().spec).toBe('# Spec v1');

    // Planning.
    test.send({ type: 'SPEC_APPROVED' });
    expect(test.stage()).toBe('planning');
    test.agentEmit('r1/plan/1', { status: 'done', submission: PLAN });
    expect(test.stage()).toBe('planReview');
    expect(test.context().plan).toEqual(PLAN);
    test.send({ type: 'PLAN_APPROVED' });

    // Build: p1 has no deps, p2 waits on p1.
    expect(test.stage()).toBe('building');
    expect(test.log.phases).toEqual(['p1']);
    const phaseInput = test.log.phases.length === 1 ? childOf(test.run(), phaseChildId('p1')).getSnapshot().context : null;
    expect(phaseInput?.runBranch).toBe('bdc/r1');
    expect(phaseInput?.runWorktree).toBe('/repo/.worktrees/bdc-r1');
    expect(phaseInput?.doneDeps).toEqual([]);
    expect(phaseInput?.lenses.security?.prompt).toBe('Look for injection');
    expect(phaseInput?.maxAttempts).toBe(3);

    test.phaseEmit('p1', { type: 'PHASE_DONE', phaseId: 'p1' });
    expect(test.log.phases).toEqual(['p1', 'p2']);
    expect(test.phaseSaw('p2')).toEqual([{ type: 'DEP_DONE', phaseId: 'p1' }]);
    test.phaseEmit('p2', { type: 'PHASE_DONE', phaseId: 'p2' });

    // Final review: the lenses that are not matching-scope run over the whole run.
    expect(test.stage()).toBe('finalReview');
    expect(test.log.agents.map((job) => job.key)).toEqual(['r1/spec/1', 'r1/plan/1', 'r1/review:security/1', 'r1/review:ux/1']);
    test.agentEmit('r1/review:security/1', { status: 'done', submission: { findings: [] } });
    expect(test.stage()).toBe('finalReview');
    test.agentEmit('r1/review:ux/1', { status: 'done', submission: { findings: [] } });

    // Ship.
    expect(test.stage()).toBe('shipping');
    test.send({ type: 'OPEN_PR', draft: true });
    await vi.waitFor(() => expect(test.stage()).toBe('done'));
    expect(test.log.prInputs).toEqual([
      {
        runId: 'r1',
        root: '/repo',
        runBranch: 'bdc/r1',
        draft: true,
        prTargets: [{ provider: 'file', path: '.herd/pull-request.md' }],
      },
    ]);
    expect(test.context().pr).toEqual({ path: '.herd/pull-request.md' });
  });

  it('requesting changes sends the spec writer back with the comments, and bumps the version', () => {
    const test = harness();
    toSpecReview(test);
    test.send({ type: 'SPEC_COMMENT', comment: { id: 'c1', quote: 'health', prefix: '', suffix: '', body: 'say which port' } });
    expect(test.context().specComments).toHaveLength(1);
    // No note and an open comment: the change request goes through.
    test.send({ type: 'SPEC_CHANGES_REQUESTED' });
    expect(test.stage()).toBe('specDrafting');
    const second = test.log.agents[1];
    expect(second?.key).toBe('r1/spec/2');
    expect(second?.prompt).toContain('say which port');
    expect(second?.prompt).toContain('# Spec v1');
    test.agentEmit('r1/spec/2', { status: 'done', submission: { markdown: '# Spec v2', notes: [] } });
    expect(test.stage()).toBe('specReview');
    expect(test.context().specVersion).toBe(2);
  });

  it('ignores a change request with nothing to act on', () => {
    const test = harness();
    toSpecReview(test);
    test.send({ type: 'SPEC_CHANGES_REQUESTED' });
    expect(test.stage()).toBe('specReview');
    expect(test.log.agents).toHaveLength(1);
  });

  it('rejects a plan edit that does not parse and accepts one that does', () => {
    const test = harness();
    toSpecReview(test);
    test.send({ type: 'SPEC_APPROVED' });
    test.agentEmit('r1/plan/1', { status: 'done', submission: PLAN });
    expect(test.stage()).toBe('planReview');

    test.send({ type: 'PLAN_EDITED', planYaml: 'phases: [{ id: p9 }]' });
    expect(test.context().plan).toEqual(PLAN);

    test.send({
      type: 'PLAN_EDITED',
      planYaml: 'phases:\n  - id: p9\n    title: Edited\n    tasks: [{ id: t9, title: Do it }]\n    proof: [{ kind: tests }]\n',
    });
    expect(test.context().plan?.phases.map((phase) => phase.id)).toEqual(['p9']);
  });

  it('retries the planner twice, then asks the PM', () => {
    const test = harness();
    toSpecReview(test);
    test.send({ type: 'SPEC_APPROVED' });
    test.agentEmit('r1/plan/1', { status: 'done', submission: { phases: [] } });
    expect(test.log.agents.map((job) => job.key)).toEqual(['r1/spec/1', 'r1/plan/1', 'r1/plan/2']);
    test.agentEmit('r1/plan/2', { status: 'done', submission: { phases: [] } });
    expect(test.log.agents.map((job) => job.key)).toContain('r1/plan/3');
    test.agentEmit('r1/plan/3', { status: 'done', submission: { phases: [] } });
    expect(test.log.pmReceived.at(-1)).toMatchObject({ type: 'DECIDE', scope: 'plan' });
    expect(test.stage()).toBe('planning');

    // The PM says stop: the run fails, and RETRY brings the planner back.
    test.pmEmit({ type: 'PM_DECISION', scope: 'plan', decision: { action: 'stop', reason: 'the plan is not worth it' } });
    expect(test.stage()).toBe('failed');
    expect(test.context().error?.where).toBe('planning');
    test.send({ type: 'RETRY' });
    expect(test.stage()).toBe('planning');
    expect(test.log.agents.at(-1)?.key).toBe('r1/plan/4');
  });

  it('respects concurrency: four independent phases, two at a time', () => {
    const test = harness({ config: configOf({ concurrency: 2 }) });
    toBuilding(test, WIDE_PLAN);
    expect(test.log.phases).toEqual(['p1', 'p2']);

    const activeCounts: number[] = [];
    test.run().subscribe((snapshot) => {
      activeCounts.push(Object.values(snapshot.context.phases).filter((status) => status === 'active').length);
    });

    test.phaseEmit('p1', { type: 'PHASE_DONE', phaseId: 'p1' });
    expect(test.log.phases).toEqual(['p1', 'p2', 'p3']);
    test.phaseEmit('p2', { type: 'PHASE_DONE', phaseId: 'p2' });
    expect(test.log.phases).toEqual(['p1', 'p2', 'p3', 'p4']);
    test.phaseEmit('p3', { type: 'PHASE_DONE', phaseId: 'p3' });
    test.phaseEmit('p4', { type: 'PHASE_DONE', phaseId: 'p4' });
    expect(test.stage()).toBe('finalReview');
    expect(Math.max(...activeCounts)).toBeLessThanOrEqual(2);
  });

  it('never grants more verification slots than the repo allows', () => {
    const test = harness({ config: configOf({ concurrency: 2, verification: { parallel: 1 } }) });
    toBuilding(test, WIDE_PLAN);
    test.phaseEmit('p1', { type: 'PHASE_VERIFY_SLOT_REQUEST', phaseId: 'p1' });
    test.phaseEmit('p2', { type: 'PHASE_VERIFY_SLOT_REQUEST', phaseId: 'p2' });
    expect(test.phaseSaw('p1')).toEqual([{ type: 'VERIFY_SLOT_GRANTED', slot: 0 }]);
    expect(test.phaseSaw('p2')).toEqual([]);
    expect(test.context().verifyQueue).toEqual(['p2']);

    test.phaseEmit('p1', { type: 'PHASE_VERIFY_SLOT_RELEASE', phaseId: 'p1' });
    expect(test.phaseSaw('p2')).toEqual([{ type: 'VERIFY_SLOT_GRANTED', slot: 0 }]);
    expect(test.context().verifySlots.held).toEqual(['p2']);

    // A finished phase frees its slot for whoever waits.
    test.phaseEmit('p2', { type: 'PHASE_DONE', phaseId: 'p2' });
    expect(test.context().verifySlots.held).toEqual(['']);
    expect(test.log.phases).toEqual(['p1', 'p2', 'p3']);
  });

  it('grants a held verification slot again when the phase asks after a restore', () => {
    const test = harness();
    toBuilding(test);
    test.phaseEmit('p1', { type: 'PHASE_VERIFY_SLOT_REQUEST', phaseId: 'p1' });
    expect(test.phaseSaw('p1')).toEqual([{ type: 'VERIFY_SLOT_GRANTED', slot: 0 }]);

    // The grant was in flight when the daemon died: the restored phase asks again (§5.7, §7.4).
    test.restore();
    expect(test.context().verifySlots.held).toEqual(['p1']);
    test.phaseEmit('p1', { type: 'PHASE_VERIFY_SLOT_REQUEST', phaseId: 'p1' });
    expect(test.phaseSaw('p1')).toEqual([
      { type: 'VERIFY_SLOT_GRANTED', slot: 0 },
      { type: 'VERIFY_SLOT_GRANTED', slot: 0 },
    ]);
    // The slot is still held once, not twice.
    expect(test.context().verifySlots.held).toEqual(['p1']);
  });

  it('sends the PM a decision request for the blocked phase, and the decision to that phase only', () => {
    const test = harness({ config: configOf({ concurrency: 2 }) });
    toBuilding(test, WIDE_PLAN);
    test.phaseEmit('p2', {
      type: 'PHASE_NEEDS_PM',
      phaseId: 'p2',
      blocker: { kind: 'verify', summary: 'unit tests fail', evidence: ['1 failing'] },
      attemptsUsed: 1,
      attemptsMax: 3,
    });
    expect(test.log.pmReceived.at(-1)).toEqual({
      type: 'DECIDE',
      scope: 'p2',
      blocker: { kind: 'verify', summary: 'unit tests fail', evidence: ['1 failing'] },
      fixAllowed: true,
    });

    test.pmEmit({ type: 'PM_DECISION', scope: 'p2', decision: { action: 'continue', reason: 'the failure is unrelated' } });
    expect(test.phaseSaw('p2')).toContainEqual({
      type: 'PM_DECISION',
      decision: { action: 'continue', reason: 'the failure is unrelated' },
    });
    expect(test.phaseSaw('p1')).toEqual([]);
    expect(test.context().overrides).toEqual([{ phaseId: 'p2', reason: 'the failure is unrelated', who: 'pm' }]);

    // The person's own override goes to the phase, marked as theirs.
    test.send({ type: 'OVERRIDE', phaseId: 'p1', lens: 'security', reason: 'known and accepted' });
    expect(test.phaseSaw('p1')).toContainEqual({
      type: 'OVERRIDE',
      lens: 'security',
      reason: 'known and accepted',
      who: 'person',
    });
    expect(test.context().overrides.at(-1)).toMatchObject({ phaseId: 'p1', who: 'person' });

    // The PM's question reaches the phase that raised it.
    const questions = [
      { id: 'q1', title: 'Ship without the test?', body: '', kind: 'confirm' as const, options: [], allowOther: false },
    ];
    test.pmEmit({ type: 'PM_ASKING', scope: 'p2', askId: 'ask-2', questions });
    expect(test.phaseSaw('p2')).toContainEqual({ type: 'PM_ASKING' });
    expect(test.context().asking).toEqual({ scope: 'p2', askId: 'ask-2', questions });
  });

  it('turns an agent prompt into a card and hands the choice to the agent that holds that key', () => {
    const test = harness();
    toBuilding(test);
    const trust = { prompt: 'Trust this folder?', choices: ['Trust', "Don't"] };

    // A phase child forwards its builder's prompt (§3.3).
    test.send({ type: 'AGENT_NEEDS_YOU', key: 'r1/p1/builder', ...trust });
    expect(test.context().agentPrompts).toEqual([{ agentKey: 'r1/p1/builder', ...trust }]);

    // The choice goes to the phase, which routes it to that builder, and the card goes away.
    test.send({ type: 'PROMPT_CHOICE', agentKey: 'r1/p1/builder', choice: 'Trust' });
    expect(test.phaseSaw('p1')).toContainEqual({ type: 'PROMPT_CHOICE', agentKey: 'r1/p1/builder', choice: 'Trust' });
    expect(test.context().agentPrompts).toEqual([]);

    // The PM's own session's prompt is a card too, and the choice goes back to the PM.
    test.send({ type: 'AGENT_NEEDS_YOU', key: 'r1/pm', ...trust });
    expect(test.context().agentPrompts.map((prompt) => prompt.agentKey)).toEqual(['r1/pm']);
    test.send({ type: 'PROMPT_CHOICE', agentKey: 'r1/pm', choice: 'Trust' });
    expect(test.log.pmReceived.at(-1)).toEqual({ type: 'PROMPT_CHOICE', agentKey: 'r1/pm', choice: 'Trust' });
    expect(test.context().agentPrompts).toEqual([]);

    // A phase that settles takes the prompts of its agents with it: those sessions are closed.
    test.send({ type: 'AGENT_NEEDS_YOU', key: 'r1/p1/builder', ...trust });
    test.phaseEmit('p1', { type: 'PHASE_DONE', phaseId: 'p1' });
    expect(test.context().agentPrompts).toEqual([]);
  });

  it('gives a stage agent its prompt choice, and forgets the prompt when it moves on', () => {
    const test = harness();
    test.send({ type: 'UNDERSTANDING_CONFIRMED' });
    test.pmEmit({ type: 'PM_BRIEF', brief: BRIEF });
    expect(test.stage()).toBe('specDrafting');
    const trust = { prompt: 'Trust this folder?', choices: ['Trust', "Don't"] };

    test.send({ type: 'AGENT_NEEDS_YOU', key: 'r1/spec/1', ...trust });
    expect(test.context().agentPrompts).toEqual([{ agentKey: 'r1/spec/1', ...trust }]);
    test.send({ type: 'PROMPT_CHOICE', agentKey: 'r1/spec/1', choice: 'Trust' });
    expect(test.log.promptChoices).toEqual([{ key: 'r1/spec/1', choice: 'Trust' }]);
    expect(test.context().agentPrompts).toEqual([]);

    // A prompt that is never answered goes when the agent reports: it has moved on.
    test.send({ type: 'AGENT_NEEDS_YOU', key: 'r1/spec/1', ...trust });
    test.agentEmit('r1/spec/1', { status: 'done', submission: { markdown: '# Spec v2', notes: [] } });
    expect(test.context().agentPrompts).toEqual([]);
  });

  it('pauses in spec review and comes back to spec review', () => {
    const test = harness();
    toSpecReview(test);
    test.send({ type: 'PAUSE' });
    expect(test.stage()).toBe('paused');
    test.send({ type: 'RESUME' });
    expect(test.stage()).toBe('specReview');
    // Nothing was spawned twice by the round trip.
    expect(test.log.agents).toHaveLength(1);
  });

  it('pauses in build and comes back to build with its phases', () => {
    const test = harness({ config: configOf({ concurrency: 2 }) });
    toBuilding(test, WIDE_PLAN);
    expect(test.log.phases).toEqual(['p1', 'p2']);
    test.send({ type: 'PAUSE' });
    expect(test.stage()).toBe('paused');
    expect(test.phaseSaw('p1')).toContainEqual({ type: 'PAUSE' });
    test.send({ type: 'RESUME' });
    expect(test.stage()).toBe('building');
    expect(test.log.phases).toEqual(['p1', 'p2']);
    expect(test.phaseSaw('p1')).toContainEqual({ type: 'RESUME' });
    // The run keeps scheduling after the resume.
    test.phaseEmit('p1', { type: 'PHASE_DONE', phaseId: 'p1' });
    expect(test.log.phases).toEqual(['p1', 'p2', 'p3']);
  });

  it('holds results that arrive while paused and replays them on resume', () => {
    const test = harness({ config: configOf({ concurrency: 2 }) });
    toBuilding(test, WIDE_PLAN);
    test.send({ type: 'PAUSE' });
    test.phaseEmit('p1', { type: 'PHASE_DONE', phaseId: 'p1' });
    expect(test.context().phases.p1).toBe('active');
    expect(test.context().deferred).toHaveLength(1);
    test.send({ type: 'RESUME' });
    expect(test.context().phases.p1).toBe('done');
    expect(test.context().deferred).toEqual([]);
    expect(test.log.phases).toEqual(['p1', 'p2', 'p3']);
  });

  it('cancels from intake, from spec review and from build', () => {
    const intake = harness();
    intake.send({ type: 'CANCEL' });
    expect(intake.stage()).toBe('cancelled');

    const review = harness();
    toSpecReview(review);
    review.send({ type: 'CANCEL' });
    expect(review.stage()).toBe('cancelled');

    const building = harness();
    toBuilding(building);
    building.send({ type: 'CANCEL' });
    expect(building.stage()).toBe('cancelled');
  });

  it('fails when a stage agent fails, and RETRY re-enters that stage', () => {
    const test = harness();
    test.send({ type: 'UNDERSTANDING_CONFIRMED' });
    test.pmEmit({ type: 'PM_BRIEF', brief: BRIEF });
    test.agentEmit('r1/spec/1', { status: 'crashed', detail: 'terminal exited' });
    expect(test.stage()).toBe('failed');
    expect(test.context().error).toEqual({ where: 'specDrafting', detail: 'crashed: terminal exited' });
    test.send({ type: 'RETRY' });
    expect(test.stage()).toBe('specDrafting');
    expect(test.log.agents.at(-1)?.key).toBe('r1/spec/2');
  });

  it('fails when the pull request cannot be opened, and RETRY tries again', async () => {
    const test = harness({ pr: 'fail' });
    toBuilding(test);
    test.phaseEmit('p1', { type: 'PHASE_DONE', phaseId: 'p1' });
    test.phaseEmit('p2', { type: 'PHASE_DONE', phaseId: 'p2' });
    test.agentEmit('r1/review:security/1', { status: 'done', submission: { findings: [] } });
    test.agentEmit('r1/review:ux/1', { status: 'done', submission: { findings: [] } });
    expect(test.stage()).toBe('shipping');
    test.send({ type: 'OPEN_PR', draft: false });
    await vi.waitFor(() => expect(test.stage()).toBe('failed'));
    expect(test.context().error?.where).toBe('shipping');
    // RETRY re-enters the stage that failed, so the pull request is attempted again.
    test.send({ type: 'RETRY' });
    await vi.waitFor(() => expect(test.log.prInputs).toHaveLength(2));
    expect(test.log.prInputs[1]).toMatchObject({ draft: false });
  });

  it('blocks the run on a blocking final finding and lets the PM continue it', () => {
    const test = harness();
    toBuilding(test);
    test.phaseEmit('p1', { type: 'PHASE_DONE', phaseId: 'p1' });
    test.phaseEmit('p2', { type: 'PHASE_DONE', phaseId: 'p2' });
    test.agentEmit('r1/review:security/1', {
      status: 'done',
      submission: { findings: [{ id: 'S1', severity: 'critical', summary: 'command injection' }] },
    });
    test.agentEmit('r1/review:ux/1', { status: 'done', submission: { findings: [] } });
    expect(test.stage()).toBe('finalReview');
    expect(test.log.pmReceived.at(-1)).toMatchObject({ type: 'DECIDE', scope: 'run', fixAllowed: false });
    test.pmEmit({ type: 'PM_DECISION', scope: 'run', decision: { action: 'continue', reason: 'behind a feature flag' } });
    expect(test.stage()).toBe('shipping');
    expect(test.context().overrides.at(-1)).toMatchObject({ phaseId: 'run', who: 'pm' });
  });

  it('applies a proposal by raising the event it proposed, and discards one without raising', () => {
    const test = harness();
    toSpecReview(test);
    test.pmEmit({ type: 'PM_PROPOSAL', proposalId: 'pr-1', text: 'approve the spec', event: { type: 'SPEC_APPROVED' } });
    expect(test.context().chat.at(-1)).toMatchObject({ from: 'pm', proposalId: 'pr-1' });
    expect(test.stage()).toBe('specReview');

    test.pmEmit({ type: 'PM_PROPOSAL', proposalId: 'pr-2', text: 'also approve', event: { type: 'SPEC_APPROVED' } });
    test.send({ type: 'DISCARD_PROPOSAL', proposalId: 'pr-2' });
    expect(test.context().proposals['pr-2']).toBeUndefined();
    expect(test.stage()).toBe('specReview');

    test.send({ type: 'APPLY_PROPOSAL', proposalId: 'pr-1' });
    expect(test.stage()).toBe('planning');
    expect(test.context().proposals['pr-1']).toBeUndefined();
  });

  it('keeps the chat and the questions the PM sent', () => {
    const test = harness();
    test.send({ type: 'MESSAGE', text: 'how is it going?' });
    expect(test.log.pmReceived.at(-1)).toEqual({ type: 'MESSAGE', text: 'how is it going?' });
    test.pmEmit({ type: 'PM_REPLY', text: 'still grilling you' });
    expect(test.context().chat).toEqual([{ from: 'pm', text: 'still grilling you' }]);
  });

  it('survives a persist → restore in intake without a second PM session', () => {
    const test = harness();
    expect(test.log.pms).toHaveLength(1);
    test.restore();
    expect(test.stage()).toBe('intake');
    expect(test.log.pms).toHaveLength(1);
    expect(test.log.pmReceived).toHaveLength(1);
    // It still works after the restore.
    test.send({ type: 'UNDERSTANDING_CONFIRMED' });
    expect(test.log.pmReceived.at(-1)).toMatchObject({ type: 'MESSAGE' });
  });

  it('survives a persist → restore in spec review without a second spec writer', () => {
    const test = harness();
    toSpecReview(test);
    expect(test.log.agents).toHaveLength(1);
    test.restore();
    expect(test.stage()).toBe('specReview');
    expect(test.log.agents).toHaveLength(1);
    test.send({ type: 'SPEC_APPROVED' });
    expect(test.log.agents.map((job) => job.key)).toEqual(['r1/spec/1', 'r1/plan/1']);
  });

  it('survives a persist → restore in build without spawning a phase twice', () => {
    const test = harness({ config: configOf({ concurrency: 2 }) });
    toBuilding(test, WIDE_PLAN);
    expect(test.log.phases).toEqual(['p1', 'p2']);
    test.restore();
    expect(test.stage()).toBe('building');
    expect(test.log.phases).toEqual(['p1', 'p2']);
    test.phaseEmit('p1', { type: 'PHASE_DONE', phaseId: 'p1' });
    expect(test.log.phases).toEqual(['p1', 'p2', 'p3']);
  });

  // Runs last: vitest runs the tests of a file in order.
  it('reaches every top-level state of the run across these tests', () => {
    const expected = ['intake', 'specDrafting', 'specReview', 'planning', 'planReview', 'building', 'finalReview', 'shipping', 'done', 'failed', 'cancelled', 'paused'];
    expect([...REACHED].filter((state) => expected.includes(state)).sort()).toEqual([...expected].sort());
  });
});
